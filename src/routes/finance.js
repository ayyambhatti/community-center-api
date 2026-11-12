const express = require("express");
const { query, withTransaction } = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { generateId, recordActivity } = require("../utils/audit");
const { mapPayment, mapExpense, mapDepositRefund } = require("../utils/formatters");

const router = express.Router();
router.use(["/payments", "/expenses", "/deposit-refunds"], requireAuth);

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
    const { bookingId, type = "Rent Balance", amount, mode = "Cash", reference = "", dateLabel } = req.body || {};
    const numAmount = Number(amount);
    if (!bookingId || !Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, message: "Valid bookingId and positive amount are required." });
    }

    const created = await withTransaction(async (conn) => {
      const [bookings] = await conn.execute("SELECT * FROM bookings WHERE id = ? LIMIT 1", [bookingId]);
      const booking = bookings[0];
      if (!booking) {
        const err = new Error("Booking not found");
        err.statusCode = 404;
        throw err;
      }

      const id = generateId("pay");
      const receiptNo = `REC-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const label = dateLabel || new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

      await conn.execute(
        `INSERT INTO payments (
          id, receipt_no, booking_id, booking_receipt_no, applicant_name,
          event_title, type, amount, mode, reference, date_label
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ]
      );

      await conn.execute("UPDATE bookings SET paid = paid + ? WHERE id = ?", [numAmount, booking.id]);

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Payment",
        action: `Recorded ${type} ₹${numAmount.toLocaleString("en-IN")}`,
        detail: `Receipt ${receiptNo} for #${booking.receipt_no} (${booking.applicant_name}, ${mode})`,
        category: "Money",
        alertTitle: `Payment Received — ₹${numAmount.toLocaleString("en-IN")}`,
        alertDetail: `${booking.applicant_name} (#${booking.receipt_no} · ${mode})`,
        href: "/payments",
      });

      const [rows] = await conn.execute("SELECT * FROM payments WHERE id = ? LIMIT 1", [id]);
      return mapPayment(rows[0]);
    });

    res.status(201).json({ success: true, payment: created });
  })
);

router.post(
  "/expenses",
  asyncHandler(async (req, res) => {
    const { title, category = "Supplies", amount, paidTo, dateLabel } = req.body || {};
    const numAmount = Number(amount);
    if (!title || !paidTo || !Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, message: "Title, paidTo, and positive amount are required." });
    }

    const created = await withTransaction(async (conn) => {
      const id = generateId("exp");
      const label = dateLabel || new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      await conn.execute(
        `INSERT INTO expenses (id, title, category, amount, paid_to, date_label, status)
         VALUES (?, ?, ?, ?, ?, ?, 'Pending')`,
        [id, title, category, numAmount, paidTo, label]
      );

      await conn.execute(
        `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
         VALUES (?, 'Expense', ?, ?, ?, ?, ?, 'Pending')`,
        [
          generateId("apr"),
          title,
          `${category} · Paid to ${paidTo}`,
          `₹${numAmount.toLocaleString("en-IN")}`,
          req.user.name || req.user.userId,
          id.toUpperCase(),
        ]
      );

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Payment",
        action: `Logged expense ₹${numAmount.toLocaleString("en-IN")}`,
        detail: `${title} (${category}) · Paid to ${paidTo}`,
        category: "Approvals",
        alertTitle: `Expense Approval Needed — ₹${numAmount.toLocaleString("en-IN")}`,
        alertDetail: `${title} · ${paidTo}`,
        href: "/payments?tab=expenses",
      });

      const [rows] = await conn.execute("SELECT * FROM expenses WHERE id = ? LIMIT 1", [id]);
      return mapExpense(rows[0]);
    });

    res.status(201).json({ success: true, expense: created });
  })
);

router.patch(
  "/deposit-refunds/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const patch = req.body || {};

    const updated = await withTransaction(async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM deposit_refunds WHERE id = ? LIMIT 1", [id]);
      const current = rows[0];
      if (!current) {
        const err = new Error("Deposit refund record not found");
        err.statusCode = 404;
        throw err;
      }

      const nextStatus = patch.status ?? current.status;
      await conn.execute(
        `UPDATE deposit_refunds
         SET deduction_amount = ?, deduction_note = ?, refund_mode = ?, status = ?, upi_or_account = ?, remarks = ?
         WHERE id = ?`,
        [
          patch.deductionAmount ?? current.deduction_amount,
          patch.deductionNote ?? current.deduction_note,
          patch.refundMode ?? current.refund_mode,
          nextStatus,
          patch.upiOrAccount ?? current.upi_or_account,
          patch.remarks ?? current.remarks,
          id,
        ]
      );

      if (nextStatus === "Sent for Approval") {
        await conn.execute(
          `INSERT INTO approvals (id, type, title, detail, amount_label, requester, reference_no, status)
           VALUES (?, 'Deposit Refund', ?, ?, ?, ?, ?, 'Pending')`,
          [
            generateId("apr"),
            `Deposit Refund — ${current.applicant_name}`,
            `${current.event_title} (#${current.booking_receipt_no})`,
            `₹${Math.max(0, Number(current.held_amount) - Number(patch.deductionAmount ?? current.deduction_amount)).toLocaleString("en-IN")}`,
            req.user.name || req.user.userId,
            current.booking_receipt_no,
          ]
        );
      }

      await recordActivity(conn, {
        userLabel: req.user.name || req.user.role,
        module: "Payment",
        action: `Updated deposit refund #${current.booking_receipt_no}`,
        detail: `Status: ${nextStatus}`,
        category: "Money",
        alertTitle: `Deposit Refund (${nextStatus}) — #${current.booking_receipt_no}`,
        alertDetail: `${current.applicant_name} · ${current.event_title}`,
        href: "/payments?tab=refunds",
      });

      const [after] = await conn.execute("SELECT * FROM deposit_refunds WHERE id = ? LIMIT 1", [id]);
      const [items] = await conn.execute("SELECT * FROM deposit_deduction_items WHERE refund_id = ?", [id]);
      return mapDepositRefund(after[0], items);
    });

    res.json({ success: true, depositRefund: updated });
  })
);

module.exports = router;
