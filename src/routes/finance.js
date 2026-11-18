const express = require("express");
const { query, withTransaction } = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { generateId, getSystemSettings, recordActivity } = require("../utils/audit");
const { mapPayment, mapExpense, mapDepositRefund } = require("../utils/formatters");
const { ensureModule5AndFinanceSchema } = require("../utils/schemaEnsure");

const router = express.Router();
router.use(["/payments", "/expenses", "/deposit-refunds"], requireAuth);

const VALID_PAYMENT_MODES = new Set(["Cash", "UPI", "Bank Transfer", "Cheque"]);
const VALID_PAYMENT_TYPES = new Set(["Advance", "Rent Balance", "Security Deposit"]);
const VALID_EXPENSE_CATEGORIES = new Set(["Cleaning", "Electricity", "Water", "Repair", "Supplies"]);
const VALID_REFUND_STATUSES = new Set(["Ready to Refund", "Sent for Approval", "Refunded"]);

router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM payments ORDER BY created_at DESC");
    res.json({ success: true, payments: rows.map(mapPayment) });
  })
);

router.post(
  "/payments",
  asyncHandler(async (req, res) => {
    const {
      bookingId,
      type = "Rent Balance",
      amount,
      mode = "Cash",
      reference = "",
      dateLabel,
    } = req.body || {};

    const numAmount = Math.round(Number(amount));
    if (!bookingId || !Number.isFinite(numAmount) || numAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Valid bookingId and positive amount are required." });
    }
    if (!VALID_PAYMENT_MODES.has(mode)) {
      return res.status(400).json({
        success: false,
        message: `Invalid payment mode "${mode}". Allowed: ${Array.from(VALID_PAYMENT_MODES).join(", ")}.`,
      });
    }
    if (!VALID_PAYMENT_TYPES.has(type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid payment type "${type}". Allowed: ${Array.from(VALID_PAYMENT_TYPES).join(", ")}.`,
      });
    }

    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";

    const created = await withTransaction(async (conn) => {
      const settings = await getSystemSettings(conn);
      const [bookings] = await conn.execute(
        "SELECT * FROM bookings WHERE id = ? OR receipt_no = ? LIMIT 1 FOR UPDATE",
        [bookingId, bookingId]
      );
      const booking = bookings[0];
      if (!booking) {
        const err = new Error("Booking not found");
        err.statusCode = 404;
        throw err;
      }
      if (booking.status === "Cancelled") {
        const err = new Error("Cannot record payment for a cancelled booking.");
        err.statusCode = 400;
        throw err;
      }

      const totalCharge = booking.is_free_use
        ? 0
        : Number(booking.rent || 0) + Number(booking.deposit || 0);
      const alreadyPaid = Number(booking.paid || 0);
      const [pendingRows] = await conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS pending_sum FROM payments WHERE booking_id = ? AND status = 'Pending'",
        [booking.id]
      );
      const pendingSum = Number(pendingRows[0]?.pending_sum || 0);
      const remainingBalance = Math.max(0, totalCharge - alreadyPaid - pendingSum);

      if (remainingBalance <= 0) {
        const err = new Error(
          `Booking #${booking.receipt_no} has no remaining balance due (total ₹${totalCharge.toLocaleString("en-IN")}).`
        );
        err.statusCode = 400;
        throw err;
      }

      if (numAmount > remainingBalance) {
        const err = new Error(
          `Payment amount (₹${numAmount.toLocaleString("en-IN")}) exceeds remaining balance due (₹${remainingBalance.toLocaleString("en-IN")}).`
        );
        err.statusCode = 400;
        throw err;
      }

      const needsApproval = !isAdminActor && Boolean(settings.require_payment_admin_approval ?? 1);
      const payStatus = needsApproval ? "Pending" : "Approved";
      const id = generateId("pay");
      const receiptNo = `REC-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const label =
        dateLabel ||
        new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

      await conn.execute(
        `INSERT INTO payments (
          id, receipt_no, booking_id, booking_receipt_no, applicant_name,
          event_title, type, amount, mode, reference, date_label, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          receiptNo,
          booking.id,
          booking.receipt_no,
          booking.applicant_name,
          booking.event_title,
          type,
          numAmount,
          mode,
          reference,
          label,
          payStatus,
        ]
      );

      if (!needsApproval) {
        await conn.execute("UPDATE bookings SET paid = paid + ? WHERE id = ?", [
          numAmount,
          booking.id,
        ]);
      } else {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status, metadata_json)
           VALUES (?, 'Record Payment', ?, ?, ?, ?, ?, 'Pending', ?)`,
          [
            generateId("apr"),
            `Payment ${type} — #${booking.receipt_no}`,
            `${booking.applicant_name} · ${mode}${reference ? ` (Ref: ${reference})` : ""}`,
            `₹${numAmount.toLocaleString("en-IN")}`,
            req.user.name || req.user.userId,
            receiptNo,
            JSON.stringify({ paymentId: id, bookingId: booking.id, amount: numAmount }),
          ]
        );
      }

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Payment",
        action: `Recorded ${type} ₹${numAmount.toLocaleString("en-IN")}${
          needsApproval ? " (Pending Admin approval)" : ""
        }`,
        detail: `Receipt ${receiptNo} for #${booking.receipt_no} (${booking.applicant_name}, ${mode})`,
        category: needsApproval ? "Approvals" : "Money",
        alertTitle: needsApproval
          ? `Payment Approval Needed — ₹${numAmount.toLocaleString("en-IN")}`
          : `Payment Received — ₹${numAmount.toLocaleString("en-IN")}`,
        alertDetail: `${booking.applicant_name} (#${booking.receipt_no} · ${mode})`,
        href: needsApproval ? "/approvals" : "/payments",
      });

      const [rows] = await conn.execute("SELECT * FROM payments WHERE id = ? LIMIT 1", [id]);
      return { payment: mapPayment(rows[0]), pendingApproval: needsApproval };
    });

    res.status(created.pendingApproval ? 202 : 201).json({
      success: true,
      pendingApproval: created.pendingApproval,
      payment: created.payment,
    });
  })
);

router.get(
  "/expenses",
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM expenses ORDER BY created_at DESC");
    res.json({ success: true, expenses: rows.map(mapExpense) });
  })
);

router.post(
  "/expenses",
  asyncHandler(async (req, res) => {
    const { title, category = "Supplies", amount, paidTo, dateLabel } = req.body || {};
    const numAmount = Math.round(Number(amount));
    if (!title || !String(title).trim() || !paidTo || !String(paidTo).trim() || !Number.isFinite(numAmount) || numAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Title, paidTo, and positive amount are required." });
    }
    if (!VALID_EXPENSE_CATEGORIES.has(category)) {
      return res.status(400).json({
        success: false,
        message: `Invalid expense category "${category}". Allowed: ${Array.from(VALID_EXPENSE_CATEGORIES).join(", ")}.`,
      });
    }

    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";

    const created = await withTransaction(async (conn) => {
      const settings = await getSystemSettings(conn);
      const needsApproval = !isAdminActor && Boolean(settings.require_expense_admin_approval ?? 1);
      const expStatus = needsApproval ? "Pending" : "Approved";
      const id = generateId("exp");
      const label =
        dateLabel ||
        new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

      await conn.execute(
        `INSERT INTO expenses (id, title, category, amount, paid_to, date_label, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, String(title).trim(), category, numAmount, String(paidTo).trim(), label, expStatus]
      );

      if (needsApproval) {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
           VALUES (?, 'Expense', ?, ?, ?, ?, ?, 'Pending')`,
          [
            generateId("apr"),
            String(title).trim(),
            `${category} · Paid to ${String(paidTo).trim()}`,
            `₹${numAmount.toLocaleString("en-IN")}`,
            req.user.name || req.user.userId,
            id.toUpperCase(),
          ]
        );
      }

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Payment",
        action: `Logged expense ₹${numAmount.toLocaleString("en-IN")}`,
        detail: `${String(title).trim()} (${category}) · Paid to ${String(paidTo).trim()}`,
        category: needsApproval ? "Approvals" : "Money",
        alertTitle: needsApproval
          ? `Expense Approval Needed — ₹${numAmount.toLocaleString("en-IN")}`
          : `Expense Recorded — ₹${numAmount.toLocaleString("en-IN")}`,
        alertDetail: `${String(title).trim()} · ${String(paidTo).trim()}`,
        href: "/payments?tab=expenses",
      });

      const [rows] = await conn.execute("SELECT * FROM expenses WHERE id = ? LIMIT 1", [id]);
      return mapExpense(rows[0]);
    });

    res.status(201).json({ success: true, expense: created });
  })
);

router.get(
  "/deposit-refunds",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const [refundsRows, deductionRows] = await Promise.all([
      query("SELECT * FROM deposit_refunds ORDER BY created_at DESC"),
      query("SELECT * FROM deposit_deduction_items"),
    ]);
    const deductionsByRefund = new Map();
    for (const item of deductionRows) {
      const list = deductionsByRefund.get(item.refund_id) || [];
      list.push(item);
      deductionsByRefund.set(item.refund_id, list);
    }
    res.json({
      success: true,
      depositRefunds: refundsRows.map((r) =>
        mapDepositRefund(r, deductionsByRefund.get(r.id) || [])
      ),
    });
  })
);

router.get(
  "/deposit-refunds/:id",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const { id } = req.params;
    const refundRows = await query(
      "SELECT * FROM deposit_refunds WHERE id = ? OR booking_receipt_no = ? LIMIT 1",
      [id, id]
    );
    if (!refundRows.length) {
      return res.status(404).json({ success: false, message: "Deposit refund record not found" });
    }
    const refund = refundRows[0];
    const deductionRows = await query(
      "SELECT * FROM deposit_deduction_items WHERE refund_id = ?",
      [refund.id]
    );
    res.json({ success: true, depositRefund: mapDepositRefund(refund, deductionRows) });
  })
);

router.post(
  "/deposit-refunds",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const {
      bookingReceiptNo,
      applicantName,
      eventTitle,
      eventDate,
      heldAmount = 0,
      deductionAmount = 0,
      deductionNote = "",
      refundMode = "UPI",
      status = "Ready to Refund",
      upiOrAccount = "",
      remarks = "",
    } = req.body || {};

    if (!bookingReceiptNo) {
      return res.status(400).json({ success: false, message: "bookingReceiptNo is required." });
    }
    if (!VALID_PAYMENT_MODES.has(refundMode)) {
      return res.status(400).json({
        success: false,
        message: `Invalid refund mode "${refundMode}". Allowed: ${Array.from(VALID_PAYMENT_MODES).join(", ")}.`,
      });
    }
    if (!VALID_REFUND_STATUSES.has(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid refund status "${status}". Allowed: ${Array.from(VALID_REFUND_STATUSES).join(", ")}.`,
      });
    }

    const numHeld = Math.round(Number(heldAmount));
    const numDeduction = Math.round(Number(deductionAmount));
    if (!Number.isFinite(numHeld) || numHeld < 0) {
      return res.status(400).json({ success: false, message: "heldAmount must be 0 or greater." });
    }
    if (!Number.isFinite(numDeduction) || numDeduction < 0) {
      return res
        .status(400)
        .json({ success: false, message: "deductionAmount cannot be negative." });
    }
    if (numDeduction > numHeld) {
      return res.status(400).json({
        success: false,
        message: `Deduction amount (₹${numDeduction.toLocaleString("en-IN")}) cannot exceed held deposit (₹${numHeld.toLocaleString("en-IN")}).`,
      });
    }

    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";
    if (status === "Refunded" && !isAdminActor) {
      return res.status(403).json({
        success: false,
        message: "Deposit payouts must be approved by Admin before marking Refunded.",
      });
    }

    const id = generateId("ref");
    await query(
      `INSERT INTO deposit_refunds (
        id, booking_receipt_no, applicant_name, event_title, event_date,
        held_amount, deduction_amount, deduction_note, refund_mode, status, upi_or_account, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        deduction_amount = VALUES(deduction_amount),
        deduction_note = VALUES(deduction_note),
        refund_mode = VALUES(refund_mode),
        status = VALUES(status),
        upi_or_account = VALUES(upi_or_account),
        remarks = VALUES(remarks)`,
      [
        id,
        bookingReceiptNo,
        applicantName || "",
        eventTitle || "",
        eventDate || "",
        numHeld,
        numDeduction,
        deductionNote,
        refundMode,
        status,
        upiOrAccount,
        remarks,
      ]
    );

    const rows = await query(
      "SELECT * FROM deposit_refunds WHERE booking_receipt_no = ? LIMIT 1",
      [bookingReceiptNo]
    );
    const refund = rows[0];
    const items = await query("SELECT * FROM deposit_deduction_items WHERE refund_id = ?", [
      refund.id,
    ]);
    res.status(201).json({ success: true, depositRefund: mapDepositRefund(refund, items) });
  })
);

router.patch(
  "/deposit-refunds/:id",
  asyncHandler(async (req, res) => {
    await ensureModule5AndFinanceSchema();
    const { id } = req.params;
    const patch = req.body || {};

    if (patch.status !== undefined && !VALID_REFUND_STATUSES.has(patch.status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid refund status "${patch.status}". Allowed: ${Array.from(VALID_REFUND_STATUSES).join(", ")}.`,
      });
    }
    if (patch.refundMode !== undefined && !VALID_PAYMENT_MODES.has(patch.refundMode)) {
      return res.status(400).json({
        success: false,
        message: `Invalid refund mode "${patch.refundMode}". Allowed: ${Array.from(VALID_PAYMENT_MODES).join(", ")}.`,
      });
    }

    const isAdminActor = (req.user?.role || "").toLowerCase() === "admin";

    const updated = await withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        "SELECT * FROM deposit_refunds WHERE id = ? OR booking_receipt_no = ? LIMIT 1 FOR UPDATE",
        [id, id]
      );
      const current = rows[0];
      if (!current) {
        const err = new Error("Deposit refund record not found");
        err.statusCode = 404;
        throw err;
      }

      if (patch.status === "Refunded" && !isAdminActor) {
        const err = new Error("Deposit payouts must be approved by Admin before marking Refunded.");
        err.statusCode = 403;
        throw err;
      }

      const heldAmount = Number(current.held_amount || 0);
      let nextDeduction =
        patch.deductionAmount !== undefined
          ? Math.round(Number(patch.deductionAmount))
          : Number(current.deduction_amount || 0);

      if (!Number.isFinite(nextDeduction) || nextDeduction < 0) {
        const err = new Error("Deduction amount cannot be negative.");
        err.statusCode = 400;
        throw err;
      }

      if (Array.isArray(patch.deductionItems)) {
        let itemsSum = 0;
        for (const d of patch.deductionItems) {
          const amt = Math.round(Number(d.amount || 0));
          if (!Number.isFinite(amt) || amt < 0) {
            const err = new Error("Deduction line item amount cannot be negative.");
            err.statusCode = 400;
            throw err;
          }
          itemsSum += amt;
        }
        nextDeduction = itemsSum;
      }

      if (nextDeduction > heldAmount) {
        const err = new Error(
          `Total deduction (₹${nextDeduction.toLocaleString("en-IN")}) cannot exceed held deposit (₹${heldAmount.toLocaleString("en-IN")}).`
        );
        err.statusCode = 400;
        throw err;
      }

      const nextStatus = patch.status ?? current.status;
      const nextNote = patch.deductionNote ?? current.deduction_note;
      const nextMode = patch.refundMode ?? current.refund_mode;

      await conn.execute(
        `UPDATE deposit_refunds
         SET deduction_amount = ?, deduction_note = ?, refund_mode = ?, status = ?, upi_or_account = ?, remarks = ?
         WHERE id = ?`,
        [
          nextDeduction,
          nextNote,
          nextMode,
          nextStatus,
          patch.upiOrAccount ?? current.upi_or_account,
          patch.remarks ?? current.remarks,
          current.id,
        ]
      );

      if (Array.isArray(patch.deductionItems)) {
        await conn.execute("DELETE FROM deposit_deduction_items WHERE refund_id = ?", [current.id]);
        for (const d of patch.deductionItems) {
          await conn.execute(
            `INSERT INTO deposit_deduction_items (id, refund_id, item, location, photos_count, amount)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              generateId("dd"),
              current.id,
              String(d.item || "Damage"),
              String(d.location || "Hall"),
              Math.max(0, Math.round(Number(d.photosCount || 0))),
              Math.round(Number(d.amount || 0)),
            ]
          );
        }
      }

      // Sync booking deposit_status when marked Refunded
      if (nextStatus === "Refunded") {
        await conn.execute("UPDATE bookings SET deposit_status = 'Refunded' WHERE receipt_no = ?", [
          current.booking_receipt_no,
        ]);
        await conn.execute(
          `UPDATE approvals
           SET status = 'Approved', decided_by = ?, decided_at = NOW()
           WHERE type = 'Deposit Refund' AND reference_no = ? AND status = 'Pending'`,
          [req.user.name || req.user.userId, current.booking_receipt_no]
        );
      }

      // Prevent duplicate pending approvals on repeated "Sent for Approval"
      if (nextStatus === "Sent for Approval") {
        const netPayoutLabel = `₹${Math.max(0, heldAmount - nextDeduction).toLocaleString("en-IN")}`;
        const [existingApr] = await conn.execute(
          `SELECT id FROM approvals
           WHERE type = 'Deposit Refund' AND reference_no = ? AND status = 'Pending'
           LIMIT 1`,
          [current.booking_receipt_no]
        );
        if (existingApr.length > 0) {
          await conn.execute(
            `UPDATE approvals SET amount_label = ?, detail = ?, requester = ? WHERE id = ?`,
            [
              netPayoutLabel,
              `${current.event_title} (#${current.booking_receipt_no})`,
              req.user.name || req.user.userId,
              existingApr[0].id,
            ]
          );
        } else {
          await conn.execute(
            `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
             VALUES (?, 'Deposit Refund', ?, ?, ?, ?, ?, 'Pending')`,
            [
              generateId("apr"),
              `Deposit Refund — ${current.applicant_name}`,
              `${current.event_title} (#${current.booking_receipt_no})`,
              netPayoutLabel,
              req.user.name || req.user.userId,
              current.booking_receipt_no,
            ]
          );
        }
      }

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Payment",
        action: `Updated deposit refund #${current.booking_receipt_no}`,
        detail: `Status: ${nextStatus} · Deduction ₹${nextDeduction.toLocaleString("en-IN")}`,
        category: "Money",
        alertTitle: `Deposit Refund (${nextStatus}) — #${current.booking_receipt_no}`,
        alertDetail: `${current.applicant_name} · ${current.event_title}`,
        href: `/deposits/${current.booking_receipt_no}`,
      });

      const [after] = await conn.execute("SELECT * FROM deposit_refunds WHERE id = ? LIMIT 1", [
        current.id,
      ]);
      const [items] = await conn.execute(
        "SELECT * FROM deposit_deduction_items WHERE refund_id = ?",
        [current.id]
      );
      return mapDepositRefund(after[0], items);
    });

    res.json({ success: true, depositRefund: updated });
  })
);

module.exports = router;
