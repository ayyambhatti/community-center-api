-- Seed defaults for Haji Mohamed Yunus Valibhoy Community Centre API
-- Note: Default user password hashes are populated by `npm run db:init` (scripts/init-db.js)

SET NAMES utf8mb4;

INSERT INTO system_settings (
  id,
  centre_name,
  centre_location,
  centre_phone,
  geofence_latitude,
  geofence_longitude,
  geofence_radius_meters,
  require_gps_for_check_in,
  route_all_alerts_to_admin,
  base_rent_per_floor,
  ac_surcharge_per_floor,
  default_security_deposit,
  max_upload_size_mb,
  require_free_use_admin_approval,
  require_booking_admin_approval,
  require_user_admin_approval,
  require_expense_admin_approval,
  require_refund_admin_approval,
  require_repair_admin_approval,
  require_payment_admin_approval,
  require_customer_edit_admin_approval,
  require_attendance_override_admin_approval
) VALUES (
  1,
  'Haji Mohamed Yunus Valibhoy Community Centre',
  'Dhari, Gujarat, India',
  '',
  21.3250054,
  71.0246248,
  200,
  1,
  1,
  5000,
  2000,
  15000,
  5,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1
) ON DUPLICATE KEY UPDATE id = id;

INSERT INTO hall_check_items (id, label, helper, status, issue_cost, note) VALUES
  ('chk-1', 'Main Hall Lighting & Chandeliers', 'Check all switches, bulbs, and emergency backup lights', 'OK', 0, ''),
  ('chk-2', 'Air Conditioning & Fans', 'Verify AC cooling and ceiling fans on Ground and First Floor', 'OK', 0, ''),
  ('chk-3', 'Washrooms & Water Supply', 'Inspect taps, flush tanks, drainage, and cleanliness', 'OK', 0, ''),
  ('chk-4', 'Kitchen & Dining Area', 'Check gas connections, sinks, and waste bins', 'OK', 0, ''),
  ('chk-5', 'Sound System & Microphones', 'Test amplifier, speakers, and wireless mics', 'OK', 0, ''),
  ('chk-6', 'Chairs, Tables & Stage Furniture', 'Confirm count and inspect for broken legs or upholstery tears', 'OK', 0, '')
ON DUPLICATE KEY UPDATE id = id;

-- Default Role & Permissions Matrix (Admin has full control & sole approval rights)
INSERT INTO role_permissions (id, role, module, can_view, can_create, can_edit, can_approve) VALUES
  ('rp-admin-dashboard', 'Admin', 'Dashboard', 1, 1, 1, 1),
  ('rp-admin-bookings', 'Admin', 'Bookings', 1, 1, 1, 1),
  ('rp-admin-calendar', 'Admin', 'Calendar', 1, 1, 1, 1),
  ('rp-admin-customers', 'Admin', 'Customers', 1, 1, 1, 1),
  ('rp-admin-payments', 'Admin', 'Payments', 1, 1, 1, 1),
  ('rp-admin-expenses', 'Admin', 'Expenses', 1, 1, 1, 1),
  ('rp-admin-refunds', 'Admin', 'Deposit Refunds', 1, 1, 1, 1),
  ('rp-admin-maintenance', 'Admin', 'Maintenance', 1, 1, 1, 1),
  ('rp-admin-inspections', 'Admin', 'Inspections', 1, 1, 1, 1),
  ('rp-admin-attendance', 'Admin', 'Attendance', 1, 1, 1, 1),
  ('rp-admin-approvals', 'Admin', 'Approvals', 1, 1, 1, 1),
  ('rp-admin-reports', 'Admin', 'Reports', 1, 1, 1, 1),
  ('rp-admin-users', 'Admin', 'Users', 1, 1, 1, 1),
  ('rp-admin-settings', 'Admin', 'Settings', 1, 1, 1, 1),
  ('rp-admin-audit', 'Admin', 'Audit Logs', 1, 0, 0, 1),

  ('rp-mgr-dashboard', 'Manager', 'Dashboard', 1, 0, 0, 0),
  ('rp-mgr-bookings', 'Manager', 'Bookings', 1, 1, 1, 0),
  ('rp-mgr-calendar', 'Manager', 'Calendar', 1, 1, 1, 0),
  ('rp-mgr-customers', 'Manager', 'Customers', 1, 1, 1, 0),
  ('rp-mgr-payments', 'Manager', 'Payments', 1, 1, 0, 0),
  ('rp-mgr-expenses', 'Manager', 'Expenses', 1, 1, 0, 0),
  ('rp-mgr-refunds', 'Manager', 'Deposit Refunds', 1, 1, 1, 0),
  ('rp-mgr-maintenance', 'Manager', 'Maintenance', 1, 1, 1, 0),
  ('rp-mgr-inspections', 'Manager', 'Inspections', 1, 1, 1, 0),
  ('rp-mgr-attendance', 'Manager', 'Attendance', 1, 1, 0, 0),
  ('rp-mgr-reports', 'Manager', 'Reports', 1, 0, 0, 0),

  ('rp-acc-dashboard', 'Accountant', 'Dashboard', 1, 0, 0, 0),
  ('rp-acc-bookings', 'Accountant', 'Bookings', 1, 0, 0, 0),
  ('rp-acc-customers', 'Accountant', 'Customers', 1, 0, 0, 0),
  ('rp-acc-payments', 'Accountant', 'Payments', 1, 1, 0, 0),
  ('rp-acc-expenses', 'Accountant', 'Expenses', 1, 1, 0, 0),
  ('rp-acc-refunds', 'Accountant', 'Deposit Refunds', 1, 1, 1, 0),
  ('rp-acc-reports', 'Accountant', 'Reports', 1, 0, 0, 0),

  ('rp-stf-dashboard', 'Staff', 'Dashboard', 1, 0, 0, 0),
  ('rp-stf-bookings', 'Staff', 'Bookings', 1, 0, 0, 0),
  ('rp-stf-calendar', 'Staff', 'Calendar', 1, 0, 0, 0),
  ('rp-stf-maintenance', 'Staff', 'Maintenance', 1, 1, 1, 0),
  ('rp-stf-inspections', 'Staff', 'Inspections', 1, 1, 1, 0),
  ('rp-stf-attendance', 'Staff', 'Attendance', 1, 1, 0, 0)
ON DUPLICATE KEY UPDATE id = id;
