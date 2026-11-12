const express = require("express");
const { query, withTransaction } = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { generateId, getSystemSettings, recordActivity } = require("../utils/audit");
const { mapMaintenanceTicket, mapHallCheckItem, mapDepositRefund } = require("../utils/formatters");

const router = express.Router();
router.use(["/tickets", "/hall-checks"], requireAuth);

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

    const ticket = await withTransaction(async (conn) => {
      const settings = await getSystemSettings(conn);
      const [countRows] = await conn.execute("SELECT COUNT(*) AS cnt FROM maintenance_tickets");
      const seq = String(115 + Number(countRows[0].cnt || 0)).padStart(4, "0");
      const ticketNo = `MC-${new Date().getFullYear()}-${seq}`;
      const id = generateId("mt");
      const dateLabel = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

      const needsApproval = !isAdminActor && Boolean(settings.require_repair_admin_approval ?? 1);
      const initialStatus = needsApproval ? "Pending" : body.status || "Pending";

      await conn.execute(
        `INSERT INTO maintenance_tickets (
          id, ticket_no, title, category, sub_category, location, priority,
          estimated_cost, raised_by, date_label, status, description,
          photos_json, block_hall, block_date_iso, block_from, block_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(Array.isArray(photos) ? photos : []),
          blockHall ? 1 : 0,
          blockDateISO || null,
          blockFrom || null,
          blockTo || null,
        ]
      );

      for (const q of Array.isArray(quotations) ? quotations : []) {
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
        action: `Raised repair ticket ${ticketNo}`,
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
    const { status } = req.body || {};
    if (!status) {
      return res.status(400).json({ success: false, message: "Status is required." });
    }

    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";
    if (status === "Approved" && !isAdminActor) {
      return res.status(403).json({ success: false, message: "Only Admin can mark a repair ticket Approved." });
    }

    const ticket = await withTransaction(async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM maintenance_tickets WHERE id = ? LIMIT 1", [id]);
      const current = rows[0];
      if (!current) {
        const err = new Error("Maintenance ticket not found");
        err.statusCode = 404;
        throw err;
      }

      await conn.execute("UPDATE maintenance_tickets SET status = ? WHERE id = ?", [status, id]);
      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Maintenance",
        action: `Updated ticket ${current.ticket_no} -> ${status}`,
        detail: current.title,
        category: "Repairs",
        alertTitle: `Ticket ${current.ticket_no} marked ${status}`,
        alertDetail: current.title,
        href: "/maintenance",
      });

      const [after] = await conn.execute("SELECT * FROM maintenance_tickets WHERE id = ? LIMIT 1", [id]);
      const [qRows] = await conn.execute("SELECT * FROM maintenance_quotations WHERE ticket_id = ?", [id]);
      return mapMaintenanceTicket(after[0], qRows);
    });

    res.json({ success: true, ticket });
  })
);

router.patch(
  "/hall-checks/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status = "OK", issueCost = 0, note = "" } = req.body || {};

    await query(
      "UPDATE hall_check_items SET status = ?, issue_cost = ?, note = ? WHERE id = ?",
      [status, Number(issueCost || 0), note, id]
    );
    const rows = await query("SELECT * FROM hall_check_items WHERE id = ? LIMIT 1", [id]);
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: "Checklist item not found" });
    }
    res.json({ success: true, item: mapHallCheckItem(rows[0]) });
  })
);

router.post(
  "/hall-checks/save-to-refund",
  asyncHandler(async (req, res) => {
    const { refundId, items = [] } = req.body || {};
    if (!refundId) {
      return res.status(400).json({ success: false, message: "refundId is required" });
    }

    const updated = await withTransaction(async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM deposit_refunds WHERE id = ? LIMIT 1", [refundId]);
      const refund = rows[0];
      if (!refund) {
        const err = new Error("Deposit refund not found");
        err.statusCode = 404;
        throw err;
      }

      const issues = (Array.isArray(items) ? items : []).filter((i) => i.status === "Issue");
      const totalDeduction = issues.reduce((acc, i) => acc + Number(i.issueCost || 0), 0);
      const deductionNote = issues.map((i) => `${i.label} (₹${i.issueCost || 0})`).join(", ") || "No damage recorded";

      await conn.execute("DELETE FROM deposit_deduction_items WHERE refund_id = ?", [refundId]);
      for (const issue of issues) {
        await conn.execute(
          `INSERT INTO deposit_deduction_items (id, refund_id, item, location, photos_count, amount)
           VALUES (?, ?, ?, 'Hall Inspection', 0, ?)`,
          [generateId("dd"), refundId, issue.label, Number(issue.issueCost || 0)]
        );
      }

      await conn.execute(
        "UPDATE deposit_refunds SET deduction_amount = ?, deduction_note = ? WHERE id = ?",
        [totalDeduction, deductionNote, refundId]
      );

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Maintenance",
        action: `Saved hall inspection to deposit #${refund.booking_receipt_no}`,
        detail: deductionNote,
        category: "Repairs",
        alertTitle: `Hall Inspection Saved — #${refund.booking_receipt_no}`,
        alertDetail: `Deduction ₹${totalDeduction.toLocaleString("en-IN")} · ${deductionNote}`,
        href: `/deposits/${refundId}`,
      });

      const [after] = await conn.execute("SELECT * FROM deposit_refunds WHERE id = ? LIMIT 1", [refundId]);
      const [dItems] = await conn.execute("SELECT * FROM deposit_deduction_items WHERE refund_id = ?", [refundId]);
      return mapDepositRefund(after[0], dItems);
    });

    res.json({ success: true, depositRefund: updated });
  })
);

module.exports = router;
