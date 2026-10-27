import { config } from "../../config/env.js";
import { Lead, ILead } from "../../models/Lead.js";
import { SmartfloLeadJob, ISmartfloLeadJob } from "../../models/SmartfloLeadJob.js";
import { normalizePhoneNumber } from "../../utils/phoneUtils.js";

export interface SmartfloLeadPayload {
  field_0: string; // Mandatory: Primary phone number
  field_1?: string; // Lead Name (Wife name / Husband name)
  field_2?: string; // Email
  field_3?: string; // Centre Location
  field_4?: string; // Stable CRM Lead Unique ID (e.g. SOI-1234)
  field_5?: string; // Lead Source / Campaign
  [key: string]: any;
}

/**
 * Maps a CRM Lead document or lead data object to Smartflo's broadcast lead payload.
 */
export function mapLeadToSmartfloPayload(lead: any): SmartfloLeadPayload {
  const phone = lead.primaryMobileNumber || lead.mobileNumber || lead.phoneNumber || "";
  const normalizedPhone = normalizePhoneNumber(phone) || phone.replace(/\D/g, "");

  // Build couple/lead name
  const nameParts = [lead.wifeName || lead.patientName, lead.husbandName || lead.spouseName].filter(Boolean);
  const leadName = nameParts.join(" & ") || (lead.wifeName || lead.husbandName || lead.patientName || "Valued Patient");

  const email = (lead.primaryEmail || lead.secondaryEmail || "").trim();
  const location = (lead.centreLocation || lead.location || lead.campLocation || "").trim();
  const uniqueId = (lead.uniqueId || "").trim();
  const source = (lead.leadSource || lead.campaignName || lead.source || "").trim();

  return {
    field_0: normalizedPhone,
    field_1: leadName,
    field_2: email,
    field_3: location,
    field_4: uniqueId,
    field_5: source,
  };
}

/**
 * Enqueues a CRM lead for synchronization with Smartflo.
 * Non-blocking, durable, safe against duplicates.
 */
export async function enqueueLeadForSmartflo(leadId: any, uniqueId: string, customListId?: string): Promise<ISmartfloLeadJob | null> {
  const targetListId = customListId || config.smartfloLeadListId;

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
  const targetListId = customListId || config.smartfloLeadListId;
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

/**
 * Processes a single Smartflo sync job with timeout, exponential backoff, and idempotency handling.
 */
export async function processSmartfloJob(jobId: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (!config.smartfloSyncEnabled) {
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

  if (!config.smartfloApiToken) {
    job.status = "pending";
    job.lastError = "Smartflo API Token is not configured (SMARTFLO_API_TOKEN is empty).";
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

  job.requestPayload = payload;
  await job.save();

  const url = `${config.smartfloApiBaseUrl}/broadcast/lead/${job.targetLeadListId}`;
  const controller = new AbortController();
  const timeoutMs = 15000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.smartfloApiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

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
      job.smartfloLeadId = responseData?.id || responseData?.lead_id || responseData?.data?.id || "";
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
    clearTimeout(timeoutId);
    const isTimeout = err.name === "AbortError";
    const errMsg = isTimeout ? "Request timed out after 15s" : err.message || "Network error";

    if (job.attempts < job.maxAttempts) {
      job.status = "pending";
      const backoffSec = Math.pow(2, job.attempts) * 15;
      job.scheduledAt = new Date(Date.now() + backoffSec * 1000);
      job.lastError = `${errMsg}. Scheduled retry in ${backoffSec}s. Note: Check Smartflo list in case request succeeded before timeout.`;
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
 */
export async function runPendingSmartfloJobs(limit: number = 50): Promise<number> {
  if (!config.smartfloSyncEnabled || !config.smartfloApiToken) {
    return 0;
  }

  // Include pending eligible jobs as well as any orphaned jobs stuck in "processing" past stale threshold
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const eligibleJobs = await SmartfloLeadJob.find({
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
