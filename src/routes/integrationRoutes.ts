import { Router } from "express";
import {
  verifyMetaWebhook,
  handleMetaWebhookEvent,
} from "../controllers/metaWebhookController.js";
import { MetaPageController } from "../controllers/metaPageController.js";
import { verifyMetaSignature } from "../middleware/metaSignature.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roleGuard.js";

const router = Router();

/**
 * Public Webhook Endpoints (secured via Meta token and HMAC SHA-256 signatures)
 * GET  /api/v1/integrations/meta/webhook  -> Verification handshake
 * POST /api/v1/integrations/meta/webhook  -> Notification receiver (signature verified)
 */
router.get("/meta/webhook", verifyMetaWebhook);
router.post("/meta/webhook", verifyMetaSignature, handleMetaWebhookEvent);

/**
 * OAuth & Management Endpoints (Requires valid JWT + admin/marketing role)
 */
const allowedRoles: ("admin" | "marketing")[] = ["admin", "marketing"];

// OAuth Endpoints
router.get(
  "/meta/oauth/start",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.startOAuth
);
router.get(
  "/meta/oauth/callback",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.handleOAuthCallback
);

// Account & Ad Accounts & Campaigns
router.get(
  "/meta/account",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.getAccount
);
router.get(
  "/meta/ad-accounts",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.listAdAccounts
);
router.get(
  "/meta/campaigns",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.listCampaigns
);
router.post(
  "/meta/disconnect-account",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.disconnectAccount
);

// Page & Form Management
router.get(
  "/meta/pages",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.listPages
);
router.post(
  "/meta/pages/connect",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.connectPage
);
router.get(
  "/meta/pages/:pageId/forms",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.listPageForms
);
router.post(
  "/meta/pages/:pageId/forms/sync",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.syncForms
);
router.post(
  "/meta/pages/:pageId/subscribe",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.subscribePage
);
router.delete(
  "/meta/pages/:pageId",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.disconnectPage
);

// Webhook Auditing
router.get(
  "/meta/events",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.listEvents
);

// Meta Ads Manual Setup Endpoints
router.post(
  "/meta/setup/validate",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.validateSetup
);
router.post(
  "/meta/setup/save",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.saveSetup
);
router.get(
  "/meta/setup",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.listSetups
);
router.post(
  "/meta/setup/:id/test",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.testSetupConnection
);
router.delete(
  "/meta/setup/:id",
  requireAuth,
  requireRole(allowedRoles),
  MetaPageController.deleteSetup
);

export default router;
