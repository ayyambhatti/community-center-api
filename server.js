require("dotenv").config();

const http = require("http");
const app = require("./src/app");
const env = require("./src/config/env");
const { closePool } = require("./src/config/db");

const server = http.createServer(app);

server.listen(env.port, () => {
  console.log(
    `[community-center-api] Listening on port ${env.port} (${env.nodeEnv})`
  );
});

async function shutdown(signal) {
  console.log(`[community-center-api] Received ${signal}, shutting down...`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = server;

