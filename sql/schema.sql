-- Schema for Haji Mohamed Yunus Valibhoy Community Centre API
-- Compatible with MySQL 8.0+ and MariaDB 10.6+ (cPanel shared hosting)

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  role ENUM('Admin', 'Manager', 'Accountant', 'Staff') NOT NULL DEFAULT 'Staff',
  password_hash VARCHAR(255) NOT NULL,
  last_login VARCHAR(64) NOT NULL DEFAULT 'Never',
  active TINYINT(1) NOT NULL DEFAULT 1,
  approval_status ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Approved',
  approved_by VARCHAR(64) NULL,
  approved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  id VARCHAR(64) PRIMARY KEY,
  role ENUM('Admin', 'Manager', 'Accountant', 'Staff') NOT NULL,
  module VARCHAR(64) NOT NULL,
  can_view TINYINT(1) NOT NULL DEFAULT 0,
  can_create TINYINT(1) NOT NULL DEFAULT 0,
  can_edit TINYINT(1) NOT NULL DEFAULT 0,
  can_approve TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_role_module (role, module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_settings (
  id TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
  centre_name VARCHAR(200) NOT NULL,
  centre_location VARCHAR(200) NOT NULL,
  centre_phone VARCHAR(32) NOT NULL DEFAULT '',
  geofence_latitude DECIMAL(10, 7) NOT NULL,
  geofence_longitude DECIMAL(10, 7) NOT NULL,
  geofence_radius_meters INT NOT NULL DEFAULT 200,
  require_gps_for_check_in TINYINT(1) NOT NULL DEFAULT 1,
  route_all_alerts_to_admin TINYINT(1) NOT NULL DEFAULT 1,
  base_rent_per_floor INT NOT NULL DEFAULT 5000,
  ac_surcharge_per_floor INT NOT NULL DEFAULT 2000,
  default_security_deposit INT NOT NULL DEFAULT 15000,
  max_upload_size_mb INT NOT NULL DEFAULT 5,
  require_free_use_admin_approval TINYINT(1) NOT NULL DEFAULT 1,
  require_booking_admin_approval TINYINT(1) NOT NULL DEFAULT 1,
  require_user_admin_approval TINYINT(1) NOT NULL DEFAULT 1,
  require_expense_admin_approval TINYINT(1) NOT NULL DEFAULT 1,
  require_refund_admin_approval TINYINT(1) NOT NULL DEFAULT 1,
  require_repair_admin_approval TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS applicants (
  id VARCHAR(64) PRIMARY KEY,
  customer_code VARCHAR(32) NULL,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  address TEXT NOT NULL,
  id_proof_masked VARCHAR(64) NOT NULL,
  notes TEXT NOT NULL,
  member_since VARCHAR(32) NULL,
  preferences_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_applicants_phone (phone),
  INDEX idx_applicants_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bookings (
  id VARCHAR(64) PRIMARY KEY,
  receipt_no VARCHAR(32) NOT NULL UNIQUE,
  event_title VARCHAR(180) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  applicant_id VARCHAR(64) NULL,
  applicant_name VARCHAR(150) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  hall ENUM('Ground Floor', 'Ground + First Floor') NOT NULL DEFAULT 'Ground Floor',
  is_ac TINYINT(1) NOT NULL DEFAULT 0,
  date_iso CHAR(10) NOT NULL,
  end_date_iso CHAR(10) NULL,
  date_label VARCHAR(64) NOT NULL,
  timing VARCHAR(80) NOT NULL,
  guests INT NOT NULL DEFAULT 0,
  rent INT NOT NULL DEFAULT 0,
  deposit INT NOT NULL DEFAULT 0,
  paid INT NOT NULL DEFAULT 0,
  status ENUM('Confirmed', 'Pending', 'Awaiting approval', 'Completed', 'Cancelled') NOT NULL DEFAULT 'Awaiting approval',
  is_free_use TINYINT(1) NOT NULL DEFAULT 0,
  notes TEXT NULL,
  payment_mode ENUM('Cash', 'UPI', 'Bank Transfer', 'Cheque') NULL,
  created_at_label VARCHAR(64) NULL,
  created_by VARCHAR(64) NULL,
  pre_inspection_done TINYINT(1) NOT NULL DEFAULT 0,
  post_inspection_done TINYINT(1) NOT NULL DEFAULT 0,
  deposit_status ENUM('Held', 'Awaiting inspection', 'Ready to Refund', 'Refunded', 'N/A') NOT NULL DEFAULT 'Held',
  cancellation_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_bookings_date (date_iso, end_date_iso),
  INDEX idx_bookings_status (status),
  CONSTRAINT fk_bookings_applicant FOREIGN KEY (applicant_id) REFERENCES applicants(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id VARCHAR(64) PRIMARY KEY,
  receipt_no VARCHAR(48) NOT NULL UNIQUE,
  booking_id VARCHAR(64) NOT NULL,
  booking_receipt_no VARCHAR(32) NOT NULL,
  applicant_name VARCHAR(150) NOT NULL,
  event_title VARCHAR(180) NOT NULL,
  type ENUM('Advance', 'Rent Balance', 'Security Deposit') NOT NULL,
  amount INT NOT NULL,
  mode ENUM('Cash', 'UPI', 'Bank Transfer', 'Cheque') NOT NULL,
  reference VARCHAR(120) NOT NULL DEFAULT '',
  date_label VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payments_booking (booking_id),
  CONSTRAINT fk_payments_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS expenses (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  category ENUM('Cleaning', 'Electricity', 'Water', 'Repair', 'Supplies') NOT NULL,
  amount INT NOT NULL,
  paid_to VARCHAR(150) NOT NULL,
  date_label VARCHAR(64) NOT NULL,
  status ENUM('Approved', 'Pending') NOT NULL DEFAULT 'Pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS deposit_refunds (
  id VARCHAR(64) PRIMARY KEY,
  booking_receipt_no VARCHAR(32) NOT NULL,
  applicant_name VARCHAR(150) NOT NULL,
  event_title VARCHAR(180) NOT NULL,
  event_date VARCHAR(64) NOT NULL,
  held_amount INT NOT NULL,
  deduction_amount INT NOT NULL DEFAULT 0,
  deduction_note TEXT NOT NULL,
  refund_mode ENUM('Cash', 'UPI', 'Bank Transfer', 'Cheque') NOT NULL DEFAULT 'UPI',
  status ENUM('Ready to Refund', 'Sent for Approval', 'Refunded') NOT NULL DEFAULT 'Ready to Refund',
  collected_label VARCHAR(64) NULL,
  inspection_ref VARCHAR(64) NULL,
  upi_or_account VARCHAR(120) NULL,
  remarks TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_refunds_receipt (booking_receipt_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS deposit_deduction_items (
  id VARCHAR(64) PRIMARY KEY,
  refund_id VARCHAR(64) NOT NULL,
  item VARCHAR(200) NOT NULL,
  location VARCHAR(120) NOT NULL,
  photos_count INT NOT NULL DEFAULT 0,
  amount INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_deduction_refund FOREIGN KEY (refund_id) REFERENCES deposit_refunds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id VARCHAR(64) PRIMARY KEY,
  ticket_no VARCHAR(48) NOT NULL UNIQUE,
  title VARCHAR(200) NOT NULL,
  category ENUM('Plumbing', 'Electrical', 'AC / Fans', 'Carpentry', 'Civil', 'Furniture', 'Cleaning') NOT NULL,
  sub_category VARCHAR(80) NULL,
  location VARCHAR(150) NOT NULL,
  priority ENUM('Low', 'Medium', 'High', 'Normal', 'Urgent') NOT NULL DEFAULT 'Medium',
  estimated_cost INT NOT NULL DEFAULT 0,
  raised_by VARCHAR(100) NOT NULL,
  date_label VARCHAR(64) NOT NULL,
  status ENUM('Pending', 'Approved', 'In Progress', 'Completed', 'Draft') NOT NULL DEFAULT 'Pending',
  description TEXT NULL,
  attachments_label VARCHAR(120) NULL,
  photos_json JSON NULL,
  block_hall TINYINT(1) NOT NULL DEFAULT 0,
  block_date_iso CHAR(10) NULL,
  block_from VARCHAR(32) NULL,
  block_to VARCHAR(32) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS maintenance_quotations (
  id VARCHAR(64) PRIMARY KEY,
  ticket_id VARCHAR(64) NOT NULL,
  vendor VARCHAR(150) NOT NULL,
  file_name VARCHAR(200) NOT NULL,
  amount INT NOT NULL,
  CONSTRAINT fk_quotation_ticket FOREIGN KEY (ticket_id) REFERENCES maintenance_tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hall_check_items (
  id VARCHAR(64) PRIMARY KEY,
  label VARCHAR(180) NOT NULL,
  helper VARCHAR(255) NOT NULL,
  status ENUM('OK', 'Issue') NOT NULL DEFAULT 'OK',
  issue_cost INT NOT NULL DEFAULT 0,
  note TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_attendance (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  role_title VARCHAR(100) NOT NULL,
  check_in_time VARCHAR(32) NOT NULL DEFAULT '—',
  check_out_time VARCHAR(32) NOT NULL DEFAULT '—',
  geo_verified TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('Present', 'Late', 'Absent') NOT NULL DEFAULT 'Present',
  present_days INT NOT NULL DEFAULT 0,
  late_days INT NOT NULL DEFAULT 0,
  absent_days INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_attendance_logs (
  id VARCHAR(64) PRIMARY KEY,
  staff_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NULL,
  date_iso CHAR(10) NOT NULL,
  name VARCHAR(120) NOT NULL,
  role_title VARCHAR(100) NOT NULL,
  check_in_time VARCHAR(32) NOT NULL,
  check_out_time VARCHAR(32) NOT NULL DEFAULT '—',
  geo_verified TINYINT(1) NOT NULL DEFAULT 0,
  distance_meters INT NULL,
  latitude DECIMAL(10, 7) NULL,
  longitude DECIMAL(10, 7) NULL,
  status ENUM('Present', 'Late', 'Absent') NOT NULL DEFAULT 'Present',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_attendance_date (date_iso)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approvals (
  id VARCHAR(64) PRIMARY KEY,
  type ENUM('Booking', 'Free Hall Use', 'Booking Cancellation', 'User Access', 'Password Reset', 'Deposit Refund', 'Expense', 'Repair Cost', 'Hall Block') NOT NULL,
  title VARCHAR(200) NOT NULL,
  detail TEXT NOT NULL,
  amount_label VARCHAR(64) NOT NULL,
  requester VARCHAR(100) NOT NULL,
  reference_no VARCHAR(64) NOT NULL,
  status ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending',
  decided_by VARCHAR(64) NULL,
  decided_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(64) PRIMARY KEY,
  category ENUM('Money', 'Bookings', 'Repairs', 'Approvals', 'Attendance') NOT NULL,
  title VARCHAR(200) NOT NULL,
  detail TEXT NOT NULL,
  time_label VARCHAR(64) NOT NULL,
  unread TINYINT(1) NOT NULL DEFAULT 1,
  href VARCHAR(180) NOT NULL DEFAULT '/dashboard',
  audience ENUM('admin', 'all') NOT NULL DEFAULT 'admin',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  time_label VARCHAR(64) NOT NULL,
  user_label VARCHAR(80) NOT NULL,
  module ENUM('Booking', 'Payment', 'Maintenance', 'Approval', 'User', 'Attendance', 'Settings') NOT NULL,
  action VARCHAR(200) NOT NULL,
  detail TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS action_items (
  id VARCHAR(64) PRIMARY KEY,
  tag ENUM('PAY', 'INS', 'REF', 'BK', 'FIX') NOT NULL,
  title VARCHAR(200) NOT NULL,
  detail TEXT NOT NULL,
  button_label VARCHAR(80) NOT NULL,
  success_message VARCHAR(200) NOT NULL,
  link_url VARCHAR(180) NULL,
  completed TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
