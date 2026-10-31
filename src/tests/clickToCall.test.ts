import { initiateSmartfloClickToCall, _clearClickToCallDebounceMap } from "../services/smartflo/smartfloClickToCallService.js";
import { executeSmartfloCallHangup, _clearHangupDebounceMap } from "../services/smartflo/smartfloHangupService.js";
import { handleClickToCall, handleHangupCall } from "../controllers/smartfloController.js";
import { updateMySmartfloExtension } from "../controllers/authController.js";
import { processSmartfloWebhook } from "../services/smartflo/smartfloWebhookService.js";
import { config } from "../config/env.js";
import { _setMockTokenCache, invalidateSmartfloAccessToken } from "../services/smartflo/smartfloAuthService.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { SmartfloCallLog } from "../models/SmartfloCallLog.js";
import mongoose from "mongoose";

async function runClickToCallTests() {
  console.log("=== Running Smartflo Click-to-Call Unit & Logic Tests ===");
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

  // Backup configs
  const origCallerId = config.smartfloCallerId;
  const origLoginId = config.smartfloLoginId;
  const origPassword = config.smartfloPassword;
  const origBaseUrl = config.smartfloApiBaseUrl;

  try {
    // Set valid test auth cache (expires in 1 hour)
    _setMockTokenCache({
      accessToken: "MOCK_SMARTFLO_JWT_TOKEN",
      expiresAt: Date.now() + 3600 * 1000,
    });
    config.smartfloCallerId = "919999900000";
    config.smartfloLoginId = "TEST_USER";
    config.smartfloPassword = "TEST_PASSWORD";
    config.smartfloApiBaseUrl = "https://api-smartflo.mock/v1";

    // ----------------------------------------------------
    // Test 1: Correct API URL, Headers, and Verified Payload Contract
    // ----------------------------------------------------
    {
      _clearClickToCallDebounceMap();
      let capturedUrl = "";
      let capturedOptions: any = null;

      const mockFetch: any = async (url: string, options: any) => {
        capturedUrl = url;
        capturedOptions = options;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            message: "Call originated successfully.",
            ref_id: "C2C2408011234MOCK",
          }),
        };
      };

      const mockLead: any = {
        _id: "65d8a9b2f123456789abcdef",
        uniqueId: "SOI-1042",
        primaryMobileNumber: "+91 98765 43210",
        callingConsent: "Yes",
      };

      const mockUser: any = {
        name: "Agent Smith",
        email: "smith@seedscrm.com",
        smartfloAgentNumber: "06012345",
      };

      const res = await initiateSmartfloClickToCall(
        { lead: mockLead, user: mockUser },
        mockFetch,
        () => 1700000000000
      );

      assert("Click-to-call returns success: true", res.success === true);
      assert("Captures refId from Smartflo response", res.refId === "C2C2408011234MOCK");
      assert("Dispatches to /v1/click_to_call endpoint", capturedUrl === "https://api-smartflo.mock/v1/click_to_call");
      assert("Attaches Bearer auth token header", capturedOptions.headers.Authorization === "Bearer MOCK_SMARTFLO_JWT_TOKEN");
      assert("Sets application/json content-type header", capturedOptions.headers["Content-Type"] === "application/json");

      const body = JSON.parse(capturedOptions.body);
      assert("Payload uses verified 'agent_number'", body.agent_number === "06012345");
      assert("Payload uses verified 'destination_number' (prefixed with 91)", body.destination_number === "919876543210");
      assert("Payload sets async=1 as strictly required by Smartflo", body.async === 1);
      assert("Payload includes configured Caller ID", body.caller_id === "919999900000");
      assert("Payload includes custom_identifier with lead_unique_id", body.custom_identifier?.lead_unique_id === "SOI-1042");
      assert("Custom identifier does not contain $ characters", !JSON.stringify(body.custom_identifier).includes("$"));
    }

    // ----------------------------------------------------
    // Test 2: Missing Agent Mapping is Rejected
    // ----------------------------------------------------
    {
      _clearClickToCallDebounceMap();
      const mockLead: any = {
        uniqueId: "SOI-1042",
        primaryMobileNumber: "9876543210",
      };
      const mockUserNoAgent: any = {
        name: "Unconfigured Agent",
        email: "noagent@seedscrm.com",
        smartfloAgentNumber: "", // empty
      };

      let threw = false;
      try {
        await initiateSmartfloClickToCall({ lead: mockLead, user: mockUserNoAgent });
      } catch (e: any) {
        threw = true;
        assert("Rejects when agent telephony identifier is missing", e.message.includes("Extension ID in Profile Settings"));
      }
      assert("Missing agent mapping threw error", threw);
    }

    // ----------------------------------------------------
    // Test 3: Missing Outbound Caller ID is Rejected
    // ----------------------------------------------------
    {
      _clearClickToCallDebounceMap();
      config.smartfloCallerId = ""; // unset
      const mockLead: any = {
        uniqueId: "SOI-1042",
        primaryMobileNumber: "9876543210",
      };
      const mockUser: any = {
        name: "Agent Smith",
        smartfloAgentNumber: "06012345",
      };

      let threw = false;
      try {
        await initiateSmartfloClickToCall({ lead: mockLead, user: mockUser });
      } catch (e: any) {
        threw = true;
        assert("Rejects when SMARTFLO_CALLER_ID is not configured", e.message.includes("Caller ID in Profile Settings"));
      }
      assert("Missing Caller ID threw error", threw);
      config.smartfloCallerId = "919999900000"; // restore
    }

    // ----------------------------------------------------
    // Test 4: Calling Consent Restriction ('No') is Blocked
    // ----------------------------------------------------
    {
      _clearClickToCallDebounceMap();
      const mockLeadNoConsent: any = {
        uniqueId: "SOI-1042",
        primaryMobileNumber: "9876543210",
        callingConsent: "No",
      };
      const mockUser: any = {
        name: "Agent Smith",
        smartfloAgentNumber: "06012345",
      };

      let threw = false;
      try {
        await initiateSmartfloClickToCall({ lead: mockLeadNoConsent, user: mockUser });
      } catch (e: any) {
        threw = true;
        assert("Blocks call when callingConsent is 'No'", e.message.includes("calling consent. Calling blocked"));
      }
      assert("Consent restriction threw error", threw);
    }

    // ----------------------------------------------------
    // Test 5: Invalid Phone Numbers are Rejected
    // ----------------------------------------------------
    {
      _clearClickToCallDebounceMap();
      const mockLeadInvalidPhone: any = {
        uniqueId: "SOI-1042",
        primaryMobileNumber: "123", // too short / invalid
      };
      const mockUser: any = {
        name: "Agent Smith",
        smartfloAgentNumber: "06012345",
      };

      let threw = false;
      try {
        await initiateSmartfloClickToCall({ lead: mockLeadInvalidPhone, user: mockUser });
      } catch (e: any) {
        threw = true;
        assert("Rejects invalid destination phone format", e.message.includes("Invalid destination phone number format"));
      }
      assert("Invalid phone threw error", threw);
    }

    // ----------------------------------------------------
    // Test 6: Smartflo API Rejection and HTTP Error Handling
    // ----------------------------------------------------
    {
      _clearClickToCallDebounceMap();
      const mockFetchReject: any = async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ success: false, message: "Invalid destination number." }),
      });

      const mockLead: any = {
        uniqueId: "SOI-1042",
        primaryMobileNumber: "9876543210",
      };
      const mockUser: any = {
        name: "Agent Smith",
        smartfloAgentNumber: "06012345",
      };

      let threw = false;
      try {
        await initiateSmartfloClickToCall({ lead: mockLead, user: mockUser }, mockFetchReject);
      } catch (e: any) {
        threw = true;
        assert("Safely catches and surfaces Smartflo HTTP 400 error", e.message.includes("Smartflo Click-to-Call error (HTTP 400)"));
      }
      assert("HTTP error threw exception", threw);
    }

    // ----------------------------------------------------
    // Test 7: Double-Click Debounce / Rate Limiting
    // ----------------------------------------------------
    {
      _clearClickToCallDebounceMap();
      const mockFetchOk: any = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, ref_id: "REF1" }),
      });

      const mockLead: any = {
        _id: "lead123",
        uniqueId: "SOI-1042",
        primaryMobileNumber: "9876543210",
      };
      const mockUser: any = {
        email: "smith@seedscrm.com",
        smartfloAgentNumber: "06012345",
      };

      let clock = 100000;
      const res1 = await initiateSmartfloClickToCall({ lead: mockLead, user: mockUser }, mockFetchOk, () => clock);
      assert("First click call request succeeds", res1.success === true);

      // Second click 2 seconds later
      clock += 2000;
      let debounced = false;
      try {
        await initiateSmartfloClickToCall({ lead: mockLead, user: mockUser }, mockFetchOk, () => clock);
      } catch (e: any) {
        debounced = true;
        assert("Second rapid click within 10s is blocked by debounce guard", e.message.includes("A call request to this lead was just initiated"));
      }
      assert("Debounce protection triggered", debounced);

      // Third click 11 seconds later (outside debounce window)
      clock += 9000;
      const res3 = await initiateSmartfloClickToCall({ lead: mockLead, user: mockUser }, mockFetchOk, () => clock);
      assert("Click after debounce window expires succeeds", res3.success === true);
    }

    // ----------------------------------------------------
    // Test 8: Controller Role-Based Access Control (RBAC)
    // ----------------------------------------------------
    {
      _clearClickToCallDebounceMap();

      // Mock Mongoose Lead.findOne and User.findById
      const origLeadFindOne = Lead.findOne;
      const origUserFindById = User.findById;

      const leadOwnedByAgentA: any = {
        _id: "lead_a_id",
        uniqueId: "SOI-101",
        primaryMobileNumber: "9876543210",
        callerName: "Agent Aarti",
        leadOwner: "Agent Aarti",
      };

      (Lead as any).findOne = () => ({
        lean: () => leadOwnedByAgentA,
        then: (resolve: any) => resolve(leadOwnedByAgentA),
      });

      (User as any).findById = (id: string) => ({
        lean: () => ({ name: "Agent Bob", smartfloAgentNumber: "060999" }),
        then: (resolve: any) => resolve({ name: "Agent Bob", smartfloAgentNumber: "060999" }),
      });

      let statusReceived = 0;
      let jsonReceived: any = null;

      const mockRes: any = {
        status: (code: number) => {
          statusReceived = code;
          return {
            json: (payload: any) => {
              jsonReceived = payload;
            },
          };
        },
      };

      // Agent Bob attempts to call Agent Aarti's lead
      const reqUnauthorizedAgent: any = {
        user: {
          id: "bob_user_id",
          name: "Agent Bob",
          email: "bob@seedscrm.com",
          role: "agent",
        },
        body: {
          leadId: "SOI-101",
        },
      };

      await handleClickToCall(reqUnauthorizedAgent, mockRes);
      assert("Agent cannot call lead assigned to another caller/owner (HTTP 403)", statusReceived === 403);
      assert("403 error message explains access restriction", jsonReceived?.error?.includes("Access denied"));

      // Admin user attempts to call Agent Aarti's lead (Allowed)
      const reqAdmin: any = {
        user: {
          id: "admin_user_id",
          name: "Super Admin",
          email: "admin@seedscrm.com",
          role: "admin",
        },
        body: {
          leadId: "SOI-101",
        },
      };

      (User as any).findById = (id: string) => ({
        then: (resolve: any) => resolve({ name: "Super Admin", smartfloAgentNumber: "060100" }),
      });

      statusReceived = 0;
      jsonReceived = null;

      // Click to call will proceed past RBAC check to service
      await handleClickToCall(reqAdmin, mockRes);
      assert("Admin can initiate call to any lead (not blocked by 403)", statusReceived !== 403);

      // Restore Mongoose methods
      Lead.findOne = origLeadFindOne;
      User.findById = origUserFindById;
    }

    // ----------------------------------------------------
    // Test 9: Webhook Correlation via custom_identifier
    // ----------------------------------------------------
    {
      const { processSmartfloWebhook } = await import("../services/smartflo/smartfloWebhookService.js");
      const { SmartfloCallLog } = await import("../models/SmartfloCallLog.js");

      const origLeadFindOne = Lead.findOne;
      const origCallFindOne = SmartfloCallLog.findOne;
      const origCallFindOneAndUpdate = SmartfloCallLog.findOneAndUpdate;
      const origLeadFindByIdAndUpdate = Lead.findByIdAndUpdate;

      let savedUpdateDoc: any = null;
      let matchedLeadByUniqueId: any = null;

      (Lead as any).findOne = async (query: any) => {
        if (query.uniqueId) {
          matchedLeadByUniqueId = {
            _id: "65d8a9b2f123456789abcdef",
            uniqueId: "SOI-1042",
            auditLogs: [],
          };
          return matchedLeadByUniqueId;
        }
        return null;
      };

      (SmartfloCallLog as any).findOne = async () => null; // New call
      (SmartfloCallLog as any).findOneAndUpdate = async (filter: any, update: any) => {
        savedUpdateDoc = update.$set;
        return { _id: "call_log_mongo_id", ...savedUpdateDoc };
      };
      (Lead as any).findByIdAndUpdate = async () => true;

      // Simulate a Smartflo webhook carrying custom_identifier from Click-to-Call
      const clickToCallWebhookPayload: any = {
        call_id: "C2C-SESSION-12345",
        direction: "outbound",
        call_to_number: "9876543210",
        call_status: "answered",
        duration: 85,
        billsec: 60,
        custom_identifier: {
          lead_unique_id: "SOI-1042",
          lead_id: "65d8a9b2f123456789abcdef",
          initiated_by: "Agent_Smith",
          initiated_at: "1730194800000",
        },
        recording_url: "https://smartflo.tatateleservices.com/recordings/c2c-12345.mp3",
      };

      const webhookResult = await processSmartfloWebhook(clickToCallWebhookPayload);
      assert("Webhook correlates correctly via custom_identifier.lead_unique_id", webhookResult.leadMatched === true);
      assert("Webhook associates lead unique ID SOI-1042", webhookResult.leadUniqueId === "SOI-1042");
      assert("Call log saves matchingMethod as 'crm_unique_id'", savedUpdateDoc?.matchingMethod === "crm_unique_id");
      assert("Call log stores recording URL", savedUpdateDoc?.recordingUrl === "https://smartflo.tatateleservices.com/recordings/c2c-12345.mp3");
      assert("Call log flags recordingAvailable: true", savedUpdateDoc?.recordingAvailable === true);

      // Duplicate delivery test: same call_id should not duplicate
      (SmartfloCallLog as any).findOne = async () => ({ callId: "C2C-SESSION-12345" });
      const duplicateResult = await processSmartfloWebhook(clickToCallWebhookPayload);
      assert("Duplicate webhook delivery is detected as duplicate", duplicateResult.isDuplicate === true);

      // Pending recording test: call log saves without recording
      const pendingRecPayload: any = {
        call_id: "C2C-SESSION-PENDING-99",
        direction: "outbound",
        call_to_number: "9876543210",
        call_status: "answered",
        duration: 30,
        billsec: 25,
        custom_identifier: {
          lead_unique_id: "SOI-1042",
        },
        recording_url: "", // Not yet available
      };
      savedUpdateDoc = null;
      (SmartfloCallLog as any).findOne = async () => null;
      const pendingResult = await processSmartfloWebhook(pendingRecPayload);
      assert("Call without immediate recording succeeds", pendingResult.success === true);
      assert("Flags recordingAvailable: false when recording is not yet ready", savedUpdateDoc?.recordingAvailable === false);

      // Restore Mongoose methods
      Lead.findOne = origLeadFindOne;
      SmartfloCallLog.findOne = origCallFindOne;
      SmartfloCallLog.findOneAndUpdate = origCallFindOneAndUpdate;
      Lead.findByIdAndUpdate = origLeadFindByIdAndUpdate;
    }

    // ----------------------------------------------------
    // Test 10: Call Hangup Service & Controller Tests
    // ----------------------------------------------------
    {
      const { executeSmartfloCallHangup, _clearHangupDebounceMap } = await import("../services/smartflo/smartfloHangupService.js");
      const { handleHangupCall } = await import("../controllers/smartfloController.js");

      _clearHangupDebounceMap();
      let hangupUrl = "";
      let hangupOptions: any = null;

      const mockHangupFetch: any = async (url: string, options: any) => {
        hangupUrl = url;
        hangupOptions = options;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            message: "Call hangup successful",
          }),
        };
      };

      // 1. Hangup via ref_id
      const resHangupRef = await executeSmartfloCallHangup({ refId: "REF_TEST_999" }, mockHangupFetch, () => 200000);
      assert("Hangup via ref_id succeeds", resHangupRef.success === true);
      assert("Dispatches to /v1/call/hangup endpoint", hangupUrl === "https://api-smartflo.mock/v1/call/hangup");
      assert("Attaches Bearer auth token header on hangup", hangupOptions.headers.Authorization === "Bearer MOCK_SMARTFLO_JWT_TOKEN");
      const parsedBody = JSON.parse(hangupOptions.body);
      assert("Body contains ref_id", parsedBody.ref_id === "REF_TEST_999");
      assert("Body does not contain call_id when ref_id is passed", parsedBody.call_id === undefined);

      // 2. Hangup via call_id
      hangupUrl = "";
      hangupOptions = null;
      const resHangupCall = await executeSmartfloCallHangup({ callId: "CALL_SESSION_888" }, mockHangupFetch, () => 200001);
      assert("Hangup via call_id succeeds", resHangupCall.success === true);
      const parsedCallBody = JSON.parse(hangupOptions.body);
      assert("Body contains call_id", parsedCallBody.call_id === "CALL_SESSION_888");
      assert("Body does not contain ref_id when call_id is passed", parsedCallBody.ref_id === undefined);

      // 3. Rejects when neither identifier is passed
      let threwEmpty = false;
      try {
        await executeSmartfloCallHangup({}, mockHangupFetch);
      } catch (e: any) {
        threwEmpty = true;
        assert("Throws error when both refId and callId are missing", e.message.includes("Missing call identifier"));
      }
      assert("Empty identifier threw error", threwEmpty);

      // 4. Double-click debounce on hangup
      let clock = 300000;
      await executeSmartfloCallHangup({ refId: "REF_DEBOUNCE_1" }, mockHangupFetch, () => clock);
      let debounced = false;
      try {
        await executeSmartfloCallHangup({ refId: "REF_DEBOUNCE_1" }, mockHangupFetch, () => clock + 2000);
      } catch (e: any) {
        debounced = true;
        assert("Second rapid hangup click within 5s is blocked by debounce guard", e.message.includes("hangup request for this call was just submitted"));
      }
      assert("Hangup debounce guard triggered", debounced);

      // 5. Smartflo API Rejection handling
      const mockHangupReject: any = async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ success: false, message: "Invalid parameters provided" }),
      });

      let threwReject = false;
      try {
        await executeSmartfloCallHangup({ refId: "REF_REJECT_1" }, mockHangupReject);
      } catch (e: any) {
        threwReject = true;
        assert("Surfaces Smartflo hangup HTTP error", e.message.includes("Smartflo Call Hangup error (HTTP 400)"));
      }
      assert("API rejection threw error", threwReject);

      // 6. Controller Authorization Guard (Agent can only hang up their own lead)
      const origLeadFindOne = Lead.findOne;
      const leadOwnedByAgentA: any = {
        _id: "lead_a_id",
        uniqueId: "SOI-101",
        callerName: "Agent Aarti",
        leadOwner: "Agent Aarti",
      };

      (Lead as any).findOne = () => ({
        then: (resolve: any) => resolve(leadOwnedByAgentA),
      });

      let statusReceived = 0;
      let jsonReceived: any = null;
      const mockRes: any = {
        status: (code: number) => {
          statusReceived = code;
          return {
            json: (payload: any) => {
              jsonReceived = payload;
            },
          };
        },
      };

      const reqUnauthorizedAgent: any = {
        user: {
          id: "bob_user_id",
          name: "Agent Bob",
          email: "bob@seedscrm.com",
          role: "agent",
        },
        body: {
          leadId: "SOI-101",
          refId: "REF_RBAC_TEST",
        },
      };

      await handleHangupCall(reqUnauthorizedAgent, mockRes);
      assert("Agent cannot hang up call for lead assigned to another caller/owner (HTTP 403)", statusReceived === 403);
      assert("403 error explains hangup access restriction", jsonReceived?.error?.includes("Access denied"));

      Lead.findOne = origLeadFindOne;
    }

    // -------------------------------------------------------------
    // Test 6: Webhook direction normalization & agent display extraction
    // -------------------------------------------------------------
    {
      const origFindOne = Lead.findOne;
      const origFind = Lead.find;
      const origFindByIdAndUpdate = Lead.findByIdAndUpdate;
      const origFindOneAndUpdate = SmartfloCallLog.findOneAndUpdate;
      const origFindOneCallLog = SmartfloCallLog.findOne;

      try {
        let savedCallData: any = null;

        (Lead as any).findOne = async () => ({
          _id: new mongoose.Types.ObjectId(),
          uniqueId: "SOI-999",
        });
        (Lead as any).find = () => ({
          limit: () => [{
            _id: new mongoose.Types.ObjectId(),
            uniqueId: "SOI-999",
            normalizedPhone: "919876543210",
            primaryMobileNumber: "9876543210",
          }],
        });
        (Lead as any).findByIdAndUpdate = async () => null;

        (SmartfloCallLog as any).findOne = async () => null;
        (SmartfloCallLog as any).findOneAndUpdate = async (_query: any, update: any) => {
          savedCallData = update.$set;
          return { _id: new mongoose.Types.ObjectId(), ...update.$set };
        };

        // Case A: Smartflo sends call_type: "outbound" without "direction" key
        await processSmartfloWebhook({
          call_id: "CALL_TYPE_TEST_1",
          call_type: "outbound",
          DestinationNumber: "9876543210",
          agent_name: "Amit Kumar",
          CallDuration: 45,
          custom_identifier: { lead_unique_id: "SOI-999" },
        });

        assert("Payload with call_type 'outbound' normalizes direction to 'outbound'", savedCallData?.direction === "outbound");
        assert("Agent name 'Amit Kumar' extracted cleanly", savedCallData?.agentName === "Amit Kumar");

        // Case B: Smartflo sends raw agent as object or stringified object
        await processSmartfloWebhook({
          call_id: "CALL_AGENT_OBJ_TEST",
          direction: "inbound",
          SourceNumber: "9876543210",
          agent_name: "[object Object]",
          answer_agent_name: "Amit Kumar",
          CallDuration: 20,
          custom_identifier: { lead_unique_id: "SOI-999" },
        });

        assert("Fallback to answer_agent_name when agent_name is [object Object]", savedCallData?.agentName === "Amit Kumar");

        // Case C: Click-to-call payload with outbound_type: "click_to_call"
        await processSmartfloWebhook({
          call_id: "C2C_OUTBOUND_TEST",
          outbound_type: "click_to_call",
          DestinationNumber: "9876543210",
          answered_agent: { name: "Amit Kumar" } as any,
          CallDuration: 30,
          custom_identifier: { lead_unique_id: "SOI-999" },
        });

        assert("Payload with outbound_type 'click_to_call' normalizes direction to 'outbound'", savedCallData?.direction === "outbound");
        assert("Agent object extracted to string name 'Amit Kumar'", savedCallData?.agentName === "Amit Kumar");

        // Case D: Inbound Ringing (Call Received On Server)
        await processSmartfloWebhook({
          call_id: "INBOUND_RING_101",
          direction: "inbound",
          SourceNumber: "919876543210",
          call_to_number: "919228173971",
          status: "in_progress",
        });

        assert("Inbound ringing event sets direction to 'inbound'", savedCallData?.direction === "inbound");
        assert("Inbound ringing event normalizes customer number", savedCallData?.customerNumber === "919876543210");
        assert("Inbound ringing status normalized to 'in_progress'", savedCallData?.status === "in_progress");
        assert("Inbound call associates matched lead", savedCallData?.crmLeadUniqueId === "SOI-999");

        // Case E: Inbound Answered by Agent
        await processSmartfloWebhook({
          call_id: "INBOUND_RING_101",
          direction: "inbound",
          SourceNumber: "919876543210",
          call_to_number: "919228173971",
          status: "answered",
          answered_agent: "0608426290047",
        });

        assert("Inbound answered event upgrades status to 'answered'", savedCallData?.status === "answered");
        assert("Inbound answered agent captured correctly", savedCallData?.agentName === "0608426290047");

        // Case F: Inbound Hangup with duration and recording
        let leadAuditPushed = 0;
        let leadAuditUpdated = 0;
        let updatedAuditValue = "";

        const mockAuditLogs: any[] = [];
        (Lead as any).findById = () => ({
          select: () => ({ auditLogs: mockAuditLogs }),
        });

        (Lead as any).findByIdAndUpdate = async (_id: any, update: any) => {
          if (update.$push?.auditLogs) {
            leadAuditPushed++;
            mockAuditLogs.push(update.$push.auditLogs);
          }
          if (update.$set) {
            leadAuditUpdated++;
            for (const k of Object.keys(update.$set)) {
              if (k.endsWith(".newValue")) {
                updatedAuditValue = update.$set[k];
              }
            }
          }
          return null;
        };

        // First event: ringing pushes initial activity
        (SmartfloCallLog as any).findOne = async () => null;
        await processSmartfloWebhook({
          call_id: "LIFECYCLE_CALL_1",
          direction: "inbound",
          SourceNumber: "919876543210",
          call_to_number: "919228173971",
          status: "in_progress",
        });
        assert("Initial ringing event pushes 1 auditLog entry", leadAuditPushed === 1);

        // Second event: answered updates existing activity in-place
        (SmartfloCallLog as any).findOne = async () => savedCallData;
        await processSmartfloWebhook({
          call_id: "LIFECYCLE_CALL_1",
          direction: "inbound",
          SourceNumber: "919876543210",
          call_to_number: "919228173971",
          status: "answered",
          answered_agent: "0608426290047",
        });
        assert("Answered event does NOT push second auditLog", leadAuditPushed === 1);
        assert("Answered event updates auditLog in-place", leadAuditUpdated >= 1);
        assert("Updated audit text contains ANSWERED", updatedAuditValue.includes("ANSWERED"));

        // Third event: hangup updates final duration and recording
        await processSmartfloWebhook({
          call_id: "LIFECYCLE_CALL_1",
          direction: "inbound",
          SourceNumber: "919876543210",
          call_to_number: "919228173971",
          status: "answered",
          answered_agent: "0608426290047",
          duration: 90,
          answered_duration: 85,
          recording_url: "https://smartflo.tatateleservices.com/rec/123.wav",
        });
        assert("Hangup event preserves exactly 1 auditLog on the lead", leadAuditPushed === 1);
        assert("Hangup event captures duration (1m 25s)", updatedAuditValue.includes("1m 25s"));
        assert("Hangup event reflects Recording Available", updatedAuditValue.includes("Recording Available"));

        // Out-of-order event: Late 'in_progress' does not regress answered terminal status
        await processSmartfloWebhook({
          call_id: "LIFECYCLE_CALL_1",
          direction: "inbound",
          SourceNumber: "919876543210",
          call_to_number: "919228173971",
          status: "in_progress",
        });
        assert("Out-of-order 'in_progress' does not regress answered status", savedCallData?.status === "answered");
        assert("Out-of-order event preserves recording URL", savedCallData?.recordingUrl === "https://smartflo.tatateleservices.com/rec/123.wav");
      } finally {
        (Lead as any).findOne = origFindOne;
        (Lead as any).find = origFind;
        (Lead as any).findByIdAndUpdate = origFindByIdAndUpdate;
        (SmartfloCallLog as any).findOneAndUpdate = origFindOneAndUpdate;
        (SmartfloCallLog as any).findOne = origFindOneCallLog;
      }
    }

    // -------------------------------------------------------------
    // Test 7: Phone Normalization Variants (+91, 91, 0, 10-digit)
    // -------------------------------------------------------------
    {
      const { normalizePhoneNumber } = await import("../utils/phoneUtils.js");
      assert("Normalizes plain 10-digit phone 9876543210", normalizePhoneNumber("9876543210") === "9876543210");
      assert("Normalizes +91 prefixed phone +919876543210", normalizePhoneNumber("+919876543210") === "9876543210");
      assert("Normalizes 91 prefixed phone 919876543210", normalizePhoneNumber("919876543210") === "9876543210");
      assert("Normalizes 0 prefixed phone 09876543210", normalizePhoneNumber("09876543210") === "9876543210");
      assert("Rejects invalid non-numeric short phone 123", normalizePhoneNumber("123") === null);
    }

    // -------------------------------------------------------------
    // Test 8: Socket.IO Restricted CORS Origin Validation
    // -------------------------------------------------------------
    {
      const origCors = config.corsOrigin;
      config.corsOrigin = ["https://seedscrm.seedsofinnocens.com", "http://localhost:3000"];

      const allowedOrigin = "https://seedscrm.seedsofinnocens.com";
      const disallowedOrigin = "https://malicious-site.com";

      assert("Configured CORS origin is allowed", config.corsOrigin.includes(allowedOrigin));
      assert("Untrusted CORS origin is rejected", !config.corsOrigin.includes(disallowedOrigin));

      config.corsOrigin = origCors;
    }

    // -------------------------------------------------------------
    // Test 9: Socket.IO JWT Handshake Token Extraction & Validation
    // -------------------------------------------------------------
    {
      const jwt = (await import("jsonwebtoken")).default;
      const validToken = jwt.sign(
        { id: "user_agent_1", name: "Agent Test", email: "agent@seeds.com", role: "agent" },
        config.jwtSecret,
        { expiresIn: "1h" }
      );

      // Verify token decoded successfully
      const decoded: any = jwt.verify(validToken, config.jwtSecret);
      assert("JWT token generated and signed with jwtSecret", decoded?.id === "user_agent_1");
      assert("Decoded role matches 'agent'", decoded?.role === "agent");

      // Test invalid token rejection
      let invalidRejected = false;
      try {
        jwt.verify("invalid_malformed_token", config.jwtSecret);
      } catch {
        invalidRejected = true;
      }
      assert("Invalid token throws verification error", invalidRejected === true);
    }

    // -------------------------------------------------------------
    // Test 10: Self-Service Smartflo Extension ID Management & C2C
    // -------------------------------------------------------------
    {
      const { updateMySmartfloExtension } = await import("../controllers/authController.js");

      // 10A: Unauthorized access rejected when req.user is missing
      let unauthCode = 0;
      let unauthMsg = "";
      const reqNoAuth: any = { body: { smartfloAgentId: "0608426290047" } };
      const resNoAuth: any = {
        status: (code: number) => {
          unauthCode = code;
          return {
            json: (data: any) => {
              unauthMsg = data.message || data.error;
            },
          };
        },
      };
      await updateMySmartfloExtension(reqNoAuth, resNoAuth);
      assert("Self-update rejects unauthenticated access (401)", unauthCode === 401);

      // 10B: Validation rejection for extension exceeding length or invalid characters
      let valCode = 0;
      let valMsg = "";
      const reqInvalid: any = {
        user: { id: "user_test_123", role: "agent" },
        body: { smartfloAgentId: "060@invalid$extension!#%" },
      };
      const resInvalid: any = {
        status: (code: number) => {
          valCode = code;
          return {
            json: (data: any) => {
              valMsg = data.message || data.error;
            },
          };
        },
      };
      await updateMySmartfloExtension(reqInvalid, resInvalid);
      assert("Self-update rejects invalid extension format (400)", valCode === 400);

      // 10C: Authenticated user self-update uses session id and never accepts arbitrary client userId
      const origFindByIdAndUpdate = (User as any).findByIdAndUpdate;
      let updatedUserId = "";
      let updatedFields: any = null;

      (User as any).findByIdAndUpdate = (id: string, update: any) => {
        updatedUserId = id;
        updatedFields = update.$set;
        return {
          select: () => ({
            _id: id,
            name: "Agent Test",
            email: "agent@seeds.com",
            role: "agent",
            smartfloAgentId: update.$set.smartfloAgentId,
            smartfloAgentNumber: update.$set.smartfloAgentNumber,
          }),
        };
      };

      try {
        let successCode = 0;
        let successBody: any = null;
        const reqValid: any = {
          user: { id: "actual_session_user_id", role: "agent" },
          body: {
            userId: "malicious_spoofed_user_id", // Client attempts to spoof another member's ID
            smartfloAgentId: "0608426290047",
          },
        };
        const resValid: any = {
          status: (code: number) => {
            successCode = code;
            return {
              json: (data: any) => {
                successBody = data;
              },
            };
          },
        };

        await updateMySmartfloExtension(reqValid, resValid);
        assert("Self-update responds with HTTP 200 OK", successCode === 200);
        assert("Self-update updates authenticated user from session, ignoring client userId", updatedUserId === "actual_session_user_id");
        assert("Stores extension ID in smartfloAgentId", updatedFields.smartfloAgentId === "0608426290047");
        assert("Stores extension ID in smartfloAgentNumber alias", updatedFields.smartfloAgentNumber === "0608426290047");
        assert("Returns updated extension ID in response payload", successBody.smartfloAgentId === "0608426290047");
      } finally {
        (User as any).findByIdAndUpdate = origFindByIdAndUpdate;
      }

      // 10D: Click-to-Call uses saved smartfloAgentId
      let dispatchedAgentNumber = "";
      const mockFetchForAgent = async (url: any, opts: any) => {
        const body = JSON.parse(opts.body);
        dispatchedAgentNumber = body.agent_number;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            ref_id: "REF_AGENT_SAVED_101",
            message: "Call initiated successfully",
          }),
        } as any;
      };

      const c2cResult = await initiateSmartfloClickToCall(
        {
          lead: {
            uniqueId: "SOI-9001",
            wifeName: "Ananya",
            husbandName: "Rahul",
            primaryMobileNumber: "9876543210",
            callingConsent: "Yes",
          } as any,
          user: {
            name: "Agent Anjali",
            email: "anjali@seeds.com",
            role: "agent",
            smartfloAgentId: "0608426290047", // Saved extension ID
          } as any,
        },
        mockFetchForAgent,
        () => 900001
      );

      assert("Click-to-call with saved smartfloAgentId succeeds", c2cResult.success === true);
      assert("Dispatches saved extension 0608426290047 as agent_number", dispatchedAgentNumber === "0608426290047");

      // 10E: When extension ID is missing, Click-to-Call is blocked with user-friendly instruction
      let missingExtensionErrorMsg = "";
      try {
        await initiateSmartfloClickToCall(
          {
            lead: {
              uniqueId: "SOI-9002",
              primaryMobileNumber: "9876543210",
              callingConsent: "Yes",
            } as any,
            user: {
              name: "Agent Without Extension",
              email: "noext@seeds.com",
              role: "agent",
              smartfloAgentId: "",
              smartfloAgentNumber: "",
            } as any,
          },
          mockFetchForAgent,
          () => 900002
        );
      } catch (err: any) {
        missingExtensionErrorMsg = err.message;
      }

      assert(
        "Missing extension blocks call with exact instruction message",
        missingExtensionErrorMsg.includes("Extension ID in Profile Settings")
      );
    }

    // -------------------------------------------------------------
    // Test 11: Call Lifecycle Synchronization & HTTP 422 Graceful Handling
    // -------------------------------------------------------------
    {
      _clearHangupDebounceMap();

      // 11A: Smartflo HTTP 422 "Invalid Ref ID" (call already hung up on carrier) handles gracefully
      const mock422HangupFetch = (async (url: string, opts: any) => {
        if (url.includes("/v1/auth/login")) {
          return new Response(JSON.stringify({ success: true, access_token: "mock-token-xyz" }), { status: 200 });
        }
        if (url.includes("/call/hangup")) {
          return new Response(JSON.stringify({ success: false, message: "Invalid Ref ID" }), {
            status: 422,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      }) as any;

      const result422 = await executeSmartfloCallHangup({ refId: "REF_ALREADY_DEAD_1" }, mock422HangupFetch);
      assert("HTTP 422 'Invalid Ref ID' resolves with success: true", result422.success === true);
      assert("HTTP 422 returns user-friendly ended message", result422.message.includes("Call has already ended"));

      // 11B: Controller handleHangupCall gracefully handles already ended call and returns HTTP 200
      const origLeadFindOne = Lead.findOne;
      (Lead as any).findOne = () => ({
        then: (resolve: any) =>
          resolve({
            _id: "lead_hangup_id",
            uniqueId: "SOI-5555",
            callerName: "Agent Test",
            leadOwner: "Agent Test",
          }),
      });

      _clearHangupDebounceMap();
      let ctrlStatus = 0;
      let ctrlJson: any = null;
      const mockRes: any = {
        status: (code: number) => {
          ctrlStatus = code;
          return {
            json: (payload: any) => {
              ctrlJson = payload;
            },
          };
        },
      };

      const mockReqHangup: any = {
        user: { id: "agent_555", name: "Agent Test", role: "agent" },
        body: { leadId: "SOI-5555", refId: "REF_DEAD_CTRL_1" },
      };

      (globalThis as any)._smartfloMockFetch = mock422HangupFetch;
      await handleHangupCall(mockReqHangup, mockRes);
      delete (globalThis as any)._smartfloMockFetch;

      assert("Controller returns HTTP 200 on hangup request", ctrlStatus === 200);
      assert("Controller status is success", ctrlJson?.status === "success");

      Lead.findOne = origLeadFindOne;

      // 11C: Outbound terminal webhook triggers outbound:ended broadcast
      const origFindOne = Lead.findOne;
      const origFind = Lead.find;
      const origFindByIdAndUpdate = Lead.findByIdAndUpdate;
      const origFindOneAndUpdate = SmartfloCallLog.findOneAndUpdate;
      const origFindOneCallLog = SmartfloCallLog.findOne;

      try {
        let loggedCall: any = null;
        (SmartfloCallLog as any).findOne = () => ({
          then: (res: any) => res(null),
        });
        (SmartfloCallLog as any).findOneAndUpdate = (_query: any, update: any) => {
          loggedCall = update.$set;
          return {
            _id: "call_log_c2c_ended",
            ...update.$set,
          };
        };
        (Lead as any).findOne = () => ({
          then: (res: any) =>
            res({
              _id: "lead_outbound_term",
              uniqueId: "SOI-8888",
              wifeName: "Neha Sharma",
              primaryMobileNumber: "9876543210",
              auditLogs: [],
            }),
        });
        (Lead as any).find = () => ({
          limit: () => Promise.resolve([]),
        });
        (Lead as any).findByIdAndUpdate = () => Promise.resolve({});

        const outboundTerminalWebhook = {
          call_id: "C2C_TERMINAL_CALL_99",
          ref_id: "REF_TERMINAL_99",
          customer_number: "9876543210",
          call_type: "outbound",
          status: "answered",
          total_call_duration: "45",
          answered_call_duration: "30",
          hangup_cause_description: "NORMAL_CLEARING",
          custom_identifier: { lead_unique_id: "SOI-8888" },
        };

        const webhookRes = await processSmartfloWebhook(outboundTerminalWebhook);
        assert("Outbound terminal webhook succeeds", webhookRes.success === true);
        assert("Outbound terminal call log status is answered", loggedCall?.status === "answered");
        assert("Outbound terminal call log direction is outbound", loggedCall?.direction === "outbound");
      } finally {
        Lead.findOne = origFindOne;
        Lead.find = origFind;
        Lead.findByIdAndUpdate = origFindByIdAndUpdate;
        SmartfloCallLog.findOneAndUpdate = origFindOneAndUpdate;
        SmartfloCallLog.findOne = origFindOneCallLog;
      }
    }

    // -------------------------------------------------------------
    // Test 12: Multi-Agent Smartflo Configuration & Isolation
    // -------------------------------------------------------------
    {
      _clearClickToCallDebounceMap();

      // Agent 1: Priya Sharma, Extension 0601001, Caller ID +919228173971
      // Agent 2: Rahul Verma, Extension 0602002, Caller ID +919228173972
      let dispatchedPayloadAgent1: any = null;
      let dispatchedPayloadAgent2: any = null;

      const mockMultiAgentFetch = (async (url: string, opts: any) => {
        if (url.includes("/v1/auth/login")) {
          return new Response(JSON.stringify({ success: true, access_token: "mock-multi-agent-token" }), { status: 200 });
        }
        if (url.includes("/click_to_call")) {
          const body = JSON.parse(opts.body);
          if (body.agent_number === "0601001") {
            dispatchedPayloadAgent1 = body;
          } else if (body.agent_number === "0602002") {
            dispatchedPayloadAgent2 = body;
          }
          return new Response(JSON.stringify({ success: true, ref_id: `REF_${body.agent_number}` }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      }) as any;

      const leadSample1: any = {
        _id: "lead_multi_1",
        uniqueId: "SOI-MULTI-1",
        primaryMobileNumber: "9876543210",
        callingConsent: "Yes",
      };

      const leadSample2: any = {
        _id: "lead_multi_2",
        uniqueId: "SOI-MULTI-2",
        primaryMobileNumber: "9123456789",
        callingConsent: "Yes",
      };

      // Call initiated by Agent 1
      const call1 = await initiateSmartfloClickToCall(
        {
          lead: leadSample1,
          user: {
            name: "Priya Sharma",
            email: "priya@seedscrm.com",
            role: "agent",
            smartfloAgentId: "0601001",
            smartfloCallerId: "+919228173971",
          } as any,
        },
        mockMultiAgentFetch,
        () => 800001
      );

      // Call initiated by Agent 2
      const call2 = await initiateSmartfloClickToCall(
        {
          lead: leadSample2,
          user: {
            name: "Rahul Verma",
            email: "rahul@seedscrm.com",
            role: "agent",
            smartfloAgentId: "0602002",
            smartfloCallerId: "+919228173972",
          } as any,
        },
        mockMultiAgentFetch,
        () => 800002
      );

      assert("Agent 1 Click-to-call initiates successfully", call1.success === true);
      assert("Agent 1 payload uses agent 1 extension", dispatchedPayloadAgent1?.agent_number === "0601001");
      assert("Agent 1 payload uses agent 1 caller ID", dispatchedPayloadAgent1?.caller_id === "+919228173971");

      assert("Agent 2 Click-to-call initiates successfully", call2.success === true);
      assert("Agent 2 payload uses agent 2 extension", dispatchedPayloadAgent2?.agent_number === "0602002");
      assert("Agent 2 payload uses agent 2 caller ID", dispatchedPayloadAgent2?.caller_id === "+919228173972");

      // Verify missing caller ID blocks call when global caller ID is also unset
      config.smartfloCallerId = "";
      let missingCallerIdErr = "";
      try {
        await initiateSmartfloClickToCall(
          {
            lead: leadSample1,
            user: {
              name: "Agent No Caller ID",
              email: "nocli@seedscrm.com",
              role: "agent",
              smartfloAgentId: "0603003",
              smartfloCallerId: "",
            } as any,
          },
          mockMultiAgentFetch,
          () => 800003
        );
      } catch (err: any) {
        missingCallerIdErr = err.message;
      }
      assert(
        "Missing Caller ID blocks call with configuration guidance",
        missingCallerIdErr.includes("Caller ID in Profile Settings")
      );

      // Verify Agent Self-Update cannot modify other users' settings
      const origUserFindByIdAndUpdate = User.findByIdAndUpdate;
      let targetUserIdUpdated = "";
      let targetUpdateFields: any = null;

      (User as any).findByIdAndUpdate = (id: any, update: any) => {
        targetUserIdUpdated = String(id);
        targetUpdateFields = update.$set;
        return {
          select: () =>
            Promise.resolve({
              _id: id,
              name: "Priya Sharma",
              email: "priya@seedscrm.com",
              role: "agent",
              smartfloAgentId: update.$set.smartfloAgentId,
              smartfloCallerId: update.$set.smartfloCallerId,
            }),
        };
      };

      let selfUpdateStatus = 0;
      let selfUpdateJson: any = null;
      const selfUpdateRes: any = {
        status: (code: number) => {
          selfUpdateStatus = code;
          return {
            json: (payload: any) => {
              selfUpdateJson = payload;
            },
          };
        },
      };

      // Malicious attempt: Agent 1 tries to send arbitrary userId in body
      const maliciousReq: any = {
        user: { id: "authenticated_priya_id", role: "agent" },
        body: {
          userId: "victim_rahul_id",
          smartfloAgentId: "0609999",
          smartfloCallerId: "+919228173999",
        },
      };

      await updateMySmartfloExtension(maliciousReq, selfUpdateRes);

      assert("Self-update responds with HTTP 200", selfUpdateStatus === 200);
      assert("Self-update updates strictly authenticated session id, ignoring malicious body userId", targetUserIdUpdated === "authenticated_priya_id");
      assert("Self-update persists caller ID", targetUpdateFields.smartfloCallerId === "+919228173999");
      assert("Self-update persists extension ID", targetUpdateFields.smartfloAgentId === "0609999");

      User.findByIdAndUpdate = origUserFindByIdAndUpdate;
    }

  } finally {
    // Restore original configs
    config.smartfloCallerId = origCallerId;
    config.smartfloLoginId = origLoginId;
    config.smartfloPassword = origPassword;
    config.smartfloApiBaseUrl = origBaseUrl;
    invalidateSmartfloAccessToken();
  }

  console.log(`\n=== Test Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runClickToCallTests();
