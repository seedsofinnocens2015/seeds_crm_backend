import mongoose from "mongoose";
import { Lead, ILead } from "../../models/Lead.js";
import { SmartfloCallLog, ISmartfloCallLog } from "../../models/SmartfloCallLog.js";
import { normalizePhoneNumber } from "../../utils/phoneUtils.js";

export interface SmartfloWebhookPayload {
  call_id?: string;
  callId?: string;
  uuid?: string;
  ref_id?: string;
  refId?: string;
  caller_id_number?: string;
  customer_number?: string;
  call_to_number?: string;
  call_status?: string;
  status?: string;
  direction?: string;
  duration?: number | string;
  billsec?: number | string;
  answered_duration?: number | string;
  start_stamp?: string;
  end_stamp?: string;
  calldate?: string;
  answered_agent?: string;
  agent_name?: string;
  agent_id?: string;
  answered_agent_number?: string;
  recording_url?: string;
  recordingUrl?: string;
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
 */
function normalizeCallDirection(raw: string): "inbound" | "outbound" | "broadcast" | "unknown" {
  const d = (raw || "").toLowerCase().trim();
  if (d.includes("in")) return "inbound";
  if (d.includes("broad")) return "broadcast";
  if (d.includes("out")) return "outbound";
  return "outbound";
}

/**
 * Parses and processes incoming Smartflo call webhook event.
 * Idempotent, deduplicated, matches lead safely by external ID or normalized phone.
 */
export async function processSmartfloWebhook(payload: SmartfloWebhookPayload): Promise<WebhookProcessingResult> {
  const rawCallId = payload.call_id || payload.callId;
  if (!rawCallId) {
    throw new Error("Missing mandatory 'call_id' in webhook payload.");
  }
  const callId = String(rawCallId).trim();

  // Extract phone number from customer side
  const rawCustomerPhone =
    payload.caller_id_number ||
    payload.customer_number ||
    payload.call_to_number ||
    "";
  const customerNumber = String(rawCustomerPhone).trim();
  const normalizedPhone = normalizePhoneNumber(customerNumber) || customerNumber.replace(/\D/g, "");

  // Duration calculations
  const totalDuration = parseInt(String(payload.duration || 0), 10) || 0;
  const answeredDuration = parseInt(String(payload.answered_duration || payload.billsec || 0), 10) || 0;

  // Timestamps
  const startTime = payload.start_stamp || payload.calldate ? new Date(payload.start_stamp || payload.calldate!) : new Date();
  const endTime = payload.end_stamp ? new Date(payload.end_stamp) : new Date();

  // Recording URL
  const recordingUrl = (payload.recording_url || payload.recordingUrl || "").trim();
  const hasRecording = recordingUrl.length > 0;

  // External CRM identifier passed back by dialer (custom parameter or explicit CRM id)
  const externalLeadId = (
    payload.crm_unique_id ||
    payload.crm_lead_id ||
    payload.custom_parameter_1 ||
    payload.custom_parameter_2 ||
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
    agentName: String(payload.answered_agent || payload.agent_name || payload.agent_id || ""),
    agentNumber: String(payload.answered_agent_number || ""),
    direction: normalizeCallDirection(payload.direction || ""),
    status: normalizeCallStatus(payload.call_status || payload.status || ""),
    durationSeconds: totalDuration,
    answeredDurationSeconds: answeredDuration,
    startTime: isNaN(startTime.getTime()) ? new Date() : startTime,
    endTime: isNaN(endTime.getTime()) ? new Date() : endTime,
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
