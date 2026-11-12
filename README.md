# Community Centre Backend API

Backend REST API for **Haji Mohamed Yunus Valibhoy Community Centre (Dhari)** built with **Node.js, Express, and MySQL2**.

> **Note:** This repository contains **only the backend API & MySQL schema**. The Next.js frontend lives in its own separate repository and is deployed to Vercel.

---

## Project Structure

- `server.js` — HTTP entrypoint (cPanel LiteSpeed `lsnode` / Passenger compatible via `process.env.PORT`)
- `src/app.js` — Express middleware (`helmet`, `cors`, `morgan`, rate limiting) and API router
- `src/config/db.js` — `mysql2/promise` connection pool (`utf8mb4` for `₹` symbol support)
- `src/routes/` — `health.js`, `auth.js`, `bootstrap.js`, `bookings.js`, `finance.js`, `maintenance.js`, `attendance.js`, `admin.js`
- `src/utils/geofence.js` — Server-side 200m Haversine GPS geofence verification (`21.3250054, 71.0246248`)
- `sql/schema.sql` — MySQL/MariaDB schema
- `sql/seed.sql` — Initial settings & hall checklist items
- `scripts/init-db.js` — Creates schema + seeds defaults + default bcrypt-hashed user accounts

---

## Local Development

```bash
cp .env.example .env
# Edit .env with your local MySQL credentials and JWT_SECRET
npm install
npm run db:init
npm run dev
```

Verify health check at `http://localhost:4000/api/health`.

---

## cPanel Shared Hosting Deployment (`api.hmyvalibhoycc-dhari.com`)

1. **Create Subdomain in cPanel → Domains**:
   - Domain: `api.hmyvalibhoycc-dhari.com`
   - Wait for AutoSSL / Let's Encrypt HTTPS certificate.
2. **Create MySQL Database & User in cPanel → MySQL® Databases**:
   - Create database (e.g. `cpaneluser_community_center`)
   - Create MySQL user with strong password and grant **All Privileges** on that database.
3. **Clone / Setup Node.js App in cPanel**:
   - Via SSH:
     ```bash
     cd ~
     git clone https://github.com/ayyambhatti/community-center-api.git api.hmyvalibhoycc-dhari.com
     cd ~/api.hmyvalibhoycc-dhari.com
     cp .env.example .env
     nano .env   # Fill DB_HOST=localhost, DB_NAME, DB_USER, DB_PASSWORD, JWT_SECRET, CORS_ORIGINS
     ```
   - In **cPanel → Setup Node.js App**:
     - Node.js version: `20.x`
     - Application mode: `Production`
     - Application root: `api.hmyvalibhoycc-dhari.com`
     - Application URL: `api.hmyvalibhoycc-dhari.com`
     - Application startup file: `server.js`
     - Click **Run NPM Install** (or run `npm install --omit=dev` via SSH).
4. **Initialize Database Tables & Seed Users**:
   ```bash
   npm run db:init
   ```
5. **Restart App & Verify**:
   ```bash
   mkdir -p tmp && touch tmp/restart.txt
   curl https://api.hmyvalibhoycc-dhari.com/api/health
   ```

---

## GitHub Actions Auto-Deploy (Optional)

Add these repository secrets in GitHub (**Settings → Secrets and variables → Actions**):
- `SERVER_HOST` — cPanel server hostname or IP
- `SERVER_USER` — cPanel SSH username
- `SERVER_SSH_KEY` or `SERVER_PASSWORD` — SSH credentials from hosting support
- `SERVER_PORT` — SSH port (usually `22`, unless hosting uses a custom port)

