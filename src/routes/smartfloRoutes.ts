import { Router } from "express";
import {
  handleSmartfloWebhook,
  fetchLeadsForSmartfloPull,
  getLeadCallHistory,
  streamCallRecording,
  getSmartfloSyncJobs,
  retrySmartfloSyncJob,
  triggerCdrReconciliation,
} from "../controllers/smartfloController.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roleGuard.js";

const router = Router();

/**
 * 1. Smartflo Call Webhook Endpoint (Public / Secured by Webhook Secret)
 * POST /api/v1/integrations/smartflo/webhook
 */
router.post("/webhook", handleSmartfloWebhook);

/**
 * 2. Dedicated Smartflo Inbound Pull Endpoint (Secured by Smartflo API Key)
 * GET /api/v1/integrations/smartflo/leads
 */
router.get("/leads", fetchLeadsForSmartfloPull);

/**
 * 3. Authenticated CRM Endpoints (Requires valid user JWT)
 */
// Call history for a specific lead
router.get("/calls/:leadId", requireAuth, getLeadCallHistory);

// Secure streaming/redirect to call recording
router.get("/recording/:callId", requireAuth, streamCallRecording);

/**
 * 4. Admin & Team Leader Integration Management
 */
const privilegedRoles: ("admin" | "team_leader")[] = ["admin", "team_leader"];

// Inspect sync queue jobs
router.get("/jobs", requireAuth, requireRole(privilegedRoles), getSmartfloSyncJobs);

// Retry failed sync job
router.post("/jobs/:jobId/retry", requireAuth, requireRole(privilegedRoles), retrySmartfloSyncJob);

// Manual CDR reconciliation
router.post("/cdr-sync", requireAuth, requireRole(privilegedRoles), triggerCdrReconciliation);

export default router;
