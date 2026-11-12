const express = require("express");
const { query, withTransaction } = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { calculateDistanceMeters, isWithinGeofence } = require("../utils/geofence");
const { generateId, getSystemSettings, recordActivity } = require("../utils/audit");
const { mapStaffAttendanceLog } = require("../utils/formatters");

const router = express.Router();
router.use(requireAuth);

router.get(
  "/logs",
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM staff_attendance_logs ORDER BY created_at DESC LIMIT 200");
    res.json({ success: true, logs: rows.map(mapStaffAttendanceLog) });
  })
);

router.post(
  "/check-in",
  asyncHandler(async (req, res) => {
    const { latitude, longitude, dateISO } = req.body || {};
    const settings = await getSystemSettings();

    const lat = Number(latitude);
    const lon = Number(longitude);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

    if (settings.require_gps_for_check_in && !hasCoords) {
      return res.status(400).json({
        success: false,
        message: "Live GPS coordinates are required for attendance check-in.",
      });
    }

    let distanceMeters = null;
    let withinFence = !settings.require_gps_for_check_in;

    if (hasCoords) {
      distanceMeters = calculateDistanceMeters(
        lat,
        lon,
        Number(settings.geofence_latitude),
        Number(settings.geofence_longitude)
      );
      withinFence = isWithinGeofence(distanceMeters, Number(settings.geofence_radius_meters));

      if (settings.require_gps_for_check_in && !withinFence) {
        return res.status(403).json({
          success: false,
          message: `You are ${distanceMeters}m away from the community centre (allowed radius: ${settings.geofence_radius_meters}m).`,
          distanceMeters,
          radiusMeters: Number(settings.geofence_radius_meters),
        });
      }
    }

    const todayISO = dateISO || new Date().toISOString().slice(0, 10);
    const timeLabel = new Date().toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const log = await withTransaction(async (conn) => {
      const id = generateId("attlog");
      await conn.execute(
        `INSERT INTO staff_attendance_logs (
          id, staff_id, user_id, date_iso, name, role_title,
          check_in_time, check_out_time, geo_verified, distance_meters, latitude, longitude, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '—', ?, ?, ?, ?, 'Present')`,
        [
          id,
          req.user.id,
          req.user.userId,
          todayISO,
          req.user.name,
          req.user.role,
          timeLabel,
          withinFence ? 1 : 0,
          distanceMeters,
          hasCoords ? lat : null,
          hasCoords ? lon : null,
        ]
      );

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.userId,
        module: "Attendance",
        action: "Staff check-in recorded",
        detail: `${req.user.name} checked in at ${timeLabel}${distanceMeters !== null ? ` (${distanceMeters}m from centre)` : ""}`,
        category: "Attendance",
        alertTitle: `${req.user.name} Checked In`,
        alertDetail: `Time: ${timeLabel}${distanceMeters !== null ? ` · GPS verified (${distanceMeters}m)` : ""}`,
        href: "/attendance",
      });

      const [rows] = await conn.execute("SELECT * FROM staff_attendance_logs WHERE id = ? LIMIT 1", [id]);
      return mapStaffAttendanceLog(rows[0]);
    });

    res.status(201).json({ success: true, log });
  })
);

router.post(
  "/check-out",
  asyncHandler(async (req, res) => {
    const { logId } = req.body || {};
    const timeLabel = new Date().toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const updated = await withTransaction(async (conn) => {
      let targetRow = null;
      if (logId) {
        const [rows] = await conn.execute("SELECT * FROM staff_attendance_logs WHERE id = ? LIMIT 1", [logId]);
        targetRow = rows[0];
      } else {
        const [rows] = await conn.execute(
          "SELECT * FROM staff_attendance_logs WHERE staff_id = ? AND check_out_time = '—' ORDER BY created_at DESC LIMIT 1",
          [req.user.id]
        );
        targetRow = rows[0];
      }

      if (!targetRow) {
        const err = new Error("No open check-in record found to check out.");
        err.statusCode = 404;
        throw err;
      }

      await conn.execute("UPDATE staff_attendance_logs SET check_out_time = ? WHERE id = ?", [
        timeLabel,
        targetRow.id,
      ]);

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.userId,
        module: "Attendance",
        action: "Staff check-out recorded",
        detail: `${targetRow.name} checked out at ${timeLabel}`,
        category: "Attendance",
        alertTitle: `${targetRow.name} Checked Out`,
        alertDetail: `Check-out at ${timeLabel}`,
        href: "/attendance",
      });

      const [after] = await conn.execute("SELECT * FROM staff_attendance_logs WHERE id = ? LIMIT 1", [targetRow.id]);
      return mapStaffAttendanceLog(after[0]);
    });

    res.json({ success: true, log: updated });
  })
);

module.exports = router;

