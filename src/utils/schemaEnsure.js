const { query } = require("../config/db");

const CANONICAL_HALL_CHECK_ITEMS = [
  {
    id: "chk-1",
    label: "Chairs & tables count",
    helper: "Counted & unbroken (seating rows)",
  },
  {
    id: "chk-2",
    label: "Lights & electrical",
    helper: "All panels, switches & sockets",
  },
  {
    id: "chk-3",
    label: "Fans & air conditioning",
    helper: "Fans, AC units & remotes returned",
  },
  {
    id: "chk-4",
    label: "Sound system & stage",
    helper: "Mic, speakers, stage lights",
  },
  {
    id: "chk-5",
    label: "Washrooms",
    helper: "Taps, flush, cleanliness",
  },
  {
    id: "chk-6",
    label: "Kitchen & utensils",
    helper: "Gas, sinks, utensil count",
  },
  {
    id: "chk-7",
    label: "Floor, walls & doors",
    helper: "No stains, wall marks or damage",
  },
];

let schemaReadyPromise = null;

async function runSchemaMigrations() {
  // 1. Ensure inspection_photos table + checklist_item_id column
  await query(`
    CREATE TABLE IF NOT EXISTS inspection_photos (
      id VARCHAR(64) PRIMARY KEY,
      booking_receipt_no VARCHAR(32) NOT NULL,
      mode ENUM('Before Event', 'After Event') NOT NULL DEFAULT 'Before Event',
      checklist_item_id VARCHAR(64) NULL,
      label VARCHAR(200) NOT NULL,
      is_issue TINYINT(1) NOT NULL DEFAULT 0,
      data_url LONGTEXT NOT NULL,
      size_kb INT NOT NULL DEFAULT 0,
      uploaded_by VARCHAR(100) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_insp_photos_booking (booking_receipt_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const cols = await query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inspection_photos' AND COLUMN_NAME = 'checklist_item_id'`
  );
  if (cols.length === 0) {
    await query(
      "ALTER TABLE inspection_photos ADD COLUMN checklist_item_id VARCHAR(64) NULL AFTER mode"
    );
  }

  // 2. Ensure per-booking checklist table
  await query(`
    CREATE TABLE IF NOT EXISTS booking_hall_checks (
      booking_receipt_no VARCHAR(32) NOT NULL,
      item_id VARCHAR(64) NOT NULL,
      status ENUM('OK', 'Issue') NOT NULL DEFAULT 'OK',
      issue_cost INT NOT NULL DEFAULT 0,
      note TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (booking_receipt_no, item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 3. Ensure all 7 canonical hall_check_items template rows exist with consistent labels
  for (const item of CANONICAL_HALL_CHECK_ITEMS) {
    await query(
      `INSERT INTO hall_check_items (id, label, helper, status, issue_cost, note)
       VALUES (?, ?, ?, 'OK', 0, '')
       ON DUPLICATE KEY UPDATE label = VALUES(label), helper = VALUES(helper), status = 'OK', issue_cost = 0, note = ''`,
      [item.id, item.label, item.helper]
    );
  }

  // 4. Deduplicate deposit_refunds per booking_receipt_no and enforce UNIQUE key
  const uniqueIdx = await query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deposit_refunds'
       AND COLUMN_NAME = 'booking_receipt_no' AND NON_UNIQUE = 0`
  );

  if (uniqueIdx.length === 0) {
    const dupGroups = await query(
      `SELECT booking_receipt_no FROM deposit_refunds
       GROUP BY booking_receipt_no HAVING COUNT(*) > 1`
    );
    for (const grp of dupGroups) {
      const rows = await query(
        `SELECT id FROM deposit_refunds
         WHERE booking_receipt_no = ?
         ORDER BY
           CASE status WHEN 'Refunded' THEN 3 WHEN 'Sent for Approval' THEN 2 ELSE 1 END DESC,
           deduction_amount DESC,
           updated_at DESC`,
        [grp.booking_receipt_no]
      );
      const keepId = rows[0]?.id;
      for (let i = 1; i < rows.length; i++) {
        const dropId = rows[i].id;
        if (dropId && dropId !== keepId) {
          await query("DELETE FROM deposit_refunds WHERE id = ?", [dropId]);
        }
      }
    }
    await query(
      "ALTER TABLE deposit_refunds ADD UNIQUE INDEX uq_refunds_receipt (booking_receipt_no)"
    );
  }
}

function ensureModule5AndFinanceSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = runSchemaMigrations().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

module.exports = {
  CANONICAL_HALL_CHECK_ITEMS,
  ensureModule5AndFinanceSchema,
};
