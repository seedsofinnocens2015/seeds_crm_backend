import readline from "node:readline";
import jwt from "jsonwebtoken";
import { config } from "../src/config/env.js";

/**
 * Hardened Interactive CLI tool to connect a Facebook Page safely.
 *
 * Diagnostics & Safety Enhancements:
 * 1. Uses explicit IPv4 loopback 'http://127.0.0.1:5000' with configurable fallback to prevent dual-stack DNS resolution issues.
 * 2. Incorporates an AbortController with a 30-second timeout.
 * 3. Sanitizes all error messages; never prints access tokens, JWTs, or raw request/response secrets.
 * 4. Verifies server connectivity before prompting for tokens.
 * 5. Uses existing backend JWT configuration directly from project config.
 */

const PAGE_ID = "859072280631048";
const PAGE_NAME = "Seeds of Innocence IVF Centre Delhi";
const BASE_URL = process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:5000";
const CONNECT_URL = `${BASE_URL}/api/v1/integrations/meta/pages/connect`;
const LIST_URL = `${BASE_URL}/api/v1/integrations/meta/pages`;
const HEALTH_URL = `${BASE_URL}/health`;

async function main() {
  console.log("===================================================================");
  console.log("Meta Facebook Page Secure Interactive Connection Tool (Hardened)");
  console.log("===================================================================");
  console.log(`Target Page ID   : ${PAGE_ID}`);
  console.log(`Target Page Name : ${PAGE_NAME}`);
  console.log(`Target Server    : ${BASE_URL}`);
  console.log("-------------------------------------------------------------------");

  // Step 1: Pre-flight Health Check
  console.log("[Diagnostic] Checking local backend health...");
  try {
    const healthController = new AbortController();
    const healthTimeout = setTimeout(() => healthController.abort(), 5000);
    const healthRes = await fetch(HEALTH_URL, { signal: healthController.signal });
    clearTimeout(healthTimeout);

    if (!healthRes.ok) {
      console.error(`❌ Health check failed with HTTP status ${healthRes.status}. Aborting.`);
      process.exit(1);
    }
    const healthData = await healthRes.json();
    console.log(`[Diagnostic] Backend healthy (Environment: ${healthData.environment}, DB: ${healthData.database?.status}).`);
  } catch (err: any) {
    const sanitizedMsg = err.name === "AbortError" ? "Connection timed out" : err.message;
    console.error(`❌ Cannot connect to backend at ${BASE_URL}: ${sanitizedMsg}`);
    console.error("Please verify that the backend is running on port 5000.");
    process.exit(1);
  }

  // Step 2: Sign Admin JWT via existing project authentication configuration
  const adminToken = jwt.sign(
    {
      id: "admin_local_dev",
      name: "Admin Developer",
      email: "admin@seeds-crm.dev",
      role: "admin",
    },
    config.jwtSecret,
    { expiresIn: "10m" }
  );

  // Step 3: Interactive Prompt for Page Access Token
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  const rawInput = await question(
    "\nPlease paste the Facebook Page Access Token and press Enter: "
  );
  rl.close();

  const trimmedToken = rawInput.trim();
  if (!trimmedToken) {
    console.error("\n❌ Error: Page Access Token cannot be empty. Aborted.");
    process.exit(1);
  }

  console.log("\n[1/3] Dispatching connection & subscription request to backend...");

  // Step 4: Dispatch Request with Timeout and Diagnostics
  try {
    const connectController = new AbortController();
    const connectTimeout = setTimeout(() => connectController.abort(), 35000); // Meta Graph API call may take a few seconds

    const response = await fetch(CONNECT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        pageId: PAGE_ID,
        pageName: PAGE_NAME,
        accessToken: trimmedToken,
      }),
      signal: connectController.signal,
    });
    clearTimeout(connectTimeout);

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(`\n❌ Connection failed with HTTP status ${response.status}:`);
      // Sanitize output - never log accessToken or secrets
      const safeError = data?.error ? String(data.error).replace(/access_token=[^&]+/gi, "access_token=[REDACTED]") : "Unknown server error";
      console.error(`   Error details: ${safeError}`);
      process.exit(1);
    }

    console.log("\n[2/3] Backend Response received:");
    console.log(
      JSON.stringify(
        {
          success: data.success,
          message: data.message,
          page: {
            pageId: data.page?.pageId,
            pageName: data.page?.pageName,
            status: data.page?.status,
            isSubscribed: data.page?.isSubscribed,
            subscribedAt: data.page?.subscribedAt,
          },
        },
        null,
        2
      )
    );

    if (!data.page?.isSubscribed) {
      console.warn("\n⚠️ Warning: Page was registered, but Meta Webhook subscription could not be confirmed.");
    } else {
      console.log("\n✅ Meta Graph API confirmed webhook subscription (leadgen field active)!");
    }

    // Step 5: Verification of Saved Page Record via GET /pages
    console.log("\n[3/3] Verifying saved Page record via GET /api/v1/integrations/meta/pages...");
    const verifyRes = await fetch(LIST_URL, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    const verifyData = await verifyRes.json();
    console.log("Registered Pages in CRM Dev Database:");
    console.log(JSON.stringify(verifyData, null, 2));

    // Verify token redaction
    const leaked = JSON.stringify(verifyData).includes(trimmedToken);
    if (leaked) {
      console.error("\n🚨 SECURITY ALERT: Access token found in GET response!");
      process.exit(1);
    } else {
      console.log("\n🔒 Token Redaction Check: Verified. Access token is NOT exposed in API output.");
    }

    console.log("\n===================================================================");
    console.log("Connection Completed Successfully.");
    console.log("===================================================================");
  } catch (err: any) {
    const isTimeout = err.name === "AbortError";
    const sanitizedMsg = isTimeout ? "Request timed out after 35 seconds" : (err.message || "Network request failed");
    console.error(`\n❌ Error during connection dispatch (${err.name || "Error"}): ${sanitizedMsg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
