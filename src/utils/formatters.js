function parseJsonArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapUser(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    role: row.role,
    lastLogin: row.last_login,
    active: Boolean(row.active),
  };
}

function mapSystemSettings(row) {
  return {
    centreName: row.centre_name,
    centreLocation: row.centre_location,
    geofenceLatitude: Number(row.geofence_latitude),
    geofenceLongitude: Number(row.geofence_longitude),
    geofenceRadiusMeters: Number(row.geofence_radius_meters),
    requireGpsForCheckIn: Boolean(row.require_gps_for_check_in),
    routeAllAlertsToAdmin: Boolean(row.route_all_alerts_to_admin),
    baseRentPerFloor: Number(row.base_rent_per_floor),
    acSurchargePerFloor: Number(row.ac_surcharge_per_floor),
    defaultSecurityDeposit: Number(row.default_security_deposit),
    requireFreeUseAdminApproval: Boolean(row.require_free_use_admin_approval),
  };
}

function mapApplicant(row) {
  return {
    id: row.id,
    customerCode: row.customer_code || undefined,
    name: row.name,
    phone: row.phone,
    address: row.address,
    idProofMasked: row.id_proof_masked,
    notes: row.notes,
    memberSince: row.member_since || undefined,
    preferences: parseJsonArray(row.preferences_json),
  };
}

function mapBooking(row) {
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    eventTitle: row.event_title,
    eventType: row.event_type,
    applicantId: row.applicant_id || "",
    applicantName: row.applicant_name,
    phone: row.phone,
    hall: row.hall,
    isAC: Boolean(row.is_ac),
    dateISO: row.date_iso,
    endDateISO: row.end_date_iso || undefined,
    dateLabel: row.date_label,
    timing: row.timing,
    guests: Number(row.guests),
    rent: Number(row.rent),
    deposit: Number(row.deposit),
    paid: Number(row.paid),
    status: row.status,
    isFreeUse: Boolean(row.is_free_use),
    notes: row.notes || undefined,
    paymentMode: row.payment_mode || undefined,
    createdAtLabel: row.created_at_label || undefined,
    createdBy: row.created_by || undefined,
    preInspectionDone: Boolean(row.pre_inspection_done),
    postInspectionDone: Boolean(row.post_inspection_done),
    depositStatus: row.deposit_status,
    cancellationReason: row.cancellation_reason || undefined,
  };
}

function mapPayment(row) {
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    bookingId: row.booking_id,
    bookingReceiptNo: row.booking_receipt_no,
    applicantName: row.applicant_name,
    eventTitle: row.event_title,
    type: row.type,
    amount: Number(row.amount),
    mode: row.mode,
    reference: row.reference,
    dateLabel: row.date_label,
  };
}

function mapExpense(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    amount: Number(row.amount),
    paidTo: row.paid_to,
    dateLabel: row.date_label,
    status: row.status,
  };
}

function mapDepositRefund(row, deductionItems = []) {
  return {
    id: row.id,
    bookingReceiptNo: row.booking_receipt_no,
    applicantName: row.applicant_name,
    eventTitle: row.event_title,
    eventDate: row.event_date,
    heldAmount: Number(row.held_amount),
    deductionAmount: Number(row.deduction_amount),
    deductionNote: row.deduction_note,
    refundMode: row.refund_mode,
    status: row.status,
    collectedLabel: row.collected_label || undefined,
    inspectionRef: row.inspection_ref || undefined,
    upiOrAccount: row.upi_or_account || undefined,
    remarks: row.remarks || undefined,
    deductionItems: deductionItems.map((item) => ({
      id: item.id,
      item: item.item,
      location: item.location,
      photosCount: Number(item.photos_count),
      amount: Number(item.amount),
    })),
  };
}

function mapMaintenanceTicket(row, quotations = []) {
  return {
    id: row.id,
    ticketNo: row.ticket_no,
    title: row.title,
    category: row.category,
    subCategory: row.sub_category || undefined,
    location: row.location,
    priority: row.priority,
    estimatedCost: Number(row.estimated_cost),
    raisedBy: row.raised_by,
    dateLabel: row.date_label,
    status: row.status,
    description: row.description || undefined,
    attachmentsLabel: row.attachments_label || undefined,
    photos: parseJsonArray(row.photos_json),
    quotations: quotations.map((q) => ({
      id: q.id,
      vendor: q.vendor,
      fileName: q.file_name,
      amount: Number(q.amount),
    })),
    blockHall: Boolean(row.block_hall),
    blockDateISO: row.block_date_iso || undefined,
    blockFrom: row.block_from || undefined,
    blockTo: row.block_to || undefined,
  };
}

function mapHallCheckItem(row) {
  return {
    id: row.id,
    label: row.label,
    helper: row.helper,
    status: row.status,
    issueCost: Number(row.issue_cost),
    note: row.note,
  };
}

function mapStaffAttendance(row) {
  return {
    id: row.id,
    name: row.name,
    roleTitle: row.role_title,
    checkInTime: row.check_in_time,
    checkOutTime: row.check_out_time,
    geoVerified: Boolean(row.geo_verified),
    status: row.status,
    presentDays: Number(row.present_days),
    lateDays: Number(row.late_days),
    absentDays: Number(row.absent_days),
  };
}

function mapStaffAttendanceLog(row) {
  return {
    id: row.id,
    staffId: row.staff_id,
    dateISO: row.date_iso,
    name: row.name,
    roleTitle: row.role_title,
    checkInTime: row.check_in_time,
    checkOutTime: row.check_out_time,
    geoVerified: Boolean(row.geo_verified),
    distanceMeters: row.distance_meters !== null ? Number(row.distance_meters) : null,
    status: row.status,
  };
}

function mapApproval(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    detail: row.detail,
    amountLabel: row.amount_label,
    requester: row.requester,
    referenceNo: row.reference_no,
    status: row.status,
  };
}

function mapNotification(row) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    detail: row.detail,
    timeLabel: row.time_label,
    unread: Boolean(row.unread),
    href: row.href,
    audience: row.audience,
  };
}

function mapAuditLog(row) {
  return {
    id: row.id,
    timeLabel: row.time_label,
    userLabel: row.user_label,
    module: row.module,
    action: row.action,
    detail: row.detail,
  };
}

function mapActionItem(row) {
  return {
    id: row.id,
    tag: row.tag,
    title: row.title,
    detail: row.detail,
    buttonLabel: row.button_label,
    successMessage: row.success_message,
    linkUrl: row.link_url || undefined,
    completed: Boolean(row.completed),
  };
}

module.exports = {
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
};

