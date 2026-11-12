-- Seed defaults for Haji Mohamed Yunus Valibhoy Community Centre API
-- Note: Default user password hashes are populated by `npm run db:init` (scripts/init-db.js)

SET NAMES utf8mb4;

INSERT INTO system_settings (
  id,
  centre_name,
  centre_location,
  geofence_latitude,
  geofence_longitude,
  geofence_radius_meters,
  require_gps_for_check_in,
  route_all_alerts_to_admin,
  base_rent_per_floor,
  ac_surcharge_per_floor,
  default_security_deposit,
  require_free_use_admin_approval
) VALUES (
  1,
  'Haji Mohamed Yunus Valibhoy Community Centre',
  'Dhari, Gujarat, India',
  21.3250054,
  71.0246248,
  200,
  1,
  1,
  5000,
  2000,
  15000,
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

