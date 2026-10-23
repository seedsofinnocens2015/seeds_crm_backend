import assert from "node:assert";
import mongoose from "mongoose";
import dns from "node:dns";
import jwt from "jsonwebtoken";
import { config } from "../src/config/env.js";
import { connectDB } from "../src/config/db.js";
import { Lead } from "../src/models/Lead.js";
import { MetaPageConnection } from "../src/models/MetaPageConnection.js";
import { MetaWebhookEvent } from "../src/models/MetaWebhookEvent.js";
import { MetaPageService } from "../src/services/metaPageService.js";
import {
  generateOAuthState,
  verifyOAuthState,
} from "../src/utils/oauthState.js";
import {
  ingestMetaLead,
  MetaLeadDetails,
} from "../src/services/metaLeadService.js";

// Ensure Node 25 DNS resolution for Atlas
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  // Ignore fallback
}

let totalTests = 0;
let passedTests = 0;

async function test(name: string, fn: () => Promise<void>) {
  totalTests++;
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passedTests++;
  } catch (err: any) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${err.message}`);
  }
}

async function runOAuthAndDiscoverySuite() {
  console.log("=== STARTING META OAUTH & FORM DISCOVERY TEST SUITE ===\n");

  await connectDB();

  // Safety Verification Check: Verify database is indeed seeds_crm_dev
  const dbName = mongoose.connection.name;
  console.log(`Verified Runtime Database: "${dbName}"`);
  assert.strictEqual(
    dbName,
    "seeds_crm_dev",
    `SAFETY VIOLATION: Tests must run only on seeds_crm_dev! Detected: ${dbName}`
  );

  const testUser = {
    id: "user_marketing_01",
    email: "digital.marketing@seedsofinnocence.com",
    role: "marketing",
  };

  const testPageId = "page_oauth_test_7788";
  const testPageName = "Seeds IVF OAuth Test Page";
  const testToken = "EAAG_oauth_page_token_99999";

  // Clean up any test records in dev DB
  await MetaPageConnection.deleteMany({ pageId: testPageId });
  await MetaWebhookEvent.deleteMany({ pageId: testPageId });

  // 1. Test OAuth State Generation & Verification
  await test("generateOAuthState & verifyOAuthState create cryptographically signed tamper-proof state", async () => {
    const state = generateOAuthState(testUser);
    assert(state.includes("."));

    // Verify valid state
    const decoded = verifyOAuthState(state);
    assert.strictEqual(decoded.userId, testUser.id);
    assert.strictEqual(decoded.userEmail, testUser.email);
    assert.strictEqual(decoded.userRole, testUser.role);
    assert(decoded.nonce);

    // Verify tampered state is rejected
    const [payloadStr, sig] = state.split(".");
    const tamperedState = `${payloadStr}X.${sig}`;
    assert.throws(() => verifyOAuthState(tamperedState), /Invalid OAuth state signature/);

    // Verify malformed state is rejected
    assert.throws(() => verifyOAuthState("invalid_state_without_period"), /Malformed OAuth state/);
  });

  // 2. Test getOAuthDialogUrl Construction
  await test("MetaPageService.getOAuthDialogUrl constructs valid Meta authorization URL with required scopes", async () => {
    config.metaAppId = "123456789012345";
    const state = generateOAuthState(testUser);
    const authUrl = MetaPageService.getOAuthDialogUrl(state);

    assert(authUrl.startsWith("https://www.facebook.com/v21.0/dialog/oauth"));
    assert(authUrl.includes("client_id=123456789012345"));
    assert(authUrl.includes("leads_retrieval"));
    assert(authUrl.includes("pages_manage_metadata"));
    assert(authUrl.includes(`state=${encodeURIComponent(state)}`));
  });

  // 3. Test OAuth Code Exchange & Long-lived Token Exchange Simulation
  await test("MetaPageService.exchangeCodeForUserToken & exchangeForLongLivedToken exchange tokens", async () => {
    config.metaAppSecret = "mock_secret_abcdef123";
    const mockFetch = async (url: string) => {
      if (url.includes("grant_type=fb_exchange_token")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: "long_lived_token_xyz", token_type: "bearer" }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "short_lived_token_abc", token_type: "bearer" }),
      } as any;
    };

    const shortRes = await MetaPageService.exchangeCodeForUserToken("mock_auth_code_123", mockFetch as any);
    assert.strictEqual(shortRes.access_token, "short_lived_token_abc");

    const longRes = await MetaPageService.exchangeForLongLivedToken(shortRes.access_token, mockFetch as any);
    assert.strictEqual(longRes.access_token, "long_lived_token_xyz");
  });

  // 4. Test User Pages Discovery
  await test("MetaPageService.fetchUserPages retrieves authorized pages from /me/accounts", async () => {
    const mockFetch = async (url: string) => {
      if (url.includes("me/accounts")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: [
                {
                  id: testPageId,
                  name: testPageName,
                  access_token: testToken,
                  tasks: ["ANALYZE", "ADVERTISE", "MESSAGING", "MODERATE", "CREATE_CONTENT", "MANAGE"],
                },
              ],
            }),
        } as any;
      }
      return { ok: false, status: 404, text: async () => "{}" } as any;
    };

    const pages = await MetaPageService.fetchUserPages("user_token_abc", mockFetch as any);
    assert.strictEqual(pages.length, 1);
    assert.strictEqual(pages[0].id, testPageId);
    assert.strictEqual(pages[0].name, testPageName);
    assert.strictEqual(pages[0].access_token, testToken);
  });

  // 5. Test Instant Lead Forms Discovery
  await test("MetaPageService.fetchPageForms retrieves instant lead forms for a Page", async () => {
    const mockFetch = async (url: string) => {
      if (url.includes(`${testPageId}/leadgen_forms`)) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: [
                { id: "form_fertility_01", name: "Free Fertility Consultation Form", status: "ACTIVE" },
                { id: "form_ivf_delhi_02", name: "IVF Treatment Query Form", status: "ACTIVE" },
                { id: "form_archived_03", name: "Old Summer Campaign Form", status: "ARCHIVED" },
              ],
            }),
        } as any;
      }
      return { ok: false, status: 404, text: async () => "{}" } as any;
    };

    const forms = await MetaPageService.fetchPageForms(testPageId, testToken, mockFetch as any);
    assert.strictEqual(forms.length, 3);
    assert.strictEqual(forms[0].id, "form_fertility_01");
    assert.strictEqual(forms[1].id, "form_ivf_delhi_02");
    assert.strictEqual(forms[2].status, "ARCHIVED");
  });

  // 6. Test Connect Page with Selective Forms Sync
  await test("MetaPageService.connectPage and updatePageSyncedForms manage selective form sync", async () => {
    const mockFetch = async (url: string) => {
      if (url.includes("/subscribed_apps")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true }),
        } as any;
      }
      return { ok: false, status: 404, text: async () => "{}" } as any;
    };

    // Connect Page with form_fertility_01 selected
    const connection = await MetaPageService.connectPage(
      {
        pageId: testPageId,
        pageName: testPageName,
        accessToken: testToken,
        connectedBy: testUser.email,
        selectedForms: ["form_fertility_01"],
      },
      mockFetch as any
    );

    assert.strictEqual(connection.pageId, testPageId);
    assert.strictEqual(connection.isSubscribed, true);
    assert.deepStrictEqual(connection.selectedForms, ["form_fertility_01"]);

    // Update to sync both forms
    const updated = await MetaPageService.updatePageSyncedForms(testPageId, [
      "form_fertility_01",
      "form_ivf_delhi_02",
    ]);
    assert.deepStrictEqual(updated.selectedForms, ["form_fertility_01", "form_ivf_delhi_02"]);
  });

  // 7. Test Selective Ingestion: Ingests Synced Form & Skips Unsynced Form
  const synthLeadSynced = `lead_synced_${Date.now()}`;
  const synthLeadUnsynced = `lead_unsynced_${Date.now()}`;

  await test("ingestMetaLead creates lead for selected form and skips lead for unselected form", async () => {
    // 7a. Lead from synced form: form_fertility_01
    const mockDetailsSynced: MetaLeadDetails = {
      id: synthLeadSynced,
      page_id: testPageId,
      form_id: "form_fertility_01",
      field_data: [
        { name: "full_name", values: ["Synced Patient"] },
        { name: "phone_number", values: ["9812345678"] },
      ],
    };

    const resSynced = await ingestMetaLead(synthLeadSynced, {
      pageId: testPageId,
      mockDetails: mockDetailsSynced,
    });

    assert.strictEqual(resSynced.status, "created");
    assert(resSynced.uniqueId);

    // Verify saved lead
    const savedLead = await Lead.findById(resSynced.leadId);
    assert(savedLead);
    assert.strictEqual(savedLead.patientName, "Synced Patient");

    // 7b. Lead from UNSELECTED form: form_archived_03
    const mockDetailsUnsynced: MetaLeadDetails = {
      id: synthLeadUnsynced,
      page_id: testPageId,
      form_id: "form_archived_03",
      field_data: [
        { name: "full_name", values: ["Unsynced Patient"] },
        { name: "phone_number", values: ["9876543210"] },
      ],
    };

    const resUnsynced = await ingestMetaLead(synthLeadUnsynced, {
      pageId: testPageId,
      mockDetails: mockDetailsUnsynced,
    });

    assert.strictEqual(resUnsynced.status, "skipped_form_not_synced");

    // Confirm unsynced lead was NOT created in CRM
    const unsyncedInDb = await Lead.findOne({ "customFields.metaLeadId": synthLeadUnsynced });
    assert.strictEqual(unsyncedInDb, null);
  });

  // Clean up synthetic test records from isolated dev database
  console.log("\nCleaning up test leads and page connections from seeds_crm_dev...");
  await Lead.deleteMany({ "customFields.metaLeadId": { $in: [synthLeadSynced, synthLeadUnsynced] } });
  await MetaPageConnection.deleteMany({ pageId: testPageId });
  await MetaWebhookEvent.deleteMany({ pageId: testPageId });
  console.log("Cleanup complete.");

  console.log("\n==========================================");
  console.log(`TOTAL OAUTH & DISCOVERY TESTS: ${totalTests}`);
  console.log(`PASSED: ${passedTests}`);
  console.log(`FAILED: ${totalTests - passedTests}`);
  console.log("==========================================\n");

  await mongoose.disconnect();
}

runOAuthAndDiscoverySuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
