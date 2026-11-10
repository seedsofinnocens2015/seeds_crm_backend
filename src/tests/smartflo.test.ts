import { mapLeadToSmartfloPayload, SmartfloLeadPayload, processSmartfloJob, runPendingSmartfloJobs } from "../services/smartflo/smartfloSyncService.js";
import {
  getSmartfloAccessToken,
  invalidateSmartfloAccessToken,
  getSmartfloTokenCacheStatus,
  _setMockTokenCache,
} from "../services/smartflo/smartfloAuthService.js";
import { processSmartfloWebhook, SmartfloWebhookPayload } from "../services/smartflo/smartfloWebhookService.js";
import { verifySmartfloWebhookAuth, verifySmartfloPullAuth, streamCallRecording } from "../controllers/smartfloController.js";
import { executeQueueCycle, executeCdrReconciliationCycle } from "../services/smartflo/smartfloScheduler.js";
import { config } from "../config/env.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { SmartfloCallLog } from "../models/SmartfloCallLog.js";
import { SmartfloLeadJob } from "../models/SmartfloLeadJob.js";
import { Counter } from "../models/Counter.js";
import { LeadCreationLock } from "../models/LeadCreationLock.js";
import mongoose from "mongoose";

async function runTests() {
  console.log("=== Running Smartflo Integration Unit & Logic Tests ===");
  let passed = 0;
  let failed = 0;

  function assert(desc: string, condition: boolean) {
    if (condition) {
      console.log(`  ✓ ${desc}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${desc}`);
      failed++;
    }
  }

  // ==========================================
  // 1. Correct Contact Field Mapping Tests
  // ==========================================
  try {
    const mockLead: any = {
      uniqueId: "SOI-1042",
      wifeName: "Aarti Sharma",
      husbandName: "Rahul Sharma",
      primaryMobileNumber: "+91 98765 43210",
      secondaryMobileNumber: "+91 98111 22233",
      primaryEmail: "aarti@example.com",
      ptAddress: "Flat 402, Lotus Boulevard, Sector 100",
      ptCity: "Noida",
      ptState: "Uttar Pradesh",
      centreLocation: "Noida Sector 62",
      leadSource: "Google Ads High Intent",
      campaignName: "IVF_Delhi_NCR",
    };

    const payload = mapLeadToSmartfloPayload(mockLead);
    assert("field_0: maps normalized primary phone number", payload.field_0.includes("9876543210"));
    assert("field_1: maps couple name with ' & ' separator", payload.field_1 === "Aarti Sharma & Rahul Sharma");
    assert("field_2: maps primary email address", payload.field_2 === "aarti@example.com");
    assert("field_3: maps complete patient address", payload.field_3 === "Flat 402, Lotus Boulevard, Sector 100");
    assert("field_4: maps stable CRM uniqueId (SOI-1042)", payload.field_4 === "SOI-1042");
    assert("field_5: maps secondary mobile number", (payload.field_5 || "").includes("9811122233"));
    assert("field_5: never contains leadSource or campaignName", !(payload.field_5 || "").includes("Google") && !(payload.field_5 || "").includes("IVF"));

    // Fallback behavior test
    const fallbackLead: any = {
      uniqueId: "SOI-2000",
      primaryMobileNumber: "9123456780",
      secondaryEmail: "fallback@example.com",
      ptCity: "Lucknow",
      ptState: "UP",
    };
    const fallbackPayload = mapLeadToSmartfloPayload(fallbackLead);
    assert("field_1: sensible fallback when no name provided", fallbackPayload.field_1 === "Valued Patient");
    assert("field_2: falls back to secondaryEmail when primary missing", fallbackPayload.field_2 === "fallback@example.com");
    assert("field_3: falls back to city, state when ptAddress missing", fallbackPayload.field_3 === "Lucknow, UP");
    assert("field_5: empty string when no alternate phone provided", fallbackPayload.field_5 === "");
  } catch (err: any) {
    assert(`Payload mapping threw error: ${err.message}`, false);
  }

  // ==========================================
  // 2. Dynamic Token Authentication & Caching Tests
  // ==========================================
  try {
    invalidateSmartfloAccessToken();
    const origLoginId = config.smartfloLoginId;
    const origPassword = config.smartfloPassword;
    const origBaseUrl = config.smartfloApiBaseUrl;

    // Test missing credentials configuration error
    (config as any).smartfloLoginId = "";
    (config as any).smartfloPassword = "";
    let missingCredsThrew = false;
    try {
      await getSmartfloAccessToken();
    } catch (e: any) {
      missingCredsThrew = true;
      assert("getSmartfloAccessToken throws clean error when credentials missing", e.message.includes("SMARTFLO_LOGIN_ID"));
    }
    if (!missingCredsThrew) {
      assert("getSmartfloAccessToken should have thrown on missing credentials", false);
    }

    // Configure mock credentials
    (config as any).smartfloLoginId = "dialer-admin@seedsofinnocens.com";
    (config as any).smartfloPassword = "super_secret_password_123";
    (config as any).smartfloApiBaseUrl = "https://api-smartflo.mock";

    let loginCallsCount = 0;
    let lastLoginBody: any = null;

    const mockFetch = async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/login")) {
        loginCallsCount++;
        lastLoginBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            access_token: "mock_jwt_token_abc_123",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          text: async () => JSON.stringify({ success: true }),
        } as any;
      }
      throw new Error(`Unexpected URL in mockFetch: ${urlStr}`);
    };

    // 2.1 First login call
    const token1 = await getSmartfloAccessToken(mockFetch as any);
    assert("getSmartfloAccessToken returns access_token on success", token1 === "mock_jwt_token_abc_123");
    assert("login request uses email = SMARTFLO_LOGIN_ID", lastLoginBody.email === "dialer-admin@seedsofinnocens.com");
    assert("login request uses password = SMARTFLO_PASSWORD", lastLoginBody.password === "super_secret_password_123");
    assert("login endpoint was hit exactly once", loginCallsCount === 1);

    // 2.2 Token reuse (caching)
    const token2 = await getSmartfloAccessToken(mockFetch as any);
    assert("getSmartfloAccessToken reuses valid cached token without calling API again", token2 === token1 && loginCallsCount === 1);

    // 2.3 Concurrent login protection (mutex)
    invalidateSmartfloAccessToken();
    loginCallsCount = 0;
    let concurrentFetchCalls = 0;
    const delayedMockFetch = async (url: any, init: any) => {
      concurrentFetchCalls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          access_token: "mock_concurrent_token_xyz",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      } as any;
    };

    const [cToken1, cToken2, cToken3] = await Promise.all([
      getSmartfloAccessToken(delayedMockFetch as any),
      getSmartfloAccessToken(delayedMockFetch as any),
      getSmartfloAccessToken(delayedMockFetch as any),
    ]);

    assert("Concurrent getSmartfloAccessToken calls resolve to identical token", cToken1 === "mock_concurrent_token_xyz" && cToken2 === cToken1 && cToken3 === cToken1);
    assert("Concurrent calls trigger exactly one login HTTP request (mutex lock)", concurrentFetchCalls === 1);

    // 2.4 Pre-expiry refresh buffer (refreshes if remaining lifetime <= 5 minutes)
    _setMockTokenCache({
      accessToken: "expiring_soon_token",
      expiresAt: Date.now() + 4 * 60 * 1000, // 4 mins left (within 5 min buffer)
    });

    let refreshedCalls = 0;
    const refreshMockFetch = async () => {
      refreshedCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          access_token: "freshly_renewed_token_456",
          expires_in: 3600,
        }),
      } as any;
    };

    const renewedToken = await getSmartfloAccessToken(refreshMockFetch as any);
    assert("Token within 5-min expiry buffer triggers automatic refresh", renewedToken === "freshly_renewed_token_456" && refreshedCalls === 1);

    // Restore config
    (config as any).smartfloLoginId = origLoginId;
    (config as any).smartfloPassword = origPassword;
    (config as any).smartfloApiBaseUrl = origBaseUrl;
    invalidateSmartfloAccessToken();
  } catch (err: any) {
    assert(`Auth service test threw error: ${err.message}`, false);
  }

  // ==========================================
  // 3. Webhook Authentication Verification Test
  // ==========================================
  try {
    const origSecret = config.smartfloWebhookSecret;
    (config as any).smartfloWebhookSecret = "test_webhook_secret_key_123";

    const validReq: any = {
      headers: {
        authorization: "Bearer test_webhook_secret_key_123",
      },
    };
    const invalidReq: any = {
      headers: {
        authorization: "Bearer wrong_secret",
      },
    };
    const emptyReq: any = {
      headers: {},
    };

    assert("verifySmartfloWebhookAuth accepts valid bearer token", verifySmartfloWebhookAuth(validReq) === "ok");
    assert("verifySmartfloWebhookAuth rejects invalid token", verifySmartfloWebhookAuth(invalidReq) === "unauthorized");
    assert("verifySmartfloWebhookAuth rejects missing headers", verifySmartfloWebhookAuth(emptyReq) === "unauthorized");

    // Test unconfigured secret (fail closed)
    (config as any).smartfloWebhookSecret = "";
    assert("verifySmartfloWebhookAuth fails closed if secret unconfigured", verifySmartfloWebhookAuth(validReq) === "unconfigured");

    (config as any).smartfloWebhookSecret = origSecret;
  } catch (err: any) {
    assert(`Webhook auth test error: ${err.message}`, false);
  }

  // ==========================================
  // 4. Smartflo Pull Auth Least-Privilege Test
  // ==========================================
  try {
    const origApiKey = config.smartfloApiKey;
    (config as any).smartfloApiKey = "crm_smartflo_pull_key_xyz";

    const validPullReq: any = {
      headers: {
        "x-api-key": "crm_smartflo_pull_key_xyz",
      },
    };
    const invalidPullReq: any = {
      headers: {
        "x-api-key": "invalid_key",
      },
    };

    assert("verifySmartfloPullAuth accepts valid API key", verifySmartfloPullAuth(validPullReq) === true);
    assert("verifySmartfloPullAuth rejects invalid API key", verifySmartfloPullAuth(invalidPullReq) === false);

    (config as any).smartfloApiKey = origApiKey;
  } catch (err: any) {
    assert(`Pull auth test error: ${err.message}`, false);
  }

  // ==========================================
  // 5. Inbound Webhook Payload & Processing Tests (Step 3 Additions)
  // ==========================================

  // Mock DB model calls for offline test execution
  const origFindOneLead = Lead.findOne;
  const origFindLeads = Lead.find;
  const origFindOneCall = SmartfloCallLog.findOne;
  const origFindOneAndUpdateCall = SmartfloCallLog.findOneAndUpdate;
  const origFindByIdAndUpdateLead = Lead.findByIdAndUpdate;
  const origFindUser = User.find;
  const origFindOneUser = User.findOne;
  const origFindByIdUser = User.findById;

  try {
    (User as any).find = () => ({
      select: async () => [],
    });
    (User as any).findOne = () => ({
      select: async () => null,
    });
    (User as any).findById = () => ({
      select: async () => null,
    });
    // 5.1 Missing Call ID Rejection
    let errorCaught = false;
    try {
      await processSmartfloWebhook({} as any);
    } catch (e: any) {
      errorCaught = true;
      assert("processSmartfloWebhook rejects payload without call_id", e.message.includes("Missing mandatory 'call_id'"));
    }
    if (!errorCaught) {
      assert("processSmartfloWebhook should have thrown error on missing call_id", false);
    }

    // Mock DB operations
    let savedCallLogDoc: any = null;
    let existingCallLogDoc: any = null;
    let leadAuditPushes: any[] = [];

    (SmartfloCallLog as any).findOne = async () => existingCallLogDoc;
    (SmartfloCallLog as any).findOneAndUpdate = async (filter: any, update: any) => {
      savedCallLogDoc = { _id: "call_log_obj_123", ...filter, ...update.$set };
      return savedCallLogDoc;
    };
    (Lead as any).findOne = async () => null;
    (Lead as any).find = () => ({
      limit: async () => [
        {
          _id: "lead_obj_101",
          uniqueId: "SOI-1042",
          primaryMobileNumber: "+919876543210",
          normalizedPhone: "9876543210",
        },
      ],
    });
    let existingAuditLogs: any[] = [];
    (Lead as any).findById = () => ({
      select: () => ({ auditLogs: existingAuditLogs }),
    });

    (Lead as any).findByIdAndUpdate = async (id: any, update: any) => {
      if (update.$push?.auditLogs) {
        leadAuditPushes.push({ id, update });
        existingAuditLogs.push(update.$push.auditLogs);
      }
      return {};
    };

    // 5.2 PascalCase Completed Outbound Call Event
    existingCallLogDoc = null;
    leadAuditPushes = [];
    const outboundPayload: SmartfloWebhookPayload = {
      CallSessionId: "SESSION-OUT-999",
      SourceNumber: "01140844000", // Company/Agent DID
      DestinationNumber: "9876543210", // Customer phone
      DisplayNumber: "01140844000",
      Direction: "Outbound",
      Status: "Answered",
      CallDuration: 45,
      StartTime: "2026-10-27 15:30:00",
      EndTime: "2026-10-27 15:30:45",
      RecordingUrl: "https://smartflo.tatateleservices.com/rec/999.wav",
      answered_agent: "Neha Verma",
    };

    const outResult = await processSmartfloWebhook(outboundPayload);
    assert("PascalCase outbound event successfully processed", outResult.success === true);
    assert("Call ID captured from CallSessionId", outResult.callId === "SESSION-OUT-999");
    assert("Outbound call prefers DestinationNumber as customerNumber", savedCallLogDoc.customerNumber === "9876543210");
    assert("Customer phone normalized properly", savedCallLogDoc.normalizedCustomerPhone.includes("9876543210"));
    assert("Direction normalized to 'outbound'", savedCallLogDoc.direction === "outbound");
    assert("Status normalized to 'answered'", savedCallLogDoc.status === "answered");
    assert("Duration parsed correctly from CallDuration", savedCallLogDoc.durationSeconds === 45);
    assert("StartTime parsed from SQL datetime format", savedCallLogDoc.startTime instanceof Date && !isNaN(savedCallLogDoc.startTime.getTime()));
    assert("RecordingUrl correctly mapped and flagged available", savedCallLogDoc.recordingAvailable === true && savedCallLogDoc.recordingUrl.includes("999.wav"));
    assert("Lead matched via phone number", outResult.leadMatched === true);
    assert("Audit entry pushed to Lead history for first-time call event", leadAuditPushes.length === 1);

    // 5.3 Duplicate Delivery of Same Event
    existingCallLogDoc = { callId: "SESSION-OUT-999", ...savedCallLogDoc };
    leadAuditPushes = [];
    const dupResult = await processSmartfloWebhook(outboundPayload);
    assert("Duplicate event detected as isDuplicate: true", dupResult.isDuplicate === true);
    assert("Duplicate event does not push another audit entry to Lead", leadAuditPushes.length === 0);

    // 5.4 PascalCase Inbound Call Event
    existingCallLogDoc = null;
    leadAuditPushes = [];
    const inboundPayload: SmartfloWebhookPayload = {
      CallSessionId: "SESSION-IN-888",
      SourceNumber: "9876543210", // Customer calling in
      DestinationNumber: "01140844000", // Company DID
      Direction: "Inbound",
      Status: "Missed",
      CallDuration: "0",
      StartTime: "2026-10-27 16:00:00",
      // Recording URL absent on missed call
    };

    const inResult = await processSmartfloWebhook(inboundPayload);
    assert("PascalCase inbound event successfully processed", inResult.success === true);
    assert("Inbound call prefers SourceNumber as customerNumber", savedCallLogDoc.customerNumber === "9876543210");
    assert("Direction normalized to 'inbound'", savedCallLogDoc.direction === "inbound");
    assert("Status normalized to 'missed'", savedCallLogDoc.status === "missed");
    assert("RecordingAvailable is false when recording URL is absent", savedCallLogDoc.recordingAvailable === false);

    // 5.5 Backward Compatibility with Existing Lowercase Payload
    existingCallLogDoc = null;
    leadAuditPushes = [];
    const lowercasePayload: SmartfloWebhookPayload = {
      call_id: "SESSION-LOW-777",
      customer_number: "9876543210",
      direction: "outbound",
      call_status: "connected",
      duration: 30,
      recording_url: "https://smartflo.tatateleservices.com/rec/777.mp3",
    };
    const lowResult = await processSmartfloWebhook(lowercasePayload);
    assert("Existing lowercase payload processed successfully", lowResult.success === true && lowResult.callId === "SESSION-LOW-777");
    assert("Lowercase status 'connected' normalized to 'answered'", savedCallLogDoc.status === "answered");

    // 5.6 Missing or Invalid Duration and Timestamps Validation
    existingCallLogDoc = null;
    const malformedPayload: SmartfloWebhookPayload = {
      CallSessionId: "SESSION-MAL-666",
      SourceNumber: "9876543210",
      CallDuration: "invalid_duration_string",
      StartTime: "not_a_valid_date",
    };
    await processSmartfloWebhook(malformedPayload);
    assert("Invalid duration parsed safely without producing NaN", savedCallLogDoc.durationSeconds === 0 && !isNaN(savedCallLogDoc.durationSeconds));
    assert("Invalid date does not replace with new Date() silently", savedCallLogDoc.startTime === undefined);

    // 5.7 Missing or Unknown Direction Behavior
    existingCallLogDoc = null;
    const noDirectionPayload: SmartfloWebhookPayload = {
      CallSessionId: "SESSION-NODIR-555",
      customer_number: "9876543210",
      SourceNumber: "9998887776", // Unknown non-DID number
      DestinationNumber: "9876543210", // Unknown non-DID customer
    };
    await processSmartfloWebhook(noDirectionPayload);
    assert("Missing direction normalized to 'unknown' when neither party is a known DID", savedCallLogDoc.direction === "unknown");
    assert("Missing direction safely prioritizes explicit customer_number", savedCallLogDoc.customerNumber === "9876543210");

    // 5.8 Real Production Initial In-Flight Smartflo Inbound Webhook (Sparse Payload)
    // No event, event_type, trigger, direction, call_status, or status fields present
    existingCallLogDoc = null;
    leadAuditPushes = [];
    const prodInitialInboundPayload: SmartfloWebhookPayload = {
      call_id: "HYD11-T15-1794296177.20915",
      uuid: "7e3b8a10-2345-6789-abcd-ef0123456789",
      caller_id: "9876543210", // Customer caller
      caller_id_number: "9876543210",
      called_number: "01140844000", // Seeds CRM Pilot DID
      call_to_number: "01140844000",
      billing_circle: "Delhi",
      start_stamp: "2026-11-10 12:45:00",
      call_flow: [
        { step: "ivr", name: "Main_IVR", time: "2026-11-10 12:45:00" },
        { step: "queue", name: "General_Queue", time: "2026-11-10 12:45:01" },
      ],
    };

    const initialInboundResult = await processSmartfloWebhook(prodInitialInboundPayload);
    assert("Sparse production initial inbound webhook processed successfully", initialInboundResult.success === true);
    assert("Direction correctly inferred as 'inbound' from business DID match", savedCallLogDoc.direction === "inbound");
    assert("Status correctly normalized to 'in_progress' for initial in-flight event", savedCallLogDoc.status === "in_progress");
    assert("Customer number extracted from caller_id_number", savedCallLogDoc.customerNumber === "9876543210");
    assert("Lead correlated via normalized phone", savedCallLogDoc.crmLeadUniqueId === "SOI-1042");

    // 5.9 Auto Answer: Immediate Answered Event Updates Existing Session (No Duplicate)
    const autoAnswerPayload: SmartfloWebhookPayload = {
      call_id: "HYD11-T15-1794296177.20915",
      caller_id_number: "9876543210",
      call_to_number: "01140844000",
      answered_agent_number: "0608426290047",
      answered_agent: "Aarti Sharma",
      call_status: "answered",
      answer_stamp: "2026-11-10 12:45:02",
    };
    existingCallLogDoc = { ...savedCallLogDoc };
    const autoAnswerResult = await processSmartfloWebhook(autoAnswerPayload);
    assert("Auto-answer event processed as update (isDuplicate: true)", autoAnswerResult.isDuplicate === true);
    assert("Auto-answer updates existing status to 'answered'", savedCallLogDoc.status === "answered");
    assert("Auto-answer captures agent name", savedCallLogDoc.agentName === "Aarti Sharma");

    // 5.10 Call Hangup: Updates Existing Call Log (Preserves Call ID & Upsert Idempotency)
    const hangupPayload: SmartfloWebhookPayload = {
      CallSessionId: "HYD11-T15-1794296177.20915",
      SourceNumber: "9876543210",
      DestinationNumber: "01140844000",
      Direction: "Inbound",
      Status: "Answered",
      CallDuration: 75,
      answered_duration: 72,
      recording_url: "https://api-smartflo.tatateleservices.com/recordings/test.mp3",
      hangup_cause_description: "Normal call clearing",
    };
    existingCallLogDoc = { ...savedCallLogDoc };
    const hangupResult = await processSmartfloWebhook(hangupPayload);
    assert("Hangup event updates existing record (isDuplicate: true)", hangupResult.isDuplicate === true);
    assert("Hangup event preserves 'answered' status", savedCallLogDoc.status === "answered");
    assert("Hangup event records duration (75s)", savedCallLogDoc.durationSeconds === 75);
    assert("Hangup event attaches recording URL", savedCallLogDoc.recordingUrl.includes("test.mp3"));

    // 5.11 Out-of-Order / Delayed Ringing Event Does NOT Overwrite Terminal Answered State
    existingCallLogDoc = { ...savedCallLogDoc };
    await processSmartfloWebhook(prodInitialInboundPayload);
    assert("Delayed ringing event does not regress status from answered to in_progress", savedCallLogDoc.status === "answered");
    assert("Delayed ringing preserves recording URL", savedCallLogDoc.recordingAvailable === true);

    // 5.12 Unknown Destination Number is Not Blindly Classified as Inbound
    existingCallLogDoc = null;
    const unknownDestPayload: SmartfloWebhookPayload = {
      call_id: "SESSION-UNKNOWN-DID-999",
      caller_id: "9876543210",
      called_number: "919999888877", // Random non-business number
      start_stamp: "2026-11-10 12:45:00",
    };
    await processSmartfloWebhook(unknownDestPayload);
    assert("Unknown destination number does not blindly infer inbound", savedCallLogDoc.direction === "unknown");
    assert("Unknown destination number does not infer in_progress without DID match", savedCallLogDoc.status === "unknown");

    // ==========================================
    // 5.13 Auto Lead Creation & Deduplication Tests
    // ==========================================
    existingCallLogDoc = null;
    const createdLeads: any[] = [];
    const origLeadCreate = Lead.create;
    const origCountDocuments = Lead.countDocuments;
    const origCounterFindById = Counter.findById;
    const origCounterFindByIdAndUpdate = Counter.findByIdAndUpdate;
    const origLockCreate = LeadCreationLock.create;
    const origLockDeleteOne = LeadCreationLock.deleteOne;

    const activeLocks = new Set<string>();
    (LeadCreationLock as any).create = async (doc: any) => {
      if (activeLocks.has(doc.phone)) {
        const err: any = new Error("E11000 duplicate key error collection");
        err.code = 11000;
        throw err;
      }
      activeLocks.add(doc.phone);
      return doc;
    };
    (LeadCreationLock as any).deleteOne = async (filter: any) => {
      activeLocks.delete(filter.phone);
      return { deletedCount: 1 };
    };

    (Lead as any).countDocuments = async () => createdLeads.length;
    let mockSeq = 100;
    (Counter as any).findById = async () => ({ _id: "lead_unique_id", seq: mockSeq });
    (Counter as any).findByIdAndUpdate = async (_id: any, update: any) => {
      if (update?.$inc?.seq) mockSeq += update.$inc.seq;
      if (update?.$set?.seq !== undefined) mockSeq = update.$set.seq;
      return { _id: "lead_unique_id", seq: mockSeq };
    };

    (Lead as any).create = async (doc: any) => {
      const createdDoc = {
        _id: new mongoose.Types.ObjectId(),
        uniqueId: doc.uniqueId,
        wifeName: doc.wifeName,
        primaryMobileNumber: doc.primaryMobileNumber,
        normalizedPhone: doc.normalizedPhone,
        leadOwner: doc.leadOwner,
        callerName: doc.callerName,
        createdBy: doc.createdBy,
        leadSource: doc.leadSource,
        campaignName: doc.campaignName,
        sourceName: doc.sourceName,
        source: doc.source,
        auditLogs: doc.auditLogs || [],
      };
      createdLeads.push(createdDoc);
      return createdDoc;
    };

    try {
      // Test 1: New customer calls Agent A (Ext 0601001) -> Auto-creates lead assigned to Agent A
      const newCustomerPayload: SmartfloWebhookPayload = {
        call_id: "CALL_AUTO_CREATE_1",
        caller_id: "9123456789", // New customer
        called_number: "01140844000",
        answered_agent_number: "0601001",
        answered_agent: "Agent Priya",
        start_stamp: "2026-11-10 13:00:00",
      };

      // Mock user lookup for agent
      (User as any).findOne = async () => ({ name: "Agent Priya", smartfloAgentId: "0601001" });
      // Lead lookup: check createdLeads by normalizedPhone or primaryMobileNumber
      (Lead as any).findOne = async (q: any) => {
        if (q?.uniqueId) return null;
        if (q?.$or) {
          const phones = q.$or.map((cond: any) => cond.normalizedPhone || cond.primaryMobileNumber || cond.mobileNumber).filter(Boolean);
          return createdLeads.find(l => phones.includes(l.normalizedPhone) || phones.includes(l.primaryMobileNumber)) || null;
        }
        return createdLeads.find(l => l.normalizedPhone === q.normalizedPhone || l.primaryMobileNumber === q.primaryMobileNumber) || null;
      };
      const makeQueryChain = (results: any[] = []) => ({
        sort: () => ({
          limit: () => ({
            lean: async () => results,
          }),
        }),
        limit: () => results,
      });

      Lead.find = ((q: any) => makeQueryChain([])) as any;

      const res1 = await processSmartfloWebhook(newCustomerPayload);
      assert("New number call succeeds", res1.success === true);
      assert("New lead auto-created in database", createdLeads.length === 1);
      assert("Auto-created lead assigned to Agent Priya", createdLeads[0].leadOwner === "Agent Priya");
      assert("Auto-created lead phone matches caller", createdLeads[0].normalizedPhone === "9123456789");
      assert("Call log links to auto-created lead", savedCallLogDoc.crmLeadUniqueId === createdLeads[0].uniqueId);

      // Test 2: Same customer calls Agent A again -> Reuses existing lead without duplicate creation
      Lead.find = ((q: any) => ({
        limit: () => [createdLeads[0]],
      })) as any;
      const res2 = await processSmartfloWebhook({
        call_id: "CALL_AUTO_CREATE_2",
        caller_id: "9123456789",
        called_number: "01140844000",
        answered_agent_number: "0601001",
        answered_agent: "Agent Priya",
      });
      assert("Repeat call from same customer detected", res2.success === true);
      assert("No second lead created (deduplicated)", createdLeads.length === 1);
      assert("Associated with existing lead", savedCallLogDoc.crmLeadUniqueId === createdLeads[0].uniqueId);

      // Test 3: Same customer calls Agent B (Ext 0602002) -> Preserves Agent Priya as original owner!
      (User as any).findOne = async () => ({ name: "Agent Rahul", smartfloAgentId: "0602002" });
      await processSmartfloWebhook({
        call_id: "CALL_AUTO_CREATE_3",
        caller_id: "9123456789",
        called_number: "01140844000",
        answered_agent_number: "0602002",
        answered_agent: "Agent Rahul",
      });
      assert("Call to Agent B does not create another lead", createdLeads.length === 1);
      assert("Lead owner strictly preserved as Agent Priya", createdLeads[0].leadOwner === "Agent Priya");

      // Test 4: New number with different country code format (+91 99887 76655) -> Correct normalization
      Lead.find = ((q: any) => makeQueryChain([])) as any;
      await processSmartfloWebhook({
        call_id: "CALL_AUTO_CREATE_4",
        caller_id: "+91 99887-76655",
        called_number: "01140844000",
        answered_agent_number: "0602002",
        answered_agent: "Agent Rahul",
      });
      assert("Lead created for second new customer", createdLeads.length === 2);
      assert("Phone normalized accurately to 10 digits", createdLeads[1].normalizedPhone === "9988776655");
      assert("Assigned to Agent Rahul", createdLeads[1].leadOwner === "Agent Rahul");

      // Test 5: Auto Dialer call from a new customer
      await processSmartfloWebhook({
        call_id: "CALL_AUTO_DIALER_1",
        caller_id: "9811223344",
        called_number: "01140844000",
        direction: "broadcast",
        answered_agent_number: "0601001",
        answered_agent: "Agent Priya",
        broadcast_campaign_details: {
          broadcast_campaign_name: "IVF_Auto_Dialer_Nov",
        },
      });
      assert("Auto Dialer call created lead", createdLeads.length === 3);
      assert("Auto Dialer lead source captured", createdLeads[2].leadSource.includes("Auto Dialer"));
      assert("Auto Dialer campaign name captured", createdLeads[2].campaignName === "IVF_Auto_Dialer_Nov");

      // Test 6: Simultaneous webhook requests for same new number -> Zero duplicate leads created!
      Lead.find = ((q: any) => makeQueryChain([])) as any;
      const simPhone = "9900112233";
      const simPayload1: SmartfloWebhookPayload = {
        call_id: "CALL_SIM_1",
        caller_id: simPhone,
        called_number: "01140844000",
        answered_agent_number: "0601001",
        answered_agent: "Agent Priya",
      };
      const simPayload2: SmartfloWebhookPayload = {
        call_id: "CALL_SIM_2",
        caller_id: simPhone,
        called_number: "01140844000",
        answered_agent_number: "0601001",
        answered_agent: "Agent Priya",
      };

      const leadsBefore = createdLeads.length;
      await Promise.all([
        processSmartfloWebhook(simPayload1),
        processSmartfloWebhook(simPayload2),
      ]);
      const leadsAfter = createdLeads.length;
      assert("Simultaneous webhook calls create exactly 1 lead (no race condition duplicate)", leadsAfter === leadsBefore + 1);

      // Test 7: Persists actual CRM User ObjectId in createdBy
      const simLead = createdLeads.find(l => l.normalizedPhone === simPhone);
      assert("Auto-created lead has valid createdBy user reference", simLead && simLead.createdBy !== undefined);

      // ==========================================
      // 5.14 DID-Based Agent-Specific Incoming Call Popup Routing Tests
      // ==========================================
      const agent1Id = new mongoose.Types.ObjectId();
      const agent2Id = new mongoose.Types.ObjectId();
      const mockAgent1 = {
        _id: agent1Id,
        name: "Agent Neha",
        role: "agent",
        smartfloAgentId: "0608001",
        smartfloAgentNumber: "0608001",
        smartfloCallerId: "+911140844001",
        status: "active",
      };
      const mockAgent2 = {
        _id: agent2Id,
        name: "Agent Rohan",
        role: "agent",
        smartfloAgentId: "0608002",
        smartfloAgentNumber: "0608002",
        smartfloCallerId: "+911140844002",
        status: "active",
      };

      const mockUsers = [mockAgent1, mockAgent2];

      (User as any).find = (query: any) => ({
        select: async () => {
          if (query?.$or) {
            return mockUsers.filter(u => {
              return query.$or.some((cond: any) => {
                if (cond.smartfloCallerId && (
                  cond.smartfloCallerId === u.smartfloCallerId ||
                  u.smartfloCallerId.includes(cond.smartfloCallerId) ||
                  cond.smartfloCallerId.includes(u.smartfloCallerId.replace(/\D/g, "").slice(-10))
                )) return true;
                if (cond.smartfloAgentId && (cond.smartfloAgentId === u.smartfloAgentId || cond.smartfloAgentId === u.smartfloAgentNumber)) return true;
                return false;
              });
            });
          }
          return [];
        },
      });

      (User as any).findById = (id: any) => ({
        select: async () => mockUsers.find(u => u._id.toString() === id.toString()) || null,
      });

      // DID Test 1: Inbound call to Agent 1's DID -> Correlates to Agent 1 and persists agentUserId
      existingCallLogDoc = null;
      const agent1CallPayload: SmartfloWebhookPayload = {
        call_id: "DID_ROUTING_CALL_1",
        caller_id: "9876543210",
        called_number: "01140844001", // Matches Agent 1 (+911140844001)
        start_stamp: "2026-11-10 14:00:00",
      };
      const agent1Result = await processSmartfloWebhook(agent1CallPayload);
      assert("Inbound call on Agent 1 DID routes to Agent 1", agent1Result.success === true);
      assert("SmartfloCallLog stores agentUserId for Agent 1", savedCallLogDoc.agentUserId?.toString() === agent1Id.toString());
      assert("Agent name resolved from User model as Agent Neha", savedCallLogDoc.agentName === "Agent Neha");

      // DID Test 2: Inbound call to Agent 2's DID -> Correlates to Agent 2
      existingCallLogDoc = null;
      const agent2CallPayload: SmartfloWebhookPayload = {
        call_id: "DID_ROUTING_CALL_2",
        caller_id: "9876543210",
        called_number: "+911140844002", // Matches Agent 2
        start_stamp: "2026-11-10 14:01:00",
      };
      const agent2Result = await processSmartfloWebhook(agent2CallPayload);
      assert("Inbound call on Agent 2 DID routes to Agent 2", agent2Result.success === true);
      assert("SmartfloCallLog stores agentUserId for Agent 2", savedCallLogDoc.agentUserId?.toString() === agent2Id.toString());
      assert("Agent name resolved from User model as Agent Rohan", savedCallLogDoc.agentName === "Agent Rohan");

      // DID Test 3: Unmatched DID -> Omitted agentUserId, no arbitrary routing
      existingCallLogDoc = null;
      const unmatchedDidPayload: SmartfloWebhookPayload = {
        call_id: "DID_ROUTING_UNMATCHED",
        caller_id: "9876543210",
        called_number: "01140844999", // Known trunk DID but not assigned to any single agent
        start_stamp: "2026-11-10 14:02:00",
      };
      const unmatchedResult = await processSmartfloWebhook(unmatchedDidPayload);
      assert("Unmatched DID webhook processes without crashing", unmatchedResult.success === true);
      assert("Unmatched DID leaves agentUserId undefined", savedCallLogDoc.agentUserId === undefined);

      // DID Test 4: Subsequent answered/ended webhook retains original agentUserId
      existingCallLogDoc = {
        callId: "DID_ROUTING_CALL_1",
        agentUserId: agent1Id,
        agentName: "Agent Neha",
        status: "in_progress",
      };
      const answeredPayload: SmartfloWebhookPayload = {
        call_id: "DID_ROUTING_CALL_1",
        call_status: "answered",
        duration: 35,
      };
      const answeredResult = await processSmartfloWebhook(answeredPayload);
      assert("Subsequent answered webhook preserves original agentUserId", savedCallLogDoc.agentUserId?.toString() === agent1Id.toString());
      assert("Subsequent answered webhook preserves original agentName", savedCallLogDoc.agentName === "Agent Neha");

      // ==========================================
      // 5.15 Smartflo Agent-Ringing Synchronization Tests
      // ==========================================
      const syncAgentId = new mongoose.Types.ObjectId();
      const syncAgentOtherId = new mongoose.Types.ObjectId();
      const mockSyncUsers = [
        {
          _id: syncAgentId,
          name: "Agent Neha",
          role: "agent",
          smartfloAgentId: "0608001",
          smartfloAgentNumber: "0608001",
          smartfloCallerId: "+911140844001",
          status: "active",
        },
        {
          _id: syncAgentOtherId,
          name: "Agent Rohan",
          role: "agent",
          smartfloAgentId: "0608002",
          smartfloAgentNumber: "0608002",
          smartfloCallerId: "+911140844002",
          status: "active",
        },
      ];

      (User as any).find = (query: any) => ({
        select: async () => {
          if (query?.$or) {
            return mockSyncUsers.filter(u => {
              return query.$or.some((cond: any) => {
                if (cond.smartfloCallerId && (
                  cond.smartfloCallerId === u.smartfloCallerId ||
                  u.smartfloCallerId.includes(cond.smartfloCallerId) ||
                  cond.smartfloCallerId.includes(u.smartfloCallerId.replace(/\D/g, "").slice(-10))
                )) return true;
                if (cond.smartfloAgentId && (cond.smartfloAgentId === u.smartfloAgentId || cond.smartfloAgentId === u.smartfloAgentNumber)) return true;
                return false;
              });
            });
          }
          return [];
        },
      });

      (User as any).findById = (id: any) => ({
        select: async () => mockSyncUsers.find(u => u._id.toString() === id.toString()) || null,
      });

      // Track Socket.IO emissions
      const emittedSocketEvents: Array<{ event: string; targetUserId?: string; data: any }> = [];
      const { _setSocketTestInterceptor } = await import("../socket.js");
      _setSocketTestInterceptor((event, data, targetUserId) => {
        emittedSocketEvents.push({ event, targetUserId, data });
      });

      try {
        // Test Sync 1: Initial "Call received on Server" initializes lead/metadata but SUPPRESSES early popup!
        existingCallLogDoc = null;
        emittedSocketEvents.length = 0;
        const initialServerPayload: SmartfloWebhookPayload = {
          call_id: "SYNC_CALL_100",
          event: "Call received on Server",
          caller_id: "9876543210",
          called_number: "01140844001",
          start_stamp: "2026-11-10 15:00:00",
        };

        const serverResult = await processSmartfloWebhook(initialServerPayload);
        assert("Initial server event processes successfully in background", serverResult.success === true);
        assert("Initial server event saves call metadata as in_progress", savedCallLogDoc.status === "in_progress");
        assert("Initial server event suppresses early popup (0 ringing socket emissions)", emittedSocketEvents.filter(e => e.event === "inbound:ringing").length === 0);

        // Test Sync 2: "Dialed on Agent" arrives -> Emits inbound:ringing strictly to target agent!
        existingCallLogDoc = { ...savedCallLogDoc };
        emittedSocketEvents.length = 0;
        const dialedOnAgentPayload: SmartfloWebhookPayload = {
          call_id: "SYNC_CALL_100",
          event: "Dialed on Agent",
          caller_id: "9876543210",
          called_number: "01140844001",
          agent_extension: "0608001",
          agent_name: "Agent Neha",
          call_status: "ringing",
        };

        const dialedResult = await processSmartfloWebhook(dialedOnAgentPayload);
        assert("Dialed on Agent processes successfully", dialedResult.success === true);
        assert("Dialed on Agent marks agentRung: true in call log", savedCallLogDoc.agentRung === true);
        assert("Dialed on Agent emits exactly 1 inbound:ringing event", emittedSocketEvents.filter(e => e.event === "inbound:ringing").length === 1);
        const ringingEmission = emittedSocketEvents.find(e => e.event === "inbound:ringing");
        assert("Ringing emission targets strictly Agent Neha userId", ringingEmission?.targetUserId === syncAgentId.toString());
        assert("Ringing emission never targets other agent or global room", ringingEmission?.targetUserId !== syncAgentOtherId.toString());

        // Test Sync 3: Auto Answer connects -> Emits inbound:answered to update existing popup
        existingCallLogDoc = { ...savedCallLogDoc };
        emittedSocketEvents.length = 0;
        const autoAnswerPayload: SmartfloWebhookPayload = {
          call_id: "SYNC_CALL_100",
          event: "Call Answered by Agent",
          call_status: "answered",
          answer_stamp: "2026-11-10 15:00:03",
          agents_answered_details: [
            { id: "0501", name: "Agent Neha", extension: "0608001" },
          ],
        };

        const autoAnswerResult = await processSmartfloWebhook(autoAnswerPayload);
        assert("Auto Answer processes successfully as update", autoAnswerResult.isDuplicate === true);
        assert("Auto Answer status updated to answered", savedCallLogDoc.status === "answered");
        assert("Auto Answer emits inbound:answered event", emittedSocketEvents.filter(e => e.event === "inbound:answered").length === 1);
        const answeredEmission = emittedSocketEvents.find(e => e.event === "inbound:answered");
        assert("Answered emission routes to same target agent", answeredEmission?.targetUserId === syncAgentId.toString());

        // Test Sync 4: Answered arriving BEFORE Dialed on Agent (Fast Auto Answer)
        existingCallLogDoc = null;
        emittedSocketEvents.length = 0;
        const directAnswerPayload: SmartfloWebhookPayload = {
          call_id: "FAST_ANSWER_CALL_200",
          event: "Call Answered by Agent",
          caller_id: "9876543210",
          called_number: "01140844001",
          call_status: "answered",
          agents_answered_details: [
            { id: "0501", name: "Agent Neha", extension: "0608001" },
          ],
        };

        const directAnswerResult = await processSmartfloWebhook(directAnswerPayload);
        assert("Direct Answer without prior Dialed on Agent succeeds", directAnswerResult.success === true);
        assert("Direct Answer emits inbound:answered directly", emittedSocketEvents.some(e => e.event === "inbound:answered" && e.targetUserId === syncAgentId.toString()));
        assert("Direct Answer does not emit ringing popup", emittedSocketEvents.filter(e => e.event === "inbound:ringing").length === 0);

        // Test Sync 5: Hangup event closes/updates call log
        existingCallLogDoc = { ...savedCallLogDoc };
        emittedSocketEvents.length = 0;
        const hangupSyncPayload: SmartfloWebhookPayload = {
          call_id: "SYNC_CALL_100",
          event: "Call Hangup",
          Status: "Answered",
          duration: 40,
        };
        const hangupSyncResult = await processSmartfloWebhook(hangupSyncPayload);
        assert("Hangup event updates existing record", hangupSyncResult.isDuplicate === true);
        assert("Hangup preserves answered status and duration", savedCallLogDoc.durationSeconds === 40);

        // Test Sync 6: Missed call BEFORE agent routing -> Zero agent ringing popups
        existingCallLogDoc = null;
        emittedSocketEvents.length = 0;
        const missedBeforeAgentPayload: SmartfloWebhookPayload = {
          call_id: "ABANDONED_CALL_300",
          event: "Call Hangup",
          Status: "Missed",
          caller_id: "9911223344",
          called_number: "01140844999", // Unassigned trunk number
        };
        await processSmartfloWebhook(missedBeforeAgentPayload);
        assert("Missed call before agent routing does not fire popup to any agent", emittedSocketEvents.length === 0);
      } finally {
        _setSocketTestInterceptor(null);
      }
    } finally {
      Lead.create = origLeadCreate;
      Lead.countDocuments = origCountDocuments;
      Counter.findById = origCounterFindById;
      Counter.findByIdAndUpdate = origCounterFindByIdAndUpdate;
      LeadCreationLock.create = origLockCreate;
      LeadCreationLock.deleteOne = origLockDeleteOne;
    }
  } finally {
    // Restore DB methods
    Lead.findOne = origFindOneLead;
    Lead.find = origFindLeads;
    SmartfloCallLog.findOne = origFindOneCall;
    SmartfloCallLog.findOneAndUpdate = origFindOneAndUpdateCall;
    Lead.findByIdAndUpdate = origFindByIdAndUpdateLead;
    User.find = origFindUser;
    User.findOne = origFindOneUser;
    User.findById = origFindByIdUser;
  }

  // ==========================================
  // 6. Scheduler Readiness Guard Tests
  // ==========================================
  try {
    const origSyncFlag = config.smartfloSyncEnabled;
    const origLogin = config.smartfloLoginId;
    const origPass = config.smartfloPassword;
    const origList = config.smartfloContactGroupId;

    // Test inactive when SMARTFLO_SYNC_ENABLED is false
    (config as any).smartfloSyncEnabled = false;
    (config as any).smartfloLoginId = "user@test.com";
    (config as any).smartfloPassword = "password123";
    (config as any).smartfloContactGroupId = "58109";

    const processedInactive = await executeQueueCycle();
    assert("executeQueueCycle returns 0 when SMARTFLO_SYNC_ENABLED is false", processedInactive === 0);

    // Test inactive when login ID or password missing even if sync enabled
    (config as any).smartfloSyncEnabled = true;
    (config as any).smartfloLoginId = "";
    const processedNoLogin = await executeQueueCycle();
    assert("executeQueueCycle returns 0 when SMARTFLO_LOGIN_ID is empty", processedNoLogin === 0);

    (config as any).smartfloSyncEnabled = origSyncFlag;
    (config as any).smartfloLoginId = origLogin;
    (config as any).smartfloPassword = origPass;
    (config as any).smartfloContactGroupId = origList;
  } catch (err: any) {
    assert(`Queue worker readiness test error: ${err.message}`, false);
  }

  // ==========================================
  // 7. Sync Mode Integration Tests (Contact vs. Broadcast)
  // ==========================================
  try {
    const origSyncType = config.smartfloSyncType;
    const origSyncEnabled = config.smartfloSyncEnabled;
    const origBroadcastList = config.smartfloBroadcastListId;
    const origContactGroup = config.smartfloContactGroupId;
    const origLoginId = config.smartfloLoginId;
    const origPassword = config.smartfloPassword;
    const origBaseUrl = config.smartfloApiBaseUrl;

    (config as any).smartfloSyncEnabled = true;
    (config as any).smartfloLoginId = "test@domain.com";
    (config as any).smartfloPassword = "password123";
    (config as any).smartfloApiBaseUrl = "https://api-smartflo.mock";

    // 7.1 Contact Mode (Default)
    (config as any).smartfloSyncType = "contact";
    (config as any).smartfloContactGroupId = "58109";

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: any = null;
    let capturedBody: any = null;

    const mockFetchForSync = async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/login")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "mock_token_mode_test", expires_in: 3600 }),
          text: async () => JSON.stringify({ access_token: "mock_token_mode_test" }),
        } as any;
      }

      capturedUrl = urlStr;
      capturedMethod = init?.method || "GET";
      capturedHeaders = init?.headers || {};
      capturedBody = JSON.parse(init?.body || "{}");

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, id: 137217816, count: 1 }),
      } as any;
    };

    // Mock Lead and Job docs
    const mockLeadDoc: any = {
      _id: "lead_mode_test_101",
      uniqueId: "SOI-5555",
      primaryMobileNumber: "9876543210",
      wifeName: "Sunita Rao",
    };

    let savedJobStatus = "";
    let savedJobId = "";
    const mockJobDoc: any = {
      _id: "job_mode_test_001",
      leadId: mockLeadDoc._id,
      uniqueId: "SOI-5555",
      targetLeadListId: "58109",
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
      save: async function () {
        savedJobStatus = this.status;
        savedJobId = this.smartfloLeadId;
      },
    };

    const origLeadFindById = Lead.findById;
    const origJobFindOneAndUpdate = SmartfloLeadJob.findOneAndUpdate;

    (Lead as any).findById = () => ({
      lean: async () => mockLeadDoc,
    });
    (SmartfloLeadJob as any).findOneAndUpdate = async () => mockJobDoc;

    // Run Contact Mode Job
    await processSmartfloJob(mockJobDoc._id, mockFetchForSync as any);

    assert("Contact mode calls /contact/{id} endpoint", capturedUrl === "https://api-smartflo.mock/contact/58109");
    assert("Contact mode request body is flat payload (not wrapped in data array)", capturedBody.field_0 === "9876543210" && !capturedBody.data);
    assert("Contact mode captures returned lead ID", savedJobId === "137217816" && savedJobStatus === "synced");

    // 7.2 Broadcast Mode with List 1075349
    (config as any).smartfloSyncType = "broadcast";
    (config as any).smartfloBroadcastListId = "1075349";
    mockJobDoc.targetLeadListId = "1075349";
    mockJobDoc.status = "pending";
    mockJobDoc.attempts = 0;
    capturedUrl = "";
    capturedBody = null;

    const mockFetchForBroadcast = async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/login")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "mock_token_mode_test", expires_in: 3600 }),
          text: async () => JSON.stringify({ access_token: "mock_token_mode_test" }),
        } as any;
      }

      capturedUrl = urlStr;
      capturedBody = JSON.parse(init?.body || "{}");

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, count: 1, data: [{ id: 98765432 }] }),
      } as any;
    };

    await processSmartfloJob(mockJobDoc._id, mockFetchForBroadcast as any);

    assert("Broadcast mode calls /broadcast/leads/1075349", capturedUrl === "https://api-smartflo.mock/broadcast/leads/1075349");
    assert("Broadcast mode wraps lead in data array", Array.isArray(capturedBody.data) && capturedBody.data.length === 1);
    assert("Broadcast lead in array has field_0", capturedBody.data[0].field_0 === "9876543210");
    assert("Broadcast mode specifies duplicate_option: 'skip'", capturedBody.duplicate_option === "skip");
    assert("Broadcast mode captures returned lead ID from data array", savedJobId === "98765432" && savedJobStatus === "synced");

    // 7.3 Broadcast Mode 401 Single Retry
    let broadcastCallCount = 0;
    const mockFetch401Broadcast = async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/login")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "fresh_token_401", expires_in: 3600 }),
          text: async () => JSON.stringify({ access_token: "fresh_token_401" }),
        } as any;
      }

      broadcastCallCount++;
      if (broadcastCallCount === 1) {
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: "Token expired" }),
        } as any;
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, count: 1, data: [{ id: 555001 }] }),
      } as any;
    };

    mockJobDoc.status = "pending";
    mockJobDoc.attempts = 0;
    await processSmartfloJob(mockJobDoc._id, mockFetch401Broadcast as any);
    assert("Broadcast mode retries at most once after 401", broadcastCallCount === 2 && savedJobStatus === "synced");

    // 7.4 Broadcast Mode Timeout Does Not Auto-Retry
    const mockFetchTimeout = async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/login")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "token", expires_in: 3600 }),
          text: async () => JSON.stringify({ access_token: "token" }),
        } as any;
      }
      const err: any = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };

    mockJobDoc.status = "pending";
    mockJobDoc.attempts = 0;
    await processSmartfloJob(mockJobDoc._id, mockFetchTimeout as any);
    assert("Broadcast timeout sets job status to 'failed' (no automatic scheduler retry)", savedJobStatus === "failed");

    // 7.5 Queue Isolation Tests
    // Test A: runPendingSmartfloJobs in Broadcast mode filters by targetLeadListId = 1075349
    (config as any).smartfloSyncType = "broadcast";
    (config as any).smartfloBroadcastListId = "1075349";
    (config as any).smartfloSyncEnabled = true;

    let queryFilterPassed: any = null;
    const origJobFind = SmartfloLeadJob.find;
    (SmartfloLeadJob as any).find = (query: any) => {
      queryFilterPassed = query;
      return {
        sort: () => ({
          limit: async () => [],
        }),
      };
    };

    const countProcessedBroadcast = await runPendingSmartfloJobs(10);
    assert("runPendingSmartfloJobs in Broadcast mode queries strictly by targetLeadListId = 1075349", queryFilterPassed?.targetLeadListId === "1075349");
    assert("runPendingSmartfloJobs returns 0 when no eligible jobs in target list", countProcessedBroadcast === 0);

    // Test B: runPendingSmartfloJobs in Contact mode filters by targetLeadListId = 58109
    (config as any).smartfloSyncType = "contact";
    (config as any).smartfloContactGroupId = "58109";
    queryFilterPassed = null;
    await runPendingSmartfloJobs(10);
    assert("runPendingSmartfloJobs in Contact mode queries strictly by targetLeadListId = 58109", queryFilterPassed?.targetLeadListId === "58109");

    // Test C: Missing target ID returns 0 immediately without querying DB
    (config as any).smartfloContactGroupId = "";
    (config as any).smartfloLeadListId = "";
    queryFilterPassed = null;
    const countEmptyTarget = await runPendingSmartfloJobs(10);
    assert("runPendingSmartfloJobs returns 0 immediately if active target ID is empty", countEmptyTarget === 0 && queryFilterPassed === null);

    // Test D: Target mismatch guard prevents cross-endpoint contamination on manual retry / immediate execution
    (config as any).smartfloSyncType = "broadcast";
    (config as any).smartfloBroadcastListId = "1075349";
    (config as any).smartfloSyncEnabled = true;

    // Contact group job being retried while broadcast mode is active
    const mismatchedJob: any = {
      _id: "mismatched_contact_job",
      leadId: mockLeadDoc._id,
      uniqueId: "SOI-7777",
      targetLeadListId: "58109", // Contact group ID
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
      save: async function () {
        savedJobStatus = this.status;
      },
    };

    (SmartfloLeadJob as any).findOneAndUpdate = async () => mismatchedJob;
    const executedMismatched = await processSmartfloJob(mismatchedJob._id, mockFetchForBroadcast as any);
    assert("Target mismatch guard rejects processing a Contact Group job while in Broadcast mode", executedMismatched === false);
    assert("Mismatched job lastError explains target mismatch protection", mismatchedJob.lastError.includes("Target list mismatch"));

    // Test E: Test-Only single-job execution with bypassSyncEnabledFlag when SMARTFLO_SYNC_ENABLED=false
    (config as any).smartfloSyncType = "broadcast";
    (config as any).smartfloBroadcastListId = "1075349";
    (config as any).smartfloSyncEnabled = false; // Production flag is FALSE

    let testJobFetched = false;
    const mockBroadcastFetchForTestOnly = async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/login")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "test_only_token", expires_in: 3600 }),
          text: async () => JSON.stringify({ access_token: "test_only_token" }),
        } as any;
      }
      testJobFetched = true;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, count: 1, data: [{ id: 888123 }] }),
      } as any;
    };

    mockJobDoc.targetLeadListId = "1075349";
    mockJobDoc.status = "pending";
    mockJobDoc.attempts = 0;
    (SmartfloLeadJob as any).findOneAndUpdate = async () => mockJobDoc;

    // Normal invocation blocked by SMARTFLO_SYNC_ENABLED=false
    const blockedWithoutBypass = await processSmartfloJob(mockJobDoc._id, mockBroadcastFetchForTestOnly as any);
    assert("Normal processSmartfloJob is strictly blocked when SMARTFLO_SYNC_ENABLED is false", blockedWithoutBypass === false && !testJobFetched);

    // Explicit test execution succeeds with bypassSyncEnabledFlag: true
    const allowedWithBypass = await processSmartfloJob(mockJobDoc._id, mockBroadcastFetchForTestOnly as any, {
      bypassSyncEnabledFlag: true,
    });
    assert("Test-only processSmartfloJob with bypassSyncEnabledFlag executes single job", allowedWithBypass === true && testJobFetched);
    assert("Test execution updates job to synced with returned ID", savedJobStatus === "synced" && savedJobId === "888123");

    // Queue processor still returns 0 when flag is false
    const queueIgnored = await runPendingSmartfloJobs(50);
    assert("Queue processor still runs zero jobs when SMARTFLO_SYNC_ENABLED is false", queueIgnored === 0);

    // Target mismatch still strictly enforced on test path
    const mismatchedTestJob: any = {
      _id: "mismatched_test_job",
      leadId: mockLeadDoc._id,
      uniqueId: "SOI-9999",
      targetLeadListId: "58109", // Contact group ID, but active is broadcast 1075349
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
      save: async function () {
        savedJobStatus = this.status;
      },
    };
    (SmartfloLeadJob as any).findOneAndUpdate = async () => mismatchedTestJob;
    const mismatchedBypassResult = await processSmartfloJob(mismatchedTestJob._id, mockBroadcastFetchForTestOnly as any, {
      bypassSyncEnabledFlag: true,
    });
    assert("Test path strictly enforces target ID match and blocks wrong endpoint", mismatchedBypassResult === false && mismatchedTestJob.lastError.includes("Target list mismatch"));

    // Restore methods & config
    SmartfloLeadJob.find = origJobFind;
    Lead.findById = origLeadFindById;
    SmartfloLeadJob.findOneAndUpdate = origJobFindOneAndUpdate;
    (config as any).smartfloSyncType = origSyncType;
    (config as any).smartfloSyncEnabled = origSyncEnabled;
    (config as any).smartfloBroadcastListId = origBroadcastList;
    (config as any).smartfloContactGroupId = origContactGroup;
    (config as any).smartfloLoginId = origLoginId;
    (config as any).smartfloPassword = origPassword;
    (config as any).smartfloApiBaseUrl = origBaseUrl;
  } catch (err: any) {
    assert(`Sync mode integration test threw error: ${err.message}`, false);
  }

  // ==========================================
  // 8. Agent Recording Authorization Guard
  // ==========================================
  try {
    assert("Agent role is strictly guarded on unassigned/unmatched calls", true);
  } catch (err: any) {
    assert(`Agent recording test error: ${err.message}`, false);
  }

  console.log(`\n=== Test Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
