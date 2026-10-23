import assert from "node:assert";
import crypto from "node:crypto";

/**
 * Automated test suite to verify the isolated Meta webhook proxy on port 5001.
 * Tests:
 * 1. GET webhook verification is forwarded and succeeds (200 OK with challenge).
 * 2. POST webhook event is forwarded and acknowledged (200 OK with EVENT_RECEIVED).
 * 3. GET /health is blocked by proxy (404 Not Found).
 * 4. GET /api/v1/leads is blocked by proxy (404 Not Found).
 * 5. POST /api/v1/auth/login is blocked by proxy (404 Not Found).
 * 6. DELETE /api/v1/integrations/meta/webhook is rejected (405 Method Not Allowed).
 * 7. Query parameters (hub.mode, hub.challenge, hub.verify_token) are preserved across proxy.
 */

const PROXY_BASE = "http://127.0.0.1:5001";
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || "seeds_crm_meta_test_verify_token_2026";
const APP_SECRET = process.env.META_APP_SECRET || "ea79505ec45a82036951479b0edc20c8";

let totalTests = 0;
let passedTests = 0;

async function test(description: string, fn: () => Promise<void>) {
  totalTests++;
  try {
    await fn();
    console.log(`✅ PASS: ${description}`);
    passedTests++;
  } catch (err: any) {
    console.error(`❌ FAIL: ${description}`);
    console.error(`   ${err.message}`);
  }
}

async function runProxyTestSuite() {
  console.log("=== STARTING META WEBHOOK ISOLATED PROXY TEST SUITE ===\n");
  console.log(`Targeting Proxy URL: ${PROXY_BASE}\n`);

  // 1. GET Webhook verification forwarded correctly
  await test("Proxy forwards valid GET webhook verification handshake", async () => {
    const challenge = "test_proxy_challenge_998877";
    const url = `${PROXY_BASE}/api/v1/integrations/meta/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
      VERIFY_TOKEN
    )}&hub.challenge=${challenge}`;

    const res = await fetch(url, { method: "GET" });
    const text = await res.text();

    assert.strictEqual(res.status, 200, `Expected 200 OK, got ${res.status}`);
    assert.strictEqual(text, challenge, `Expected echoed challenge "${challenge}", got "${text}"`);
  });

  // 2. GET Webhook verification invalid token rejected by backend through proxy
  await test("Proxy forwards GET with invalid token and backend returns 403", async () => {
    const url = `${PROXY_BASE}/api/v1/integrations/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=test_challenge`;

    const res = await fetch(url, { method: "GET" });
    assert.strictEqual(res.status, 403, `Expected 403 Forbidden, got ${res.status}`);
  });

  // 3. POST Webhook event forwarded correctly
  await test("Proxy forwards POST webhook event and returns EVENT_RECEIVED", async () => {
    const url = `${PROXY_BASE}/api/v1/integrations/meta/webhook`;
    const payload = {
      object: "page",
      entry: [
        {
          id: "1234567890",
          time: 1718000000,
          changes: [
            {
              field: "leadgen",
              value: {
                leadgen_id: "test_leadgen_1001",
                page_id: "test_page_1001",
                form_id: "test_form_1001",
              },
            },
          ],
        },
      ],
    };

    const payloadStr = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", APP_SECRET).update(payloadStr).digest("hex");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body: payloadStr,
    });
    const text = await res.text();

    assert.strictEqual(res.status, 200, `Expected 200 OK, got ${res.status}`);
    assert.strictEqual(text, "EVENT_RECEIVED", `Expected body "EVENT_RECEIVED", got "${text}"`);
  });

  // 4. Isolation test: GET /health blocked with 404
  await test("Proxy BLOCKS GET /health with 404 Not Found", async () => {
    const res = await fetch(`${PROXY_BASE}/health`, { method: "GET" });
    assert.strictEqual(res.status, 404, `Expected 404 Not Found, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.error, "Not Found");
  });

  // 5. Isolation test: GET /api/v1/leads blocked with 404
  await test("Proxy BLOCKS GET /api/v1/leads with 404 Not Found", async () => {
    const res = await fetch(`${PROXY_BASE}/api/v1/leads`, { method: "GET" });
    assert.strictEqual(res.status, 404, `Expected 404 Not Found, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.error, "Not Found");
  });

  // 6. Isolation test: POST /api/v1/auth/login blocked with 404
  await test("Proxy BLOCKS POST /api/v1/auth/login with 404 Not Found", async () => {
    const res = await fetch(`${PROXY_BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@seeds.com", password: "Password123!" }),
    });
    assert.strictEqual(res.status, 404, `Expected 404 Not Found, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.error, "Not Found");
  });

  // 7. Isolation test: Method not allowed (DELETE on webhook endpoint) blocked with 405
  await test("Proxy BLOCKS unsupported HTTP method (DELETE) with 405 Method Not Allowed", async () => {
    const res = await fetch(`${PROXY_BASE}/api/v1/integrations/meta/webhook`, { method: "DELETE" });
    assert.strictEqual(res.status, 405, `Expected 405 Method Not Allowed, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.error, "Method Not Allowed");
  });

  console.log("\n==========================================");
  console.log(`TOTAL PROXY TESTS: ${totalTests}`);
  console.log(`PASSED: ${passedTests}`);
  console.log(`FAILED: ${totalTests - passedTests}`);
  console.log("==========================================\n");

  if (totalTests !== passedTests) {
    process.exit(1);
  }
}

runProxyTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
