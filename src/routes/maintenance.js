const express = require("express");
const { query, withTransaction } = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { generateId, getSystemSettings, recordActivity } = require("../utils/audit");
const {
  mapBooking,
  mapMaintenanceTicket,
  mapHallCheckItem,
  mapDepositRefund,
} = require("../utils/formatters");
const { ensureModule5AndFinanceSchema } = require("../utils/schemaEnsure");

const router = express.Router();
router.use(["/tickets", "/hall-checks", "/inspections"], requireAuth);

const VALID_TICKET_CATEGORIES = new Set([
  "Plumbing",
  "Electrical",
  "AC / Fans",
  "Carpentry",
  "Civil",
  "Furniture",
  "Cleaning",
]);
const VALID_TICKET_PRIORITIES = new Set(["Low", "Medium", "High", "Normal", "Urgent"]);
const VALID_TICKET_STATUSES = new Set(["Draft", "Pending", "Approved", "In Progress", "Completed"]);
const VALID_CHECK_STATUSES = new Set(["OK", "Issue"]);

const ALLOWED_TICKET_TRANSITIONS = {
  Draft: new Set(["Pending", "Approved"]),
  Pending: new Set(["Approved"]),
  Approved: new Set(["In Progress"]),
  "In Progress": new Set(["Completed"]),
  Completed: new Set([]),
};

function mapInspectionPhoto(row) {
  return {
    id: row.id,
    bookingReceiptNo: row.booking_receipt_no,
    mode: row.mode,
    checklistItemId: row.checklist_item_id || undefined,
    label: row.label,
    isIssue: Boolean(row.is_issue),
    dataUrl: row.data_url,
    sizeKb: Number(row.size_kb || 0),
    uploadedBy: row.uploaded_by || undefined,
    createdAt: row.created_at,
  };
}

async function resolveBookingByReceiptOrId(receiptOrId, conn = null) {
  const exec = conn
    ? (sql, params) => conn.execute(sql, params).then(([r]) => r)
    : query;
  const rows = await exec(
    "SELECT * FROM bookings WHERE receipt_no = ? OR id = ? LIMIT 1",
    [receiptOrId, receiptOrId]
  );
  return rows[0] || null;
}

router.get(
  "/tickets",
  asyncHandler(async (req, res) => {
    const [ticketsRows, quotationsRows] = await Promise.all([
      query("SELECT * FROM maintenance_tickets ORDER BY created_at DESC"),
      query("SELECT * FROM maintenance_quotations"),
    ]);
    const quotationsByTicket = new Map();
    for (const q of quotationsRows) {
      const list = quotationsByTicket.get(q.ticket_id) || [];
      list.push(q);
      quotationsByTicket.set(q.ticket_id, list);
    }
    res.json({
      success: true,
      tickets: ticketsRows.map((t) =>
        mapMaintenanceTicket(t, quotationsByTicket.get(t.id) || [])
      ),
    });
  })
);

router.get(
  "/tickets/:id/photos",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const rows = await query(
      "SELECT id, ticket_no, photos_json FROM maintenance_tickets WHERE id = ? OR ticket_no = ? LIMIT 1",
      [id, id]
    );
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: "Maintenance ticket not found" });
    }
    const mapped = mapMaintenanceTicket(rows[0], [], { includePhotoData: true });
    res.json({ success: true, ticketId: rows[0].id, ticketNo: rows[0].ticket_no, photos: mapped.photos });
  })
);

router.post(
  "/tickets",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const {
      title,
      category = "Plumbing",
      subCategory,
      location = "Main Hall",
      priority = "Medium",
      estimatedCost = 0,
      description = "",
      attachmentsLabel,
      quotations = [],
      photos = [],
      blockHall = false,
      blockDateISO,
      blockFrom,
      blockTo,
    } = body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, message: "Ticket title is required." });
    }
    if (!VALID_TICKET_CATEGORIES.has(category)) {
      return res.status(400).json({
        success: false,
        message: `Invalid category "${category}". Allowed: ${Array.from(VALID_TICKET_CATEGORIES).join(", ")}.`,
      });
    }
    if (!VALID_TICKET_PRIORITIES.has(priority)) {
      return res.status(400).json({
        success: false,
        message: `Invalid priority "${priority}". Allowed: ${Array.from(VALID_TICKET_PRIORITIES).join(", ")}.`,
      });
    }
    if (body.status !== undefined && !VALID_TICKET_STATUSES.has(body.status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status "${body.status}". Allowed: ${Array.from(VALID_TICKET_STATUSES).join(", ")}.`,
      });
    }
    const numCost = Number(estimatedCost);
    if (!Number.isFinite(numCost) || numCost < 0) {
      return res.status(400).json({
        success: false,
        message: "Estimated cost must be a non-negative number.",
      });
    }

    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";
    const safePhotos = Array.isArray(photos) ? photos : [];
    const safeQuotations = Array.isArray(quotations) ? quotations : [];
    const computedAttachmentsLabel =
      attachmentsLabel ||
      `${safeQuotations.length} quotation(s), ${safePhotos.length} photo(s)`;

    const ticket = await withTransaction(async (conn) => {
      const settings = await getSystemSettings(conn);
      const [countRows] = await conn.execute("SELECT COUNT(*) AS cnt FROM maintenance_tickets");
      const seq = String(115 + Number(countRows[0].cnt || 0)).padStart(4, "0");
      const ticketNo = `MC-${new Date().getFullYear()}-${seq}`;
      const id = generateId("mt");
      const dateLabel = new Date().toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

      const isDraft = body.status === "Draft";
      const needsApproval =
        !isDraft && !isAdminActor && Boolean(settings.require_repair_admin_approval ?? 1);
      // Non-admin can only create Draft or Pending tickets
      const initialStatus = isDraft
        ? "Draft"
        : isAdminActor
        ? body.status || "Approved"
        : "Pending";

      await conn.execute(
        `INSERT INTO maintenance_tickets (
          id, ticket_no, title, category, sub_category, location, priority,
          estimated_cost, raised_by, date_label, status, description,
          attachments_label, photos_json, block_hall, block_date_iso, block_from, block_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ticketNo,
          String(title).trim(),
          category,
          subCategory || null,
          location,
          priority,
          numCost,
          req.user.name || req.user.userId,
          dateLabel,
          initialStatus,
          description || null,
          computedAttachmentsLabel,
          JSON.stringify(safePhotos),
          blockHall ? 1 : 0,
          blockDateISO || null,
          blockFrom || null,
          blockTo || null,
        ]
      );

      for (const q of safeQuotations) {
        const qAmount = Number(q.amount || 0);
        await conn.execute(
          `INSERT INTO maintenance_quotations (id, ticket_id, vendor, file_name, amount)
           VALUES (?, ?, ?, ?, ?)`,
          [
            generateId("qt"),
            id,
            q.vendor || "Vendor",
            q.fileName || "quote.pdf",
            Number.isFinite(qAmount) && qAmount >= 0 ? qAmount : 0,
          ]
        );
      }

      if (needsApproval) {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
          [
            generateId("apr"),
            blockHall ? "Hall Block" : "Repair Cost",
            `${blockHall ? "Hall Block & Repair" : "Repair Request"} — ${String(title).trim()}`,
            `${location} · ${category} (${priority})`,
            `₹${numCost.toLocaleString("en-IN")}`,
            req.user.name || req.user.userId,
            ticketNo,
          ]
        );
      }

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Maintenance",
        action: isDraft ? `Saved draft ticket ${ticketNo}` : `Raised repair ticket ${ticketNo}`,
        detail: `${String(title).trim()} (${location}) · Est. ₹${numCost.toLocaleString("en-IN")}`,
        category: needsApproval ? "Approvals" : "Repairs",
        alertTitle: `New Repair Ticket ${ticketNo}`,
        alertDetail: `${String(title).trim()} · ${location} (${priority})`,
        href: needsApproval ? "/approvals" : "/maintenance",
      });

      const [rows] = await conn.execute("SELECT * FROM maintenance_tickets WHERE id = ? LIMIT 1", [id]);
      const [qRows] = await conn.execute("SELECT * FROM maintenance_quotations WHERE ticket_id = ?", [id]);
      return mapMaintenanceTicket(rows[0], qRows);
    });

    res.status(201).json({ success: true, ticket });
  })
);

router.patch(
  "/tickets/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, photos } = req.body || {};

    if (!status && !Array.isArray(photos)) {
      return res.status(400).json({ success: false, message: "Status or photos are required." });
    }

    if (status !== undefined && !VALID_TICKET_STATUSES.has(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid ticket status "${status}". Allowed: ${Array.from(VALID_TICKET_STATUSES).join(", ")}.`,
      });
    }

    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";
    if (status === "Approved" && !isAdminActor) {
      return res.status(403).json({
        success: false,
        message: "Only Admin can mark a repair ticket Approved.",
      });
    }

    const ticket = await withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        "SELECT * FROM maintenance_tickets WHERE id = ? OR ticket_no = ? LIMIT 1",
        [id, id]
      );
      const current = rows[0];
      if (!current) {
        const err = new Error("Maintenance ticket not found");
        err.statusCode = 404;
        throw err;
      }

      if (status && status !== current.status) {
        const allowed = ALLOWED_TICKET_TRANSITIONS[current.status] || new Set();
        if (!allowed.has(status)) {
          const err = new Error(
            current.status === "Pending"
              ? `Cannot move ticket from Pending directly to ${status}. Admin approval is required first.`
              : `Invalid status transition from "${current.status}" to "${status}".`
          );
          err.statusCode = 400;
          throw err;
        }
      }

      const nextStatus = status || current.status;
      const nextPhotosJson = Array.isArray(photos)
        ? JSON.stringify(photos)
        : typeof current.photos_json === "string"
        ? current.photos_json
        : JSON.stringify(current.photos_json || []);

      await conn.execute(
        "UPDATE maintenance_tickets SET status = ?, photos_json = ? WHERE id = ?",
        [nextStatus, nextPhotosJson, current.id]
      );

      // If Admin directly approves a Pending ticket here, also mark matching pending approval Approved
      if (status === "Approved" && current.status === "Pending") {
        await conn.execute(
          `UPDATE approvals
           SET status = 'Approved', decided_by = ?, decided_at = NOW()
           WHERE reference_no = ? AND type IN ('Repair Cost', 'Hall Block') AND status = 'Pending'`,
          [req.user.name || req.user.userId, current.ticket_no]
        );
      }

      if (status && status !== current.status) {
        await recordActivity(conn, {
          userLabel: req.user.name || req.user.role,
          module: "Maintenance",
          action: `Updated ticket ${current.ticket_no} -> ${nextStatus}`,
          detail: current.title,
          category: "Repairs",
          alertTitle: `Ticket ${current.ticket_no} marked ${nextStatus}`,
          alertDetail: current.title,
          href: "/maintenance",
        });
      }

      const [after] = await conn.execute("SELECT * FROM maintenance_tickets WHERE id = ? LIMIT 1", [
        current.id,
      ]);
      const [qRows] = await conn.execute("SELECT * FROM maintenance_quotations WHERE ticket_id = ?", [
        current.id,
      ]);
      return mapMaintenanceTicket(after[0], qRows);
    });

    res.json({ success: true, ticket });
  })
);

router.get(
  "/hall-checks",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const rows = await query("SELECT * FROM hall_check_items ORDER BY id ASC");
    res.json({ success: true, items: rows.map(mapHallCheckItem) });
  })
);

router.patch(
  "/hall-checks/:id",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const { id } = req.params;
    const { status = "OK", issueCost = 0, note = "", bookingReceiptNo } = req.body || {};

    if (!VALID_CHECK_STATUSES.has(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid checklist status "${status}". Allowed: OK, Issue.`,
      });
    }
    const numCost = Number(issueCost);
    if (!Number.isFinite(numCost) || numCost < 0) {
      return res.status(400).json({
        success: false,
        message: "Deduction cost must be 0 or greater (negative values are not allowed).",
      });
    }

    const templateRows = await query("SELECT * FROM hall_check_items WHERE id = ? LIMIT 1", [id]);
    if (!templateRows[0]) {
      return res.status(404).json({ success: false, message: "Checklist item not found" });
    }

    const normalizedCost = status === "OK" ? 0 : Math.round(numCost);
    const normalizedNote = status === "OK" ? "" : String(note || "");

    if (bookingReceiptNo) {
      const booking = await resolveBookingByReceiptOrId(bookingReceiptNo);
      if (!booking) {
        return res.status(404).json({ success: false, message: "Booking not found" });
      }
      await query(
        `INSERT INTO booking_hall_checks (booking_receipt_no, item_id, status, issue_cost, note)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), issue_cost = VALUES(issue_cost), note = VALUES(note)`,
        [booking.receipt_no, id, status, normalizedCost, normalizedNote]
      );
      return res.json({
        success: true,
        item: {
          ...mapHallCheckItem(templateRows[0]),
          status,
          issueCost: normalizedCost,
          note: normalizedNote,
        },
      });
    }

    // Legacy fallback: do not mutate global template if no booking specified, just return validated shape
    res.json({
      success: true,
      item: {
        ...mapHallCheckItem(templateRows[0]),
        status,
        issueCost: normalizedCost,
        note: normalizedNote,
      },
    });
  })
);

router.get(
  "/inspections/:bookingReceiptNo/checklist",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const { bookingReceiptNo } = req.params;
    const booking = await resolveBookingByReceiptOrId(bookingReceiptNo);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const [templateRows, bookingRows] = await Promise.all([
      query("SELECT * FROM hall_check_items ORDER BY id ASC"),
      query("SELECT * FROM booking_hall_checks WHERE booking_receipt_no = ?", [booking.receipt_no]),
    ]);

    const overrideByItem = new Map(bookingRows.map((r) => [r.item_id, r]));
    const items = templateRows.map((tpl) => {
      const ov = overrideByItem.get(tpl.id);
      return {
        id: tpl.id,
        label: tpl.label,
        helper: tpl.helper,
        status: ov ? ov.status : "OK",
        issueCost: ov ? Number(ov.issue_cost || 0) : 0,
        note: ov ? ov.note || "" : "",
      };
    });

    res.json({ success: true, bookingReceiptNo: booking.receipt_no, items });
  })
);

router.patch(
  "/inspections/:bookingReceiptNo/checklist/:itemId",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const { bookingReceiptNo, itemId } = req.params;
    const { status = "OK", issueCost = 0, note = "" } = req.body || {};

    if (!VALID_CHECK_STATUSES.has(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid checklist status "${status}". Allowed: OK, Issue.`,
      });
    }
    const numCost = Number(issueCost);
    if (!Number.isFinite(numCost) || numCost < 0) {
      return res.status(400).json({
        success: false,
        message: "Deduction cost cannot be negative.",
      });
    }

    const [booking, templateRows] = await Promise.all([
      resolveBookingByReceiptOrId(bookingReceiptNo),
      query("SELECT * FROM hall_check_items WHERE id = ? LIMIT 1", [itemId]),
    ]);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (!templateRows[0]) {
      return res.status(404).json({ success: false, message: "Checklist item not found" });
    }

    const normalizedCost = status === "OK" ? 0 : Math.round(numCost);
    const normalizedNote = status === "OK" ? "" : String(note || "");

    await query(
      `INSERT INTO booking_hall_checks (booking_receipt_no, item_id, status, issue_cost, note)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), issue_cost = VALUES(issue_cost), note = VALUES(note)`,
      [booking.receipt_no, itemId, status, normalizedCost, normalizedNote]
    );

    res.json({
      success: true,
      item: {
        id: templateRows[0].id,
        label: templateRows[0].label,
        helper: templateRows[0].helper,
        status,
        issueCost: normalizedCost,
        note: normalizedNote,
      },
    });
  })
);

router.get(
  "/inspections/:bookingReceiptNo/photos",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const { bookingReceiptNo } = req.params;
    const booking = await resolveBookingByReceiptOrId(bookingReceiptNo);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const rows = await query(
      "SELECT * FROM inspection_photos WHERE booking_receipt_no = ? ORDER BY created_at DESC",
      [booking.receipt_no]
    );
    res.json({ success: true, photos: rows.map(mapInspectionPhoto) });
  })
);

router.post(
  "/inspections/:bookingReceiptNo/photos",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const { bookingReceiptNo } = req.params;
    const booking = await resolveBookingByReceiptOrId(bookingReceiptNo);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const body = req.body || {};
    const list = Array.isArray(body.photos) ? body.photos : [body];

    const validItems = list.filter(
      (p) => p && typeof p.dataUrl === "string" && p.dataUrl.startsWith("data:image/")
    );
    if (validItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one valid compressed image dataUrl is required.",
      });
    }

    const uploadedBy = req.user.name || req.user.userId;
    const insertedIds = [];

    for (const p of validItems) {
      const id = generateId("ip");
      const mode = p.mode === "After Event" ? "After Event" : "Before Event";
      const checklistItemId =
        typeof p.checklistItemId === "string" && p.checklistItemId.trim()
          ? p.checklistItemId.trim().slice(0, 64)
          : null;
      const label = String(p.label || "Inspection photo").slice(0, 200);
      const isIssue = p.isIssue ? 1 : 0;
      const sizeKb = Number(p.sizeKb || Math.round((p.dataUrl.length * 3) / 4 / 1024));

      await query(
        `INSERT INTO inspection_photos (id, booking_receipt_no, mode, checklist_item_id, label, is_issue, data_url, size_kb, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, booking.receipt_no, mode, checklistItemId, label, isIssue, p.dataUrl, sizeKb, uploadedBy]
      );
      insertedIds.push(id);
    }

    const rows = await query(
      `SELECT * FROM inspection_photos WHERE booking_receipt_no = ? ORDER BY created_at DESC`,
      [booking.receipt_no]
    );

    res.status(201).json({
      success: true,
      insertedIds,
      photos: rows.map(mapInspectionPhoto),
    });
  })
);

router.delete(
  "/inspections/photos/:photoId",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const { photoId } = req.params;
    await query("DELETE FROM inspection_photos WHERE id = ?", [photoId]);
    res.json({ success: true, deletedId: photoId });
  })
);

router.get(
  "/inspections/meter/last",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const rows = await query(
      `SELECT receipt_no, meter_closing_unit, meter_closing_at
       FROM bookings
       WHERE meter_closing_unit IS NOT NULL
       ORDER BY meter_closing_at DESC, updated_at DESC
       LIMIT 1`
    );
    const last = rows[0] || null;
    res.json({
      success: true,
      lastReading: last
        ? {
            bookingReceiptNo: last.receipt_no,
            closingUnit: Number(last.meter_closing_unit),
            recordedAt: last.meter_closing_at,
          }
        : null,
    });
  })
);

router.patch(
  "/inspections/:bookingReceiptNo/meter",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const { bookingReceiptNo } = req.params;
    const {
      openingUnit,
      closingUnit,
      electricityRatePerUnit,
      electricityWaived,
    } = req.body || {};

    const result = await withTransaction(async (conn) => {
      const booking = await resolveBookingByReceiptOrId(bookingReceiptNo, conn);
      if (!booking) {
        const err = new Error("Booking not found");
        err.statusCode = 404;
        throw err;
      }

      const [rRows] = await conn.execute(
        "SELECT status FROM deposit_refunds WHERE booking_receipt_no = ? LIMIT 1",
        [booking.receipt_no]
      );
      if (rRows[0]?.status === "Refunded") {
        const err = new Error(
          "Deposit refund has already been marked Refunded; meter readings are locked."
        );
        err.statusCode = 409;
        throw err;
      }

      const nextOpening =
        openingUnit !== undefined && openingUnit !== null && openingUnit !== ""
          ? Number(openingUnit)
          : booking.meter_opening_unit !== null && booking.meter_opening_unit !== undefined
          ? Number(booking.meter_opening_unit)
          : null;

      const nextClosing =
        closingUnit !== undefined && closingUnit !== null && closingUnit !== ""
          ? Number(closingUnit)
          : booking.meter_closing_unit !== null && booking.meter_closing_unit !== undefined
          ? Number(booking.meter_closing_unit)
          : null;

      if (nextOpening !== null && (!Number.isFinite(nextOpening) || nextOpening < 0)) {
        const err = new Error("Opening meter unit must be a non-negative number.");
        err.statusCode = 400;
        throw err;
      }
      if (nextClosing !== null && (!Number.isFinite(nextClosing) || nextClosing < 0)) {
        const err = new Error("Closing meter unit must be a non-negative number.");
        err.statusCode = 400;
        throw err;
      }
      if (nextOpening !== null && nextClosing !== null && nextClosing < nextOpening) {
        const err = new Error(
          `Closing meter unit (${nextClosing}) cannot be less than opening unit (${nextOpening}).`
        );
        err.statusCode = 400;
        throw err;
      }

      const nextRate =
        electricityRatePerUnit !== undefined
          ? Math.max(0, Number(electricityRatePerUnit))
          : Number(booking.electricity_rate_per_unit ?? 12);
      if (!Number.isFinite(nextRate) || nextRate < 0) {
        const err = new Error("Electricity rate per unit must be 0 or greater.");
        err.statusCode = 400;
        throw err;
      }

      const nextWaived =
        electricityWaived !== undefined
          ? electricityWaived
            ? 1
            : 0
          : booking.electricity_waived
          ? 1
          : 0;

      const actor = req.user.name || req.user.userId;
      const openingChanged =
        openingUnit !== undefined && openingUnit !== null && openingUnit !== "";
      const closingChanged =
        closingUnit !== undefined && closingUnit !== null && closingUnit !== "";

      await conn.execute(
        `UPDATE bookings SET
          electricity_rate_per_unit = ?,
          electricity_waived = ?,
          meter_opening_unit = ?,
          meter_opening_at = CASE WHEN ? = 1 THEN NOW() ELSE meter_opening_at END,
          meter_opening_by = CASE WHEN ? = 1 THEN ? ELSE meter_opening_by END,
          meter_closing_unit = ?,
          meter_closing_at = CASE WHEN ? = 1 THEN NOW() ELSE meter_closing_at END,
          meter_closing_by = CASE WHEN ? = 1 THEN ? ELSE meter_closing_by END
         WHERE id = ?`,
        [
          nextRate,
          nextWaived,
          nextOpening,
          openingChanged ? 1 : 0,
          openingChanged ? 1 : 0,
          actor,
          nextClosing,
          closingChanged ? 1 : 0,
          closingChanged ? 1 : 0,
          actor,
          booking.id,
        ]
      );

      const unitsConsumed =
        nextOpening !== null && nextClosing !== null ? Number((nextClosing - nextOpening).toFixed(2)) : null;
      const electricityCharge =
        unitsConsumed !== null && !nextWaived ? Math.round(unitsConsumed * nextRate) : 0;

      await recordActivity(conn, {
        userLabel: actor,
        module: "Maintenance",
        action: `Recorded electricity meter for #${booking.receipt_no}`,
        detail:
          unitsConsumed !== null
            ? `Opening ${nextOpening} → Closing ${nextClosing} (${unitsConsumed} units @ ₹${nextRate}/unit = ₹${electricityCharge})`
            : `Opening meter unit recorded: ${nextOpening}`,
        category: "Repairs",
        alertTitle: `Meter Reading Updated — #${booking.receipt_no}`,
        alertDetail:
          unitsConsumed !== null
            ? `${unitsConsumed} units · Electricity ₹${electricityCharge.toLocaleString("en-IN")}`
            : `Opening: ${nextOpening} units`,
        href: `/inspections/${booking.receipt_no}`,
      });

      const [after] = await conn.execute("SELECT * FROM bookings WHERE id = ? LIMIT 1", [
        booking.id,
      ]);
      return {
        booking: mapBooking(after[0]),
        unitsConsumed,
        electricityCharge,
      };
    });

    res.json({ success: true, ...result });
  })
);

router.post(
  "/hall-checks/save-to-refund",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const {
      refundId,
      bookingReceiptNo,
      mode = "After Event",
      items = [],
    } = req.body || {};

    if (!refundId && !bookingReceiptNo) {
      return res
        .status(400)
        .json({ success: false, message: "bookingReceiptNo or refundId is required." });
    }
    if (mode !== "Before Event" && mode !== "After Event") {
      return res.status(400).json({
        success: false,
        message: 'Invalid inspection mode. Allowed: "Before Event", "After Event".',
      });
    }

    const checklistItems = Array.isArray(items) ? items : [];
    for (const item of checklistItems) {
      if (item.status && !VALID_CHECK_STATUSES.has(item.status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid checklist item status "${item.status}".`,
        });
      }
      if (item.status === "Issue") {
        const cost = Number(item.issueCost ?? 0);
        if (!Number.isFinite(cost) || cost < 0) {
          return res.status(400).json({
            success: false,
            message: `Deduction cost for "${item.label || item.id}" cannot be negative.`,
          });
        }
      }
    }

    const result = await withTransaction(async (conn) => {
      // 1. Resolve booking or refund
      let targetBooking = null;
      let existingRefund = null;

      if (bookingReceiptNo) {
        targetBooking = await resolveBookingByReceiptOrId(bookingReceiptNo, conn);
      }
      if (refundId) {
        const [rRows] = await conn.execute(
          "SELECT * FROM deposit_refunds WHERE id = ? OR booking_receipt_no = ? LIMIT 1",
          [refundId, refundId]
        );
        existingRefund = rRows[0] || null;
        if (!targetBooking && existingRefund) {
          targetBooking = await resolveBookingByReceiptOrId(existingRefund.booking_receipt_no, conn);
        }
      }

      if (!targetBooking && !existingRefund) {
        const err = new Error("Booking not found");
        err.statusCode = 404;
        throw err;
      }

      const effectiveReceiptNo = targetBooking?.receipt_no || existingRefund.booking_receipt_no;
      const heldAmount = Number(
        existingRefund ? existingRefund.held_amount : targetBooking?.deposit || 0
      );

      const issues = checklistItems.filter((i) => i.status === "Issue");
      const checklistDeduction = issues.reduce(
        (acc, i) => acc + Math.round(Number(i.issueCost || 0)),
        0
      );

      // Compute electricity bill from booking's recorded opening/closing meter readings
      let electricityUnits = 0;
      let electricityCharge = 0;
      let electricityRate = Number(targetBooking?.electricity_rate_per_unit ?? 12);
      const hasOpening =
        targetBooking?.meter_opening_unit !== null &&
        targetBooking?.meter_opening_unit !== undefined;
      const hasClosing =
        targetBooking?.meter_closing_unit !== null &&
        targetBooking?.meter_closing_unit !== undefined;
      if (
        mode === "After Event" &&
        targetBooking &&
        !targetBooking.electricity_waived &&
        hasOpening &&
        hasClosing
      ) {
        const openVal = Number(targetBooking.meter_opening_unit);
        const closeVal = Number(targetBooking.meter_closing_unit);
        if (closeVal >= openVal) {
          electricityUnits = Number((closeVal - openVal).toFixed(2));
          electricityCharge = Math.round(electricityUnits * electricityRate);
        }
      }

      const totalDeduction = checklistDeduction + electricityCharge;

      if (mode === "After Event" && totalDeduction > heldAmount) {
        const err = new Error(
          `Total deduction (₹${totalDeduction.toLocaleString("en-IN")}) cannot exceed held security deposit (₹${heldAmount.toLocaleString("en-IN")}).`
        );
        err.statusCode = 400;
        throw err;
      }

      // 2. Persist per-booking checklist states (isolated to effectiveReceiptNo!)
      for (const item of checklistItems) {
        if (!item?.id) continue;
        const normalizedStatus = item.status === "Issue" ? "Issue" : "OK";
        const normalizedCost = normalizedStatus === "Issue" ? Math.round(Number(item.issueCost || 0)) : 0;
        const normalizedNote = normalizedStatus === "Issue" ? String(item.note || "") : "";
        await conn.execute(
          `INSERT INTO booking_hall_checks (booking_receipt_no, item_id, status, issue_cost, note)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE status = VALUES(status), issue_cost = VALUES(issue_cost), note = VALUES(note)`,
          [effectiveReceiptNo, item.id, normalizedStatus, normalizedCost, normalizedNote]
        );
      }

      // 3. Update booking inspection flags
      if (targetBooking) {
        if (mode === "Before Event") {
          await conn.execute("UPDATE bookings SET pre_inspection_done = 1 WHERE id = ?", [
            targetBooking.id,
          ]);
        } else {
          await conn.execute(
            "UPDATE bookings SET post_inspection_done = 1, deposit_status = CASE WHEN deposit_status = 'Refunded' THEN 'Refunded' ELSE 'Ready to Refund' END WHERE id = ?",
            [targetBooking.id]
          );
        }
      }

      const noteParts = issues.map(
        (i) => `${i.note || i.label} (₹${Math.round(Number(i.issueCost || 0))})`
      );
      if (electricityCharge > 0) {
        noteParts.push(
          `Electricity ${electricityUnits} units @ ₹${electricityRate}/unit (₹${electricityCharge})`
        );
      }
      const deductionNote =
        noteParts.length > 0 ? noteParts.join(", ") : "Hall checked — zero damage";

      let updatedRefund = null;

      if (mode === "After Event" || refundId) {
        let refund = existingRefund;
        if (!refund) {
          const [rRows] = await conn.execute(
            "SELECT * FROM deposit_refunds WHERE booking_receipt_no = ? LIMIT 1 FOR UPDATE",
            [effectiveReceiptNo]
          );
          refund = rRows[0] || null;
        }

        if (refund && refund.status === "Refunded") {
          const err = new Error(
            "Deposit refund has already been marked Refunded and cannot be modified."
          );
          err.statusCode = 409;
          throw err;
        }

        const inspectionRef = `INS-${new Date().getFullYear()}-${effectiveReceiptNo}-B · ${
          issues.length
        } ${issues.length === 1 ? "issue" : "issues"}${
          electricityCharge > 0 ? ` + ${electricityUnits} kWh` : ""
        }`;

        if (!refund && targetBooking) {
          const newRefundId = generateId("ref");
          await conn.execute(
            `INSERT INTO deposit_refunds (
              id, booking_receipt_no, applicant_name, event_title, event_date,
              held_amount, deduction_amount, deduction_note, refund_mode, status,
              collected_label, inspection_ref
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ready to Refund', ?, ?)
            ON DUPLICATE KEY UPDATE
              deduction_amount = VALUES(deduction_amount),
              deduction_note = VALUES(deduction_note),
              inspection_ref = VALUES(inspection_ref)`,
            [
              newRefundId,
              targetBooking.receipt_no,
              targetBooking.applicant_name,
              targetBooking.event_title,
              targetBooking.date_label,
              heldAmount,
              totalDeduction,
              deductionNote,
              targetBooking.payment_mode || "UPI",
              `₹${heldAmount.toLocaleString("en-IN")} · ${targetBooking.payment_mode || "UPI"}`,
              inspectionRef,
            ]
          );
          const [createdRows] = await conn.execute(
            "SELECT * FROM deposit_refunds WHERE booking_receipt_no = ? LIMIT 1",
            [targetBooking.receipt_no]
          );
          refund = createdRows[0];
        }

        if (refund) {
          // Count After Event photos: prefer per-item tagged count, else fall back to untagged After-Event photos
          const [photoCounts] = await conn.execute(
            `SELECT checklist_item_id, COUNT(*) AS cnt
             FROM inspection_photos
             WHERE booking_receipt_no = ? AND mode = 'After Event'
             GROUP BY checklist_item_id`,
            [refund.booking_receipt_no]
          );
          const countByItem = new Map();
          let untaggedAfterCount = 0;
          for (const row of photoCounts) {
            if (row.checklist_item_id) {
              countByItem.set(row.checklist_item_id, Number(row.cnt || 0));
            } else {
              untaggedAfterCount += Number(row.cnt || 0);
            }
          }

          await conn.execute("DELETE FROM deposit_deduction_items WHERE refund_id = ?", [refund.id]);
          for (const issue of issues) {
            const taggedCount = countByItem.get(issue.id) || 0;
            const linkedPhotoCount = taggedCount > 0 ? taggedCount : untaggedAfterCount;
            await conn.execute(
              `INSERT INTO deposit_deduction_items (id, refund_id, item, location, photos_count, amount)
               VALUES (?, ?, ?, 'Hall Inspection', ?, ?)`,
              [
                generateId("dd"),
                refund.id,
                issue.note ? `${issue.label} (${issue.note})` : issue.label,
                linkedPhotoCount,
                Math.round(Number(issue.issueCost || 0)),
              ]
            );
          }

          if (electricityCharge > 0 && targetBooking) {
            const meterPhotosCount = countByItem.get("meter-closing") || 0;
            await conn.execute(
              `INSERT INTO deposit_deduction_items (id, refund_id, item, location, photos_count, amount)
               VALUES (?, ?, ?, 'Electricity Meter', ?, ?)`,
              [
                generateId("dd"),
                refund.id,
                `Electricity Bill — ${electricityUnits} units @ ₹${electricityRate}/unit (${Number(targetBooking.meter_opening_unit)} → ${Number(targetBooking.meter_closing_unit)})`,
                meterPhotosCount,
                electricityCharge,
              ]
            );
          }

          await conn.execute(
            `UPDATE deposit_refunds
             SET deduction_amount = ?, deduction_note = ?, inspection_ref = ?,
                 status = CASE WHEN status = 'Refunded' THEN 'Refunded' ELSE 'Ready to Refund' END
             WHERE id = ?`,
            [totalDeduction, deductionNote, inspectionRef, refund.id]
          );

          const [after] = await conn.execute(
            "SELECT * FROM deposit_refunds WHERE id = ? LIMIT 1",
            [refund.id]
          );
          const [dItems] = await conn.execute(
            "SELECT * FROM deposit_deduction_items WHERE refund_id = ?",
            [refund.id]
          );
          updatedRefund = mapDepositRefund(after[0], dItems);
        }
      }

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Maintenance",
        action: `Saved ${mode} inspection for #${effectiveReceiptNo}`,
        detail: `${issues.length} issue(s) · ${deductionNote}`,
        category: "Repairs",
        alertTitle: `${mode} Inspection Saved — #${effectiveReceiptNo}`,
        alertDetail: `Deduction ₹${totalDeduction.toLocaleString("en-IN")} · ${deductionNote}`,
        href: updatedRefund ? `/deposits/${updatedRefund.bookingReceiptNo}` : "/maintenance",
      });

      let updatedBooking = null;
      if (targetBooking) {
        const [bAfter] = await conn.execute("SELECT * FROM bookings WHERE id = ? LIMIT 1", [
          targetBooking.id,
        ]);
        updatedBooking = bAfter[0] ? mapBooking(bAfter[0]) : null;
      }

      return { depositRefund: updatedRefund, booking: updatedBooking };
    });

    res.json({ success: true, ...result });
  })
);

module.exports = router;
