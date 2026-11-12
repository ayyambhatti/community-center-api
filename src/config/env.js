function parseOrigins(raw) {
  if (!raw || raw.trim() === "*") return "*";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || "community_center",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    connectionLimit: Math.min(10, Math.max(2, Number(process.env.DB_CONNECTION_LIMIT || 8))),
  },
  jwt: {
    secret: process.env.JWT_SECRET || "dev-insecure-secret-change-in-production",
    expiresIn: process.env.JWT_EXPIRES_IN || "1d",
    rememberExpiresIn: process.env.JWT_REMEMBER_EXPIRES_IN || "30d",
  },
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 300),
};

module.exports = env;

