import mongoose from "mongoose";
import { Lead, ILead } from "../../models/Lead.js";
import { User } from "../../models/User.js";
import { SmartfloCallLog, ISmartfloCallLog } from "../../models/SmartfloCallLog.js";
import { LeadCreationLock } from "../../models/LeadCreationLock.js";
import { normalizePhoneNumber } from "../../utils/phoneUtils.js";
import {
  broadcastInboundCallEvent,
  broadcastCallEndedEvent,
  broadcastOutboundCallEvent,
  InboundCallNotification,
  CallEndedNotification,
  OutboundCallNotification,
} from "../../socket.js";
import { config } from "../../config/env.js";
import { SOURCE_NAME_TO_INFO, getFormattedTimestamp, getTodayDDMMMYY, getCurrentMonthMMMYY } from "../../utils/dateUtils.js";
import { getNextUniqueId } from "../../utils/idGenerator.js";

export interface SmartfloWebhookPayload {
  // Call ID aliases
  CallSessionId?: string | number;
  call_id?: string | number;
  callId?: string | number;

  // Phone number aliases
  SourceNumber?: string | number;
  caller_id_number?: string | number;
  caller_id?: string | number;
  DestinationNumber?: string | number;
  call_to_number?: string | number;
  called_number?: string | number;
  DisplayNumber?: string | number;
  customer_number?: string | number;

  // UUID & Reference ID
  uuid?: string;
  ref_id?: string;
  refId?: string;

  // Status & Direction
  Status?: string;
  call_status?: string;
  status?: string;
  Direction?: string;
  direction?: string;

  // Durations
  CallDuration?: number | string;
  duration?: number | string;
  billsec?: number | string;
  answered_duration?: number | string;

  // Timestamps
  StartTime?: string;
  start_stamp?: string;
  calldate?: string;
  EndTime?: string;
  end_stamp?: string;

  // Agent aliases
  answered_agent?: string;
  agent_name?: string;
  agent_id?: string;
  answered_agent_number?: string;
  agent_extension?: string;
  agent_number?: string;
  extension?: string;
  agents_answered_details?: Array<Record<string, any>>;

  // Recording URL aliases
  RecordingUrl?: string;
  RecordingURL?: string;
  recording_url?: string;
  recordingUrl?: string;

  // Custom Lead Tracking parameters
  custom_identifier?: Record<string, any>;
  custom_parameter_1?: string; // May carry CRM Unique ID e.g. "SOI-101"
  custom_parameter_2?: string;
  custom_parameter_3?: string;
  crm_lead_id?: string;
  crm_unique_id?: string;
  hangup_cause_description?: string;
  disposition?: string;
  [key: string]: any;
}

export interface WebhookProcessingResult {
  success: boolean;
  isDuplicate: boolean;
  callLogId?: string;
  callId: string;
  leadMatched: boolean;
  leadUniqueId?: string;
  message: string;
}

/**
 * Checks whether a given phone number/string matches our company's business virtual numbers (DIDs).
 * Checks config.smartfloCallerId, dateUtils SOURCE_NAME_TO_INFO DID numbers, and common Seeds CRM DIDs.
 */
export function isKnownBusinessDid(phoneCandidate: string | number | undefined | null): boolean {
  if (!phoneCandidate && phoneCandidate !== 0) return false;
  const str = String(phoneCandidate).trim();
  if (!str) return false;

  const rawClean = str.replace(/\D/g, "");
  if (rawClean.length < 8) return false;

  const tenDigit = rawClean.slice(-10);

  // 1. Configured account Pilot DID / Caller ID (e.g. +919228173971)
  if (config.smartfloCallerId) {
    const configClean = config.smartfloCallerId.replace(/\D/g, "");
    if (configClean && (configClean.includes(tenDigit) || tenDigit.includes(configClean.slice(-10)))) {
      return true;
    }
  }

  // 2. Verified DIDs from SOURCE_NAME_TO_INFO (115+ Seeds IVF campaign numbers)
  if (SOURCE_NAME_TO_INFO[tenDigit] || SOURCE_NAME_TO_INFO[rawClean] || SOURCE_NAME_TO_INFO[`91${tenDigit}`]) {
    return true;
  }

  // 3. Known Seeds of Innocens Pilot Landline / Virtual DIDs (011-4084xxxx, 011-411xxxxx)
  if (rawClean.startsWith("11408") || rawClean.startsWith("011408") || rawClean.startsWith("11411") || rawClean.startsWith("011411")) {
    return true;
  }

  // 4. Check if number exists in User table as smartfloCallerId
  // (handled separately if needed, but primary DID list above covers all active trunks)
  return false;
}

/**
 * Detects whether the payload represents Smartflo's characteristic in-flight "Call received on Server"
 * initial webhook, which omits event, direction, and status, but contains call_id, caller/called numbers,
 * start_stamp and/or call_flow.
 */
export function isInitialInboundProgressPayload(payload: SmartfloWebhookPayload): boolean {
  const rawCallId = payload.CallSessionId ?? payload.call_id ?? payload.callId;
  if (!rawCallId) return false;

  // If payload already has explicit terminal statuses (answered, missed, ended, failed), it's not the initial event
  const rawStatus = String(payload.Status ?? payload.call_status ?? payload.status ?? "").toLowerCase().trim();
  if (rawStatus.includes("answer") || rawStatus.includes("miss") || rawStatus.includes("fail") || rawStatus.includes("end") || rawStatus.includes("busy")) {
    return false;
  }

  // Check caller and called numbers
  const caller = String(payload.caller_id_number ?? payload.caller_id ?? payload.SourceNumber ?? "").trim();
  const called = String(payload.called_number ?? payload.call_to_number ?? payload.DestinationNumber ?? "").trim();

  if (!caller && !called) return false;

  // Called number must be our known company business DID
  const calledIsDid = isKnownBusinessDid(called);
  if (!calledIsDid) return false;

  // Has start_stamp or call_flow or absence of duration
  const hasStartStamp = !!(payload.start_stamp ?? payload.StartTime ?? payload.calldate);
  const hasCallFlow = !!(payload.call_flow);
  const hasNoDuration = !payload.duration && !payload.CallDuration && !payload.billsec;

  return (hasStartStamp || hasCallFlow || hasNoDuration);
}

/**
 * Normalizes call status string into standard CRM enum.
 */
function normalizeCallStatus(raw: string, payload?: SmartfloWebhookPayload): "answered" | "missed" | "busy" | "failed" | "no_answer" | "in_progress" | "unknown" {
  const s = (raw || "").toLowerCase().trim();
  
  // Also check Smartflo event/trigger indicators if status is empty or generic
  const eventIndicator = String(
    payload?.event ??
    payload?.event_type ??
    payload?.trigger ??
    payload?.webhook_event ??
    payload?.notification_type ??
    ""
  ).toLowerCase().trim();

  // If payload contains explicit event trigger names from Smartflo:
  // "Dialed on Agent", "Call received on Server" or "ringing" -> in_progress
  if (
    eventIndicator.includes("dialed") ||
    eventIndicator.includes("received") ||
    eventIndicator.includes("server") ||
    eventIndicator.includes("ring") ||
    eventIndicator.includes("initiate") ||
    eventIndicator.includes("start")
  ) {
    if (!s.includes("answer") && !s.includes("miss") && !s.includes("hangup")) {
      return "in_progress";
    }
  }

  // "Call answered by Agent" -> answered
  if (eventIndicator.includes("answered") || eventIndicator.includes("picked")) {
    if (!s.includes("miss") && !s.includes("hangup") && !s.includes("end")) {
      return "answered";
    }
  }

  if (s.includes("answer") || s === "connected" || s === "success") return "answered";
  if (s.includes("miss")) return "missed";
  if (s.includes("busy")) return "busy";
  if (s.includes("no") && s.includes("answer")) return "no_answer";
  if (s.includes("fail") || s.includes("cancel")) return "failed";
  if (s.includes("progress") || s.includes("ring") || s.includes("received") || s.includes("initiat")) return "in_progress";

  // Characteristic initial in-flight Smartflo webhook detection
  if (payload && isInitialInboundProgressPayload(payload)) {
    return "in_progress";
  }

  return "unknown";
}

/**
 * Normalizes call direction.
 * Accurately parses standard direction keys, Smartflo-specific fields, call types, and numeric codes.
 * Returns "unknown" only if direction cannot be determined.
 */
function normalizeCallDirection(
  rawDirection: any,
  payload?: SmartfloWebhookPayload
): "inbound" | "outbound" | "broadcast" | "unknown" {
  // 1. Direct raw string/number check
  if (rawDirection !== undefined && rawDirection !== null) {
    const d = String(rawDirection).toLowerCase().trim();
    if (d === "1" || d === "in" || d.includes("inbound")) return "inbound";
    if (d === "2" || d === "out" || d.includes("outbound") || d === "click_to_call") return "outbound";
    if (d.includes("broad")) return "broadcast";
  }

  // 2. Payload context inspection if direct direction is missing or ambiguous
  if (payload) {
    // Check call_type or callType
    const callType = String(payload.call_type ?? payload.callType ?? payload.type ?? "").toLowerCase().trim();
    if (callType === "1" || callType.includes("inbound")) return "inbound";
    if (callType === "2" || callType.includes("outbound") || callType === "click_to_call") return "outbound";
    if (callType.includes("broad")) return "broadcast";

    // Check outbound_type (Smartflo Click-to-Call sends outbound_type: "click_to_call" or similar)
    const outboundType = String(payload.outbound_type ?? payload.outboundType ?? "").toLowerCase().trim();
    if (outboundType.includes("click") || outboundType.includes("outbound")) return "outbound";

    // Check if initiated via custom_identifier or ref_id from Click-to-Call
    if (payload.ref_id || payload.refId) return "outbound";
    if (payload.custom_identifier && typeof payload.custom_identifier === "object") {
      if (Object.keys(payload.custom_identifier).length > 0) return "outbound";
    }

    // Check call_flow: if first node is an Agent or contains Click to Call, it's outbound
    if (Array.isArray(payload.call_flow) && payload.call_flow.length > 0) {
      const flowStr = JSON.stringify(payload.call_flow).toLowerCase();
      if (flowStr.includes("click") || flowStr.includes("outbound")) return "outbound";
    }

    // Smartflo DID-based Inbound Detection:
    // When explicit direction fields are missing, inspect caller and called numbers.
    // If the called destination number matches our company business DID and caller is present, infer 'inbound'.
    const calledNum = String(
      payload.called_number ??
      payload.call_to_number ??
      payload.DestinationNumber ??
      ""
    ).trim();
    const callerNum = String(
      payload.caller_id_number ??
      payload.caller_id ??
      payload.SourceNumber ??
      ""
    ).trim();

    if (calledNum && callerNum && isKnownBusinessDid(calledNum)) {
      return "inbound";
    }
  }

  return "unknown";
}

/**
 * Safely extracts a clean string display name for the agent.
 * Handles strings, nested objects ({ name, agent_name }), and strips raw object stringifications.
 */
function extractAgentName(rawAgent: any, payload?: SmartfloWebhookPayload): string {
  // If rawAgent is an object
  if (rawAgent && typeof rawAgent === "object") {
    const candidate = rawAgent.agent_name || rawAgent.name || rawAgent.displayName || rawAgent.agentName;
    if (candidate && typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  // If rawAgent is string
  if (typeof rawAgent === "string" && rawAgent.trim() && rawAgent.trim() !== "[object Object]") {
    return rawAgent.trim();
  }

  // Check payload fallbacks
  if (payload) {
    if (payload.answer_agent_name && typeof payload.answer_agent_name === "string" && payload.answer_agent_name.trim()) {
      return payload.answer_agent_name.trim();
    }
    if (Array.isArray(payload.agents_answered_details) && payload.agents_answered_details.length > 0) {
      const firstAgent = payload.agents_answered_details[0];
      if (firstAgent && typeof firstAgent === "object") {
        const candidate = firstAgent.agent_name || firstAgent.name;
        if (candidate && typeof candidate === "string" && candidate.trim()) {
          return candidate.trim();
        }
      }
    }
    if (payload.agent_extension && typeof payload.agent_extension === "string" && payload.agent_extension.trim()) {
      // Do not return raw extension as name unless candidate name not available
    }
    if (payload.agent_name && typeof payload.agent_name === "string" && payload.agent_name.trim() && payload.agent_name.trim() !== "[object Object]") {
      return payload.agent_name.trim();
    }
    if (payload.answered_agent && typeof payload.answered_agent === "string" && payload.answered_agent.trim() && payload.answered_agent.trim() !== "[object Object]") {
      return payload.answered_agent.trim();
    }
    if (payload.agent_id && typeof payload.agent_id === "string" && payload.agent_id.trim() && payload.agent_id.trim() !== "[object Object]") {
      return payload.agent_id.trim();
    }
  }

  return "";
}

/**
 * Safely parses integer duration; never returns NaN.
 */
function parseSafeDuration(val: any): number {
  if (val === undefined || val === null || val === "") return 0;
  const parsed = parseInt(String(val).trim(), 10);
  return isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

/**
 * Safely parses dates including ISO8601, SQL format "YYYY-MM-DD HH:mm:ss", and timezone-naive strings.
 * Smartflo portals are typically configured with Time Zone: "IST: Indian Standard Time".
 * When timestamps arrive without an explicit UTC/offset specifier (e.g. '2026-10-31 13:09:00'),
 * it treats them as Indian Standard Time (+05:30) so they convert accurately into UTC instants,
 * preventing double timezone shift or false 5-hour offsets.
 * Returns undefined if input is empty, null, or invalid rather than replacing with new Date().
 */
function parseSafeDate(raw: any): Date | undefined {
  if (!raw) return undefined;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
  if (typeof raw !== "string") return undefined;
  const str = raw.trim();
  if (!str) return undefined;

  // 1. If string explicitly specifies timezone (ends with Z or +/-HH:mm offset)
  if (str.endsWith("Z") || str.endsWith("z") || /[+-]\d{2}(:\d{2})?$/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? undefined : d;
  }

  // 2. Handle SQL format "YYYY-MM-DD HH:mm:ss" or naive ISO "YYYY-MM-DDTHH:mm:ss"
  const isoCandidate = str.includes(" ") && !str.includes("T") ? str.replace(" ", "T") : str;

  // Parse as IST (+05:30) by default because Smartflo account is configured in IST
  const istDate = new Date(`${isoCandidate}+05:30`);
  if (!isNaN(istDate.getTime())) {
    return istDate;
  }

  // Fallback direct parse attempt
  const directDate = new Date(str);
  return !isNaN(directDate.getTime()) ? directDate : undefined;
}

/**
 * Parses and processes incoming Smartflo call webhook event.
 * Idempotent, deduplicated, matches lead safely by external ID or normalized phone.
 */
export async function processSmartfloWebhook(payload: SmartfloWebhookPayload): Promise<WebhookProcessingResult> {
  // 1. Call ID validation and verified alias resolution
  // Smartflo provides call identifier through verified aliases:
  // - call_id / CallSessionId / callId / callID
  // - session_id / call_session_id / SessionId
  // - uuid (Stable provider UUID when call_id template variable is unresolved or omitted)
  const candidateId =
    payload.call_id ??
    payload.CallSessionId ??
    payload.callId ??
    payload.callID ??
    payload.session_id ??
    payload.call_session_id ??
    payload.SessionId;

  // Check if candidateId is a resolved string or number (not an un-interpolated template literal like "$call_id" or "")
  const isResolvedIdentifier = (val: any): boolean => {
    if (val === undefined || val === null) return false;
    const str = String(val).trim();
    if (!str || str.startsWith("$") || str.toLowerCase() === "undefined" || str.toLowerCase() === "null") {
      return false;
    }
    return true;
  };

  let resolvedCallId = "";
  if (isResolvedIdentifier(candidateId)) {
    resolvedCallId = String(candidateId).trim();
  } else if (isResolvedIdentifier(payload.uuid)) {
    // Fallback to verified stable provider UUID if template variable $call_id was not populated by Smartflo
    resolvedCallId = String(payload.uuid).trim();
  }

  if (!resolvedCallId) {
    const availableKeys = Object.keys(payload).filter((k) => isResolvedIdentifier(payload[k]));
    throw new Error(
      `Missing mandatory 'call_id' in webhook payload. Available keys with values: [${availableKeys.join(", ")}]`
    );
  }
  const callId = resolvedCallId;

  // Check existing SmartfloCallLog for this callId first to retain direction, agentUserId & correlation
  // Also check by uuid or refId if previously linked
  const existingRecord = await SmartfloCallLog.findOne({
    $or: [
      { callId },
      ...(payload.uuid && isResolvedIdentifier(payload.uuid) ? [{ uuid: String(payload.uuid).trim() }] : []),
    ],
  });
  const isDuplicate = !!existingRecord;

  // 2. Direction normalization (inherit from existingRecord if payload lacks explicit direction)
  const rawDirection = payload.Direction ?? payload.direction ?? payload.call_type ?? payload.callType ?? payload.type ?? "";
  const directionCandidate = normalizeCallDirection(rawDirection, payload);
  const direction = directionCandidate !== "unknown" ? directionCandidate : (existingRecord?.direction || "unknown");

  // 3. Customer phone extraction based on direction
  // - Inbound: SourceNumber is the calling customer; DestinationNumber is company DID.
  // - Outbound: DestinationNumber is the called customer; SourceNumber is agent/company DID.
  // - Unknown: Safely inspect customer_number first, then SourceNumber / DestinationNumber.
  const cleanPhoneCandidate = (candidate: any): string => {
    if (candidate === undefined || candidate === null) return "";
    const str = String(candidate).trim();
    if (!str || str.startsWith("$") || str.toLowerCase() === "undefined" || str.toLowerCase() === "null") {
      return "";
    }
    return str;
  };

  let rawCustomerPhone = "";
  if (direction === "inbound") {
    rawCustomerPhone =
      cleanPhoneCandidate(payload.caller_id_number) ||
      cleanPhoneCandidate(payload.customer_no_with_prefix) ||
      cleanPhoneCandidate(payload["customer_no_with_prefix "]) ||
      cleanPhoneCandidate(payload.customer_number_with_prefix) ||
      cleanPhoneCandidate(payload.customer_number) ||
      cleanPhoneCandidate(payload.caller_id) ||
      cleanPhoneCandidate(payload.SourceNumber) ||
      "";
  } else if (direction === "outbound") {
    rawCustomerPhone =
      cleanPhoneCandidate(payload.DestinationNumber) ||
      cleanPhoneCandidate(payload.customer_number) ||
      cleanPhoneCandidate(payload.call_to_number) ||
      cleanPhoneCandidate(payload.called_number) ||
      cleanPhoneCandidate(payload.customer_no_with_prefix) ||
      cleanPhoneCandidate(payload.SourceNumber) ||
      "";
  } else {
    // Missing or unknown direction: safely prioritize explicit customer_number, then SourceNumber, then DestinationNumber
    rawCustomerPhone =
      cleanPhoneCandidate(payload.customer_number) ||
      cleanPhoneCandidate(payload.customer_no_with_prefix) ||
      cleanPhoneCandidate(payload["customer_no_with_prefix "]) ||
      cleanPhoneCandidate(payload.caller_id_number) ||
      cleanPhoneCandidate(payload.caller_id) ||
      cleanPhoneCandidate(payload.SourceNumber) ||
      cleanPhoneCandidate(payload.DestinationNumber) ||
      cleanPhoneCandidate(payload.call_to_number) ||
      cleanPhoneCandidate(payload.called_number) ||
      "";
  }

  const customerNumber = rawCustomerPhone.trim();
  const normalizedPhone = customerNumber ? (normalizePhoneNumber(customerNumber) || customerNumber.replace(/\D/g, "")) : "";

  // 4. Status normalization
  const rawStatus = payload.Status ?? payload.call_status ?? payload.status ?? payload.event ?? payload.trigger ?? "";
  const status = normalizeCallStatus(String(rawStatus), payload);

  // Safe diagnostic log (Never log sensitive auth tokens, passwords or secrets)
  const eventIdentifier = String(
    payload.event ?? payload.event_type ?? payload.trigger ?? payload.webhook_event ?? payload.Status ?? payload.call_status ?? payload.status ?? "unknown"
  );
  console.info(
    `[Smartflo Webhook] Ingested Event: callId=${callId}, event="${eventIdentifier}", direction=${direction}, status=${status}, caller=${customerNumber ? customerNumber.slice(-4).padStart(customerNumber.length, "*") : "none"}`
  );

  // 5. Safe duration calculations
  const totalDuration = parseSafeDuration(payload.CallDuration ?? payload.duration);
  const answeredDuration = parseSafeDuration(payload.answered_duration ?? payload.billsec);

  // 6. Safe timestamp parsing (preserves undefined if missing or invalid)
  const rawStartTime = payload.StartTime ?? payload.start_stamp ?? payload.calldate;
  const rawEndTime = payload.EndTime ?? payload.end_stamp;
  const startTime = parseSafeDate(rawStartTime);
  const endTime = parseSafeDate(rawEndTime);

  // 7. Recording URL parsing
  const rawRecordingUrl = payload.RecordingUrl ?? payload.RecordingURL ?? payload.recording_url ?? payload.recordingUrl ?? "";
  const recordingUrl = typeof rawRecordingUrl === "string" ? rawRecordingUrl.trim() : "";
  const hasRecording = recordingUrl.length > 0;

  // 8. Agent and Display Number (sanitize to string, never allow [object Object])
  let agentName = extractAgentName(payload.answered_agent ?? payload.agent_name, payload);
  let agentNumber = String(
    payload.answered_agent_number ??
    payload.agent_number ??
    payload.agent_extension ??
    payload.extension ??
    payload.agent_id ??
    ""
  ).trim();

  // If agents_answered_details is present (e.g. Call Answered by Agent)
  if (Array.isArray(payload.agents_answered_details) && payload.agents_answered_details.length > 0) {
    const firstDetail = payload.agents_answered_details[0];
    if (firstDetail && typeof firstDetail === "object") {
      if (!agentName) {
        agentName = String(firstDetail.name || firstDetail.agent_name || "").trim();
      }
      if (!agentNumber) {
        agentNumber = String(firstDetail.extension || firstDetail.agent_number || firstDetail.id || "").trim();
      }
    }
  }

  // Also check call_flow array for Agent node if agentNumber or agentName is still missing
  if ((!agentNumber || !agentName) && Array.isArray(payload.call_flow)) {
    for (const step of payload.call_flow) {
      if (step && typeof step === "object" && (step.type === "Agent" || step.type === "agent")) {
        if (!agentNumber && (step.num || step.extension || step.number || step.id)) {
          agentNumber = String(step.num || step.extension || step.number || step.id).trim();
        }
        if (!agentName && (step.name || step.agent_name)) {
          agentName = String(step.name || step.agent_name).trim();
        }
        if (agentNumber && agentName) break;
      }
    }
  }
  let matchedAgentUserId: mongoose.Types.ObjectId | null = existingRecord?.agentUserId || null;
  const rawCallerDid = String(
    payload.call_to_number ??
    payload.called_number ??
    payload.did ??
    payload.DestinationNumber ??
    payload.DisplayNumber ??
    ""
  ).trim();
  const callerDid = rawCallerDid.startsWith("$") ? "" : rawCallerDid;

  // Multi-Agent Correlation by DID (smartfloCallerId) and Agent Extension:
  // Correlate against User database to resolve actual User ObjectId and official name.
  // DID-Based Routing Requirement:
  // Inbound Smartflo popups are agent-specific based on the existing user field: "Assigned Outbound Caller ID / DID" (User.smartfloCallerId).
  try {
    if (!matchedAgentUserId) {
      // 1. Try matching by called DID (smartfloCallerId)
      if (callerDid) {
        const cleanDid = callerDid.replace(/\D/g, "");
        const didConditions: any[] = [{ smartfloCallerId: callerDid }];
        if (cleanDid.length >= 8) {
          didConditions.push({ smartfloCallerId: cleanDid });
          const tenDigit = cleanDid.slice(-10);
          didConditions.push(
            { smartfloCallerId: `+91${tenDigit}` },
            { smartfloCallerId: `91${tenDigit}` },
            { smartfloCallerId: `0${tenDigit}` },
            { smartfloCallerId: tenDigit }
          );
        }

        const matchedUsers = await User.find({
          $or: didConditions,
          status: "active",
        }).select("_id name role smartfloAgentId smartfloAgentNumber smartfloCallerId");

        if (matchedUsers.length === 1) {
          const user = matchedUsers[0];
          matchedAgentUserId = user._id as mongoose.Types.ObjectId;
          if (!agentName || agentName === "Smartflo Dialer") {
            agentName = user.name;
          }
          if (!agentNumber) {
            agentNumber = user.smartfloAgentId || user.smartfloAgentNumber || "";
          }
          console.info(
            `[Smartflo Webhook] Inbound call DID ${callerDid} matched unique agent: ${user.name} (${user._id})`
          );
        } else if (matchedUsers.length > 1) {
          console.warn(
            `[Smartflo Webhook] Ambiguous DID match: ${matchedUsers.length} active users share DID ${callerDid} (${matchedUsers.map((u) => u.name).join(", ")}). Omitted automatic single-agent assignment.`
          );
        } else {
          console.info(
            `[Smartflo Webhook] Inbound DID ${callerDid} did not match any active agent smartfloCallerId.`
          );
        }
      }

      // 2. If agent extension/number is present in payload or call_flow, verify or correlate directly by extension
      const cleanAgentNumber = agentNumber.replace(/^Extension-/i, "").trim();
      const extCandidates: string[] = [];
      if (agentNumber) extCandidates.push(agentNumber);
      if (cleanAgentNumber && cleanAgentNumber !== agentNumber) extCandidates.push(cleanAgentNumber);

      if (extCandidates.length > 0) {
        const extConditions: any[] = [];
        for (const ext of extCandidates) {
          extConditions.push({ smartfloAgentId: ext });
          extConditions.push({ smartfloAgentNumber: ext });
          extConditions.push({ smartfloCallerId: ext });
        }

        const matchedByExt = await User.find({
          $or: extConditions,
          status: "active",
        }).select("_id name role smartfloAgentId smartfloAgentNumber smartfloCallerId");

        if (matchedByExt.length === 1) {
          const user = matchedByExt[0];
          matchedAgentUserId = user._id as mongoose.Types.ObjectId;
          if (!agentName || agentName === "Smartflo Dialer") {
            agentName = user.name;
          }
          console.info(
            `[Smartflo Webhook] Inbound call extension/agentNumber ${agentNumber} matched unique agent: ${user.name} (${user._id})`
          );
        }
      }
    } else {
      // If agentUserId already saved on existing call log, fetch user details if agentName missing
      if (!agentName || agentName === "Smartflo Dialer") {
        const user = await User.findById(matchedAgentUserId).select("name smartfloAgentId smartfloAgentNumber");
        if (user) {
          agentName = user.name;
          if (!agentNumber) {
            agentNumber = user.smartfloAgentId || user.smartfloAgentNumber || "";
          }
        }
      }
    }
  } catch (userLookupErr: any) {
    console.warn(`[Smartflo Webhook] User correlation lookup error: ${userLookupErr.message}`);
  }

  // 9. External CRM identifier passed back by dialer (custom parameter, custom_identifier, or explicit CRM id)
  const customIdent = payload.custom_identifier && typeof payload.custom_identifier === "object"
    ? payload.custom_identifier
    : {};

  const externalLeadId = String(
    customIdent.lead_unique_id ??
    customIdent.lead_id ??
    payload.crm_unique_id ??
    payload.crm_lead_id ??
    payload.custom_parameter_1 ??
    payload.custom_parameter_2 ??
    payload.custom_parameter_3 ??
    ""
  ).trim();

  // Step 1: Lead Matching Strategy
  let matchedLead: ILead | null = null;
  let matchingMethod: "crm_unique_id" | "phone_primary" | "phone_alternate" | "ambiguous" | "unmatched" = "unmatched";

  // Check 1: Stable CRM Lead Unique ID (SOI-xxx or MongoDB ObjectId)
  if (externalLeadId) {
    if (externalLeadId.startsWith("SOI-") || externalLeadId.startsWith("soi-")) {
      matchedLead = await Lead.findOne({ uniqueId: new RegExp(`^${externalLeadId}$`, "i") });
      if (matchedLead) matchingMethod = "crm_unique_id";
    } else if (mongoose.isValidObjectId(externalLeadId)) {
      matchedLead = await Lead.findById(externalLeadId);
      if (matchedLead) matchingMethod = "crm_unique_id";
    }
  }

  // Check 2: Fallback to normalized phone number lookup
  if (!matchedLead && normalizedPhone && normalizedPhone.length >= 10) {
    const candidateLeads = await Lead.find({
      $or: [
        { normalizedPhone: normalizedPhone },
        { normalizedAlternate: normalizedPhone },
        { primaryMobileNumber: normalizedPhone },
        { secondaryMobileNumber: normalizedPhone },
        { mobileNumber: normalizedPhone },
        { phoneNumber: normalizedPhone },
      ],
    }).limit(3);

    if (candidateLeads.length === 1) {
      matchedLead = candidateLeads[0];
      const leadNorm = matchedLead.normalizedPhone || normalizePhoneNumber(matchedLead.primaryMobileNumber || "");
      matchingMethod = leadNorm === normalizedPhone ? "phone_primary" : "phone_alternate";
    } else if (candidateLeads.length > 1) {
      // Ambiguous: multiple leads share this number.
      // Do NOT attach arbitrarily to prevent data cross-contamination.
      matchingMethod = "ambiguous";
      console.warn(
        `[Smartflo Webhook] Ambiguous phone match for ${normalizedPhone}. Found ${candidateLeads.length} leads: ${candidateLeads.map((l) => l.uniqueId).join(", ")}. Flagging call for manual review.`
      );
    }
  }

  // Step 1.5: Automatic Lead Creation for Inbound / Auto Dialer Calls from Unmatched Numbers
  // If no lead exists for this customer phone, automatically create a new Lead record.
  // Assign to the agent whose extension received the call, and prevent duplicate creation atomically via LeadCreationLock.
  if (!matchedLead && matchingMethod !== "ambiguous" && normalizedPhone && normalizedPhone.length >= 10) {
    let acquiredLock = false;
    try {
      // 1. Double check if lead was created just before lock attempt
      let existingCheck = await Lead.findOne({
        $or: [
          { normalizedPhone: normalizedPhone },
          { primaryMobileNumber: normalizedPhone },
          { mobileNumber: normalizedPhone },
        ],
      });

      if (existingCheck) {
        matchedLead = existingCheck;
        matchingMethod = "phone_primary";
      } else {
        // Attempt to acquire distributed DB-level lock for this phone number
        try {
          await LeadCreationLock.create({ phone: normalizedPhone });
          acquiredLock = true;
        } catch (lockErr: any) {
          // Lock already held by a simultaneous request. Wait slightly for the competitor to finish.
          console.warn(
            `[Smartflo Webhook] Lock conflict for phone ${normalizedPhone.slice(-4).padStart(normalizedPhone.length, "*")} (callId: ${callId}). Waiting for competing worker.`
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // Re-check after waiting or acquiring lock
        existingCheck = await Lead.findOne({
          $or: [
            { normalizedPhone: normalizedPhone },
            { primaryMobileNumber: normalizedPhone },
            { mobileNumber: normalizedPhone },
          ],
        });

        if (existingCheck) {
          matchedLead = existingCheck;
          matchingMethod = "phone_primary";
        } else if (acquiredLock) {
          // Double check once more that competitor didn't write
          const assignedOwnerName = agentName || "Smartflo Dialer";
          const autoUniqueId = await getNextUniqueId();
          const todayDate = getTodayDDMMMYY();
          const currentMonth = getCurrentMonthMMMYY();
          const currentTimestamp = getFormattedTimestamp(new Date());

          // Derive campaign/source from DID if available
          const didClean = callerDid.replace(/\D/g, "");
          const didTen = didClean.slice(-10);
          const didInfo = SOURCE_NAME_TO_INFO[didTen] || SOURCE_NAME_TO_INFO[didClean] || null;

          const callSource = direction === "broadcast" || payload.broadcast_campaign_details
            ? "Smartflo Auto Dialer"
            : "Inbound Call";

          try {
            const newLeadDoc = await Lead.create({
              uniqueId: autoUniqueId,
              firstActivityDate: currentTimestamp,
              primaryMobileNumber: customerNumber,
              normalizedPhone: normalizedPhone,
              wifeName: "Inbound Caller",
              husbandName: "",
              husbandAge: "28",
              wifeAge: "26",
              preMedicalConditions: "No",
              marriedSince: "1",
              tryingToConceiveYears: "1",
              callingConsent: "No",
              whatsappConsent: "No",
              leadSource: didInfo?.source || callSource,
              campaignName: didInfo?.campaignName || (payload.broadcast_campaign_details?.broadcast_campaign_name || "Smartflo Inbound"),
              sourceName: callerDid || "Smartflo Pilot DID",
              source: didInfo?.source || "Telephony",
              subStatus: "Fresh Lead",
              leadStage: "Fresh Lead",
              leadValidStatus: "Valid",
              centreLocation: "Noida Sector 62",
              centreAddress: "Seeds IVF Centre",
              leadOwner: assignedOwnerName,
              callerName: assignedOwnerName,
              createdBy: matchedAgentUserId,
              notes: `Auto-created via ${callSource} received on DID ${callerDid || "Pilot"} assigned to extension ${agentNumber || "unassigned"}.`,
              date: todayDate,
              dateOfLead: todayDate,
              month: currentMonth,
              leadTimestamp: currentTimestamp,
              assignedDate: todayDate,
              assignedAt: new Date().toISOString(),
              auditLogs: [
                {
                  performedBy: assignedOwnerName,
                  performedByRole: "agent",
                  performedByEmail: "dialer@smartflo.crm",
                  timestamp: new Date().toISOString(),
                  changes: [
                    {
                      field: "created",
                      fieldLabel: "Auto Lead Creation",
                      oldValue: "",
                      newValue: `Lead auto-created from ${callSource} (${customerNumber}) assigned to ${assignedOwnerName}`,
                    },
                  ],
                },
              ],
            });

            matchedLead = newLeadDoc;
            matchingMethod = "phone_primary";
            console.info(
              `[Smartflo Webhook] Auto-created new Lead ${autoUniqueId} (id: ${newLeadDoc._id}) for phone ${customerNumber} assigned to ${assignedOwnerName} (callId: ${callId})`
            );
          } catch (createErr: any) {
            console.error(
              `[Smartflo Webhook] Lead.create failed for callId=${callId}, phone=${normalizedPhone.slice(-4).padStart(normalizedPhone.length, "*")}, uniqueId=${autoUniqueId}: ${createErr.message}`,
              createErr
            );
            // Check if failure was duplicate key error where another worker created it
            const duplicateCheck = await Lead.findOne({
              $or: [
                { normalizedPhone: normalizedPhone },
                { primaryMobileNumber: normalizedPhone },
                { uniqueId: autoUniqueId },
              ],
            });
            if (duplicateCheck) {
              matchedLead = duplicateCheck;
              matchingMethod = "phone_primary";
            }
          }
        }
      }
    } catch (lockErr: any) {
      console.error(
        `[Smartflo Webhook] Unexpected error during auto-lead lock handling for callId=${callId}, phone=${normalizedPhone.slice(-4).padStart(normalizedPhone.length, "*")}: ${lockErr.message}`
      );
      const fallbackCheck = await Lead.findOne({
        $or: [
          { normalizedPhone: normalizedPhone },
          { primaryMobileNumber: normalizedPhone },
        ],
      });
      if (fallbackCheck) {
        matchedLead = fallbackCheck;
        matchingMethod = "phone_primary";
      }
    } finally {
      if (acquiredLock) {
        try {
          await LeadCreationLock.deleteOne({ phone: normalizedPhone });
        } catch (cleanupErr: any) {
          // TTL index will auto-cleanup after 30s
        }
      }
    }
  }

  // Step 2: Upsert SmartfloCallLog with Idempotency Key (callId)
  // Status priority hierarchy to prevent terminal status regression from out-of-order webhooks
  const statusWeight: Record<string, number> = {
    unknown: 0,
    in_progress: 10,
    ringing: 10,
    answered: 20,
    connected: 20,
    no_answer: 30,
    missed: 30,
    busy: 30,
    failed: 30,
  };

  const currentWeight = statusWeight[existingRecord?.status || "unknown"] || 0;
  const incomingWeight = statusWeight[status] || 0;

  // Never overwrite an already answered, missed, or completed status with a weaker/earlier status (e.g. late in_progress)
  const finalStatus = existingRecord && currentWeight >= 20 && incomingWeight < currentWeight
    ? existingRecord.status
    : status;

  // Preserve recording URL and answered durations if already recorded and incoming is empty
  const finalRecordingUrl = recordingUrl || existingRecord?.recordingUrl || "";
  const finalHasRecording = hasRecording || !!existingRecord?.recordingAvailable;
  const finalAnsweredDuration = answeredDuration > 0 ? answeredDuration : (existingRecord?.answeredDurationSeconds || 0);
  const finalTotalDuration = totalDuration > 0 ? totalDuration : (existingRecord?.durationSeconds || 0);
  const finalAgentName = agentName || existingRecord?.agentName || "";
  const finalAgentNumber = agentNumber || existingRecord?.agentNumber || "";
  const finalAgentUserId = matchedAgentUserId || existingRecord?.agentUserId || undefined;

  // Check whether this payload represents a terminal call hangup / call ended event.
  // Smartflo terminal indicators:
  // - Event name: "call_hangup", "hangup", "call hangup", "completed", "ended", "call_ended", "call:ended"
  // - Telephony indicators: hangup_cause, hangup_cause_code, hangup_cause_description
  // - End timestamps: EndTime, end_stamp, or post-call recordingUrl
  const eventName = String(
    payload.event ?? payload.event_type ?? payload.trigger ?? payload.webhook_event ?? ""
  ).toLowerCase().trim();

  const rawHangupCause = String(
    payload.hangup_cause ?? payload.hangup_cause_description ?? payload.hangup_cause_code ?? ""
  ).trim();

  const hasHangupEventName = (
    eventName.includes("hangup") ||
    eventName.includes("completed") ||
    eventName.includes("ended") ||
    eventName.includes("clearing") ||
    eventName.includes("disconnect")
  );

  const hasHangupCause = (
    rawHangupCause.length > 0 &&
    rawHangupCause !== "0" &&
    rawHangupCause.toLowerCase() !== "none"
  );

  const hasEndTimestampOrRecording = !!(payload.EndTime || payload.end_stamp || recordingUrl);

  const isLiveAnsweredEvent = (
    eventName.includes("answered") ||
    eventName.includes("picked") ||
    (status === "answered" && !hasHangupEventName && !hasHangupCause && !hasEndTimestampOrRecording)
  );

  // A webhook is definitively terminal if:
  // 1. It carries an explicit hangup/completion event name, OR
  // 2. It carries a genuine hangup cause description (e.g. NORMAL_CLEARING, ORIGINATOR_CANCEL), OR
  // 3. It carries an explicit end timestamp/recordingUrl while NOT being an in-flight live answer event.
  const isTerminalHangup = !isLiveAnsweredEvent && (
    hasHangupEventName ||
    hasHangupCause ||
    (hasEndTimestampOrRecording && status !== "in_progress")
  );

  const isDialedOnAgent = eventName.includes("dialed") || (eventName.includes("agent") && eventName.includes("dial"));
  const hasAgentExtension = !!(payload.agent_extension || payload.extension || payload.answered_agent_number || (payload.agent_number && payload.agent_number.length < 10));
  const isAnsweredState = (status === "answered" || eventName.includes("answered") || eventName.includes("picked")) && !isTerminalHangup;
  const hadPriorAgentRung = !!existingRecord?.agentRung;

  // In direct DID-to-agent architectures, Smartflo does not dispatch an intermediate "Dialed on Agent" webhook.
  // When an inbound call arrives on a business DID that uniquely maps to an active CRM agent (matchedAgentUserId),
  // that initial in-progress server event confirms immediate agent delivery/ringing.
  const isDirectDidMatch = (status === "in_progress" && !!finalAgentUserId && direction === "inbound");

  // An agent is confirmed rung/offered if:
  // 1. Direct DID-to-agent mapping resolved a unique active CRM agent on the incoming call, OR
  // 2. An explicit "Dialed on Agent" queue event was received, OR
  // 3. Agent extension metadata is present, OR
  // 4. In-flight answered state was reached, OR
  // 5. An earlier webhook in this call already marked agentRung as true.
  const isAgentConfirmedRung = isDirectDidMatch || isDialedOnAgent || hasAgentExtension || isAnsweredState || hadPriorAgentRung;

  const updateData: Partial<ISmartfloCallLog> = {
    callId,
    uuid: String(payload.uuid || existingRecord?.uuid || ""),
    refId: String(payload.ref_id || payload.refId || existingRecord?.refId || ""),
    customerNumber,
    normalizedCustomerPhone: normalizedPhone,
    agentUserId: finalAgentUserId,
    agentRung: isAgentConfirmedRung,
    agentName: finalAgentName,
    agentNumber: finalAgentNumber,
    direction,
    status: finalStatus,
    durationSeconds: finalTotalDuration,
    answeredDurationSeconds: finalAnsweredDuration,
    startTime: startTime ?? existingRecord?.startTime ?? undefined,
    endTime: endTime ?? existingRecord?.endTime ?? undefined,
    recordingUrl: finalRecordingUrl,
    recordingAvailable: finalHasRecording,
    disposition: String(payload.disposition || existingRecord?.disposition || ""),
    hangupCause: String(payload.hangup_cause_description || existingRecord?.hangupCause || ""),
    rawPayload: payload,
    receivedAt: existingRecord?.receivedAt || new Date(),
  };

  if (matchedLead) {
    updateData.crmLeadId = matchedLead._id as mongoose.Types.ObjectId;
    updateData.crmLeadUniqueId = matchedLead.uniqueId;
    updateData.matchingMethod = matchingMethod;
  } else {
    updateData.matchingMethod = matchingMethod;
  }

  // Atomically upsert call record
  // If a pending record was created by click-to-call matching ref_id, reconcile and upgrade it to official callId
  const existingByRef = updateData.refId ? await SmartfloCallLog.findOne({ refId: updateData.refId }) : null;
  if (existingByRef && existingByRef.callId.startsWith("C2C_PENDING_")) {
    await SmartfloCallLog.deleteOne({ _id: existingByRef._id });
  }

  const savedCallLog = await SmartfloCallLog.findOneAndUpdate(
    { callId },
    { $set: updateData },
    { upsert: true, new: true }
  );

  // Step 3: Record Call Activity into the Lead's Audit Log / History
  // Maintains exactly ONE auditLog entry per callId, updating it across lifecycle events (ringing -> answered -> hangup)
  if (matchedLead) {
    const formattedDuration = finalAnsweredDuration > 0
      ? `${Math.floor(finalAnsweredDuration / 60)}m ${finalAnsweredDuration % 60}s (Answered)`
      : `${finalTotalDuration}s`;

    const agentLabel = updateData.agentName || "Smartflo Dialer";
    const directionLabel = updateData.direction ? updateData.direction.toUpperCase() : "CALL";
    const statusLabel = updateData.status ? updateData.status.toUpperCase() : "COMPLETED";

    const title = `${directionLabel} Call: ${statusLabel} with ${agentLabel}`;
    const detailParts = [
      `Duration: ${formattedDuration}`,
      `Call ID: ${callId}`,
      finalHasRecording ? "Recording Available" : "No Recording",
    ];
    if (updateData.disposition) detailParts.push(`Disposition: ${updateData.disposition}`);
    if (updateData.hangupCause) detailParts.push(`Cause: ${updateData.hangupCause}`);

    const callAuditEntry = {
      performedBy: agentLabel,
      performedByRole: "agent",
      performedByEmail: "dialer@smartflo.crm",
      timestamp: (updateData.startTime || new Date()).toISOString(),
      changes: [
        {
          field: "smartflo_call",
          fieldLabel: "Smartflo Call Log",
          oldValue: callId,
          newValue: `${title} | ${detailParts.join(" | ")}`,
        },
      ],
    };

    // Check if an auditLog for this callId already exists on the lead
    const leadQuery = Lead.findById(matchedLead._id);
    const currentLead = typeof leadQuery?.select === "function"
      ? await leadQuery.select({ auditLogs: 1 })
      : await leadQuery;

    const existingLogIndex = (currentLead?.auditLogs || []).findIndex(
      (log: any) => (log.changes || []).some((c: any) => c.field === "smartflo_call" && c.oldValue === callId)
    );

    if (existingLogIndex >= 0) {
      // Update existing auditLog in-place without adding duplicate entries
      const setPath = `auditLogs.${existingLogIndex}`;
      await Lead.findByIdAndUpdate(matchedLead._id, {
        $set: {
          [`${setPath}.performedBy`]: agentLabel,
          [`${setPath}.changes.0.newValue`]: `${title} | ${detailParts.join(" | ")}`,
        },
      });
    } else {
      // First event for this callId: push new activity entry
      await Lead.findByIdAndUpdate(matchedLead._id, {
        $push: { auditLogs: callAuditEntry },
      });
    }
  }

  // Step 4: Real-Time Call Popups and Lifecycle Synchronization for CRM
  if (direction === "inbound") {
    const calledDid = String(payload.call_to_number ?? payload.did ?? payload.DestinationNumber ?? payload.DisplayNumber ?? "");
    const leadDisplayName = matchedLead
      ? (matchedLead.wifeName || matchedLead.husbandName || matchedLead.patientName || "Valued Lead")
      : "Unknown Caller";

    const notificationPayload: InboundCallNotification = {
      callId,
      uuid: String(payload.uuid || ""),
      did: calledDid,
      callerNumber: customerNumber,
      normalizedPhone,
      status: status === "answered" ? "answered" : status === "missed" ? "missed" : status === "in_progress" ? "ringing" : "ended",
      timestamp: (startTime || new Date()).toISOString(),
      agentExtension: agentNumber || undefined,
      agentName: agentName || undefined,
      leadMatched: !!matchedLead,
      lead: matchedLead
        ? {
            id: matchedLead._id.toString(),
            uniqueId: matchedLead.uniqueId,
            name: leadDisplayName,
            stage: matchedLead.leadStage || "Fresh Lead",
            owner: matchedLead.leadOwner || matchedLead.callerName || undefined,
            primaryMobileNumber: matchedLead.primaryMobileNumber || customerNumber,
          }
        : null,
    };

    const targetUserIdStr = finalAgentUserId ? finalAgentUserId.toString() : undefined;

    // Timing Synchronization & Terminal Hangup Rules:
    // 1. Terminal Call Hangup:
    //    Smartflo sends a terminal hangup webhook containing call_status: "answered" with duration/billsec and hangup_cause.
    //    A terminal hangup must NEVER emit "inbound:answered" or "inbound:ringing"!
    //    - If the call was previously active/rung, emit "inbound:ended" strictly to close the open popup.
    //    - If the popup was never opened, do NOT emit an active popup (log-only update).
    // 2. Initial "Call received on Server":
    //    Suppress early ringing popup until "Dialed on Agent" or agent extension routing is confirmed.
    // 3. "Dialed on Agent":
    //    Emit "inbound:ringing" exclusively to the target agent's private room.
    // 4. Genuine "Call Answered by Agent" (or in-flight Auto Answer):
    //    Emit "inbound:answered" to update the popup to connected and start the call timer.
    // 5. Missed calls before agent routing:
    //    Do NOT fire ghost missed popups to agents.
    if (isTerminalHangup) {
      if (hadPriorAgentRung && targetUserIdStr) {
        console.info(
          `[Smartflo Webhook] Emitting inbound:ended on terminal hangup for active callId=${callId}, targetUser=${targetUserIdStr}`
        );
        broadcastInboundCallEvent("inbound:ended", { ...notificationPayload, status: "ended" }, targetUserIdStr);
      } else {
        console.info(
          `[Smartflo Webhook] Terminal hangup recorded for callId=${callId} without prior agent ringing. Omitted UI popup emission.`
        );
      }
    } else if (status === "in_progress") {
      if (isAgentConfirmedRung && targetUserIdStr) {
        if (!hadPriorAgentRung) {
          console.info(`[Smartflo Webhook] Emitting synchronized inbound:ringing for callId=${callId}, leadMatched=${!!matchedLead}, targetUser=${targetUserIdStr}`);
          broadcastInboundCallEvent("inbound:ringing", notificationPayload, targetUserIdStr);
        } else {
          console.info(`[Smartflo Webhook] Skipping duplicate inbound:ringing for already-rung callId=${callId}, targetUser=${targetUserIdStr}`);
        }
      } else {
        console.info(
          `[Smartflo Webhook] Suppressing early inbound:ringing popup for callId=${callId}: unassigned or ambiguous DID (awaiting agent routing).`
        );
      }
    } else if (status === "answered") {
      // Genuine live in-flight answer event only
      console.info(`[Smartflo Webhook] Emitting inbound:answered for live callId=${callId}, leadMatched=${!!matchedLead}, targetUser=${targetUserIdStr || "unassigned"}`);
      broadcastInboundCallEvent("inbound:answered", notificationPayload, targetUserIdStr);
    } else if (status === "missed") {
      // Only emit missed popup to agent if the call was actually offered/rung to an agent
      if (hadPriorAgentRung || isDialedOnAgent || targetUserIdStr) {
        console.info(`[Smartflo Webhook] Emitting inbound:missed for callId=${callId}, leadMatched=${!!matchedLead}, targetUser=${targetUserIdStr || "unassigned"}`);
        broadcastInboundCallEvent("inbound:missed", notificationPayload, targetUserIdStr);
      } else {
        console.info(`[Smartflo Webhook] Suppressed missed popup for callId=${callId} because call abandoned before routing to any agent.`);
      }
    } else {
      console.info(`[Smartflo Webhook] Emitting inbound:ended for callId=${callId}, leadMatched=${!!matchedLead}, targetUser=${targetUserIdStr || "unassigned"}`);
      broadcastInboundCallEvent("inbound:ended", notificationPayload, targetUserIdStr);
    }
  } else {
    // Outbound Call Lifecycle Synchronization:
    // Support outbound ringing, answered/connected, and terminal ended events.
    const targetUserIdStr = finalAgentUserId ? finalAgentUserId.toString() : undefined;
    const outboundLeadId = matchedLead?._id?.toString() || (externalLeadId ? String(externalLeadId) : undefined);
    const outboundLeadUniqueId = matchedLead?.uniqueId || (externalLeadId.startsWith("SOI-") ? externalLeadId : undefined);

    const isTerminal = ["answered", "missed", "completed", "ended", "failed", "busy", "no_answer"].includes(status) && isTerminalHangup;

    if (isTerminal) {
      const callEndedPayload: CallEndedNotification = {
        callId,
        refId: updateData.refId || existingRecord?.refId || undefined,
        leadId: outboundLeadId,
        leadUniqueId: outboundLeadUniqueId,
        customerNumber,
        status: status === "answered" ? "answered" : status === "missed" ? "missed" : "ended",
        durationSeconds: finalTotalDuration,
        timestamp: (endTime || new Date()).toISOString(),
      };

      console.info(
        `[Smartflo Webhook] Emitting outbound:ended for callId=${callId}, refId=${callEndedPayload.refId}, lead=${callEndedPayload.leadUniqueId}, targetUser=${targetUserIdStr || "global"}`
      );
      broadcastCallEndedEvent("outbound:ended", callEndedPayload, targetUserIdStr);
      broadcastCallEndedEvent("call:ended", callEndedPayload, targetUserIdStr);
    } else if (status === "answered" && !isTerminalHangup) {
      // In-flight answered: agent & customer connected
      const answeredNotification: OutboundCallNotification = {
        callId,
        refId: updateData.refId || existingRecord?.refId || undefined,
        leadId: outboundLeadId,
        leadUniqueId: outboundLeadUniqueId,
        customerNumber,
        status: "answered",
        durationSeconds: finalAnsweredDuration,
        timestamp: (startTime || new Date()).toISOString(),
      };
      console.info(
        `[Smartflo Webhook] Emitting outbound:answered for connected callId=${callId}, refId=${answeredNotification.refId}, lead=${answeredNotification.leadUniqueId}, targetUser=${targetUserIdStr || "global"}`
      );
      broadcastOutboundCallEvent("outbound:answered", answeredNotification, targetUserIdStr);
    } else if (status === "in_progress" || isDialedOnAgent) {
      // Agent is ringing / waiting
      const ringingNotification: OutboundCallNotification = {
        callId,
        refId: updateData.refId || existingRecord?.refId || undefined,
        leadId: outboundLeadId,
        leadUniqueId: outboundLeadUniqueId,
        customerNumber,
        status: "ringing",
        timestamp: (startTime || new Date()).toISOString(),
      };
      console.info(
        `[Smartflo Webhook] Emitting outbound:ringing for callId=${callId}, refId=${ringingNotification.refId}, lead=${ringingNotification.leadUniqueId}, targetUser=${targetUserIdStr || "global"}`
      );
      broadcastOutboundCallEvent("outbound:ringing", ringingNotification, targetUserIdStr);
    } else if (["missed", "failed", "busy", "no_answer"].includes(status)) {
      // Unanswered or rejected outbound call
      const failedPayload: CallEndedNotification = {
        callId,
        refId: updateData.refId || existingRecord?.refId || undefined,
        leadId: outboundLeadId,
        leadUniqueId: outboundLeadUniqueId,
        customerNumber,
        status: status === "missed" ? "missed" : "failed",
        durationSeconds: finalTotalDuration,
        timestamp: (endTime || new Date()).toISOString(),
      };
      console.info(
        `[Smartflo Webhook] Emitting outbound:ended (failed/missed) for callId=${callId}, lead=${failedPayload.leadUniqueId}, targetUser=${targetUserIdStr || "global"}`
      );
      broadcastCallEndedEvent("outbound:ended", failedPayload, targetUserIdStr);
      broadcastCallEndedEvent("call:ended", failedPayload, targetUserIdStr);
    }
  }

  return {
    success: true,
    isDuplicate,
    callLogId: savedCallLog._id.toString(),
    callId,
    leadMatched: !!matchedLead,
    leadUniqueId: matchedLead?.uniqueId,
    message: isDuplicate
      ? `Call event ${callId} updated successfully.`
      : `Call event ${callId} processed and recorded successfully.`,
  };
}
