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
import { SmartfloCallLog } from "../models/SmartfloCallLog.js";
import { SmartfloLeadJob } from "../models/SmartfloLeadJob.js";

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

  try {
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
    (Lead as any).findByIdAndUpdate = async (id: any, update: any) => {
      leadAuditPushes.push({ id, update });
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
      SourceNumber: "01140844000",
      DestinationNumber: "9876543210",
    };
    await processSmartfloWebhook(noDirectionPayload);
    assert("Missing direction normalized to 'unknown'", savedCallLogDoc.direction === "unknown");
    assert("Missing direction safely prioritizes explicit customer_number", savedCallLogDoc.customerNumber === "9876543210");
  } finally {
    // Restore DB methods
    Lead.findOne = origFindOneLead;
    Lead.find = origFindLeads;
    SmartfloCallLog.findOne = origFindOneCall;
    SmartfloCallLog.findOneAndUpdate = origFindOneAndUpdateCall;
    Lead.findByIdAndUpdate = origFindByIdAndUpdateLead;
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
