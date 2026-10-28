import { config } from "../../config/env.js";
import { Lead, ILead } from "../../models/Lead.js";
import { SmartfloLeadJob, ISmartfloLeadJob } from "../../models/SmartfloLeadJob.js";
import { normalizePhoneNumber } from "../../utils/phoneUtils.js";
import { getSmartfloAccessToken, invalidateSmartfloAccessToken } from "./smartfloAuthService.js";

export interface SmartfloLeadPayload {
  field_0: string; // Mandatory: Primary phone number
  field_1: string; // Mandatory: Lead / Couple Name
  field_2?: string; // Email (primary or secondary)
  field_3?: string; // Patient Address (falls back to City, State or Location)
  field_4?: string; // Stable CRM Lead Unique ID (e.g. SOI-1234)
  field_5?: string; // Alternate phone number (secondary or whatsapp)
  [key: string]: any;
}

/**
 * Maps a CRM Lead document or lead data object to Smartflo's contact group payload.
 * Field mapping specification:
 * - field_0: primary mobile number (normalized digits/E.164)
 * - field_1: couple / patient name with fallback
 * - field_2: primary email, or secondary email
 * - field_3: patient address (ptAddress or ptCity, ptState or centreLocation)
 * - field_4: stable CRM unique ID (e.g. SOI-1042)
 * - field_5: alternate mobile number (secondaryMobileNumber or whatsappMobileNumber)
 * Note: Never puts leadSource or campaignName in field_5.
 */
export function mapLeadToSmartfloPayload(lead: any): SmartfloLeadPayload {
  const phone = lead.primaryMobileNumber || lead.mobileNumber || lead.phoneNumber || "";
  const normalizedPhone = normalizePhoneNumber(phone) || phone.replace(/\D/g, "");

  // Build couple/lead name with graceful fallbacks
  const nameParts = [lead.wifeName || lead.patientName, lead.husbandName || lead.spouseName].filter(Boolean);
  const leadName = nameParts.join(" & ") || (lead.wifeName || lead.husbandName || lead.patientName || "Valued Patient");

  // Email: primary or secondary
  const email = (lead.primaryEmail || lead.secondaryEmail || "").trim();

  // Address: ptAddress, falling back to city/state, falling back to centre/camp location
  const cityState = [lead.ptCity, lead.ptState].filter(Boolean).map((s: string) => s.trim()).join(", ");
  const rawAddress = lead.ptAddress || cityState || lead.centreLocation || lead.location || lead.campLocation || "";
  const address = String(rawAddress).trim();

  // Stable CRM unique ID
  const uniqueId = String(lead.uniqueId || "").trim();

  // Alternate phone number (secondaryMobileNumber or whatsappMobileNumber or alternateNumber)
  const rawAltPhone = lead.secondaryMobileNumber || lead.whatsappMobileNumber || lead.alternateNumber || "";
  const altPhoneDigits = String(rawAltPhone).trim();
  const normalizedAltPhone = altPhoneDigits ? (normalizePhoneNumber(altPhoneDigits) || altPhoneDigits.replace(/\D/g, "")) : "";

  return {
    field_0: normalizedPhone,
    field_1: leadName,
    field_2: email,
    field_3: address,
    field_4: uniqueId,
    field_5: normalizedAltPhone,
  };
}

/**
 * Resolves the target list ID based on the explicit sync type.
 * - 'broadcast': prefers SMARTFLO_BROADCAST_LIST_ID, then fallback to SMARTFLO_LEAD_LIST_ID
 * - 'contact': prefers SMARTFLO_CONTACT_GROUP_ID, then fallback to SMARTFLO_LEAD_LIST_ID
 */
export function getTargetListId(customId?: string): string {
  if (customId) return customId;
  if (config.smartfloSyncType === "broadcast") {
    return config.smartfloBroadcastListId || config.smartfloLeadListId || "";
  }
  return config.smartfloContactGroupId || config.smartfloLeadListId || "";
}

/**
 * Enqueues a CRM lead for synchronization with Smartflo.
 * Non-blocking, durable, safe against duplicates.
 */
export async function enqueueLeadForSmartflo(leadId: any, uniqueId: string, customListId?: string): Promise<ISmartfloLeadJob | null> {
  const targetListId = getTargetListId(customListId);

  // If no target list is configured yet, do not create an unroutable job
  if (!targetListId) {
    return null;
  }

  try {
    const job = await SmartfloLeadJob.findOneAndUpdate(
      { leadId, targetLeadListId: targetListId },
      {
        $setOnInsert: {
          leadId,
          uniqueId,
          targetLeadListId: targetListId,
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          scheduledAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    // If sync is enabled, trigger immediate background attempt asynchronously
    if (config.smartfloSyncEnabled) {
      setImmediate(() => {
        processSmartfloJob(job._id.toString()).catch((err) => {
          console.error(`[Smartflo Sync] Background sync error for job ${job._id}:`, err.message);
        });
      });
    }

    return job;
  } catch (error: any) {
    // If unique constraint violation or collision, ignore cleanly
    if (error.code === 11000) {
      return await SmartfloLeadJob.findOne({ leadId, targetLeadListId: targetListId });
    }
    console.error(`[Smartflo Sync] Failed to enqueue lead ${uniqueId}:`, error.message);
    return null;
  }
}

/**
 * Bulk enqueues multiple leads for Smartflo.
 * Used during CSV/Excel bulk uploads.
 */
export async function enqueueBulkLeadsForSmartflo(leads: Array<{ _id: any; uniqueId: string }>, customListId?: string): Promise<number> {
  const targetListId = getTargetListId(customListId);
  if (!targetListId || !leads.length) return 0;

  let enqueuedCount = 0;
  const operations: any[] = leads.map((lead) => ({
    updateOne: {
      filter: { leadId: lead._id, targetLeadListId: targetListId },
      update: {
        $setOnInsert: {
          leadId: lead._id,
          uniqueId: lead.uniqueId,
          targetLeadListId: targetListId,
          status: "pending" as const,
          attempts: 0,
          maxAttempts: 5,
          scheduledAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  try {
    const result = await SmartfloLeadJob.bulkWrite(operations, { ordered: false });
    enqueuedCount = result.upsertedCount || 0;

    // Trigger batch runner if enabled
    if (config.smartfloSyncEnabled) {
      setImmediate(() => {
        runPendingSmartfloJobs(50).catch((err) => {
          console.error("[Smartflo Sync] Batch processing error:", err.message);
        });
      });
    }
  } catch (err: any) {
    console.error("[Smartflo Sync] Bulk enqueue partial error:", err.message);
  }

  return enqueuedCount;
}

export interface ProcessJobOptions {
  bypassSyncEnabledFlag?: boolean;
}

/**
 * Processes a single Smartflo sync job with timeout, exponential backoff, and idempotency handling.
 */
export async function processSmartfloJob(
  jobId: string,
  fetchFn: typeof fetch = fetch,
  options?: ProcessJobOptions
): Promise<boolean> {
  const allowBypass = options?.bypassSyncEnabledFlag === true;
  if (!config.smartfloSyncEnabled && !allowBypass) {
    return false;
  }

  // Atomically claim the job if it is pending, or if it was stuck in processing for >5 minutes (stale recovery)
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const claimedJob = await SmartfloLeadJob.findOneAndUpdate(
    {
      _id: jobId,
      $or: [
        { status: "pending", scheduledAt: { $lte: new Date() } },
        { status: "processing", updatedAt: { $lte: staleThreshold } },
      ],
    },
    {
      $set: { status: "processing" },
      $inc: { attempts: 1 },
    },
    { new: true }
  );

  // If already claimed, synced, or not yet eligible, exit safely
  if (!claimedJob) {
    const existing = await SmartfloLeadJob.findById(jobId).lean();
    return existing?.status === "synced";
  }

  const job = claimedJob;

  let accessToken: string;
  try {
    accessToken = await getSmartfloAccessToken(fetchFn);
  } catch (authErr: any) {
    job.status = "pending";
    job.lastError = `Smartflo authentication failed: ${authErr.message}`;
    await job.save();
    return false;
  }

  const lead = await Lead.findById(job.leadId).lean();
  if (!lead) {
    job.status = "failed";
    job.lastError = "Lead no longer exists in CRM database.";
    job.completedAt = new Date();
    await job.save();
    return false;
  }

  const payload = mapLeadToSmartfloPayload(lead);
  if (!payload.field_0 || payload.field_0.length < 10) {
    job.status = "failed";
    job.lastError = `Invalid or missing phone number: "${payload.field_0}". Phone must have at least 10 digits.`;
    job.completedAt = new Date();
    await job.save();
    return false;
  }

  // Target ID guard: Ensure the job's targetLeadListId matches the active configuration.
  // This prevents immediate execution or manual retry from sending a job to the wrong API endpoint type.
  const activeTargetId = getTargetListId();
  if (!activeTargetId) {
    job.status = "pending";
    job.lastError = "No active Smartflo target ID configured for current sync type.";
    await job.save();
    return false;
  }

  if (job.targetLeadListId !== activeTargetId) {
    job.status = "pending";
    job.lastError = `Target list mismatch: job targets '${job.targetLeadListId}', but active '${config.smartfloSyncType}' target is '${activeTargetId}'. Job skipped to avoid cross-endpoint sync.`;
    await job.save();
    return false;
  }

  job.requestPayload = payload;
  await job.save();

  // Determine endpoint URL and request payload envelope strictly by explicit configuration
  const isBroadcast = config.smartfloSyncType === "broadcast";
  const url = isBroadcast
    ? `${config.smartfloApiBaseUrl.replace(/\/+$/, "")}/broadcast/leads/${job.targetLeadListId}`
    : `${config.smartfloApiBaseUrl.replace(/\/+$/, "")}/contact/${job.targetLeadListId}`;

  const requestBody = isBroadcast
    ? JSON.stringify({
        data: [payload],
        duplicate_option: "skip",
      })
    : JSON.stringify(payload);

  const timeoutMs = 15000;

  // Helper for making contact / broadcast lead POST request with current token
  const executePost = async (token: string) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: requestBody,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return resp;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  };

  try {
    let response = await executePost(accessToken);

    // On Smartflo API 401 response: invalidate cached token, obtain a fresh token, and retry only once
    if (response.status === 401) {
      invalidateSmartfloAccessToken();
      try {
        const freshToken = await getSmartfloAccessToken(fetchFn);
        response = await executePost(freshToken);
      } catch (refreshErr: any) {
        job.status = "pending";
        job.lastError = `Smartflo 401 token refresh failed: ${refreshErr.message}`;
        await job.save();
        return false;
      }
    }

    const responseText = await response.text();
    let responseData: any = {};
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { rawResponse: responseText };
    }

    job.responsePayload = responseData;

    // HTTP 200 or 201 indicates success from Smartflo
    if (response.ok) {
      job.status = "synced";
      job.lastError = "";
      // Handle Contact Group response ({ id: 123 }), Broadcast direct ({ id: 123 } / { data: [{ id: 123 }] }), or Broadcast async batch ({ batch_id: "..." })
      const leadIdFromResponse =
        responseData?.id ||
        responseData?.lead_id ||
        (Array.isArray(responseData?.data) && responseData.data[0]?.id) ||
        responseData?.data?.id ||
        responseData?.batch_id ||
        "";
      job.smartfloLeadId = String(leadIdFromResponse);
      job.completedAt = new Date();
      await job.save();
      return true;
    }

    // 409 Conflict / duplicate in list treated as synced or handled gracefully
    if (response.status === 409 || responseText.toLowerCase().includes("already exist")) {
      job.status = "synced";
      job.lastError = `Smartflo reported lead already exists in list: ${responseText.slice(0, 150)}`;
      job.completedAt = new Date();
      await job.save();
      return true;
    }

    // Server error or rate limit: schedule exponential backoff
    const isRetryable = response.status >= 500 || response.status === 429;
    if (isRetryable && job.attempts < job.maxAttempts) {
      job.status = "pending";
      // Backoff in seconds: 2^attempts * 10s (e.g. 20s, 40s, 80s...)
      const backoffSec = Math.pow(2, job.attempts) * 10;
      job.scheduledAt = new Date(Date.now() + backoffSec * 1000);
      job.lastError = `HTTP ${response.status}: ${responseText.slice(0, 200)}. Scheduled retry in ${backoffSec}s.`;
      await job.save();
      return false;
    }

    // Unrecoverable 4xx error or max attempts reached
    job.status = "failed";
    job.lastError = `Smartflo API error (HTTP ${response.status}): ${responseText.slice(0, 300)}`;
    job.completedAt = new Date();
    await job.save();
    return false;
  } catch (err: any) {
    const isTimeout = err.name === "AbortError";
    const errMsg = isTimeout ? "Request timed out after 15s" : err.message || "Network error";

    // Ambiguous network timeouts should NOT be blindly retried automatically because
    // the contact might have already been created on Smartflo before the response reached CRM.
    // Marking as failed with clear manual reconciliation guidance avoids creating duplicate contacts.
    if (isTimeout) {
      job.status = "failed";
      job.lastError = `${errMsg}. Ambiguous network outcome: Contact may have been created on Smartflo. Manual verification in Smartflo group required before retry.`;
      job.completedAt = new Date();
      await job.save();
      return false;
    }

    // General connection reset or DNS failure before TCP socket completion can be retried safely
    if (job.attempts < job.maxAttempts) {
      job.status = "pending";
      const backoffSec = Math.pow(2, job.attempts) * 15;
      job.scheduledAt = new Date(Date.now() + backoffSec * 1000);
      job.lastError = `${errMsg}. Scheduled retry in ${backoffSec}s.`;
      await job.save();
    } else {
      job.status = "failed";
      job.lastError = `Max retries exhausted: ${errMsg}`;
      job.completedAt = new Date();
      await job.save();
    }

    return false;
  }
}

/**
 * Scans and executes pending jobs whose scheduledAt <= now.
 * Strictly isolates job processing to the active targetLeadListId.
 */
export async function runPendingSmartfloJobs(limit: number = 50): Promise<number> {
  const activeTargetId = getTargetListId();
  if (!activeTargetId) {
    return 0;
  }

  const isConfigured = Boolean(
    config.smartfloSyncEnabled &&
    config.smartfloLoginId &&
    config.smartfloPassword
  );

  if (!isConfigured) {
    return 0;
  }

  // Include pending eligible jobs as well as any orphaned jobs stuck in "processing" past stale threshold,
  // strictly filtered by the active targetLeadListId to prevent cross-endpoint job contamination.
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const eligibleJobs = await SmartfloLeadJob.find({
    targetLeadListId: activeTargetId,
    $or: [
      { status: "pending", scheduledAt: { $lte: new Date() } },
      { status: "processing", updatedAt: { $lte: staleThreshold } },
    ],
  })
    .sort({ scheduledAt: 1 })
    .limit(limit);

  let processed = 0;
  for (const job of eligibleJobs) {
    await processSmartfloJob(job._id.toString());
    processed += 1;
  }

  return processed;
}
