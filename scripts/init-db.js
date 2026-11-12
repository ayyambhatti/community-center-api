require("dotenv").config();

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const env = require("../src/config/env");

const DEFAULT_USERS = [
  { id: "u-1", userId: "admin", name: "Haji Valibhoy Trustee", role: "Admin", password: "admin123", lastLogin: "Today, 9:40 AM" },
  { id: "u-2", userId: "manager", name: "Centre Manager", role: "Manager", password: "manager123", lastLogin: "Today, 9:05 AM" },
  { id: "u-3", userId: "accounts", name: "Imtiyaz Accountant", role: "Accountant", password: "accounts123", lastLogin: "Yesterday, 6:15 PM" },
  { id: "u-4", userId: "caretaker", name: "Irfanbhai Bloch", role: "Staff", password: "staff123", lastLogin: "Today, 8:55 AM" },
];

async function runSqlStatements(conn, sqlText) {
  const statements = sqlText
    .split(/;\s*\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  for (const statement of statements) {
    await conn.query(statement);
  }
}

async function main() {
  console.log(`[db:init] Connecting to MySQL ${env.db.host}:${env.db.port} (${env.db.database})...`);
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    charset: "utf8mb4",
  });

  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, "../sql/schema.sql"), "utf8");
    const seedSql = fs.readFileSync(path.join(__dirname, "../sql/seed.sql"), "utf8");

    console.log("[db:init] Applying schema.sql...");
    await runSqlStatements(conn, schemaSql);

    console.log("[db:init] Applying seed.sql...");
    await runSqlStatements(conn, seedSql);

    console.log("[db:init] Seeding default users with bcrypt hashes...");
    for (const user of DEFAULT_USERS) {
      const hash = await bcrypt.hash(user.password, 10);
      await conn.execute(
        `INSERT INTO users (id, user_id, name, role, password_hash, last_login, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE id = id`,
        [user.id, user.userId, user.name, user.role, hash, user.lastLogin]
      );
    }

    console.log("[db:init] Database initialized successfully.");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("[db:init] Failed:", err.message);
  process.exit(1);
});

