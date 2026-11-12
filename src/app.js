const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const env = require("./config/env");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

const healthRoutes = require("./routes/health");
const authRoutes = require("./routes/auth");
const bootstrapRoutes = require("./routes/bootstrap");
const bookingsRoutes = require("./routes/bookings");
const financeRoutes = require("./routes/finance");
const maintenanceRoutes = require("./routes/maintenance");
const attendanceRoutes = require("./routes/attendance");
const adminRoutes = require("./routes/admin");

const app = express();

// Trust reverse proxy headers behind cPanel LiteSpeed / Apache
app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(
  cors({
    origin: env.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: env.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests, please try again shortly." },
  })
);

if (env.nodeEnv !== "test") {
  app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Haji Mohamed Yunus Valibhoy Community Centre API",
    health: "/api/health",
  });
});

app.use("/api", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api", bootstrapRoutes);
app.use("/api", bookingsRoutes);
app.use("/api", financeRoutes);
app.use("/api", maintenanceRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api", adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

