const crypto = require("crypto");
const { query } = require("../config/db");

function generateId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function formatTimeLabel(date = new Date()) {
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

async function getSystemSettings(conn = null) {
  const executor = conn || { execute: (sql, params) => query(sql, params).then((rows) => [rows]) };
  const [rows] = await executor.execute("SELECT * FROM system_settings WHERE id = 1 LIMIT 1");
  return rows[0] || {
    centre_name: "Haji Mohamed Yunus Valibhoy Community Centre",
    centre_location: "Dhari, Gujarat, India",
    centre_phone: "",
    geofence_latitude: 21.3250054,
    geofence_longitude: 71.0246248,
    geofence_radius_meters: 200,
    require_gps_for_check_in: 1,
    route_all_alerts_to_admin: 1,
    base_rent_per_floor: 5000,
    ac_surcharge_per_floor: 2000,
    default_security_deposit: 15000,
    max_upload_size_mb: 5,
    require_free_use_admin_approval: 1,
    require_booking_admin_approval: 1,
    require_user_admin_approval: 1,
    require_expense_admin_approval: 1,
    require_refund_admin_approval: 1,
    require_repair_admin_approval: 1,
    require_payment_admin_approval: 1,
    require_customer_edit_admin_approval: 1,
    require_attendance_override_admin_approval: 1,
  };
}

/**
 * Records both an Admin/global notification and an audit log entry inside the current request/transaction.
 */
async function recordActivity(conn, {
  userLabel,
  module,
  action,
  detail,
  category = "Bookings",
  alertTitle,
  alertDetail,
  href = "/dashboard",
  forceAudience,
}) {
  const executor = conn || { execute: (sql, params) => query(sql, params).then((rows) => [rows]) };
  const settings = await getSystemSettings(conn);
  const audience = forceAudience || (settings.route_all_alerts_to_admin ? "admin" : "all");
  const timeLabel = formatTimeLabel();

  await executor.execute(
    `INSERT INTO audit_logs (id, time_label, user_label, module, action, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [generateId("log"), timeLabel, userLabel || "System", module, action, detail]
  );

  if (alertTitle) {
    await executor.execute(
      `INSERT INTO notifications (id, category, title, detail, time_label, unread, href, audience)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [generateId("not"), category, alertTitle, alertDetail || detail, "Just now", href, audience]
    );
  }
}

module.exports = {
  generateId,
  formatTimeLabel,
  getSystemSettings,
  recordActivity,
};
