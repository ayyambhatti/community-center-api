const express = require("express");
const bcrypt = require("bcryptjs");
const { query, withTransaction } = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { generateId, getSystemSettings, recordActivity } = require("../utils/audit");
const { mapApproval, mapNotification, mapSystemSettings, mapUser } = require("../utils/formatters");

const router = express.Router();
router.use(["/notifications", "/action-items", "/approvals", "/users", "/settings"], requireAuth);

// --- Notifications & Action Items (authenticated users; audience filtered) ---

router.patch(
  "/notifications/read-all",
  asyncHandler(async (req, res) => {
    const isAdmin = (req.user?.role || "").toLowerCase() === "admin";
    if (isAdmin) {
      await query("UPDATE notifications SET unread = 0");
    } else {
      await query("UPDATE notifications SET unread = 0 WHERE audience = 'all'");
    }
    res.json({ success: true });
  })
);

router.patch(
  "/notifications/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const unread = req.body?.unread !== undefined ? (req.body.unread ? 1 : 0) : 0;
    await query("UPDATE notifications SET unread = ? WHERE id = ?", [unread, id]);
    const rows = await query("SELECT * FROM notifications WHERE id = ? LIMIT 1", [id]);
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    res.json({ success: true, notification: mapNotification(rows[0]) });
  })
);

router.patch(
  "/action-items/:id/complete",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const completed = req.body?.completed === false ? 0 : 1;
    await query("UPDATE action_items SET completed = ? WHERE id = ?", [completed, id]);
    res.json({ success: true });
  })
);

// --- Admin-only Approvals, Users, and System Settings ---

router.patch(
  "/approvals/:id",
  requireRole("Admin"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!["Approved", "Rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be Approved or Rejected." });
    }

    const updated = await withTransaction(async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM approvals WHERE id = ? LIMIT 1", [id]);
      const current = rows[0];
      if (!current) {
        const err = new Error("Approval item not found");
        err.statusCode = 404;
        throw err;
      }

      await conn.execute(
        "UPDATE approvals SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ?",
        [status, req.user.name || req.user.userId, id]
      );

      // Cascade approval decision back to Free Hall Use bookings or Expenses when relevant
      if (current.type === "Free Hall Use") {
        const nextBookingStatus = status === "Approved" ? "Confirmed" : "Cancelled";
        await conn.execute("UPDATE bookings SET status = ? WHERE receipt_no = ?", [
          nextBookingStatus,
          current.reference_no,
        ]);
      } else if (current.type === "Expense" && status === "Approved") {
        await conn.execute("UPDATE expenses SET status = 'Approved' WHERE UPPER(id) = ?", [
          String(current.reference_no || "").toUpperCase(),
        ]);
      }

      await recordActivity(conn, {
        userLabel: req.user.name || "Admin",
        module: "Approval",
        action: `${status} ${current.type}`,
        detail: `${current.title} (${current.amount_label})`,
        category: "Approvals",
        alertTitle: `${current.type} ${status}`,
        alertDetail: `${current.title} · ${current.amount_label}`,
        href: "/approvals",
      });

      const [after] = await conn.execute("SELECT * FROM approvals WHERE id = ? LIMIT 1", [id]);
      return mapApproval(after[0]);
    });

    res.json({ success: true, approval: updated });
  })
);

router.get(
  "/users",
  requireRole("Admin"),
  asyncHandler(async (req, res) => {
    const rows = await query(
      "SELECT id, user_id, name, role, last_login, active FROM users ORDER BY created_at ASC"
    );
    res.json({ success: true, users: rows.map(mapUser) });
  })
);

router.post(
  "/users",
  requireRole("Admin"),
  asyncHandler(async (req, res) => {
    const { userId, name, role = "Staff", password } = req.body || {};
    const cleanUserId = (userId || "").trim().toLowerCase();
    if (!cleanUserId || !name || !password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "userId, name, and password (min 6 chars) are required.",
      });
    }

    const id = generateId("u");
    const passwordHash = await bcrypt.hash(password, 10);

    await withTransaction(async (conn) => {
      await conn.execute(
        `INSERT INTO users (id, user_id, name, role, password_hash, last_login, active)
         VALUES (?, ?, ?, ?, ?, 'Never', 1)`,
        [id, cleanUserId, name.trim(), role, passwordHash]
      );

      await recordActivity(conn, {
        userLabel: req.user.name || "Admin",
        module: "User",
        action: `Added user "${cleanUserId}"`,
        detail: `${name.trim()} (${role})`,
        category: "Approvals",
        href: "/users",
      });
    });

    const rows = await query(
      "SELECT id, user_id, name, role, last_login, active FROM users WHERE id = ? LIMIT 1",
      [id]
    );
    res.status(201).json({ success: true, user: mapUser(rows[0]) });
  })
);

router.patch(
  "/users/:id",
  requireRole("Admin"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, role, active, password } = req.body || {};

    const updated = await withTransaction(async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
      const current = rows[0];
      if (!current) {
        const err = new Error("User not found");
        err.statusCode = 404;
        throw err;
      }

      if (password && password.length < 6) {
        const err = new Error("Password must be at least 6 characters.");
        err.statusCode = 400;
        throw err;
      }

      const nextHash = password ? await bcrypt.hash(password, 10) : current.password_hash;
      const nextActive = active !== undefined ? (active ? 1 : 0) : current.active;

      await conn.execute(
        "UPDATE users SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?",
        [name ?? current.name, role ?? current.role, nextActive, nextHash, id]
      );

      await recordActivity(conn, {
        userLabel: req.user.name || "Admin",
        module: "User",
        action: `Updated user "${current.user_id}"`,
        detail: `${name ?? current.name} (${role ?? current.role}) · ${nextActive ? "Active" : "Disabled"}${password ? " · Password updated" : ""}`,
        category: "Approvals",
        href: "/users",
      });

      const [after] = await conn.execute(
        "SELECT id, user_id, name, role, last_login, active FROM users WHERE id = ? LIMIT 1",
        [id]
      );
      return mapUser(after[0]);
    });

    res.json({ success: true, user: updated });
  })
);

router.delete(
  "/users/:id",
  requireRole("Admin"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ success: false, message: "You cannot delete your own active account." });
    }

    await withTransaction(async (conn) => {
      const [rows] = await conn.execute("SELECT user_id, name FROM users WHERE id = ? LIMIT 1", [id]);
      const target = rows[0];
      if (!target) {
        const err = new Error("User not found");
        err.statusCode = 404;
        throw err;
      }

      await conn.execute("DELETE FROM users WHERE id = ?", [id]);
      await recordActivity(conn, {
        userLabel: req.user.name || "Admin",
        module: "User",
        action: `Removed user "${target.user_id}"`,
        detail: target.name,
        category: "Approvals",
        href: "/users",
      });
    });

    res.json({ success: true });
  })
);

router.get(
  "/settings",
  requireRole("Admin"),
  asyncHandler(async (req, res) => {
    const row = await getSystemSettings();
    res.json({ success: true, settings: mapSystemSettings(row) });
  })
);

router.put(
  "/settings",
  requireRole("Admin"),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const updated = await withTransaction(async (conn) => {
      const current = await getSystemSettings(conn);
      await conn.execute(
        `UPDATE system_settings SET
          centre_name = ?,
          centre_location = ?,
          geofence_latitude = ?,
          geofence_longitude = ?,
          geofence_radius_meters = ?,
          require_gps_for_check_in = ?,
          route_all_alerts_to_admin = ?,
          base_rent_per_floor = ?,
          ac_surcharge_per_floor = ?,
          default_security_deposit = ?,
          require_free_use_admin_approval = ?
         WHERE id = 1`,
        [
          body.centreName ?? current.centre_name,
          body.centreLocation ?? current.centre_location,
          Number(body.geofenceLatitude ?? current.geofence_latitude),
          Number(body.geofenceLongitude ?? current.geofence_longitude),
          Number(body.geofenceRadiusMeters ?? current.geofence_radius_meters),
          body.requireGpsForCheckIn !== undefined ? (body.requireGpsForCheckIn ? 1 : 0) : current.require_gps_for_check_in,
          body.routeAllAlertsToAdmin !== undefined ? (body.routeAllAlertsToAdmin ? 1 : 0) : current.route_all_alerts_to_admin,
          Number(body.baseRentPerFloor ?? current.base_rent_per_floor),
          Number(body.acSurchargePerFloor ?? current.ac_surcharge_per_floor),
          Number(body.defaultSecurityDeposit ?? current.default_security_deposit),
          body.requireFreeUseAdminApproval !== undefined ? (body.requireFreeUseAdminApproval ? 1 : 0) : current.require_free_use_admin_approval,
        ]
      );

      await recordActivity(conn, {
        userLabel: req.user.name || "Admin",
        module: "Settings",
        action: "Updated system settings",
        detail: `Geofence ${Number(body.geofenceRadiusMeters ?? current.geofence_radius_meters)}m · Rent ₹${Number(body.baseRentPerFloor ?? current.base_rent_per_floor)}/floor`,
        category: "Approvals",
        href: "/settings",
      });

      const after = await getSystemSettings(conn);
      return mapSystemSettings(after);
    });

    res.json({ success: true, settings: updated });
  })
);

module.exports = router;
