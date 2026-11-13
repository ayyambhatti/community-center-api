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
    const { latitude, longitude, dateISO, overrideReason } = req.body || {};
    const settings = await getSystemSettings();
    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";

    const lat = Number(latitude);
    const lon = Number(longitude);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

    if (settings.require_gps_for_check_in && !hasCoords && !overrideReason) {
      return res.status(400).json({
        success: false,
        message: "Live GPS coordinates are required for attendance check-in.",
      });
    }

    let distanceMeters = null;
    let withinFence = !settings.require_gps_for_check_in;
    let needsOverrideApproval = false;

    if (hasCoords) {
      distanceMeters = calculateDistanceMeters(
        lat,
        lon,
        Number(settings.geofence_latitude),
        Number(settings.geofence_longitude)
      );
      withinFence = isWithinGeofence(distanceMeters, Number(settings.geofence_radius_meters));

      if (settings.require_gps_for_check_in && !withinFence && !isAdminActor) {
        if (overrideReason && Boolean(settings.require_attendance_override_admin_approval ?? 1)) {
          needsOverrideApproval = true;
        } else {
          return res.status(403).json({
            success: false,
            canRequestOverride: Boolean(settings.require_attendance_override_admin_approval ?? 1),
            message: `You are ${distanceMeters}m away from the community centre (allowed radius: ${settings.geofence_radius_meters}m). Provide an override reason to submit for Admin approval.`,
            distanceMeters,
            radiusMeters: Number(settings.geofence_radius_meters),
          });
        }
      }
    } else if (settings.require_gps_for_check_in && overrideReason && !isAdminActor) {
      needsOverrideApproval = true;
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
          check_in_time, check_out_time, geo_verified, distance_meters, latitude, longitude,
          status, approval_status, override_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '—', ?, ?, ?, ?, 'Present', ?, ?)`,
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
          needsOverrideApproval ? "Pending" : "Approved",
          overrideReason ? String(overrideReason).trim() : null,
        ]
      );

      // Update live staff_attendance register for today
      const [existingStaff] = await conn.execute(
        "SELECT id FROM staff_attendance WHERE name = ? OR id = ? LIMIT 1",
        [req.user.name, req.user.id]
      );
      if (existingStaff.length > 0) {
        await conn.execute(
          `UPDATE staff_attendance
           SET check_in_time = ?, check_out_time = '—', geo_verified = ?, status = 'Present', present_days = present_days + 1
           WHERE id = ?`,
          [timeLabel, withinFence ? 1 : 0, existingStaff[0].id]
        );
      } else {
        await conn.execute(
          `INSERT INTO staff_attendance (id, name, role_title, check_in_time, check_out_time, geo_verified, status, present_days)
           VALUES (?, ?, ?, ?, '—', ?, 'Present', 1)`,
          [req.user.id, req.user.name, req.user.role, timeLabel, withinFence ? 1 : 0]
        );
      }

      if (needsOverrideApproval) {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status, metadata_json)
           VALUES (?, 'Attendance Override', ?, ?, ?, ?, ?, 'Pending', ?)`,
          [
            generateId("apr"),
            `Attendance Override — ${req.user.name}`,
            `${distanceMeters !== null ? `${distanceMeters}m from centre` : "GPS unavailable"} · Reason: ${String(overrideReason).trim()}`,
            distanceMeters !== null ? `${distanceMeters}m` : "Off-site",
            req.user.name || req.user.userId,
            todayISO,
            JSON.stringify({ logId: id, distanceMeters, overrideReason }),
          ]
        );
      }

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.userId,
        module: "Attendance",
        action: needsOverrideApproval
          ? "Requested out-of-geofence attendance override"
          : "Staff check-in recorded",
        detail: `${req.user.name} checked in at ${timeLabel}${distanceMeters !== null ? ` (${distanceMeters}m from centre)` : ""}${overrideReason ? ` · Override: ${overrideReason}` : ""}`,
        category: needsOverrideApproval ? "Approvals" : "Attendance",
        alertTitle: needsOverrideApproval
          ? `Attendance Override Approval Needed — ${req.user.name}`
          : `${req.user.name} Checked In`,
        alertDetail: `Time: ${timeLabel}${distanceMeters !== null ? ` · ${distanceMeters}m from centre` : ""}`,
        href: needsOverrideApproval ? "/approvals" : "/attendance",
      });

      const [rows] = await conn.execute("SELECT * FROM staff_attendance_logs WHERE id = ? LIMIT 1", [id]);
      return mapStaffAttendanceLog(rows[0]);
    });

    res.status(needsOverrideApproval ? 202 : 201).json({
      success: true,
      pendingApproval: needsOverrideApproval,
      log,
    });
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

      await conn.execute(
        "UPDATE staff_attendance SET check_out_time = ? WHERE name = ? OR id = ?",
        [timeLabel, targetRow.name, targetRow.staff_id]
      );

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

