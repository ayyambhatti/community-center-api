const express = require("express");
const bcrypt = require("bcryptjs");
const { query, withTransaction } = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { generateId, getSystemSettings, recordActivity } = require("../utils/audit");
const { mapApproval, mapNotification, mapRolePermission, mapSystemSettings, mapUser } = require("../utils/formatters");

const router = express.Router();
router.use(
  ["/notifications", "/action-items", "/approvals", "/users", "/settings", "/permissions"],
  requireAuth
);

// --- Notifications & Action Items ---

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

// --- Permissions (all logged-in users can read matrix; only Admin can edit) ---

router.get(
  "/permissions",
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM role_permissions ORDER BY role ASC, module ASC");
    res.json({ success: true, permissions: rows.map(mapRolePermission) });
  })
);

router.put(
  "/permissions",
  requireRole("Admin"),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    if (items.length === 0) {
      return res.status(400).json({ success: false, message: "permissions array is required." });
    }

    await withTransaction(async (conn) => {
      for (const item of items) {
        if (!item.role || !item.module) continue;
        // Safety lock: Admin retains full control & non-Admin roles cannot self-grant approvals unless explicit
        const isAdminRow = item.role === "Admin";
        await conn.execute(
          `INSERT INTO role_permissions (id, role, module, can_view, can_create, can_edit, can_approve)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             can_view = VALUES(can_view),
             can_create = VALUES(can_create),
             can_edit = VALUES(can_edit),
             can_approve = VALUES(can_approve)`,
          [
            item.id || generateId("rp"),
            item.role,
            item.module,
            isAdminRow || item.canView ? 1 : 0,
            isAdminRow || item.canCreate ? 1 : 0,
            isAdminRow || item.canEdit ? 1 : 0,
            isAdminRow ? 1 : item.canApprove ? 1 : 0,
          ]
        );
      }

      await recordActivity(conn, {
        userLabel: req.user.name || "Admin",
        module: "Settings",
        action: "Updated role permissions matrix",
        detail: `Updated ${items.length} permission rule(s).`,
        category: "Approvals",
        href: "/users",
        forceAudience: "admin",
      });
    });

    const rows = await query("SELECT * FROM role_permissions ORDER BY role ASC, module ASC");
    res.json({ success: true, permissions: rows.map(mapRolePermission) });
  })
);

// --- Admin-Only Central Approval Queue ---

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

      // Cascade Admin approval decision to target record
      if (current.type === "Booking" || current.type === "Free Hall Use") {
        const nextBookingStatus = status === "Approved" ? "Confirmed" : "Cancelled";
        await conn.execute("UPDATE bookings SET status = ? WHERE receipt_no = ?", [
          nextBookingStatus,
          current.reference_no,
        ]);
      } else if (current.type === "Booking Cancellation") {
        if (status === "Approved") {
          await conn.execute("UPDATE bookings SET status = 'Cancelled' WHERE receipt_no = ?", [
            current.reference_no,
          ]);
        }
      } else if (current.type === "User Access") {
        await conn.execute(
          `UPDATE users
           SET approval_status = ?, active = ?, approved_by = ?, approved_at = NOW()
           WHERE LOWER(user_id) = LOWER(?)`,
          [status, status === "Approved" ? 1 : 0, req.user.userId, current.reference_no]
        );
      } else if (current.type === "Expense" && status === "Approved") {
        await conn.execute("UPDATE expenses SET status = 'Approved' WHERE UPPER(id) = ?", [
          String(current.reference_no || "").toUpperCase(),
        ]);
      } else if (current.type === "Deposit Refund") {
        const nextRefundStatus = status === "Approved" ? "Refunded" : "Ready to Refund";
        await conn.execute("UPDATE deposit_refunds SET status = ? WHERE booking_receipt_no = ?", [
          nextRefundStatus,
          current.reference_no,
        ]);
      } else if (current.type === "Repair Cost" || current.type === "Hall Block") {
        const nextTicketStatus = status === "Approved" ? "Approved" : "Pending";
        await conn.execute("UPDATE maintenance_tickets SET status = ? WHERE ticket_no = ?", [
          nextTicketStatus,
          current.reference_no,
        ]);
      } else if (current.type === "Record Payment") {
        const meta = current.metadata_json
          ? typeof current.metadata_json === "string"
            ? JSON.parse(current.metadata_json)
            : current.metadata_json
          : null;
        if (meta?.paymentId) {
          await conn.execute("UPDATE payments SET status = ? WHERE id = ?", [status, meta.paymentId]);
          if (status === "Approved" && meta.bookingId && meta.amount) {
            await conn.execute("UPDATE bookings SET paid = paid + ? WHERE id = ?", [
              Number(meta.amount),
              meta.bookingId,
            ]);
          }
        }
      } else if (current.type === "Customer Edit" && status === "Approved") {
        const meta = current.metadata_json
          ? typeof current.metadata_json === "string"
            ? JSON.parse(current.metadata_json)
            : current.metadata_json
          : null;
        if (meta?.applicantId && meta?.updates) {
          const u = meta.updates;
          await conn.execute(
            `UPDATE applicants
             SET name = COALESCE(?, name),
                 phone = COALESCE(?, phone),
                 address = COALESCE(?, address),
                 id_proof_masked = COALESCE(?, id_proof_masked),
                 notes = COALESCE(?, notes),
                 preferences_json = COALESCE(?, preferences_json)
             WHERE id = ?`,
            [
              u.name ?? null,
              u.phone ?? null,
              u.address ?? null,
              u.idProofMasked ?? null,
              u.notes ?? null,
              u.preferences ? JSON.stringify(u.preferences) : null,
              meta.applicantId,
            ]
          );
        }
      } else if (current.type === "Attendance Override") {
        const meta = current.metadata_json
          ? typeof current.metadata_json === "string"
            ? JSON.parse(current.metadata_json)
            : current.metadata_json
          : null;
        if (meta?.logId) {
          await conn.execute(
            "UPDATE staff_attendance_logs SET approval_status = ?, geo_verified = ? WHERE id = ?",
            [status, status === "Approved" ? 1 : 0, meta.logId]
          );
        }
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

// --- Admin-Only Users CRUD & Login Access Approvals ---

router.get(
  "/users",
  requireRole("Admin"),
  asyncHandler(async (req, res) => {
    const rows = await query(
      "SELECT id, user_id, name, role, last_login, active, approval_status, approved_by FROM users ORDER BY created_at ASC"
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
        `INSERT INTO users (id, user_id, name, role, password_hash, last_login, active, approval_status, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, 'Never', 1, 'Approved', ?, NOW())`,
        [id, cleanUserId, name.trim(), role, passwordHash, req.user.userId]
      );

      await recordActivity(conn, {
        userLabel: req.user.name || "Admin",
        module: "User",
        action: `Added user "${cleanUserId}"`,
        detail: `${name.trim()} (${role}) — Approved by Admin`,
        category: "Approvals",
        href: "/users",
      });
    });

    const rows = await query(
      "SELECT id, user_id, name, role, last_login, active, approval_status, approved_by FROM users WHERE id = ? LIMIT 1",
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
    const { name, role, active, password, approvalStatus } = req.body || {};

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
      const nextApproval = approvalStatus || current.approval_status;
      const nextActive =
        active !== undefined
          ? active
            ? 1
            : 0
          : nextApproval === "Approved" && current.approval_status !== "Approved"
            ? 1
            : current.active;

      await conn.execute(
        `UPDATE users
         SET name = ?, role = ?, active = ?, password_hash = ?, approval_status = ?,
             approved_by = COALESCE(approved_by, ?)
         WHERE id = ?`,
        [name ?? current.name, role ?? current.role, nextActive, nextHash, nextApproval, req.user.userId, id]
      );

      await recordActivity(conn, {
        userLabel: req.user.name || "Admin",
        module: "User",
        action: `Updated user "${current.user_id}"`,
        detail: `${name ?? current.name} (${role ?? current.role}) · ${nextActive ? "Active" : "Disabled"} · ${nextApproval}${password ? " · Password updated" : ""}`,
        category: "Approvals",
        href: "/users",
      });

      const [after] = await conn.execute(
        "SELECT id, user_id, name, role, last_login, active, approval_status, approved_by FROM users WHERE id = ? LIMIT 1",
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

// --- Admin-Only System Settings ---

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
      const boolVal = (val, fallback) => (val !== undefined ? (val ? 1 : 0) : fallback);

      await conn.execute(
        `UPDATE system_settings SET
          centre_name = ?,
          centre_location = ?,
          centre_phone = ?,
          geofence_latitude = ?,
          geofence_longitude = ?,
          geofence_radius_meters = ?,
          require_gps_for_check_in = ?,
          route_all_alerts_to_admin = ?,
          base_rent_per_floor = ?,
          ac_surcharge_per_floor = ?,
          default_security_deposit = ?,
          max_upload_size_mb = ?,
          require_free_use_admin_approval = ?,
          require_booking_admin_approval = ?,
          require_user_admin_approval = ?,
          require_expense_admin_approval = ?,
          require_refund_admin_approval = ?,
          require_repair_admin_approval = ?,
          require_payment_admin_approval = ?,
          require_customer_edit_admin_approval = ?,
          require_attendance_override_admin_approval = ?
         WHERE id = 1`,
        [
          body.centreName ?? current.centre_name,
          body.centreLocation ?? current.centre_location,
          body.centrePhone ?? current.centre_phone ?? "",
          Number(body.geofenceLatitude ?? current.geofence_latitude),
          Number(body.geofenceLongitude ?? current.geofence_longitude),
          Number(body.geofenceRadiusMeters ?? current.geofence_radius_meters),
          boolVal(body.requireGpsForCheckIn, current.require_gps_for_check_in),
          boolVal(body.routeAllAlertsToAdmin, current.route_all_alerts_to_admin),
          Number(body.baseRentPerFloor ?? current.base_rent_per_floor),
          Number(body.acSurchargePerFloor ?? current.ac_surcharge_per_floor),
          Number(body.defaultSecurityDeposit ?? current.default_security_deposit),
          Number(body.maxUploadSizeMb ?? current.max_upload_size_mb ?? 5),
          boolVal(body.requireFreeUseAdminApproval, current.require_free_use_admin_approval),
          boolVal(body.requireBookingAdminApproval, current.require_booking_admin_approval ?? 1),
          boolVal(body.requireUserAdminApproval, current.require_user_admin_approval ?? 1),
          boolVal(body.requireExpenseAdminApproval, current.require_expense_admin_approval ?? 1),
          boolVal(body.requireRefundAdminApproval, current.require_refund_admin_approval ?? 1),
          boolVal(body.requireRepairAdminApproval, current.require_repair_admin_approval ?? 1),
          boolVal(body.requirePaymentAdminApproval, current.require_payment_admin_approval ?? 1),
          boolVal(body.requireCustomerEditAdminApproval, current.require_customer_edit_admin_approval ?? 1),
          boolVal(body.requireAttendanceOverrideAdminApproval, current.require_attendance_override_admin_approval ?? 1),
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
