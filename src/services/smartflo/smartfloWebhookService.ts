import mongoose from "mongoose";
import { Lead, ILead } from "../../models/Lead.js";
import { SmartfloCallLog, ISmartfloCallLog } from "../../models/SmartfloCallLog.js";
import { normalizePhoneNumber } from "../../utils/phoneUtils.js";
import { broadcastInboundCallEvent, InboundCallNotification } from "../../socket.js";

export interface SmartfloWebhookPayload {
  // Call ID aliases
  CallSessionId?: string | number;
  call_id?: string | number;
  callId?: string | number;

  // Phone number aliases
  SourceNumber?: string | number;
  caller_id_number?: string | number;
  DestinationNumber?: string | number;
  call_to_number?: string | number;
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
 * Normalizes call status string into standard CRM enum.
 */
function normalizeCallStatus(raw: string): "answered" | "missed" | "busy" | "failed" | "no_answer" | "in_progress" | "unknown" {
  const s = (raw || "").toLowerCase().trim();
  if (s.includes("answer") || s === "connected" || s === "success") return "answered";
  if (s.includes("miss")) return "missed";
  if (s.includes("busy")) return "busy";
  if (s.includes("no") && s.includes("answer")) return "no_answer";
  if (s.includes("fail") || s.includes("cancel")) return "failed";
  if (s.includes("progress") || s.includes("ring")) return "in_progress";
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
 * Safely parses dates including ISO8601 and SQL format "YYYY-MM-DD HH:mm:ss".
 * Returns undefined if input is empty, null, or invalid rather than replacing with new Date().
 */
function parseSafeDate(raw: any): Date | undefined {
  if (!raw || typeof raw !== "string") {
    if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
    return undefined;
  }
  const str = raw.trim();
  if (!str) return undefined;

  // Handle SQL format "YYYY-MM-DD HH:mm:ss" by replacing space with 'T' if no timezone offset
  const isoCandidate = str.includes(" ") && !str.includes("T") ? str.replace(" ", "T") : str;
  const d = new Date(isoCandidate);
  if (!isNaN(d.getTime())) {
    return d;
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
  // 1. Call ID validation
  const rawCallId = payload.CallSessionId ?? payload.call_id ?? payload.callId;
  if (rawCallId === undefined || rawCallId === null || String(rawCallId).trim() === "") {
    throw new Error("Missing mandatory 'call_id' in webhook payload.");
  }
  const callId = String(rawCallId).trim();

  // 2. Direction normalization
  const rawDirection = payload.Direction ?? payload.direction ?? payload.call_type ?? payload.callType ?? payload.type ?? "";
  const direction = normalizeCallDirection(rawDirection, payload);

  // 3. Customer phone extraction based on direction
  // - Inbound: SourceNumber is the calling customer; DestinationNumber is company DID.
  // - Outbound: DestinationNumber is the called customer; SourceNumber is agent/company DID.
  // - Unknown: Safely inspect customer_number first, then SourceNumber / DestinationNumber.
  let rawCustomerPhone = "";
  if (direction === "inbound") {
    rawCustomerPhone = String(
      payload.SourceNumber ??
      payload.caller_id_number ??
      payload.customer_number ??
      ""
    );
  } else if (direction === "outbound") {
    rawCustomerPhone = String(
      payload.DestinationNumber ??
      payload.customer_number ??
      payload.call_to_number ??
      payload.SourceNumber ??
      ""
    );
  } else {
    // Missing or unknown direction: safely prioritize explicit customer_number, then SourceNumber, then DestinationNumber
    rawCustomerPhone = String(
      payload.customer_number ??
      payload.SourceNumber ??
      payload.caller_id_number ??
      payload.DestinationNumber ??
      payload.call_to_number ??
      ""
    );
  }

  const customerNumber = rawCustomerPhone.trim();
  const normalizedPhone = customerNumber ? (normalizePhoneNumber(customerNumber) || customerNumber.replace(/\D/g, "")) : "";

  // 4. Status normalization
  const rawStatus = payload.Status ?? payload.call_status ?? payload.status ?? "";
  const status = normalizeCallStatus(String(rawStatus));

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
  const agentName = extractAgentName(payload.answered_agent ?? payload.agent_name, payload);
  const agentNumber = String(payload.answered_agent_number ?? "").trim();

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

  // Step 2: Upsert SmartfloCallLog with Idempotency Key (callId)
  const updateData: Partial<ISmartfloCallLog> = {
    callId,
    uuid: String(payload.uuid || ""),
    refId: String(payload.ref_id || payload.refId || ""),
    customerNumber,
    normalizedCustomerPhone: normalizedPhone,
    agentName,
    agentNumber,
    direction,
    status,
    durationSeconds: totalDuration,
    answeredDurationSeconds: answeredDuration,
    startTime: startTime ?? undefined,
    endTime: endTime ?? undefined,
    recordingUrl,
    recordingAvailable: hasRecording,
    disposition: String(payload.disposition || ""),
    hangupCause: String(payload.hangup_cause_description || ""),
    rawPayload: payload,
    receivedAt: new Date(),
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

  const existingRecord = await SmartfloCallLog.findOne({ callId });
  const isDuplicate = !!existingRecord;

  const savedCallLog = await SmartfloCallLog.findOneAndUpdate(
    { callId },
    { $set: updateData },
    { upsert: true, new: true }
  );

  // Step 3: Record Call Activity into the Lead's Audit Log / History
  if (matchedLead && !isDuplicate) {
    const formattedDuration = answeredDuration > 0
      ? `${Math.floor(answeredDuration / 60)}m ${answeredDuration % 60}s (Answered)`
      : `${totalDuration}s`;

    const agentLabel = updateData.agentName || "Smartflo Dialer";
    const directionLabel = updateData.direction ? updateData.direction.toUpperCase() : "CALL";
    const statusLabel = updateData.status ? updateData.status.toUpperCase() : "COMPLETED";

    const title = `${directionLabel} Call: ${statusLabel} with ${agentLabel}`;
    const detailParts = [
      `Duration: ${formattedDuration}`,
      `Call ID: ${callId}`,
      hasRecording ? "Recording Available" : "No Recording",
    ];
    if (updateData.disposition) detailParts.push(`Disposition: ${updateData.disposition}`);

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

    await Lead.findByIdAndUpdate(matchedLead._id, {
      $push: { auditLogs: callAuditEntry },
    });
  }

  // Step 4: Real-Time Inbound Call Popups for CRM
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

    if (status === "in_progress") {
      broadcastInboundCallEvent("inbound:ringing", notificationPayload);
    } else if (status === "answered") {
      broadcastInboundCallEvent("inbound:answered", notificationPayload);
    } else if (status === "missed") {
      broadcastInboundCallEvent("inbound:missed", notificationPayload);
    } else {
      broadcastInboundCallEvent("inbound:ended", notificationPayload);
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
