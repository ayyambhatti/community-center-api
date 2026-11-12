process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-smoke-secret-key-minimum-32-chars";

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");
const app = require("../src/app");
const { closePool } = require("../src/config/db");
const { calculateDistanceMeters, isWithinGeofence, DEFAULT_COORDINATES } = require("../src/utils/geofence");

async function run() {
  // 1. Verify geofence math
  const zeroDist = calculateDistanceMeters(
    DEFAULT_COORDINATES.latitude,
    DEFAULT_COORDINATES.longitude,
    DEFAULT_COORDINATES.latitude,
    DEFAULT_COORDINATES.longitude
  );
  assert.strictEqual(zeroDist, 0);
  assert.strictEqual(isWithinGeofence(150, 200), true);
  assert.strictEqual(isWithinGeofence(250, 200), false);

  // 2. Start Express app on ephemeral localhost port
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const rootRes = await fetch(`${baseUrl}/`);
    assert.strictEqual(rootRes.status, 200);
    const rootJson = await rootRes.json();
    assert.strictEqual(rootJson.success, true);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.strictEqual(healthJson.status, "OK");

    // Login payload validation
    const badLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "", password: "" }),
    });
    assert.strictEqual(badLoginRes.status, 400);

    // Self-registration as Admin must be blocked (403)
    const adminRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "evil", name: "Evil", role: "Admin", password: "password123" }),
    });
    assert.strictEqual(adminRegRes.status, 403);

    // Unauthenticated access to protected routes must return 401
    const unauthRes = await fetch(`${baseUrl}/api/bootstrap`);
    assert.strictEqual(unauthRes.status, 401);

    // Non-admin JWT on Admin-only routes must return 403
    const managerToken = jwt.sign(
      { sub: "u-2", userId: "manager", name: "Centre Manager", role: "Manager" },
      process.env.JWT_SECRET
    );
    for (const protectedAdminPath of ["/api/settings", "/api/users"]) {
      const forbiddenRes = await fetch(`${baseUrl}${protectedAdminPath}`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.strictEqual(forbiddenRes.status, 403);
    }

    const forbiddenPutPerm = await fetch(`${baseUrl}/api/permissions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${managerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permissions: [] }),
    });
    assert.strictEqual(forbiddenPutPerm.status, 403);

    // Unknown route returns JSON 404
    const missingRes = await fetch(`${baseUrl}/api/non-existent-route`);
    assert.strictEqual(missingRes.status, 404);

    console.log("[smoke-test] All HTTP, auth, registration guard, RBAC, and geofence checks passed.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closePool();
  }
}

run().catch((err) => {
  console.error("[smoke-test] Failed:", err);
  process.exit(1);
});
