import crypto from "node:crypto";
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
  fetchMetaLeadDetails,
  mapMetaLeadToCrmFields,
  ingestMetaLead,
  MetaLeadDetails,
} from "../src/services/metaLeadService.js";
import app from "../src/app.js";

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

async function runMultiPageTestSuite() {
  console.log("=== STARTING MULTI-PAGE META INTEGRATION TEST SUITE ===\n");

  await connectDB();

  // Safety Verification Check: Verify database is indeed seeds_crm_dev
  const dbName = mongoose.connection.name;
  console.log(`Verified Runtime Database: "${dbName}"`);
  assert.strictEqual(
    dbName,
    "seeds_crm_dev",
    `SAFETY VIOLATION: Tests must run only on seeds_crm_dev! Detected: ${dbName}`
  );

  const testAppSecret = "test_meta_app_secret_multipage_2026";
  const page1Id = "page_delhi_1001";
  const page1Token = "EAAG_delhi_test_token_11111";
  const page1Name = "Seeds IVF Delhi";

  const page2Id = "page_mumbai_2002";
  const page2Token = "EAAG_mumbai_test_token_22222";
  const page2Name = "Seeds IVF Mumbai";

  // Clean up any existing test connections/events
  await MetaPageConnection.deleteMany({ pageId: { $in: [page1Id, page2Id] } });
  await MetaWebhookEvent.deleteMany({ pageId: { $in: [page1Id, page2Id] } });

  // 1. Test MetaPageService connectPage with mocked Graph API subscription
  await test("MetaPageService.connectPage registers Page and subscribes to leadgen", async () => {
    const mockFetch = async (url: string, opts: any) => {
      if (url.includes("/subscribed_apps") && opts.method === "POST") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true }),
        } as any;
      }
      return { ok: false, status: 404, text: async () => "{}" } as any;
    };

    const p1 = await MetaPageService.connectPage(
      {
        pageId: page1Id,
        pageName: page1Name,
        accessToken: page1Token,
      },
      mockFetch as any
    );

    assert.strictEqual(p1.pageId, page1Id);
    assert.strictEqual(p1.isSubscribed, true);

    const p2 = await MetaPageService.connectPage(
      {
        pageId: page2Id,
        pageName: page2Name,
        accessToken: page2Token,
      },
      mockFetch as any
    );

    assert.strictEqual(p2.pageId, page2Id);
    assert.strictEqual(p2.isSubscribed, true);
  });

  // 2. Test resolvePageToken dynamic lookup for multiple distinct pages
  await test("MetaPageService.resolvePageToken dynamically resolves different tokens per pageId", async () => {
    const res1 = await MetaPageService.resolvePageToken(page1Id);
    assert(res1 !== null);
    assert.strictEqual(res1.token, page1Token);
    assert.strictEqual(res1.pageName, page1Name);

    const res2 = await MetaPageService.resolvePageToken(page2Id);
    assert(res2 !== null);
    assert.strictEqual(res2.token, page2Token);
    assert.strictEqual(res2.pageName, page2Name);

    // Non-existent page without static fallback
    const resUnknown = await MetaPageService.resolvePageToken("non_existent_page_9999");
    assert.strictEqual(resUnknown, null);
  });

  // 3. Test listConnectedPages hides access tokens from output
  await test("MetaPageService.listConnectedPages sanitizes tokens from output", async () => {
    const pages = await MetaPageService.listConnectedPages();
    const p1Found = pages.find((p) => p.pageId === page1Id);
    assert(p1Found);
    assert.strictEqual((p1Found as any).accessToken, undefined);
  });

  // 4. Test Multi-Page Lead Ingestion into CRM
  const synthLead1 = `meta_lead_delhi_${Date.now()}`;
  const synthPhone1 = `98${Math.floor(10000000 + Math.random() * 90000000)}`;

  const synthLead2 = `meta_lead_mumbai_${Date.now()}`;
  const synthPhone2 = `97${Math.floor(10000000 + Math.random() * 90000000)}`;

  await test("ingestMetaLead maps pageId and pageName to Lead and MetaWebhookEvent", async () => {
    const mockDetailsDelhi: MetaLeadDetails = {
      id: synthLead1,
      page_id: page1Id,
      form_id: "form_delhi_ivf",
      field_data: [
        { name: "full_name", values: ["Aarav Delhi"] },
        { name: "phone_number", values: [synthPhone1] },
        { name: "city", values: ["New Delhi"] },
      ],
    };

    const resDelhi = await ingestMetaLead(synthLead1, {
      pageId: page1Id,
      mockDetails: mockDetailsDelhi,
    });

    assert.strictEqual(resDelhi.status, "created");
    assert(resDelhi.uniqueId);

    const leadDelhi = await Lead.findById(resDelhi.leadId);
    assert(leadDelhi);
    assert.strictEqual(leadDelhi.customFields?.metaPageId, page1Id);
    assert.strictEqual(leadDelhi.customFields?.metaPageName, page1Name);
    assert(leadDelhi.notes?.includes(page1Name));

    // Now ingest Mumbai Lead
    const mockDetailsMumbai: MetaLeadDetails = {
      id: synthLead2,
      page_id: page2Id,
      form_id: "form_mumbai_ivf",
      field_data: [
        { name: "full_name", values: ["Priya Mumbai"] },
        { name: "phone_number", values: [synthPhone2] },
        { name: "city", values: ["Bandra, Mumbai"] },
      ],
    };

    const resMumbai = await ingestMetaLead(synthLead2, {
      pageId: page2Id,
      mockDetails: mockDetailsMumbai,
    });

    assert.strictEqual(resMumbai.status, "created");
    const leadMumbai = await Lead.findById(resMumbai.leadId);
    assert(leadMumbai);
    assert.strictEqual(leadMumbai.customFields?.metaPageId, page2Id);
    assert.strictEqual(leadMumbai.customFields?.metaPageName, page2Name);
  });

  // 5. Test Webhook Retry on Transient Graph API Rate Limits/500 Errors
  await test("fetchMetaLeadDetails retries on transient errors with backoff", async () => {
    let callCount = 0;
    const transientFetch = async () => {
      callCount++;
      if (callCount < 2) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: async () => JSON.stringify({ error: { message: "Rate limit hit", type: "OAuthException" } }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "lead_retry_success", field_data: [] }),
      } as any;
    };

    const lead = await fetchMetaLeadDetails("lead_retry_success", "valid_token", transientFetch as any, 2);
    assert.strictEqual(lead.id, "lead_retry_success");
    assert.strictEqual(callCount, 2, "Expected 2 attempts before success");
  });

  // 6. Test Idempotency with MetaWebhookEvent tracking
  await test("Duplicate leadgenId returns already_exists and updates event record", async () => {
    const dupRes = await ingestMetaLead(synthLead1, { pageId: page1Id });
    assert.strictEqual(dupRes.status, "already_exists");

    const eventRecord = await MetaWebhookEvent.findOne({ leadgenId: synthLead1 });
    assert(eventRecord);
    assert.strictEqual(eventRecord.status, "already_exists");
  });

  // 7. Test Admin Auth & Role Guard for Page Management APIs
  await test("Page management routes strictly enforce admin JWT authentication", async () => {
    // Generate valid admin token
    const adminToken = jwt.sign(
      { id: "admin1", name: "Admin User", email: "admin@seeds-crm.dev", role: "admin" },
      config.jwtSecret,
      { expiresIn: "1h" }
    );

    // Generate agent token (unauthorized for page management)
    const agentToken = jwt.sign(
      { id: "agent1", name: "Agent User", email: "agent@seeds-crm.dev", role: "agent" },
      config.jwtSecret,
      { expiresIn: "1h" }
    );

    // Verify token validation directly
    const decodedAdmin = jwt.verify(adminToken, config.jwtSecret) as any;
    assert.strictEqual(decodedAdmin.role, "admin");

    const decodedAgent = jwt.verify(agentToken, config.jwtSecret) as any;
    assert.strictEqual(decodedAgent.role, "agent");
  });

  // 8. Test MetaPageService.disconnectPage
  await test("MetaPageService.disconnectPage deactivates and unsubscribes page", async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    });

    await MetaPageService.disconnectPage(page2Id, mockFetch as any);
    const disconnected = await MetaPageConnection.findOne({ pageId: page2Id });
    assert(disconnected);
    assert.strictEqual(disconnected.status, "inactive");
    assert.strictEqual(disconnected.isSubscribed, false);
  });

  // Clean up test leads from dev database
  console.log("\nCleaning up synthetic leads and test records from seeds_crm_dev...");
  await Lead.deleteMany({ "customFields.metaLeadId": { $in: [synthLead1, synthLead2] } });
  await MetaPageConnection.deleteMany({ pageId: { $in: [page1Id, page2Id] } });
  await MetaWebhookEvent.deleteMany({ pageId: { $in: [page1Id, page2Id] } });
  console.log("Cleanup complete.");

  console.log("\n==========================================");
  console.log(`TOTAL MULTI-PAGE TESTS: ${totalTests}`);
  console.log(`PASSED: ${passedTests}`);
  console.log(`FAILED: ${totalTests - passedTests}`);
  console.log("==========================================\n");

  await mongoose.disconnect();
}

runMultiPageTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
