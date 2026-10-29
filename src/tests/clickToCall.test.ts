import { initiateSmartfloClickToCall, _clearClickToCallDebounceMap } from "../services/smartflo/smartfloClickToCallService.js";
import { handleClickToCall } from "../controllers/smartfloController.js";
import { config } from "../config/env.js";
import { _setMockTokenCache, invalidateSmartfloAccessToken } from "../services/smartflo/smartfloAuthService.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";

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
        assert("Rejects when agent telephony identifier is missing", e.message.includes("Agent telephony identifier not configured"));
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
        assert("Rejects when SMARTFLO_CALLER_ID is not configured", e.message.includes("Outbound Caller ID (SMARTFLO_CALLER_ID) is not configured"));
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
