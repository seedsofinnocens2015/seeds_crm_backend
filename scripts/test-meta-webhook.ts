/**
 * Automated Test Suite for Meta / Facebook Lead Ads Webhook Endpoint
 * Tests:
 * 1. GET /api/v1/integrations/meta/webhook - Successful Verification
 *    - Valid hub.mode='subscribe', valid hub.verify_token matching config, hub.challenge echoed back with 200 OK.
 * 2. GET /api/v1/integrations/meta/webhook - Invalid Verify Token
 *    - Returns 403 Forbidden when token does not match.
 * 3. GET /api/v1/integrations/meta/webhook - Invalid / Missing hub.mode
 *    - Returns 403 Forbidden when mode !== 'subscribe'.
 * 4. GET /api/v1/integrations/meta/webhook - Missing Parameters
 *    - Returns 403 Forbidden when verify_token or challenge is absent.
 * 5. POST /api/v1/integrations/meta/webhook - Event Notification Acknowledgement
 *    - Returns 200 OK with 'EVENT_RECEIVED' string.
 *    - Safely processes standard Meta Page Leadgen change notification schema without errors.
 */

import crypto from "node:crypto";

const BASE_URL = "http://localhost:5000/api/v1";
const TEST_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || "seeds_crm_meta_test_verify_token_2026";
const TEST_APP_SECRET = process.env.META_APP_SECRET || "ea79505ec45a82036951479b0edc20c8";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, name: string, details: string) {
  results.push({ name, passed: condition, details });
  console.log(`${condition ? "✅ PASS" : "❌ FAIL"}: ${name} (${details})`);
}

async function run() {
  console.log("=== STARTING META WEBHOOK AUTOMATED TEST SUITE ===\n");
  console.log(`Targeting Base URL: ${BASE_URL}/integrations/meta/webhook\n`);

  // ── TEST 1: Successful Verification Handshake ──────────────────────────────
  console.log("--- Testing Webhook Verification (GET) ---");
  const validChallenge = "test_challenge_abc_123456";
  const verifyUrl = `${BASE_URL}/integrations/meta/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
    TEST_VERIFY_TOKEN
  )}&hub.challenge=${encodeURIComponent(validChallenge)}`;

  const verifyRes = await fetch(verifyUrl);
  const verifyBody = await verifyRes.text();

  assert(
    verifyRes.status === 200 && verifyBody === validChallenge,
    "GET Valid Webhook Verification Handshake",
    `Status: ${verifyRes.status}, Echoed Challenge: "${verifyBody}"`
  );

  // ── TEST 2: Invalid Verify Token ───────────────────────────────────────────
  const badTokenUrl = `${BASE_URL}/integrations/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong_token_xyz&hub.challenge=${encodeURIComponent(
    validChallenge
  )}`;
  const badTokenRes = await fetch(badTokenUrl);
  assert(
    badTokenRes.status === 403,
    "GET Invalid Token Rejected with 403",
    `Status: ${badTokenRes.status}`
  );

  // ── TEST 3: Invalid Mode ───────────────────────────────────────────────────
  const badModeUrl = `${BASE_URL}/integrations/meta/webhook?hub.mode=invalid_mode&hub.verify_token=${encodeURIComponent(
    TEST_VERIFY_TOKEN
  )}&hub.challenge=${encodeURIComponent(validChallenge)}`;
  const badModeRes = await fetch(badModeUrl);
  assert(
    badModeRes.status === 403,
    "GET Invalid Mode Rejected with 403",
    `Status: ${badModeRes.status}`
  );

  // ── TEST 4: Missing Parameters ─────────────────────────────────────────────
  // 4a. No parameters
  const noParamsRes = await fetch(`${BASE_URL}/integrations/meta/webhook`);
  assert(
    noParamsRes.status === 403,
    "GET Missing All Parameters Rejected with 403",
    `Status: ${noParamsRes.status}`
  );

  // 4b. Missing challenge
  const noChallengeUrl = `${BASE_URL}/integrations/meta/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
    TEST_VERIFY_TOKEN
  )}`;
  const noChallengeRes = await fetch(noChallengeUrl);
  assert(
    noChallengeRes.status === 403,
    "GET Missing Challenge Rejected with 403",
    `Status: ${noChallengeRes.status}`
  );

  // ── TEST 5: POST Notification Event Receiver ──────────────────────────────
  console.log("\n--- Testing Webhook Event Receiver (POST) ---");

  // Sample Meta Page leadgen payload format
  const sampleMetaPayload = {
    object: "page",
    entry: [
      {
        id: "109876543210987",
        time: 1792647950,
        changes: [
          {
            field: "leadgen",
            value: {
              ad_id: "444455556666",
              form_id: "777788889999",
              leadgen_id: "123456789012345",
              created_time: 1792647948,
              page_id: "109876543210987",
              adgroup_id: "111122223333",
            },
          },
        ],
      },
    ],
  };

  const payloadStr = JSON.stringify(sampleMetaPayload);
  const signature = crypto.createHmac("sha256", TEST_APP_SECRET).update(payloadStr).digest("hex");

  const postRes = await fetch(`${BASE_URL}/integrations/meta/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: payloadStr,
  });
  const postBody = await postRes.text();

  assert(
    postRes.status === 200 && postBody === "EVENT_RECEIVED",
    "POST Meta Leadgen Event Handled & Acknowledged",
    `Status: ${postRes.status}, Body: "${postBody}"`
  );

  // 5b. Empty or non-array entry notification
  const emptyPayloadStr = JSON.stringify({ object: "page", entry: [] });
  const emptySig = crypto.createHmac("sha256", TEST_APP_SECRET).update(emptyPayloadStr).digest("hex");

  const genericPostRes = await fetch(`${BASE_URL}/integrations/meta/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": `sha256=${emptySig}`,
    },
    body: emptyPayloadStr,
  });
  assert(
    genericPostRes.status === 200,
    "POST Empty Event Handled Safely with 200",
    `Status: ${genericPostRes.status}`
  );

  // ── SUMMARY REPORT ────────────────────────────────────────────────────────
  console.log("\n==========================================");
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`TOTAL META WEBHOOK TESTS: ${total}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log("==========================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
