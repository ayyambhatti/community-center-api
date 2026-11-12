const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query } = require("../config/db");
const env = require("../config/env");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { formatTimeLabel } = require("../utils/audit");
const { mapUser } = require("../utils/formatters");

const router = express.Router();

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
      "SELECT id, user_id, name, role, password_hash, last_login, active FROM users WHERE LOWER(user_id) = ? LIMIT 1",
      [trimmedUserId]
    );

    const user = rows[0];
    if (!user || !user.active) {
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

    const lastLogin = formatTimeLabel();
    await query("UPDATE users SET last_login = ? WHERE id = ?", [lastLogin, user.id]);

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

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await query(
      "SELECT id, user_id, name, role, last_login, active FROM users WHERE id = ? LIMIT 1",
      [req.user.id]
    );
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ success: false, message: "Account not active" });
    }
    return res.json({ success: true, user: mapUser(user) });
  })
);

router.post("/logout", (req, res) => {
  res.json({ success: true, message: "Logged out" });
});

module.exports = router;

