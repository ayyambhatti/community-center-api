const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query, withTransaction } = require("../config/db");
const env = require("../config/env");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { generateId, formatTimeLabel, getSystemSettings, recordActivity } = require("../utils/audit");
const { mapUser } = require("../utils/formatters");

const router = express.Router();
const ALLOWED_SELF_REGISTER_ROLES = new Set(["Manager", "Accountant", "Staff"]);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const rawUserId = typeof req.body?.userId === "string" ? req.body.userId : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const keepMeSignedIn = Boolean(req.body?.keepMeSignedIn);
    const trimmedUserId = rawUserId.trim().toLowerCase();

    if (!trimmedUserId || !password) {
      return res.status(400).json({
        success: false,
        message: "User ID and password are required.",
      });
    }

    const rows = await query(
      "SELECT id, user_id, name, role, password_hash, last_login, active, approval_status FROM users WHERE LOWER(user_id) = ? LIMIT 1",
      [trimmedUserId]
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User ID or password is incorrect.",
      });
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return res.status(401).json({
        success: false,
        message: "User ID or password is incorrect.",
      });
    }

    if (user.approval_status === "Pending") {
      return res.status(403).json({
        success: false,
        code: "PENDING_APPROVAL",
        message: "Your login account is waiting for Admin approval.",
      });
    }

    if (user.approval_status === "Rejected") {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_REJECTED",
        message: "Your login request was rejected by Admin.",
      });
    }

    if (!user.active) {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_DISABLED",
        message: "This account is currently deactivated. Contact Admin.",
      });
    }

    const lastLogin = formatTimeLabel();
    await withTransaction(async (conn) => {
      await conn.execute("UPDATE users SET last_login = ? WHERE id = ?", [lastLogin, user.id]);
      await recordActivity(conn, {
        userLabel: `${user.name} (${user.role})`,
        module: "User",
        action: `Signed in (${user.user_id})`,
        detail: `User "${user.user_id}" signed in at ${lastLogin}.`,
        category: "Approvals",
        alertTitle: user.role === "Admin" ? undefined : `Login Alert — ${user.name} (${user.role})`,
        alertDetail: `${user.user_id} signed in at ${lastLogin}`,
        href: "/audit-logs",
        forceAudience: "admin",
      });
    });

    const token = jwt.sign(
      {
        sub: user.id,
        userId: user.user_id,
        name: user.name,
        role: user.role,
      },
      env.jwt.secret,
      {
        expiresIn: keepMeSignedIn ? env.jwt.rememberExpiresIn : env.jwt.expiresIn,
      }
    );

    return res.json({
      success: true,
      token,
      role: user.role.toLowerCase(),
      user: mapUser({ ...user, last_login: lastLogin }),
      message: "Login successful",
    });
  })
);

/**
 * Self-service login / access request: always lands as Pending until Admin approves.
 */
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const rawUserId = typeof req.body?.userId === "string" ? req.body.userId : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const requestedRole = typeof req.body?.role === "string" ? req.body.role.trim() : "Staff";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const cleanUserId = rawUserId.trim().toLowerCase();

    if (!cleanUserId || !name || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "User ID, full name, and a password of at least 6 characters are required.",
      });
    }

    if (!ALLOWED_SELF_REGISTER_ROLES.has(requestedRole)) {
      return res.status(403).json({
        success: false,
        message: "Self-registration is only permitted for Manager, Accountant, or Staff roles.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = generateId("u");
    const settings = await getSystemSettings();
    const needsApproval = Boolean(settings.require_user_admin_approval);

    await withTransaction(async (conn) => {
      await conn.execute(
        `INSERT INTO users (id, user_id, name, role, password_hash, last_login, active, approval_status)
         VALUES (?, ?, ?, ?, ?, 'Never', ?, ?)`,
        [
          id,
          cleanUserId,
          name,
          requestedRole,
          passwordHash,
          needsApproval ? 0 : 1,
          needsApproval ? "Pending" : "Approved",
        ]
      );

      if (needsApproval) {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
           VALUES (?, 'User Access', ?, ?, ?, ?, ?, 'Pending')`,
          [
            generateId("apr"),
            `New Login Request — ${name} (${cleanUserId})`,
            `Requested role: ${requestedRole}. Cannot log in until approved by Admin.`,
            requestedRole,
            name,
            cleanUserId,
          ]
        );
      }

      await recordActivity(conn, {
        userLabel: cleanUserId,
        module: "User",
        action: `New login requested (${cleanUserId})`,
        detail: `${name} (${requestedRole}) — ${needsApproval ? "Awaiting Admin approval" : "Auto-approved"}`,
        category: "Approvals",
        alertTitle: `New Login Approval Needed — ${name}`,
        alertDetail: `User ID "${cleanUserId}" requested ${requestedRole} access.`,
        href: "/approvals",
        forceAudience: "admin",
      });
    });

    return res.status(202).json({
      success: true,
      approvalStatus: needsApproval ? "Pending" : "Approved",
      message: needsApproval
        ? "Account request submitted. You can sign in once Admin approves it."
        : "Account created successfully.",
    });
  })
);

/**
 * Forgot password request: notifies Admin to review and reset the password.
 */
router.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const cleanUserId = typeof req.body?.userId === "string" ? req.body.userId.trim().toLowerCase() : "";
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!cleanUserId) {
      return res.status(400).json({ success: false, message: "User ID is required." });
    }

    const rows = await query("SELECT id, user_id, name, role FROM users WHERE LOWER(user_id) = ? LIMIT 1", [
      cleanUserId,
    ]);
    const user = rows[0];

    if (user) {
      await withTransaction(async (conn) => {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
           VALUES (?, 'Password Reset', ?, ?, ?, ?, ?, 'Pending')`,
          [
            generateId("apr"),
            `Password Reset Request — ${user.name}`,
            `User ID: ${user.user_id} (${user.role})${note ? ` · Note: ${note}` : ""}`,
            "Password Reset",
            user.name,
            user.user_id,
          ]
        );

        await recordActivity(conn, {
          userLabel: user.user_id,
          module: "User",
          action: `Password reset requested (${user.user_id})`,
          detail: `${user.name} requested an Admin password reset.`,
          category: "Approvals",
          alertTitle: `Password Reset Request — ${user.user_id}`,
          alertDetail: `Open Users Management to set a new password for ${user.name}.`,
          href: "/users",
          forceAudience: "admin",
        });
      });
    }

    return res.json({
      success: true,
      message: "If your User ID exists, Admin has been notified to reset your password.",
    });
  })
);

router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: "Current password and a new password (min 6 characters) are required.",
      });
    }

    const rows = await query("SELECT id, user_id, name, password_hash FROM users WHERE id = ? LIMIT 1", [
      req.user.id,
    ]);
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: "Current password is incorrect." });
    }

    const nextHash = await bcrypt.hash(newPassword, 10);
    await withTransaction(async (conn) => {
      await conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", [nextHash, user.id]);
      await recordActivity(conn, {
        userLabel: user.name,
        module: "User",
        action: `Changed own password (${user.user_id})`,
        detail: "Password updated via account settings.",
        category: "Approvals",
        href: "/audit-logs",
        forceAudience: "admin",
      });
    });

    return res.json({ success: true, message: "Password updated successfully." });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await query(
      "SELECT id, user_id, name, role, last_login, active, approval_status FROM users WHERE id = ? LIMIT 1",
      [req.user.id]
    );
    const user = rows[0];
    if (!user || !user.active || user.approval_status !== "Approved") {
      return res.status(401).json({ success: false, message: "Account not active or not approved" });
    }
    return res.json({ success: true, user: mapUser(user) });
  })
);

router.post("/logout", (req, res) => {
  res.json({ success: true, message: "Logged out" });
});

module.exports = router;
