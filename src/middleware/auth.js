const jwt = require("jsonwebtoken");
const env = require("../config/env");

/**
 * Extracts Bearer token from Authorization header.
 */
function extractToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

/**
 * Verifies JWT signature and attaches req.user = { id, userId, name, role }.
 */
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  try {
    const payload = jwt.verify(token, env.jwt.secret);
    req.user = {
      id: payload.sub,
      userId: payload.userId,
      name: payload.name,
      role: payload.role,
    };
    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired session token" });
  }
}

/**
 * Case-insensitive role guard (e.g., requireRole("Admin") or requireRole("Admin", "Manager")).
 */
function requireRole(...allowedRoles) {
  const allowedSet = new Set(allowedRoles.map((r) => r.toLowerCase()));
  return (req, res, next) => {
    const role = (req.user?.role || "").toLowerCase();
    if (!allowedSet.has(role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action",
      });
    }
    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
};

