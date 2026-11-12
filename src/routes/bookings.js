const express = require("express");
const { query, withTransaction } = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { generateId, getSystemSettings, recordActivity } = require("../utils/audit");
const { mapApplicant, mapBooking } = require("../utils/formatters");

const router = express.Router();
router.use(["/bookings", "/applicants"], requireAuth);

function hallsConflict(hallA, hallB) {
  const a = (hallA || "").toLowerCase();
  const b = (hallB || "").toLowerCase();
  if (a === b) return true;
  return (
    (a.includes("ground") && b.includes("ground")) ||
    (a.includes("first floor") && b.includes("first floor"))
  );
}

function datesOverlap(startA, endA, startB, endB) {
  const finalEndA = endA || startA;
  const finalEndB = endB || startB;
  return startA <= finalEndB && startB <= finalEndA;
}

router.get(
  "/bookings",
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM bookings ORDER BY date_iso ASC, created_at DESC");
    res.json({ success: true, bookings: rows.map(mapBooking) });
  })
);

router.post(
  "/bookings",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const {
      eventTitle,
      eventType = "Wedding",
      applicantId,
      applicantName,
      phone,
      hall = "Ground Floor",
      isAC = false,
      dateISO,
      endDateISO,
      dateLabel,
      timing,
      guests = 0,
      rent = 0,
      deposit = 0,
      paid = 0,
      isFreeUse = false,
      notes = "",
      paymentMode = "Cash",
    } = body;

    if (!eventTitle || !applicantName || !phone || !dateISO || !timing) {
      return res.status(400).json({
        success: false,
        message: "Event title, applicant name, phone, date, and timing are required.",
      });
    }

    const totalCharges = Number(rent) + Number(deposit);
    if (Number(paid) < 0 || (!isFreeUse && Number(paid) > totalCharges)) {
      return res.status(400).json({
        success: false,
        message: "Advance paid cannot exceed total hall charges + security deposit.",
      });
    }

    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";

    const created = await withTransaction(async (conn) => {
      const settings = await getSystemSettings(conn);
      const [existing] = await conn.execute(
        "SELECT id, receipt_no, hall, date_iso, end_date_iso, status FROM bookings WHERE status <> 'Cancelled'"
      );

      const conflict = existing.find(
        (b) =>
          datesOverlap(dateISO, endDateISO, b.date_iso, b.end_date_iso) &&
          hallsConflict(hall, b.hall)
      );
      if (conflict) {
        const err = new Error(
          `Hall "${hall}" is already booked for this date (Receipt #${conflict.receipt_no}).`
        );
        err.statusCode = 409;
        throw err;
      }

      const [countRows] = await conn.execute("SELECT COUNT(*) AS cnt FROM bookings");
      const nextReceiptNo = body.receiptNo || String(1060 + Number(countRows[0].cnt || 0));
      const bookingId = generateId("bk");

      // Every non-Admin new booking (or Free Use booking) goes to Admin approval when enabled
      const needsApproval =
        !isAdminActor &&
        (Boolean(settings.require_booking_admin_approval ?? 1) ||
          Boolean(isFreeUse && settings.require_free_use_admin_approval));

      const initialStatus = needsApproval ? "Awaiting approval" : body.status || "Confirmed";
      const depositStatus = isFreeUse || Number(deposit) <= 0 ? "N/A" : "Held";

      await conn.execute(
        `INSERT INTO bookings (
          id, receipt_no, event_title, event_type, applicant_id, applicant_name, phone,
          hall, is_ac, date_iso, end_date_iso, date_label, timing, guests,
          rent, deposit, paid, status, is_free_use, notes, payment_mode,
          created_at_label, created_by, deposit_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          bookingId,
          nextReceiptNo,
          eventTitle,
          eventType,
          applicantId || null,
          applicantName,
          phone,
          hall,
          isAC ? 1 : 0,
          dateISO,
          endDateISO || null,
          dateLabel || dateISO,
          timing,
          Number(guests || 0),
          isFreeUse ? 0 : Number(rent),
          isFreeUse ? 0 : Number(deposit),
          isFreeUse ? 0 : Number(paid),
          initialStatus,
          isFreeUse ? 1 : 0,
          notes || null,
          paymentMode || null,
          body.createdAtLabel || "Just now",
          req.user.name || req.user.userId,
          depositStatus,
        ]
      );

      if (Number(paid) > 0 && !isFreeUse) {
        const payReceipt = `REC-${new Date().getFullYear()}-${nextReceiptNo}`;
        await conn.execute(
          `INSERT INTO payments (
            id, receipt_no, booking_id, booking_receipt_no, applicant_name,
            event_title, type, amount, mode, reference, date_label
          ) VALUES (?, ?, ?, ?, ?, ?, 'Advance', ?, ?, ?, ?)`,
          [
            generateId("pay"),
            payReceipt,
            bookingId,
            nextReceiptNo,
            applicantName,
            eventTitle,
            Number(paid),
            paymentMode || "Cash",
            "Booking Advance",
            dateLabel || dateISO,
          ]
        );
      }

      if (needsApproval) {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
          [
            generateId("apr"),
            isFreeUse ? "Free Hall Use" : "Booking",
            `${isFreeUse ? "Free Hall Request" : "New Booking"} — ${eventTitle}`,
            `${applicantName} (${hall}) on ${dateLabel || dateISO} · ${timing}`,
            isFreeUse ? "₹0 (Free Use)" : `₹${totalCharges.toLocaleString("en-IN")}`,
            req.user.name || req.user.userId,
            nextReceiptNo,
          ]
        );
      }

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Booking",
        action: `Created booking #${nextReceiptNo}`,
        detail: `${eventTitle} · ${applicantName} · ${hall} on ${dateLabel || dateISO}${needsApproval ? " (Awaiting Admin approval)" : ""}`,
        category: needsApproval ? "Approvals" : "Bookings",
        alertTitle: needsApproval
          ? `Booking Approval Needed — #${nextReceiptNo}`
          : `New Booking #${nextReceiptNo} — ${eventTitle}`,
        alertDetail: `${applicantName} · ${hall} (${dateLabel || dateISO})`,
        href: needsApproval ? "/approvals" : "/bookings",
      });

      const [rows] = await conn.execute("SELECT * FROM bookings WHERE id = ? LIMIT 1", [bookingId]);
      return mapBooking(rows[0]);
    });

    res.status(201).json({ success: true, booking: created });
  })
);

router.patch(
  "/bookings/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const patch = req.body || {};
    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";

    const updated = await withTransaction(async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM bookings WHERE id = ? LIMIT 1", [id]);
      const current = rows[0];
      if (!current) {
        const err = new Error("Booking not found");
        err.statusCode = 404;
        throw err;
      }

      if (patch.status === "Confirmed" && current.status === "Awaiting approval" && !isAdminActor) {
        const err = new Error("Only Admin can approve a pending booking.");
        err.statusCode = 403;
        throw err;
      }

      // Non-Admin cancellation requests go to Admin approval before cancelling
      if (patch.status === "Cancelled" && current.status !== "Awaiting approval" && !isAdminActor) {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
           VALUES (?, 'Booking Cancellation', ?, ?, ?, ?, ?, 'Pending')`,
          [
            generateId("apr"),
            `Cancel Booking #${current.receipt_no} — ${current.event_title}`,
            `${current.applicant_name}${patch.cancellationReason ? ` · Reason: ${patch.cancellationReason}` : ""}`,
            `₹${Number(current.rent || 0).toLocaleString("en-IN")}`,
            req.user.name || req.user.userId,
            current.receipt_no,
          ]
        );

        await recordActivity(conn, {
          userLabel: req.user.name || req.user.role,
          module: "Booking",
          action: `Requested cancellation for #${current.receipt_no}`,
          detail: patch.cancellationReason || "Awaiting Admin approval",
          category: "Approvals",
          alertTitle: `Cancellation Approval Needed — #${current.receipt_no}`,
          alertDetail: `${current.event_title} · ${current.applicant_name}`,
          href: "/approvals",
        });

        return { booking: mapBooking(current), pendingApproval: true };
      }

      const nextStatus = patch.status ?? current.status;
      const nextReason = patch.cancellationReason ?? current.cancellation_reason;
      const nextNotes = patch.notes ?? current.notes;
      const nextTiming = patch.timing ?? current.timing;

      await conn.execute(
        `UPDATE bookings
         SET status = ?, cancellation_reason = ?, notes = ?, timing = ?
         WHERE id = ?`,
        [nextStatus, nextReason || null, nextNotes || null, nextTiming, id]
      );

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Booking",
        action: `Updated booking #${current.receipt_no}`,
        detail: `Status: ${nextStatus}${nextReason ? ` (${nextReason})` : ""}`,
        category: "Bookings",
        alertTitle: `Booking #${current.receipt_no} Updated (${nextStatus})`,
        alertDetail: `${current.event_title} · ${current.applicant_name}`,
        href: `/bookings/${id}`,
      });

      const [after] = await conn.execute("SELECT * FROM bookings WHERE id = ? LIMIT 1", [id]);
      return { booking: mapBooking(after[0]), pendingApproval: false };
    });

    res.status(updated.pendingApproval ? 202 : 200).json({
      success: true,
      pendingApproval: updated.pendingApproval,
      booking: updated.booking,
    });
  })
);

router.get(
  "/applicants",
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM applicants ORDER BY name ASC");
    res.json({ success: true, applicants: rows.map(mapApplicant) });
  })
);

router.post(
  "/applicants",
  asyncHandler(async (req, res) => {
    const { name, phone, address = "", idProofMasked = "", notes = "", preferences = [] } = req.body || {};
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: "Name and phone are required." });
    }

    const id = generateId("app");
    const code = `CUST-${Math.floor(1000 + Math.random() * 9000)}`;
    await query(
      `INSERT INTO applicants (id, customer_code, name, phone, address, id_proof_masked, notes, member_since, preferences_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        code,
        name.trim(),
        phone.trim(),
        address,
        idProofMasked,
        notes,
        new Date().toLocaleDateString("en-IN", { month: "short", year: "numeric" }),
        JSON.stringify(Array.isArray(preferences) ? preferences : []),
      ]
    );

    const rows = await query("SELECT * FROM applicants WHERE id = ? LIMIT 1", [id]);
    res.status(201).json({ success: true, applicant: mapApplicant(rows[0]) });
  })
);

router.patch(
  "/applicants/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";

    const result = await withTransaction(async (conn) => {
      const settings = await getSystemSettings(conn);
      const [rows] = await conn.execute("SELECT * FROM applicants WHERE id = ? LIMIT 1", [id]);
      const existing = rows[0];
      if (!existing) {
        const err = new Error("Customer not found");
        err.statusCode = 404;
        throw err;
      }

      const needsApproval = !isAdminActor && Boolean(settings.require_customer_edit_admin_approval ?? 1);
      if (needsApproval) {
        const updates = {
          name: body.name ?? existing.name,
          phone: body.phone ?? existing.phone,
          address: body.address ?? existing.address,
          idProofMasked: body.idProofMasked ?? existing.id_proof_masked,
          notes: body.notes ?? existing.notes,
          preferences: body.preferences ?? undefined,
        };

        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status, metadata_json)
           VALUES (?, 'Customer Edit', ?, ?, 'Profile Edit', ?, ?, 'Pending', ?)`,
          [
            generateId("apr"),
            `Edit Customer — ${existing.name}`,
            `Proposed changes for ${existing.customer_code || existing.id} (${updates.phone})`,
            req.user.name || req.user.userId,
            existing.customer_code || existing.id,
            JSON.stringify({ applicantId: id, updates }),
          ]
        );

        await recordActivity(conn, {
          userLabel: req.user.name || req.user.role,
          module: "Booking",
          action: `Requested customer edit (${existing.name})`,
          detail: `Changes sent for Admin approval (${updates.phone})`,
          category: "Approvals",
          alertTitle: `Customer Edit Approval Needed — ${existing.name}`,
          alertDetail: `Requested by ${req.user.name || req.user.role}`,
          href: "/approvals",
        });

        return { applicant: mapApplicant(existing), pendingApproval: true };
      }

      await conn.execute(
        `UPDATE applicants
         SET name = ?, phone = ?, address = ?, id_proof_masked = ?, notes = ?, preferences_json = ?
         WHERE id = ?`,
        [
          body.name ?? existing.name,
          body.phone ?? existing.phone,
          body.address ?? existing.address,
          body.idProofMasked ?? existing.id_proof_masked,
          body.notes ?? existing.notes,
          body.preferences ? JSON.stringify(body.preferences) : existing.preferences_json,
          id,
        ]
      );

      const [updated] = await conn.execute("SELECT * FROM applicants WHERE id = ? LIMIT 1", [id]);
      return { applicant: mapApplicant(updated[0]), pendingApproval: false };
    });

    res.status(result.pendingApproval ? 202 : 200).json({
      success: true,
      pendingApproval: result.pendingApproval,
      applicant: result.applicant,
    });
  })
);

module.exports = router;
