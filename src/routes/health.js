const express = require("express");
const { testConnection } = require("../config/db");

const router = express.Router();

router.get("/health", async (req, res) => {
  let dbStatus = "unknown";
  let dbHealthy = false;
  try {
    dbHealthy = await testConnection();
    dbStatus = dbHealthy ? "connected" : "disconnected";
  } catch (err) {
    dbStatus = `error: ${err.code || "connection_failed"}`;
  }

  res.status(200).json({
    success: true,
    service: "community-center-api",
    status: "OK",
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;

