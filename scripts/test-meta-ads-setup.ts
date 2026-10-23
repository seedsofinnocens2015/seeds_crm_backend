import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { MetaAdsSetupConfig } from "../src/models/MetaAdsSetupConfig.js";
import { MetaPageConnection } from "../src/models/MetaPageConnection.js";
import { Lead } from "../src/models/Lead.js";
import { ingestMetaLead } from "../src/services/metaLeadService.js";

import dns from "dns";
dns.setServers(["8.8.8.8", "8.8.4.4"]);

async function runTestSuite() {
  console.log("=== STARTING META ADS MANUAL SETUP TEST SUITE ===");

  const uri = process.env.MONGODB_URI;
  if (!uri || !uri.includes("seeds_crm_dev")) {
    throw new Error(`Safety check failed: MONGODB_URI must target 'seeds_crm_dev'. Current: ${uri}`);
  }

  await mongoose.connect(uri);
  console.log("Connected to development database:", mongoose.connection.db?.databaseName);

  const testPageId = "999888777666";
  const testFormId = "form_manual_test_01";
  const testLeadgenId = `test_leadgen_${Date.now()}`;

  try {
    // 1. Setup Mock Page Connection
    await MetaPageConnection.findOneAndUpdate(
      { pageId: testPageId },
      {
        pageId: testPageId,
        pageName: "Seeds IVF Test Manual Unit",
        status: "active",
        isSubscribed: true,
        accessToken: "EAATestMockTokenForManualSetupTestingOnly",
        selectedForms: [testFormId],
      },
      { upsert: true }
    );
    console.log("✓ Page connection verified in registry");

    // 2. Create MetaAdsSetupConfig
    await MetaAdsSetupConfig.deleteMany({ formId: testFormId });
    const configDoc = await MetaAdsSetupConfig.create({
      integrationName: "Manual Setup Automated Test Camp",
      leadSource: "Facebook Lead Ads",
      pageId: testPageId,
      pageName: "Seeds IVF Test Manual Unit",
      formId: testFormId,
      formName: "SOI Fertility Free Consultation Form",
      campaignName: "Test Campaign Alpha",
      campaignId: "camp_12345",
      adId: "ad_67890",
      autoSync: true,
      fieldMappings: [
        { crmField: "patientName", formFieldKey: "custom_patient_name" },
        { crmField: "mobileNumber", formFieldKey: "custom_contact_num" },
        { crmField: "location", formFieldKey: "custom_city" },
        { crmField: "email", formFieldKey: "patient_email" },
      ],
      status: "active",
      createdBy: "test-bot@seeds-crm.dev",
    });
    console.log("✓ MetaAdsSetupConfig created and saved:", configDoc.integrationName);

    // 3. Test Ingestion with Custom Field Mappings
    const mockDetails = {
      id: testLeadgenId,
      page_id: testPageId,
      form_id: testFormId,
      field_data: [
        { name: "custom_patient_name", values: ["Ananya Verma"] },
        { name: "custom_contact_num", values: ["+91 98765 43210"] },
        { name: "custom_city", values: ["Patna"] },
        { name: "patient_email", values: ["ananya.verma.test@example.com"] },
      ],
    };

    const res1 = await ingestMetaLead(testLeadgenId, {
      pageId: testPageId,
      mockDetails,
    });
    console.log("✓ Ingestion result 1:", res1.status, res1.uniqueId);

    if (res1.status !== "created") {
      throw new Error(`Expected 'created', got '${res1.status}'`);
    }

    const createdLead = await Lead.findOne({ "customFields.metaLeadId": testLeadgenId });
    if (!createdLead) throw new Error("Lead not found in DB!");

    if (createdLead.patientName !== "Ananya Verma") {
      throw new Error(`Custom field mapping failed for patientName: got ${createdLead.patientName}`);
    }
    if (createdLead.mobileNumber !== "+91 98765 43210") {
      throw new Error(`Custom field mapping failed for mobileNumber: got ${createdLead.mobileNumber}`);
    }
    if (createdLead.location !== "Patna") {
      throw new Error(`Custom field mapping failed for location: got ${createdLead.location}`);
    }
    if (createdLead.customFields?.metaCampaignName !== "Test Campaign Alpha") {
      throw new Error(`Campaign attribution failed: got ${createdLead.customFields?.metaCampaignName}`);
    }
    console.log("✓ Custom field mappings and campaign attribution verified accurately on Lead:", createdLead.uniqueId);

    // 4. Test AutoSync Disable behavior
    configDoc.autoSync = false;
    await configDoc.save();

    const testLeadgenId2 = `test_leadgen_paused_${Date.now()}`;
    const res2 = await ingestMetaLead(testLeadgenId2, {
      pageId: testPageId,
      mockDetails: {
        ...mockDetails,
        id: testLeadgenId2,
      },
    });
    console.log("✓ Ingestion result 2 (autoSync=false):", res2.status, res2.message);
    if (res2.status !== "skipped_form_not_synced") {
      throw new Error(`Expected 'skipped_form_not_synced' when autoSync=false, got '${res2.status}'`);
    }

    // 5. Test Duplicate Phone Preservation (No destructive overwrite)
    configDoc.autoSync = true;
    await configDoc.save();

    const testLeadgenId3 = `test_leadgen_repeat_${Date.now()}`;
    const res3 = await ingestMetaLead(testLeadgenId3, {
      pageId: testPageId,
      mockDetails: {
        ...mockDetails,
        id: testLeadgenId3,
      },
    });
    console.log("✓ Ingestion result 3 (duplicate phone):", res3.status, res3.message);
    if (res3.status !== "skipped_duplicate_phone") {
      throw new Error(`Expected 'skipped_duplicate_phone', got '${res3.status}'`);
    }

    console.log("ALL TESTS PASSED CLEANLY!");
  } finally {
    // Cleanup mock records
    await Lead.deleteMany({ "customFields.metaLeadId": { $in: [testLeadgenId] } });
    await MetaAdsSetupConfig.deleteMany({ formId: testFormId });
    await MetaPageConnection.deleteMany({ pageId: testPageId });
    await mongoose.disconnect();
    console.log("Cleaned up mock records & disconnected database.");
  }
}

runTestSuite().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
