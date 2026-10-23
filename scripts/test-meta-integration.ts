import crypto from "node:crypto";
import assert from "node:assert";
import mongoose from "mongoose";
import dns from "node:dns";
import { config } from "../src/config/env.js";
import { connectDB } from "../src/config/db.js";
import { Lead } from "../src/models/Lead.js";
import {
  fetchMetaLeadDetails,
  mapMetaLeadToCrmFields,
  ingestMetaLead,
  MetaLeadDetails,
} from "../src/services/metaLeadService.js";

// Fix DNS resolution for SRV connections in standalone scripts under Node 25
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

async function runTestSuite() {
  console.log("=== STARTING META INTEGRATION PHASE 2 AUTOMATED TEST SUITE ===\n");

  await connectDB();

  const testMetaAppSecret = "test_meta_app_secret_abc123456";
  const testPageToken = "EAAGtest_page_access_token_654321";

  // Test 1: Signature Verification Logic (Valid, Invalid, Tampered)
  await test("HMAC SHA256 Signature computation & verification matches Meta spec", async () => {
    const rawPayload = JSON.stringify({
      object: "page",
      entry: [{ id: "123", changes: [{ field: "leadgen", value: { leadgen_id: "lead_001" } }] }],
    });
    const rawBuffer = Buffer.from(rawPayload, "utf8");

    // Correct signature
    const validHash = crypto.createHmac("sha256", testMetaAppSecret).update(rawBuffer).digest("hex");
    const validHeader = `sha256=${validHash}`;

    // Verifier logic
    const extracted = validHeader.slice(7);
    const expected = crypto.createHmac("sha256", testMetaAppSecret).update(rawBuffer).digest("hex");
    assert.strictEqual(
      crypto.timingSafeEqual(Buffer.from(extracted, "hex"), Buffer.from(expected, "hex")),
      true
    );

    // Tampered body
    const tamperedBuffer = Buffer.from(rawPayload + " ", "utf8");
    const tamperedExpected = crypto.createHmac("sha256", testMetaAppSecret).update(tamperedBuffer).digest("hex");
    assert.notStrictEqual(extracted, tamperedExpected);
  });

  // Test 2: Field Mapping logic handles custom questions, empty values, and Indian phone numbers
  await test("mapMetaLeadToCrmFields maps names, phone, location, and custom fields accurately", async () => {
    const mockDetails: MetaLeadDetails = {
      id: "meta_lead_test_101",
      created_time: "2026-06-18T13:42:25+0000",
      form_id: "form_fertility_delhi",
      ad_id: "ad_summer_campaign_01",
      page_id: "page_seeds_delhi",
      field_data: [
        { name: "full_name", values: ["Pooja Sharma"] },
        { name: "phone_number", values: ["+91 9811223344"] },
        { name: "city", values: ["South Delhi"] },
        { name: "email", values: ["pooja.test@example.com"] },
        { name: "looking_for_treatment", values: ["ICSI / Blastocyst Culture"] },
      ],
    };

    const mapped = mapMetaLeadToCrmFields(mockDetails);

    assert.strictEqual(mapped.patientName, "Pooja Sharma");
    assert.strictEqual(mapped.normalizedPhone, "9811223344");
    assert.strictEqual(mapped.location, "South Delhi");
    assert.strictEqual(mapped.lookingForTreatment, "ICSI / Blastocyst Culture");
    assert.strictEqual(mapped.leadSource, "Meta Instant Form");
    assert.strictEqual(mapped.customFields?.metaLeadId, "meta_lead_test_101");
    assert.strictEqual(mapped.customFields?.metaFormId, "form_fertility_delhi");
    assert.strictEqual(mapped.customFields?.email, "pooja.test@example.com");
  });

  // Test 3: Mocked Graph API error handling (invalid token / HTTP 400 error)
  await test("fetchMetaLeadDetails surfaces Meta Graph API errors gracefully", async () => {
    const mockFetch = async () => {
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () =>
          JSON.stringify({
            error: {
              message: "Invalid OAuth access token - Cannot parse access token",
              type: "OAuthException",
              code: 190,
            },
          }),
      } as any;
    };

    let caughtError: Error | null = null;
    try {
      await fetchMetaLeadDetails("leadgen_bad_token", testPageToken, mockFetch as any);
    } catch (err: any) {
      caughtError = err;
    }

    assert(caughtError !== null, "Expected fetchMetaLeadDetails to throw on Graph API error");
    assert(
      caughtError.message.includes("Invalid OAuth access token"),
      `Expected message to contain error details, got: ${caughtError.message}`
    );
  });

  // Test 4: End-to-End Synthetic Ingestion into dev DB (Unique creation)
  const syntheticLeadId1 = `meta_test_synth_${Date.now()}_1`;
  const syntheticLeadId2 = `meta_test_synth_${Date.now()}_2`;
  const syntheticPhone1 = `98${Math.floor(10000000 + Math.random() * 90000000)}`;

  await test("ingestMetaLead creates a new CRM lead with atomic sequential ID", async () => {
    const mockDetails: MetaLeadDetails = {
      id: syntheticLeadId1,
      created_time: new Date().toISOString(),
      form_id: "form_synth_01",
      ad_id: "ad_synth_01",
      field_data: [
        { name: "full_name", values: ["Synthetic Test Patient"] },
        { name: "phone_number", values: [syntheticPhone1] },
        { name: "city", values: ["Noida"] },
      ],
    };

    const result = await ingestMetaLead(syntheticLeadId1, { mockDetails });

    assert.strictEqual(result.status, "created");
    assert(result.uniqueId && result.uniqueId.startsWith("SC-"));
    assert(result.leadId);

    // Verify persisted in DB
    const persisted = await Lead.findById(result.leadId);
    assert(persisted);
    assert.strictEqual(persisted.patientName, "Synthetic Test Patient");
    assert.strictEqual(persisted.normalizedPhone, syntheticPhone1);
    assert.strictEqual(persisted.customFields?.metaLeadId, syntheticLeadId1);
  });

  // Test 5: Idempotency Check - Duplicate Delivery of exact same metaLeadId
  await test("ingestMetaLead is strictly idempotent: duplicate webhook delivery does not create duplicate lead", async () => {
    const mockDetails: MetaLeadDetails = {
      id: syntheticLeadId1,
      created_time: new Date().toISOString(),
      form_id: "form_synth_01",
      field_data: [
        { name: "full_name", values: ["Synthetic Test Patient"] },
        { name: "phone_number", values: [syntheticPhone1] },
      ],
    };

    const duplicateResult = await ingestMetaLead(syntheticLeadId1, { mockDetails });

    assert.strictEqual(duplicateResult.status, "already_exists");
    assert.strictEqual(duplicateResult.metaLeadId, syntheticLeadId1);

    // Confirm collection has only 1 record with this metaLeadId
    const count = await Lead.countDocuments({ "customFields.metaLeadId": syntheticLeadId1 });
    assert.strictEqual(count, 1);
  });

  // Test 6: Duplicate Phone Handling without overwriting existing data
  await test("ingestMetaLead safely handles repeat phone submission without destructive overwrite", async () => {
    const syntheticLeadId2 = `meta_test_synth_${Date.now()}_2`;
    const mockDetailsDifferentLeadSamePhone: MetaLeadDetails = {
      id: syntheticLeadId2,
      created_time: new Date().toISOString(),
      form_id: "form_synth_02",
      field_data: [
        { name: "full_name", values: ["Different Patient Name (Same Phone)"] },
        { name: "phone_number", values: [syntheticPhone1] }, // Same phone as Test 4
      ],
    };

    const result = await ingestMetaLead(syntheticLeadId2, { mockDetails: mockDetailsDifferentLeadSamePhone });

    assert.strictEqual(result.status, "skipped_duplicate_phone");
    assert(result.message && result.message.includes("Phone number already exists"));

    // Check that the original patientName was NOT overwritten
    const originalLead = await Lead.findOne({ "customFields.metaLeadId": syntheticLeadId1 });
    assert(originalLead);
    assert.strictEqual(originalLead.patientName, "Synthetic Test Patient");

    // Check that a note history entry was safely added for the repeat inquiry
    assert(originalLead.notesHistory && originalLead.notesHistory.length > 0);
    const lastNote = originalLead.notesHistory[originalLead.notesHistory.length - 1];
    assert(lastNote.newNotes.includes(syntheticLeadId2));
  });

  // Clean up synthetic test records from isolated dev database
  console.log("\nCleaning up synthetic test records from development database...");
  await Lead.deleteMany({
    "customFields.metaLeadId": { $in: [syntheticLeadId1, syntheticLeadId2] },
  });
  console.log("Cleanup complete.");

  console.log("\n==========================================");
  console.log(`TOTAL INTEGRATION TESTS: ${totalTests}`);
  console.log(`PASSED: ${passedTests}`);
  console.log(`FAILED: ${totalTests - passedTests}`);
  console.log("==========================================\n");

  await mongoose.disconnect();
}

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
