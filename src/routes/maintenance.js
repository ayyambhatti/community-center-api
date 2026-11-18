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

const router = express.Router();
router.use(["/tickets", "/hall-checks", "/inspections"], requireAuth);

let inspectionPhotosTableReady = false;
async function ensureInspectionPhotosTable() {
  if (inspectionPhotosTableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS inspection_photos (
      id VARCHAR(64) PRIMARY KEY,
      booking_receipt_no VARCHAR(32) NOT NULL,
      mode ENUM('Before Event', 'After Event') NOT NULL DEFAULT 'Before Event',
      label VARCHAR(200) NOT NULL,
      is_issue TINYINT(1) NOT NULL DEFAULT 0,
      data_url LONGTEXT NOT NULL,
      size_kb INT NOT NULL DEFAULT 0,
      uploaded_by VARCHAR(100) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_insp_photos_booking (booking_receipt_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  inspectionPhotosTableReady = true;
}

function mapInspectionPhoto(row) {
  return {
    id: row.id,
    bookingReceiptNo: row.booking_receipt_no,
    mode: row.mode,
    label: row.label,
    isIssue: Boolean(row.is_issue),
    dataUrl: row.data_url,
    sizeKb: Number(row.size_kb || 0),
    uploadedBy: row.uploaded_by || undefined,
    createdAt: row.created_at,
  };
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

    if (!title) {
      return res.status(400).json({ success: false, message: "Ticket title is required." });
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
      const initialStatus = isDraft ? "Draft" : needsApproval ? "Pending" : body.status || "Pending";

      await conn.execute(
        `INSERT INTO maintenance_tickets (
          id, ticket_no, title, category, sub_category, location, priority,
          estimated_cost, raised_by, date_label, status, description,
          attachments_label, photos_json, block_hall, block_date_iso, block_from, block_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ticketNo,
          title,
          category,
          subCategory || null,
          location,
          priority,
          Number(estimatedCost || 0),
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
        await conn.execute(
          `INSERT INTO maintenance_quotations (id, ticket_id, vendor, file_name, amount)
           VALUES (?, ?, ?, ?, ?)`,
          [generateId("qt"), id, q.vendor || "Vendor", q.fileName || "quote.pdf", Number(q.amount || 0)]
        );
      }

      if (needsApproval) {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
          [
            generateId("apr"),
            blockHall ? "Hall Block" : "Repair Cost",
            `${blockHall ? "Hall Block & Repair" : "Repair Request"} — ${title}`,
            `${location} · ${category} (${priority})`,
            `₹${Number(estimatedCost || 0).toLocaleString("en-IN")}`,
            req.user.name || req.user.userId,
            ticketNo,
          ]
        );
      }

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Maintenance",
        action: isDraft ? `Saved draft ticket ${ticketNo}` : `Raised repair ticket ${ticketNo}`,
        detail: `${title} (${location}) · Est. ₹${Number(estimatedCost || 0).toLocaleString("en-IN")}`,
        category: needsApproval ? "Approvals" : "Repairs",
        alertTitle: `New Repair Ticket ${ticketNo}`,
        alertDetail: `${title} · ${location} (${priority})`,
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

      if (status) {
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
    const rows = await query("SELECT * FROM hall_check_items ORDER BY id ASC");
    res.json({ success: true, items: rows.map(mapHallCheckItem) });
  })
);

router.patch(
  "/hall-checks/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status = "OK", issueCost = 0, note = "" } = req.body || {};

    await query(
      "UPDATE hall_check_items SET status = ?, issue_cost = ?, note = ? WHERE id = ?",
      [status, status === "OK" ? 0 : Number(issueCost || 0), status === "OK" ? "" : note, id]
    );
    const rows = await query("SELECT * FROM hall_check_items WHERE id = ? LIMIT 1", [id]);
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: "Checklist item not found" });
    }
    res.json({ success: true, item: mapHallCheckItem(rows[0]) });
  })
);

router.get(
  "/inspections/:bookingReceiptNo/photos",
  asyncHandler(async (req, res) => {
    await ensureInspectionPhotosTable();
    const { bookingReceiptNo } = req.params;
    const rows = await query(
      "SELECT * FROM inspection_photos WHERE booking_receipt_no = ? ORDER BY created_at DESC",
      [bookingReceiptNo]
    );
    res.json({ success: true, photos: rows.map(mapInspectionPhoto) });
  })
);

router.post(
  "/inspections/:bookingReceiptNo/photos",
  asyncHandler(async (req, res) => {
    await ensureInspectionPhotosTable();
    const { bookingReceiptNo } = req.params;
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
      const label = String(p.label || "Inspection photo").slice(0, 200);
      const isIssue = p.isIssue ? 1 : 0;
      const sizeKb = Number(p.sizeKb || Math.round((p.dataUrl.length * 3) / 4 / 1024));

      await query(
        `INSERT INTO inspection_photos (id, booking_receipt_no, mode, label, is_issue, data_url, size_kb, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, bookingReceiptNo, mode, label, isIssue, p.dataUrl, sizeKb, uploadedBy]
      );
      insertedIds.push(id);
    }

    const rows = await query(
      `SELECT * FROM inspection_photos WHERE booking_receipt_no = ? ORDER BY created_at DESC`,
      [bookingReceiptNo]
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
    await ensureInspectionPhotosTable();
    const { photoId } = req.params;
    await query("DELETE FROM inspection_photos WHERE id = ?", [photoId]);
    res.json({ success: true, deletedId: photoId });
  })
);

router.post(
  "/hall-checks/save-to-refund",
  asyncHandler(async (req, res) => {
    await ensureInspectionPhotosTable();
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

    const result = await withTransaction(async (conn) => {
      // 1. Resolve booking
      let targetBooking = null;
      if (bookingReceiptNo) {
        const [bRows] = await conn.execute(
          "SELECT * FROM bookings WHERE receipt_no = ? OR id = ? LIMIT 1",
          [bookingReceiptNo, bookingReceiptNo]
        );
        targetBooking = bRows[0] || null;
      }

      // 2. Persist current checklist item states if supplied
      const checklistItems = Array.isArray(items) ? items : [];
      for (const item of checklistItems) {
        if (!item?.id) continue;
        await conn.execute(
          "UPDATE hall_check_items SET status = ?, issue_cost = ?, note = ? WHERE id = ?",
          [
            item.status === "Issue" ? "Issue" : "OK",
            item.status === "Issue" ? Number(item.issueCost || 0) : 0,
            item.status === "Issue" ? String(item.note || "") : "",
            item.id,
          ]
        );
      }

      // 3. Update booking inspection flags
      const effectiveReceiptNo = targetBooking?.receipt_no || bookingReceiptNo;
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

      const issues = checklistItems.filter((i) => i.status === "Issue");
      const totalDeduction = issues.reduce((acc, i) => acc + Number(i.issueCost || 0), 0);
      const deductionNote =
        issues.length > 0
          ? issues
              .map((i) => `${i.note || i.label} (₹${Number(i.issueCost || 0)})`)
              .join(", ")
          : "Hall checked — zero damage";

      let updatedRefund = null;

      if (mode === "After Event" || refundId) {
        let refund = null;
        if (refundId) {
          const [rRows] = await conn.execute(
            "SELECT * FROM deposit_refunds WHERE id = ? OR booking_receipt_no = ? LIMIT 1",
            [refundId, refundId]
          );
          refund = rRows[0] || null;
        }
        if (!refund && effectiveReceiptNo) {
          const [rRows] = await conn.execute(
            "SELECT * FROM deposit_refunds WHERE booking_receipt_no = ? LIMIT 1",
            [effectiveReceiptNo]
          );
          refund = rRows[0] || null;
        }

        const inspectionRef = `INS-${new Date().getFullYear()}-${effectiveReceiptNo || "0000"}-B · ${
          issues.length
        } ${issues.length === 1 ? "issue" : "issues"}`;

        if (!refund && targetBooking) {
          const newRefundId = generateId("ref");
          await conn.execute(
            `INSERT INTO deposit_refunds (
              id, booking_receipt_no, applicant_name, event_title, event_date,
              held_amount, deduction_amount, deduction_note, refund_mode, status,
              collected_label, inspection_ref
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ready to Refund', ?, ?)`,
            [
              newRefundId,
              targetBooking.receipt_no,
              targetBooking.applicant_name,
              targetBooking.event_title,
              targetBooking.date_label,
              Number(targetBooking.deposit || 0),
              totalDeduction,
              deductionNote,
              targetBooking.payment_mode || "UPI",
              `₹${Number(targetBooking.deposit || 0).toLocaleString("en-IN")} · ${
                targetBooking.payment_mode || "UPI"
              }`,
              inspectionRef,
            ]
          );
          const [createdRows] = await conn.execute(
            "SELECT * FROM deposit_refunds WHERE id = ? LIMIT 1",
            [newRefundId]
          );
          refund = createdRows[0];
        }

        if (refund) {
          const [photoCountRows] = await conn.execute(
            "SELECT COUNT(*) AS cnt FROM inspection_photos WHERE booking_receipt_no = ? AND mode = 'After Event'",
            [refund.booking_receipt_no]
          );
          const afterPhotosCount = Number(photoCountRows[0]?.cnt || 0);

          await conn.execute("DELETE FROM deposit_deduction_items WHERE refund_id = ?", [refund.id]);
          for (const issue of issues) {
            await conn.execute(
              `INSERT INTO deposit_deduction_items (id, refund_id, item, location, photos_count, amount)
               VALUES (?, ?, ?, 'Hall Inspection', ?, ?)`,
              [
                generateId("dd"),
                refund.id,
                issue.note ? `${issue.label} (${issue.note})` : issue.label,
                afterPhotosCount,
                Number(issue.issueCost || 0),
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
        action: `Saved ${mode} inspection for #${effectiveReceiptNo || refundId}`,
        detail: `${issues.length} issue(s) · ${deductionNote}`,
        category: "Repairs",
        alertTitle: `${mode} Inspection Saved — #${effectiveReceiptNo || refundId}`,
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
