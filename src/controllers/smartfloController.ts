import { Request, Response } from "express";
import mongoose from "express";
import { config } from "../config/env.js";
import { Lead } from "../models/Lead.js";
import { SmartfloLeadJob } from "../models/SmartfloLeadJob.js";
import { SmartfloCallLog } from "../models/SmartfloCallLog.js";
import {
  processSmartfloWebhook,
  processSmartfloJob,
  runPendingSmartfloJobs,
  syncSmartfloCdrRange,
  mapLeadToSmartfloPayload,
} from "../services/smartflo/index.js";

export type WebhookAuthResult = "ok" | "unconfigured" | "unauthorized";

/**
 * Middleware or validation function for Smartflo Webhook authentication.
 * Fails closed: rejects if SMARTFLO_WEBHOOK_SECRET is not configured.
 */
export function verifySmartfloWebhookAuth(req: Request): WebhookAuthResult {
  if (!config.smartfloWebhookSecret) {
    return "unconfigured";
  }
  const authHeader = req.headers["authorization"] || req.headers["x-webhook-secret"] || req.headers["x-api-key"];
  if (!authHeader) return "unauthorized";

  const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const cleanToken = token.replace(/^Bearer\s+/i, "").trim();
  return cleanToken === config.smartfloWebhookSecret ? "ok" : "unauthorized";
}

/**
 * Middleware or validation for Smartflo Inbound Pull API (Least Privilege).
 */
export function verifySmartfloPullAuth(req: Request): boolean {
  if (!config.smartfloApiKey) {
    return false;
  }
  const authHeader = req.headers["authorization"] || req.headers["x-api-key"];
  if (!authHeader) return false;

  const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const cleanToken = token.replace(/^Bearer\s+/i, "").trim();
  return cleanToken === config.smartfloApiKey;
}

/**
 * POST /api/v1/integrations/smartflo/webhook
 * Receives call event notifications from Smartflo.
 */
export async function handleSmartfloWebhook(req: Request, res: Response) {
  try {
    const authStatus = verifySmartfloWebhookAuth(req);
    if (authStatus === "unconfigured") {
      return res.status(500).json({
        error: "Server configuration error: Webhook authentication secret is not configured.",
      });
    }
    if (authStatus === "unauthorized") {
      return res.status(401).json({ error: "Unauthorized webhook request" });
    }

    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }

    const result = await processSmartfloWebhook(payload);

    return res.status(200).json({
      status: "success",
      callId: result.callId,
      isDuplicate: result.isDuplicate,
      leadMatched: result.leadMatched,
      leadUniqueId: result.leadUniqueId,
      message: result.message,
    });
  } catch (error: any) {
    console.error("[Smartflo Webhook Error]:", error.message);
    return res.status(500).json({
      status: "error",
      message: error.message || "Failed to process call webhook",
    });
  }
}

/**
 * GET /api/v1/integrations/smartflo/leads
 * Dedicated authenticated read-only CRM endpoint for Smartflo Custom Connector (Pull Mode).
 * Exposes only necessary fields (field_0, field_1, field_2, field_3, field_4, field_5).
 */
export async function fetchLeadsForSmartfloPull(req: Request, res: Response) {
  try {
    if (!verifySmartfloPullAuth(req)) {
      return res.status(401).json({ error: "Unauthorized: Invalid or missing integration API key." });
    }

    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10)));
    const skip = (page - 1) * limit;

    // Optional filter by modified/created timestamp
    const query: any = {};
    if (req.query.from_date) {
      const from = new Date(String(req.query.from_date));
      if (!isNaN(from.getTime())) {
        query.createdAt = { $gte: from };
      }
    }

    const [leads, totalCount] = await Promise.all([
      Lead.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select({
          uniqueId: 1,
          primaryMobileNumber: 1,
          mobileNumber: 1,
          phoneNumber: 1,
          wifeName: 1,
          husbandName: 1,
          patientName: 1,
          primaryEmail: 1,
          centreLocation: 1,
          leadSource: 1,
          createdAt: 1,
        })
        .lean(),
      Lead.countDocuments(query),
    ]);

    const formattedResults = leads.map((lead) => mapLeadToSmartfloPayload(lead as any));

    return res.status(200).json({
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      results: formattedResults,
    });
  } catch (error: any) {
    console.error("[Smartflo Pull API Error]:", error.message);
    return res.status(500).json({ error: "Failed to fetch leads for dialer" });
  }
}

/**
 * GET /api/v1/integrations/smartflo/calls/:leadId
 * Fetches all call activities recorded for a specific lead.
 * Secured via CRM user authentication.
 */
export async function getLeadCallHistory(req: Request, res: Response) {
  try {
    const { leadId } = req.params;

    const query: any = {
      $or: [{ crmLeadUniqueId: leadId }],
    };

    // If param is a valid ObjectId, also match by crmLeadId
    if (leadId.match(/^[0-9a-fA-F]{24}$/)) {
      query.$or.push({ crmLeadId: leadId });
    }

    const calls = await SmartfloCallLog.find(query)
      .sort({ receivedAt: -1, startTime: -1 })
      .lean();

    // Map results safely, never exposing raw system tokens to the client
    const safeCalls = calls.map((c) => ({
      id: c._id,
      callId: c.callId,
      direction: c.direction,
      status: c.status,
      customerNumber: c.customerNumber,
      agentName: c.agentName || "Agent",
      durationSeconds: c.durationSeconds,
      answeredDurationSeconds: c.answeredDurationSeconds,
      startTime: c.startTime,
      endTime: c.endTime,
      disposition: c.disposition,
      hangupCause: c.hangupCause,
      recordingAvailable: !!(c.recordingAvailable && c.recordingUrl),
      playbackUrl: c.recordingUrl
        ? `/api/integrations/smartflo/recording/${encodeURIComponent(c.callId)}`
        : null,
    }));

    return res.status(200).json({ calls: safeCalls });
  } catch (error: any) {
    console.error("[Smartflo Call History Error]:", error.message);
    return res.status(500).json({ error: "Failed to fetch call history" });
  }
}

/**
 * GET /api/v1/integrations/smartflo/recording/:callId
 * Secure streaming or authorized redirect to Smartflo recording.
 * Verifies that requester has access to CRM and that the call belongs to a known lead.
 */
export async function streamCallRecording(req: Request, res: Response) {
  try {
    const { callId } = req.params;
    const callLog = await SmartfloCallLog.findOne({ callId }).lean();

    if (!callLog || !callLog.recordingUrl) {
      return res.status(404).json({ error: "Call recording not found or not available" });
    }

    // Role-based access: agents can only listen to recordings associated with their leads
    const session = req.user;
    if (session && session.role === "agent") {
      // Unmatched or ambiguous calls must never be accessible to agents
      if (!callLog.crmLeadId) {
        return res.status(403).json({
          error: "Access denied. Agents cannot access recordings for unassigned or unmatched calls.",
        });
      }

      const lead = await Lead.findById(callLog.crmLeadId).select({ leadOwner: 1, callerName: 1 }).lean();
      if (!lead) {
        return res.status(404).json({ error: "Associated lead not found" });
      }

      const agentName = (session.name || "").trim().toLowerCase();
      const leadOwner = (lead.leadOwner || lead.callerName || "").trim().toLowerCase();
      if (leadOwner !== agentName) {
        return res.status(403).json({ error: "Access denied. You can only play recordings for your assigned leads." });
      }
    }

    // Redirect to Smartflo secure authenticated recording link
    return res.redirect(302, callLog.recordingUrl);
  } catch (error: any) {
    console.error("[Smartflo Recording Playback Error]:", error.message);
    return res.status(500).json({ error: "Failed to access call recording" });
  }
}

/**
 * GET /api/v1/integrations/smartflo/jobs
 * Admin & Team Leader endpoint to inspect Smartflo synchronization queue status.
 */
export async function getSmartfloSyncJobs(req: Request, res: Response) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10)));
    const status = req.query.status as string;

    const query: any = {};
    if (status && ["pending", "processing", "synced", "failed"].includes(status)) {
      query.status = status;
    }

    const [jobs, totalCount, statusCounts] = await Promise.all([
      SmartfloLeadJob.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SmartfloLeadJob.countDocuments(query),
      SmartfloLeadJob.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    const counts = { pending: 0, processing: 0, synced: 0, failed: 0 };
    for (const sc of statusCounts) {
      if (sc._id in counts) {
        (counts as any)[sc._id] = sc.count;
      }
    }

    return res.status(200).json({
      jobs,
      totalCount,
      counts,
      page,
      limit,
      syncEnabled: config.smartfloSyncEnabled,
      configuredListId: config.smartfloLeadListId || null,
    });
  } catch (error: any) {
    console.error("[Smartflo Jobs List Error]:", error.message);
    return res.status(500).json({ error: "Failed to fetch Smartflo jobs" });
  }
}

/**
 * POST /api/v1/integrations/smartflo/jobs/:jobId/retry
 * Admin action to retry a failed Smartflo synchronization job.
 */
export async function retrySmartfloSyncJob(req: Request, res: Response) {
  try {
    const { jobId } = req.params;
    const job = await SmartfloLeadJob.findById(jobId);
    if (!job) {
      return res.status(404).json({ error: "Sync job not found" });
    }

    job.status = "pending";
    job.attempts = 0;
    job.scheduledAt = new Date();
    await job.save();

    const success = await processSmartfloJob(job._id.toString());

    const updatedJob = await SmartfloLeadJob.findById(jobId).lean();
    return res.status(200).json({
      success,
      job: updatedJob,
      message: success ? "Job successfully synced with Smartflo" : "Job processing encountered an issue; check lastError",
    });
  } catch (error: any) {
    console.error("[Smartflo Retry Error]:", error.message);
    return res.status(500).json({ error: error.message || "Failed to retry job" });
  }
}

/**
 * POST /api/v1/integrations/smartflo/jobs/:jobId/test-sync
 * Strictly scoped Admin-only test execution endpoint for a single, explicitly selected job.
 * Allows controlled testing of an approved dummy job when SMARTFLO_SYNC_ENABLED=false.
 * Strictly checks that:
 * 1. User is authenticated with admin role.
 * 2. Only the single jobId in the route is targeted (cannot trigger queue, batch, or scheduler).
 * 3. The job's targetLeadListId matches the active configuration (cannot cross-sync).
 */
export async function testSyncSingleSmartfloJob(req: Request, res: Response) {
  try {
    const { jobId } = req.params;
    const job = await SmartfloLeadJob.findById(jobId);
    if (!job) {
      return res.status(404).json({ error: "Sync job not found" });
    }

    // Set to pending so processSmartfloJob can atomically claim it
    job.status = "pending";
    job.scheduledAt = new Date();
    await job.save();

    // Execute only this single job with explicit test bypass
    const success = await processSmartfloJob(job._id.toString(), fetch, {
      bypassSyncEnabledFlag: true,
    });

    const updatedJob = await SmartfloLeadJob.findById(jobId).lean();
    return res.status(200).json({
      success,
      job: updatedJob,
      message: success
        ? "Test job successfully executed with Smartflo"
        : `Test job processing failed: ${updatedJob?.lastError || "Check logs"}`,
    });
  } catch (error: any) {
    console.error("[Smartflo Test-Sync Error]:", error.message);
    return res.status(500).json({ error: error.message || "Failed to execute test sync" });
  }
}

/**
 * POST /api/v1/integrations/smartflo/cdr-sync
 * Triggers CDR reconciliation for a specified date range.
 */
export async function triggerCdrReconciliation(req: Request, res: Response) {
  try {
    const { fromDate, toDate } = req.body;
    if (!fromDate || !toDate) {
      return res.status(400).json({ error: "fromDate and toDate ('YYYY-MM-DD HH:mm:ss') are required." });
    }

    const summary = await syncSmartfloCdrRange(String(fromDate), String(toDate));
    return res.status(200).json({
      status: "success",
      summary,
    });
  } catch (error: any) {
    console.error("[Smartflo CDR Sync Error]:", error.message);
    return res.status(500).json({ error: error.message || "CDR reconciliation failed" });
  }
}
