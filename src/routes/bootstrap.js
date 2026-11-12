const express = require("express");
const { query } = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { getSystemSettings } = require("../utils/audit");
const {
  mapUser,
  mapSystemSettings,
  mapApplicant,
  mapBooking,
  mapPayment,
  mapExpense,
  mapDepositRefund,
  mapMaintenanceTicket,
  mapHallCheckItem,
  mapStaffAttendance,
  mapStaffAttendanceLog,
  mapApproval,
  mapNotification,
  mapAuditLog,
  mapActionItem,
} = require("../utils/formatters");

const router = express.Router();

/**
 * Returns full initial state required by DashboardContext, filtering Admin-only fields safely.
 */
router.get(
  "/bootstrap",
  requireAuth,
  asyncHandler(async (req, res) => {
    const isAdmin = (req.user?.role || "").toLowerCase() === "admin";

    const [
      settingsRow,
      bookingsRows,
      applicantsRows,
      paymentsRows,
      expensesRows,
      refundsRows,
      deductionRows,
      ticketsRows,
      quotationsRows,
      checkItemRows,
      attendanceRows,
      attendanceLogRows,
      approvalRows,
      notificationRows,
      auditLogRows,
      actionItemRows,
      usersRows,
    ] = await Promise.all([
      getSystemSettings(),
      query("SELECT * FROM bookings ORDER BY date_iso ASC, created_at DESC"),
      query("SELECT * FROM applicants ORDER BY name ASC"),
      query("SELECT * FROM payments ORDER BY created_at DESC"),
      query("SELECT * FROM expenses ORDER BY created_at DESC"),
      query("SELECT * FROM deposit_refunds ORDER BY created_at DESC"),
      query("SELECT * FROM deposit_deduction_items"),
      query("SELECT * FROM maintenance_tickets ORDER BY created_at DESC"),
      query("SELECT * FROM maintenance_quotations"),
      query("SELECT * FROM hall_check_items ORDER BY id ASC"),
      query("SELECT * FROM staff_attendance ORDER BY name ASC"),
      query("SELECT * FROM staff_attendance_logs ORDER BY created_at DESC LIMIT 200"),
      query("SELECT * FROM approvals ORDER BY created_at DESC"),
      isAdmin
        ? query("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100")
        : query("SELECT * FROM notifications WHERE audience = 'all' ORDER BY created_at DESC LIMIT 100"),
      query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200"),
      query("SELECT * FROM action_items WHERE completed = 0 ORDER BY created_at ASC"),
      isAdmin
        ? query("SELECT id, user_id, name, role, last_login, active FROM users ORDER BY created_at ASC")
        : Promise.resolve([]),
    ]);

    const deductionsByRefund = new Map();
    for (const item of deductionRows) {
      const list = deductionsByRefund.get(item.refund_id) || [];
      list.push(item);
      deductionsByRefund.set(item.refund_id, list);
    }

    const quotationsByTicket = new Map();
    for (const q of quotationsRows) {
      const list = quotationsByTicket.get(q.ticket_id) || [];
      list.push(q);
      quotationsByTicket.set(q.ticket_id, list);
    }

    res.json({
      success: true,
      data: {
        systemSettings: mapSystemSettings(settingsRow),
        bookings: bookingsRows.map(mapBooking),
        applicants: applicantsRows.map(mapApplicant),
        payments: paymentsRows.map(mapPayment),
        expenses: expensesRows.map(mapExpense),
        depositRefunds: refundsRows.map((r) =>
          mapDepositRefund(r, deductionsByRefund.get(r.id) || [])
        ),
        maintenanceTickets: ticketsRows.map((t) =>
          mapMaintenanceTicket(t, quotationsByTicket.get(t.id) || [])
        ),
        hallCheckItems: checkItemRows.map(mapHallCheckItem),
        staffAttendance: attendanceRows.map(mapStaffAttendance),
        staffAttendanceLogs: attendanceLogRows.map(mapStaffAttendanceLog),
        approvals: approvalRows.map(mapApproval),
        notifications: notificationRows.map(mapNotification),
        auditLogs: auditLogRows.map(mapAuditLog),
        actionItems: actionItemRows.map(mapActionItem),
        users: usersRows.map(mapUser),
      },
    });
  })
);

module.exports = router;

