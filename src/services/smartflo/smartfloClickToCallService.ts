import { config } from "../../config/env.js";
import { getSmartfloAccessToken } from "./smartfloAuthService.js";
import { normalizePhoneNumber } from "../../utils/phoneUtils.js";
import { IUser } from "../../models/User.js";
import { ILead } from "../../models/Lead.js";

export interface ClickToCallParams {
  lead: ILead;
  user: IUser | { id?: string; name: string; email: string; role: string; mobile?: string; smartfloAgentNumber?: string; smartfloAgentId?: string; smartfloCallerId?: string };
  targetPhoneOverride?: string;
  callTimeoutSeconds?: number;
}

export interface SmartfloClickToCallRequestBody {
  agent_number: string;
  destination_number: string;
  caller_id?: string;
  async: 1;
  call_timeout?: number;
  custom_identifier?: {
    lead_unique_id: string;
    lead_id: string;
    initiated_by: string;
    initiated_at: string;
    [key: string]: string;
  };
}

export interface ClickToCallResult {
  success: boolean;
  refId?: string;
  message: string;
  leadUniqueId: string;
  customerNumber: string;
  agentNumber: string;
}

// In-memory rate limiting map for double-click debounce protection: key -> timestamp ms
const recentCallsMap = new Map<string, number>();
const CLICK_DEBOUNCE_WINDOW_MS = 10000; // 10 seconds debounce per lead+agent

/**
 * Validates and initiates a Click-to-Call request via Tata Smartflo standard API.
 * Uses dependency injection for fetchFn and currentTimeProvider to enable isolated unit testing.
 */
export async function initiateSmartfloClickToCall(
  params: ClickToCallParams,
  fetchFn: typeof fetch = fetch,
  currentTimeProvider: () => number = () => Date.now()
): Promise<ClickToCallResult> {
  const { lead, user, targetPhoneOverride, callTimeoutSeconds } = params;

  if (!lead) {
    throw new Error("Missing required lead record.");
  }
  if (!user) {
    throw new Error("Missing authenticated user details.");
  }

  // 1. Consent Validation
  // Check if lead specifically opted out of calls
  const consent = (lead.callingConsent || "").trim().toLowerCase();
  if (consent === "no") {
    throw new Error("Lead has recorded 'No' for calling consent. Calling blocked.");
  }

  // 2. Resolve & Validate Agent Extension / Number
  // Priority: user.smartfloAgentId -> user.smartfloAgentNumber
  const resolvedAgent = (user.smartfloAgentId || user.smartfloAgentNumber || "").trim();
  if (!resolvedAgent) {
    throw new Error(
      "Please configure your Smartflo Extension ID in Profile Settings before initiating calls."
    );
  }

  // 3. Resolve & Normalize Customer Destination Number
  const rawTargetNumber = (targetPhoneOverride || lead.primaryMobileNumber || lead.mobileNumber || "").trim();
  if (!rawTargetNumber) {
    throw new Error("Lead has no primary mobile number.");
  }

  const normalizedDigits = normalizePhoneNumber(rawTargetNumber);
  if (!normalizedDigits || normalizedDigits.length < 10) {
    throw new Error(`Invalid destination phone number format: '${rawTargetNumber}'.`);
  }

  // Smartflo standard destination format: 10-digit or 91XXXXXXXXXX
  // normalizePhoneNumber returns 10 digits for Indian mobiles. Prepend 91 if required or pass normalized 10 digits.
  const destinationNumber = normalizedDigits.length === 10 ? `91${normalizedDigits}` : normalizedDigits;

  // 4. Resolve Outbound Caller ID / Pilot DID
  // Multi-agent Requirement: Must use the authenticated agent's assigned smartfloCallerId.
  // config.smartfloCallerId is ONLY a fallback during migration.
  const callerId = (user.smartfloCallerId || config.smartfloCallerId || "").trim();
  if (!callerId) {
    throw new Error(
      "Please configure your Smartflo Caller ID in Profile Settings before initiating calls."
    );
  }

  // 5. Anti-Spam / Double-Click Debounce
  const debounceKey = `${user.email || user.name}_${lead._id || lead.uniqueId}`;
  const now = currentTimeProvider();
  const lastCallTime = recentCallsMap.get(debounceKey) || 0;
  if (now - lastCallTime < CLICK_DEBOUNCE_WINDOW_MS) {
    const remainingSec = Math.ceil((CLICK_DEBOUNCE_WINDOW_MS - (now - lastCallTime)) / 1000);
    throw new Error(`A call request to this lead was just initiated. Please wait ${remainingSec}s before retrying.`);
  }

  // 6. Obtain Smartflo Bearer Access Token
  let accessToken: string;
  try {
    accessToken = await getSmartfloAccessToken(fetchFn);
  } catch (err: any) {
    throw new Error(`Smartflo authentication failed: ${err.message}`);
  }

  // 7. Construct Request Payload matching verified Smartflo Click-to-Call API
  // Rules:
  // - agent_number: string (required)
  // - destination_number: string (required)
  // - caller_id: string (optional/approved DID)
  // - async: 1 (required, only 1 supported)
  // - custom_identifier: up to 10 alphanumeric key-values, total size <= 512 chars, NO '$' characters
  const customIdentifier = {
    lead_unique_id: String(lead.uniqueId || "").replace(/[^a-zA-Z0-9_-]/g, ""),
    lead_id: String(lead._id || "").replace(/[^a-zA-Z0-9_-]/g, ""),
    initiated_by: String(user.name || "Agent").replace(/[^a-zA-Z0-9_]/g, "_"),
    initiated_at: String(now),
  };

  const payload: SmartfloClickToCallRequestBody = {
    agent_number: resolvedAgent,
    destination_number: destinationNumber,
    caller_id: callerId,
    async: 1,
    custom_identifier: customIdentifier,
  };

  if (callTimeoutSeconds && callTimeoutSeconds > 0) {
    payload.call_timeout = callTimeoutSeconds;
  }

  // 8. Execute Request
  const requestUrl = `${config.smartfloApiBaseUrl.replace(/\/+$/, "")}/click_to_call`;

  let response: Response;
  try {
    response = await fetchFn(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (netErr: any) {
    throw new Error(`Smartflo API connection error: ${netErr.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Smartflo Click-to-Call error (HTTP ${response.status}): ${errorText.slice(0, 200)}`);
  }

  const resJson = (await response.json()) as {
    success?: boolean;
    message?: string;
    ref_id?: string;
    [key: string]: any;
  };

  if (resJson.success === false) {
    throw new Error(resJson.message || "Smartflo rejected Click-to-Call request.");
  }

  // Register in debounce cache upon successful acceptance
  recentCallsMap.set(debounceKey, now);

  // Persist pending Click-to-Call log in SmartfloCallLog with ref_id if available
  const returnedRefId = resJson.ref_id ? String(resJson.ref_id).trim() : "";
  if (returnedRefId) {
    try {
      const { SmartfloCallLog } = await import("../../models/SmartfloCallLog.js");
      await SmartfloCallLog.findOneAndUpdate(
        { refId: returnedRefId },
        {
          $setOnInsert: {
            callId: `C2C_PENDING_${returnedRefId}`,
            refId: returnedRefId,
            customerNumber: destinationNumber,
            normalizedCustomerPhone: normalizedDigits,
            agentName: user.name || "Agent",
            agentNumber: resolvedAgent,
            direction: "outbound",
            status: "in_progress",
            crmLeadId: lead._id,
            crmLeadUniqueId: lead.uniqueId,
            matchingMethod: "crm_unique_id",
            recordingAvailable: false,
            receivedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );
    } catch (saveErr: any) {
      console.warn("[Smartflo ClickToCall] Notice: could not pre-create pending call log:", saveErr.message);
    }
  }

  return {
    success: true,
    refId: resJson.ref_id,
    message: resJson.message || "Call initiated successfully.",
    leadUniqueId: lead.uniqueId || "",
    customerNumber: destinationNumber,
    agentNumber: resolvedAgent,
  };
}

/**
 * Testing helper to clear the in-memory debounce map.
 */
export function _clearClickToCallDebounceMap(): void {
  recentCallsMap.clear();
}
