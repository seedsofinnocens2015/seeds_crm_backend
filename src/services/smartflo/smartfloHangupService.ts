import { config } from "../../config/env.js";
import { getSmartfloAccessToken } from "./smartfloAuthService.js";

export interface HangupCallParams {
  refId?: string;
  callId?: string;
}

export interface HangupCallResult {
  success: boolean;
  message: string;
  identifierType: "ref_id" | "call_id";
  identifierValue: string;
}

// In-memory rate limiting map for double-hangup click debounce: key -> timestamp ms
const recentHangupsMap = new Map<string, number>();
const HANGUP_DEBOUNCE_WINDOW_MS = 5000; // 5 seconds debounce per call identifier

/**
 * Executes a call hangup request against Tata Smartflo API:
 * POST https://api-smartflo.tatateleservices.com/v1/call/hangup
 * 
 * Strict requirement:
 * The payload must contain EITHER "ref_id" OR "call_id". Passing both or neither is invalid.
 */
export async function executeSmartfloCallHangup(
  params: HangupCallParams,
  fetchFn: typeof fetch = fetch,
  currentTimeProvider: () => number = () => Date.now()
): Promise<HangupCallResult> {
  const cleanRefId = (params.refId || "").trim();
  const cleanCallId = (params.callId || "").trim();

  if (!cleanRefId && !cleanCallId) {
    throw new Error("Missing call identifier: either 'refId' or 'callId' must be provided.");
  }

  // Mutually exclusive: strictly pick ref_id or call_id
  let identifierType: "ref_id" | "call_id";
  let identifierValue: string;
  let requestBody: { ref_id?: string; call_id?: string };

  if (cleanCallId) {
    identifierType = "call_id";
    identifierValue = cleanCallId;
    requestBody = { call_id: cleanCallId };
  } else {
    identifierType = "ref_id";
    identifierValue = cleanRefId;
    requestBody = { ref_id: cleanRefId };
  }

  // Anti-Spam / Double-Click Debounce
  const now = currentTimeProvider();
  const lastHangupTime = recentHangupsMap.get(identifierValue) || 0;
  if (now - lastHangupTime < HANGUP_DEBOUNCE_WINDOW_MS) {
    const remainingSec = Math.ceil((HANGUP_DEBOUNCE_WINDOW_MS - (now - lastHangupTime)) / 1000);
    throw new Error(`A hangup request for this call was just submitted. Please wait ${remainingSec}s before retrying.`);
  }

  // Obtain Smartflo Bearer Access Token
  let accessToken: string;
  try {
    accessToken = await getSmartfloAccessToken(fetchFn);
  } catch (err: any) {
    throw new Error(`Smartflo authentication failed: ${err.message}`);
  }

  const requestUrl = `${config.smartfloApiBaseUrl.replace(/\/+$/, "")}/call/hangup`;

  let response: Response;
  try {
    response = await fetchFn(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (netErr: any) {
    throw new Error(`Smartflo Call Hangup API connection error: ${netErr.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Smartflo Call Hangup error (HTTP ${response.status}): ${errorText.slice(0, 200)}`);
  }

  const resJson = (await response.json()) as {
    success?: boolean;
    message?: string;
    [key: string]: any;
  };

  if (resJson.success === false) {
    throw new Error(resJson.message || "Smartflo rejected call hangup request.");
  }

  // Register in debounce cache upon successful acceptance
  recentHangupsMap.set(identifierValue, now);

  return {
    success: true,
    message: resJson.message || "Call hangup request accepted.",
    identifierType,
    identifierValue,
  };
}

/**
 * Testing helper to clear the in-memory debounce map.
 */
export function _clearHangupDebounceMap(): void {
  recentHangupsMap.clear();
}
