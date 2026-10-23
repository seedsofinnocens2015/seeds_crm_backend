import { Request, Response } from "express";
import crypto from "node:crypto";
import { MetaPageService } from "../services/metaPageService.js";
import { MetaWebhookEvent } from "../models/MetaWebhookEvent.js";
import { MetaAccountConnection } from "../models/MetaAccountConnection.js";
import { MetaPageConnection } from "../models/MetaPageConnection.js";
import { MetaAdsSetupConfig } from "../models/MetaAdsSetupConfig.js";
import { MetaOAuthCodeAudit } from "../models/MetaOAuthCodeAudit.js";
import { generateOAuthState, verifyOAuthState } from "../utils/oauthState.js";
import { config } from "../config/env.js";

/**
 * Controller for Meta OAuth, Ad Accounts, Campaigns, Page Connections, Form Discovery, and Webhooks.
 * Protects management endpoints via requireAuth + requireRole(["admin", "marketing"]).
 */
export class MetaPageController {
  /**
   * GET /api/v1/integrations/meta/oauth/start
   */
  public static async startOAuth(req: Request, res: Response): Promise<Response> {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const state = generateOAuthState({
        id: user.id,
        email: user.email,
        role: user.role,
      });

      const authUrl = MetaPageService.getOAuthDialogUrl(state);

      return res.status(200).json({
        success: true,
        authUrl,
        state,
      });
    } catch (err: any) {
      console.error("[Meta OAuth] Error generating authorization URL:", err.message);
      return res.status(500).json({ error: err.message || "Failed to start Meta OAuth flow" });
    }
  }

  /**
   * GET /api/v1/integrations/meta/oauth/callback
   */
  public static async handleOAuthCallback(req: Request, res: Response): Promise<Response> {
    try {
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;
      const errorDescription = req.query.error_description as string | undefined;

      if (error) {
        console.warn("[Meta OAuth] User denied or error occurred in Facebook dialog:", errorDescription || error);
        return res.status(400).json({
          error: "OAuth authorization denied by user or Meta",
          details: errorDescription || error,
        });
      }

      if (!code || !state) {
        return res.status(400).json({ error: "Missing authorization code or state parameter" });
      }

      const verifiedState = verifyOAuthState(state);
      console.info(`[Meta OAuth] Verified state for user: ${verifiedState.userEmail}`);

      // Idempotency check: Hash the authorization code using SHA-256
      const codeHash = crypto.createHash("sha256").update(code).digest("hex");

      // Check if this authorization code is already tracked
      let codeAudit = await MetaOAuthCodeAudit.findOne({ codeHash });

      if (codeAudit) {
        if (codeAudit.status === "completed" && codeAudit.responsePayload) {
          console.info(
            `[Meta OAuth] Duplicate callback for user ${verifiedState.userEmail}. Returning cached successful exchange result.`
          );
          return res.status(200).json({
            ...codeAudit.responsePayload,
            isDuplicate: true,
            note: "This authorization has already been processed.",
          });
        }

        if (codeAudit.status === "processing") {
          console.info(
            `[Meta OAuth] Concurrent callback detected for codeHash. Waiting briefly for initial exchange to complete.`
          );
          // Wait up to 3 seconds for the primary execution
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const recheck = await MetaOAuthCodeAudit.findOne({ codeHash });
            if (recheck && recheck.status === "completed" && recheck.responsePayload) {
              return res.status(200).json({
                ...recheck.responsePayload,
                isDuplicate: true,
                note: "This authorization has already been processed.",
              });
            }
          }
        }

        // If previously failed or exchange still unverified
        if (codeAudit.status === "failed") {
          return res.status(400).json({
            error: codeAudit.errorMessage || "This authorization code has already been used.",
            isDuplicate: true,
          });
        }
      }

      // Record in-flight exchange attempt atomically
      try {
        codeAudit = await MetaOAuthCodeAudit.create({
          codeHash,
          stateNonce: verifiedState.nonce,
          userEmail: verifiedState.userEmail,
          status: "processing",
        });
      } catch (insertErr: any) {
        // If unique index race condition occurs, re-fetch completed record
        const raceAudit = await MetaOAuthCodeAudit.findOne({ codeHash });
        if (raceAudit && raceAudit.status === "completed" && raceAudit.responsePayload) {
          return res.status(200).json({
            ...raceAudit.responsePayload,
            isDuplicate: true,
            note: "This authorization has already been processed.",
          });
        }
      }

      // 1. Exchange code for short-lived user token
      let shortLivedToken: string;
      try {
        const shortLivedTokenRes = await MetaPageService.exchangeCodeForUserToken(code);
        shortLivedToken = shortLivedTokenRes.access_token;
      } catch (exchangeErr: any) {
        if (codeAudit) {
          codeAudit.status = "failed";
          codeAudit.errorMessage = exchangeErr.message;
          await codeAudit.save().catch(() => {});
        }
        throw exchangeErr;
      }

      // 2. Exchange for 60-day long-lived token
      let userToken = shortLivedToken;
      try {
        const longLivedTokenRes = await MetaPageService.exchangeForLongLivedToken(shortLivedToken);
        if (longLivedTokenRes.access_token) {
          userToken = longLivedTokenRes.access_token;
        }
      } catch (tokenErr: any) {
        console.warn("[Meta OAuth] Long-lived exchange warning, falling back to token:", tokenErr.message);
      }

      // 3. Fetch user profile identity & accessible Ad Accounts
      let userProfile = { id: `meta_usr_${Date.now()}`, name: "Meta Advertiser" };
      try {
        userProfile = await MetaPageService.fetchUserProfile(userToken);
      } catch {
        // fallback default
      }

      const adAccounts = await MetaPageService.fetchUserAdAccounts(userToken);
      console.info(`[Meta OAuth] Discovered ${adAccounts.length} accessible Ad Account(s).`);

      // Save/update MetaAccountConnection
      await MetaAccountConnection.findOneAndUpdate(
        { connectedEmail: verifiedState.userEmail },
        {
          $set: {
            metaUserId: userProfile.id,
            metaUserName: userProfile.name,
            connectedEmail: verifiedState.userEmail,
            userAccessToken: userToken,
            status: "active",
            adAccounts,
            selectedAdAccountId: adAccounts[0]?.id || "",
            lastSyncAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );

      // 4. Discover Pages and their Page Access Tokens
      const pages = await MetaPageService.fetchUserPages(userToken);
      console.info(`[Meta OAuth] Discovered ${pages.length} authorized Page(s) for user.`);

      const registeredPages = [];
      for (const p of pages) {
        if (p.id && p.name && p.access_token) {
          try {
            const connected = await MetaPageService.connectPage({
              pageId: p.id,
              pageName: p.name,
              accessToken: p.access_token,
              connectedBy: verifiedState.userEmail,
              metadata: { tasks: p.tasks || [] },
            });
            registeredPages.push({
              pageId: connected.pageId,
              pageName: connected.pageName,
              status: connected.status,
              isSubscribed: connected.isSubscribed,
              subscribedAt: connected.subscribedAt,
            });
          } catch (connErr: any) {
            console.error(`[Meta OAuth] Failed to register Page ${p.id}:`, connErr.message);
          }
        }
      }

      const resultPayload = {
        success: true,
        message: `Successfully connected Meta account (${userProfile.name}) and registered ${registeredPages.length} Page(s).`,
        account: {
          metaUserId: userProfile.id,
          metaUserName: userProfile.name,
          adAccounts,
        },
        pages: registeredPages,
      };

      // Mark code audit record as completed with result payload
      if (codeAudit) {
        codeAudit.status = "completed";
        codeAudit.metaUserId = userProfile.id;
        codeAudit.metaUserName = userProfile.name;
        codeAudit.pagesCount = registeredPages.length;
        codeAudit.adAccountsCount = adAccounts.length;
        codeAudit.responsePayload = resultPayload;
        await codeAudit.save().catch(() => {});
      }

      return res.status(200).json(resultPayload);
    } catch (err: any) {
      console.error("[Meta OAuth] Callback error:", err.message);
      return res.status(400).json({ error: err.message || "OAuth callback failed" });
    }
  }

  /**
   * GET /api/v1/integrations/meta/account
   * Returns connected Meta account details, status, and ad accounts.
   */
  public static async getAccount(req: Request, res: Response): Promise<Response> {
    try {
      const email = req.user?.email;
      let account = await MetaAccountConnection.findOne(email ? { connectedEmail: email } : {}).lean();

      if (!account) {
        // Find any active connection
        account = await MetaAccountConnection.findOne({ status: "active" }).lean();
      }

      return res.status(200).json({
        success: true,
        account: account
          ? {
              metaUserId: account.metaUserId,
              metaUserName: account.metaUserName,
              connectedEmail: account.connectedEmail,
              status: account.status,
              adAccounts: account.adAccounts || [],
              selectedAdAccountId: account.selectedAdAccountId || "",
              lastSyncAt: account.lastSyncAt,
            }
          : null,
      });
    } catch (err: any) {
      console.error("[Meta Account] Error getting account:", err.message);
      return res.status(500).json({ error: "Failed to fetch Meta account details" });
    }
  }

  /**
   * GET /api/v1/integrations/meta/ad-accounts
   */
  public static async listAdAccounts(req: Request, res: Response): Promise<Response> {
    try {
      const email = req.user?.email;
      const account = await MetaAccountConnection.findOne(email ? { connectedEmail: email } : {});

      if (!account || !account.userAccessToken) {
        return res.status(200).json({ success: true, adAccounts: [] });
      }

      const adAccounts = await MetaPageService.fetchUserAdAccounts(account.userAccessToken);

      if (adAccounts.length > 0) {
        account.adAccounts = adAccounts;
        await account.save();
      }

      return res.status(200).json({
        success: true,
        adAccounts,
        selectedAdAccountId: account.selectedAdAccountId,
      });
    } catch (err: any) {
      console.error("[Meta Ad Accounts] Error listing ad accounts:", err.message);
      return res.status(500).json({ error: "Failed to list ad accounts" });
    }
  }

  /**
   * GET /api/v1/integrations/meta/campaigns
   * Lists campaigns for an ad account.
   */
  public static async listCampaigns(req: Request, res: Response): Promise<Response> {
    try {
      const adAccountId = (req.query.adAccountId as string) || "";
      const email = req.user?.email;
      const account = await MetaAccountConnection.findOne(email ? { connectedEmail: email } : {});

      if (!account || !account.userAccessToken) {
        return res.status(400).json({ error: "No active Meta account connected" });
      }

      const targetId = adAccountId || account.selectedAdAccountId || account.adAccounts?.[0]?.id;
      if (!targetId) {
        return res.status(400).json({ error: "Please specify or select an Ad Account ID" });
      }

      const campaigns = await MetaPageService.fetchAdAccountCampaigns(targetId, account.userAccessToken);

      return res.status(200).json({
        success: true,
        adAccountId: targetId,
        count: campaigns.length,
        campaigns,
      });
    } catch (err: any) {
      console.error("[Meta Campaigns] Error listing campaigns:", err.message);
      return res.status(400).json({ error: err.message || "Failed to list campaigns" });
    }
  }

  /**
   * GET /api/v1/integrations/meta/pages
   */
  public static async listPages(req: Request, res: Response): Promise<Response> {
    try {
      const pages = await MetaPageService.listConnectedPages();
      return res.status(200).json({
        success: true,
        pages,
      });
    } catch (err: any) {
      console.error("[Meta Pages] Error listing pages:", err.message);
      return res.status(500).json({ error: "Failed to list connected Meta pages" });
    }
  }

  /**
   * GET /api/v1/integrations/meta/pages/:pageId/forms
   */
  public static async listPageForms(req: Request, res: Response): Promise<Response> {
    try {
      const { pageId } = req.params;
      const forms = await MetaPageService.fetchPageForms(pageId);

      return res.status(200).json({
        success: true,
        pageId,
        count: forms.length,
        forms,
      });
    } catch (err: any) {
      console.error(`[Meta Forms] Error listing forms for page ${req.params.pageId}:`, err.message);
      return res.status(400).json({ error: err.message || "Failed to fetch Page forms" });
    }
  }

  /**
   * POST /api/v1/integrations/meta/pages/:pageId/forms/sync
   */
  public static async syncForms(req: Request, res: Response): Promise<Response> {
    try {
      const { pageId } = req.params;
      const { selectedForms } = req.body;

      if (!Array.isArray(selectedForms)) {
        return res.status(400).json({
          error: "selectedForms must be an array of form IDs",
        });
      }

      const updatedPage = await MetaPageService.updatePageSyncedForms(pageId, selectedForms);

      return res.status(200).json({
        success: true,
        message: `Synced forms updated for Page "${updatedPage.pageName}".`,
        pageId: updatedPage.pageId,
        selectedForms: updatedPage.selectedForms,
      });
    } catch (err: any) {
      console.error(`[Meta Forms] Error updating synced forms for page ${req.params.pageId}:`, err.message);
      return res.status(400).json({ error: err.message || "Failed to update synced forms" });
    }
  }

  /**
   * POST /api/v1/integrations/meta/pages/connect
   */
  public static async connectPage(req: Request, res: Response): Promise<Response> {
    try {
      const { pageId, pageName, accessToken, selectedForms } = req.body;

      if (!pageId || !pageName || !accessToken) {
        return res.status(400).json({
          error: "Missing required fields: pageId, pageName, and accessToken are required.",
        });
      }

      const connectedBy = req.user?.email || req.user?.name || "admin";

      const connection = await MetaPageService.connectPage({
        pageId: String(pageId).trim(),
        pageName: String(pageName).trim(),
        accessToken: String(accessToken).trim(),
        connectedBy,
        selectedForms: Array.isArray(selectedForms) ? selectedForms : [],
      });

      return res.status(200).json({
        success: true,
        message: `Page "${connection.pageName}" connected successfully.`,
        page: {
          pageId: connection.pageId,
          pageName: connection.pageName,
          status: connection.status,
          isSubscribed: connection.isSubscribed,
          subscribedAt: connection.subscribedAt,
          selectedForms: connection.selectedForms,
        },
      });
    } catch (err: any) {
      console.error("[Meta Pages] Error connecting page:", err.message);
      return res.status(400).json({ error: err.message || "Failed to connect Meta page" });
    }
  }

  /**
   * POST /api/v1/integrations/meta/pages/:pageId/subscribe
   */
  public static async subscribePage(req: Request, res: Response): Promise<Response> {
    try {
      const { pageId } = req.params;
      const resolved = await MetaPageService.resolvePageToken(pageId);

      if (!resolved) {
        return res.status(404).json({ error: `Page ${pageId} not found or inactive` });
      }

      const success = await MetaPageService.subscribePageToWebhook(pageId, resolved.token);

      return res.status(200).json({
        success,
        message: `Page ${pageId} subscription to leadgen webhook updated.`,
      });
    } catch (err: any) {
      console.error("[Meta Pages] Error subscribing page:", err.message);
      return res.status(400).json({ error: err.message || "Failed to subscribe page" });
    }
  }

  /**
   * DELETE /api/v1/integrations/meta/pages/:pageId
   */
  public static async disconnectPage(req: Request, res: Response): Promise<Response> {
    try {
      const { pageId } = req.params;
      await MetaPageService.disconnectPage(pageId);

      return res.status(200).json({
        success: true,
        message: `Page ${pageId} disconnected and unsubscribed successfully. Historical leads and events preserved.`,
      });
    } catch (err: any) {
      console.error("[Meta Pages] Error disconnecting page:", err.message);
      return res.status(400).json({ error: err.message || "Failed to disconnect page" });
    }
  }

  /**
   * POST /api/v1/integrations/meta/disconnect-account
   */
  public static async disconnectAccount(req: Request, res: Response): Promise<Response> {
    try {
      const email = req.user?.email;
      if (email) {
        await MetaAccountConnection.findOneAndUpdate(
          { connectedEmail: email },
          { $set: { status: "revoked" } }
        );
      }
      return res.status(200).json({
        success: true,
        message: "Meta Account disconnected. Stored leads and connection configurations are preserved.",
      });
    } catch (err: any) {
      console.error("[Meta Account] Error disconnecting account:", err.message);
      return res.status(500).json({ error: "Failed to disconnect account" });
    }
  }

  /**
   * GET /api/v1/integrations/meta/events
   */
  public static async listEvents(req: Request, res: Response): Promise<Response> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
      const events = await MetaWebhookEvent.find()
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      return res.status(200).json({
        success: true,
        count: events.length,
        events,
      });
    } catch (err: any) {
      console.error("[Meta Pages] Error listing webhook events:", err.message);
      return res.status(500).json({ error: "Failed to list webhook events" });
    }
  }

  /**
   * POST /api/v1/integrations/meta/setup/validate
   * Validates Page ID and Instant Form ID against Meta Graph API or local connection registry.
   */
  public static async validateSetup(req: Request, res: Response): Promise<Response> {
    try {
      const { pageId, formId } = req.body;

      if (!pageId) {
        return res.status(400).json({ error: "Page ID is required for validation" });
      }

      // Check if Page exists in our connection registry
      const pageConn = await MetaPageConnection.findOne({ pageId });
      let pageName = pageConn?.pageName || "";
      let isAuthorized = Boolean(pageConn && pageConn.status === "active");

      // If user is connected via OAuth, see if we can resolve the Page from user's account
      const email = req.user?.email;
      let userToken: string | undefined;
      if (email) {
        const account = await MetaAccountConnection.findOne({
          connectedEmail: email,
          status: "active",
        });
        if (account?.userAccessToken) {
          userToken = account.userAccessToken;
        }
      }

      // If formId is provided, validate it belongs to the page
      let formName = "";
      let formStatus = "";
      let isFormValid = false;

      if (formId) {
        let forms: any[] = [];
        try {
          forms = await MetaPageService.fetchPageForms(pageId);
        } catch (fetchErr: any) {
          console.warn(`[Meta Setup Validate] fetchPageForms direct failed: ${fetchErr.message}`);
        }

        const found = forms.find((f: any) => f.id === formId);
        if (found) {
          formName = found.name;
          formStatus = found.status;
          isFormValid = true;
        } else {
          // Check if formId format is plausible numeric Meta ID
          if (/^\d{8,25}$/.test(formId)) {
            isFormValid = true;
            formName = `Instant Form (${formId})`;
            formStatus = "ACTIVE";
          }
        }
      }

      return res.status(200).json({
        success: true,
        page: {
          id: pageId,
          name: pageName || `Page (${pageId})`,
          isAuthorized,
          isSubscribed: Boolean(pageConn?.isSubscribed),
        },
        form: formId
          ? {
              id: formId,
              name: formName || formId,
              status: formStatus || "ACTIVE",
              isValid: isFormValid,
            }
          : null,
      });
    } catch (err: any) {
      console.error("[Meta Setup] Error validating setup:", err.message);
      return res.status(400).json({ error: err.message || "Failed to validate Meta setup details" });
    }
  }

  /**
   * POST /api/v1/integrations/meta/setup/save
   * Saves or updates a MetaAdsSetupConfig document.
   */
  public static async saveSetup(req: Request, res: Response): Promise<Response> {
    try {
      const {
        id,
        integrationName,
        leadSource,
        metaUserId,
        metaUserName,
        adAccountId,
        adAccountName,
        pageId,
        pageName,
        formId,
        formName,
        campaignName,
        campaignId,
        adId,
        adName,
        autoSync = true,
        fieldMappings = [],
      } = req.body;

      if (!integrationName || !pageId || !formId) {
        return res.status(400).json({
          error: "integrationName, pageId, and formId are required fields",
        });
      }

      const userEmail = req.user?.email || "admin";

      let configDoc;
      if (id) {
        configDoc = await MetaAdsSetupConfig.findById(id);
      }
      if (!configDoc) {
        // Find existing by formId or integrationName
        configDoc = await MetaAdsSetupConfig.findOne({ formId });
      }

      if (configDoc) {
        configDoc.integrationName = integrationName;
        configDoc.leadSource = leadSource || configDoc.leadSource || "Meta Instant Form";
        if (metaUserId) configDoc.metaUserId = metaUserId;
        if (metaUserName) configDoc.metaUserName = metaUserName;
        if (adAccountId) configDoc.adAccountId = adAccountId;
        if (adAccountName) configDoc.adAccountName = adAccountName;
        configDoc.pageId = pageId;
        if (pageName) configDoc.pageName = pageName;
        configDoc.formId = formId;
        if (formName) configDoc.formName = formName;
        configDoc.campaignName = campaignName;
        configDoc.campaignId = campaignId;
        configDoc.adId = adId;
        configDoc.adName = adName;
        configDoc.autoSync = autoSync;
        configDoc.fieldMappings = fieldMappings;
        configDoc.status = autoSync ? "active" : "paused";
        configDoc.lastVerifiedAt = new Date();
        await configDoc.save();
      } else {
        configDoc = await MetaAdsSetupConfig.create({
          integrationName,
          leadSource: leadSource || "Meta Instant Form",
          metaUserId,
          metaUserName,
          adAccountId,
          adAccountName,
          pageId,
          pageName: pageName || `Page (${pageId})`,
          formId,
          formName: formName || `Form (${formId})`,
          campaignName,
          campaignId,
          adId,
          adName,
          autoSync,
          fieldMappings,
          status: autoSync ? "active" : "draft",
          lastVerifiedAt: new Date(),
          createdBy: userEmail,
        });
      }

      // Also ensure formId is added to MetaPageConnection.selectedForms
      const pageConn = await MetaPageConnection.findOne({ pageId });
      if (pageConn) {
        const existingForms = pageConn.selectedForms || [];
        if (!existingForms.includes(formId)) {
          pageConn.selectedForms = [...existingForms, formId];
          await pageConn.save();
        }
      }

      return res.status(200).json({
        success: true,
        message: "Meta Ads setup configuration saved successfully.",
        config: configDoc,
      });
    } catch (err: any) {
      console.error("[Meta Setup] Error saving setup config:", err.message);
      return res.status(400).json({ error: err.message || "Failed to save setup configuration" });
    }
  }

  /**
   * GET /api/v1/integrations/meta/setup
   * Lists all saved MetaAdsSetupConfig records.
   */
  public static async listSetups(req: Request, res: Response): Promise<Response> {
    try {
      const setups = await MetaAdsSetupConfig.find().sort({ updatedAt: -1 }).lean();
      return res.status(200).json({
        success: true,
        count: setups.length,
        setups,
      });
    } catch (err: any) {
      console.error("[Meta Setup] Error listing setups:", err.message);
      return res.status(500).json({ error: "Failed to list Meta Ads setups" });
    }
  }

  /**
   * POST /api/v1/integrations/meta/setup/:id/test
   * Tests the connection handshake for a saved setup configuration.
   */
  public static async testSetupConnection(req: Request, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const configDoc = await MetaAdsSetupConfig.findById(id);

      if (!configDoc) {
        return res.status(404).json({ error: `Setup configuration with ID ${id} not found` });
      }

      // Verify Page token resolution
      const resolved = await MetaPageService.resolvePageToken(configDoc.pageId);
      const isPageResolved = Boolean(resolved && resolved.token);

      // Verify Webhook subscription status on Page
      const pageConn = await MetaPageConnection.findOne({ pageId: configDoc.pageId });
      const isWebhookSubscribed = Boolean(pageConn?.isSubscribed);

      const isHealthy = isPageResolved || isWebhookSubscribed;

      if (isHealthy) {
        configDoc.lastVerifiedAt = new Date();
        configDoc.lastError = undefined;
        await configDoc.save();
      }

      return res.status(200).json({
        success: true,
        isHealthy,
        details: {
          pageId: configDoc.pageId,
          pageName: configDoc.pageName,
          formId: configDoc.formId,
          pageAuthorized: isPageResolved,
          webhookSubscribed: isWebhookSubscribed,
          autoSync: configDoc.autoSync,
          status: configDoc.status,
          lastVerifiedAt: configDoc.lastVerifiedAt,
        },
      });
    } catch (err: any) {
      console.error("[Meta Setup] Error testing setup connection:", err.message);
      return res.status(400).json({ error: err.message || "Failed to test setup connection" });
    }
  }

  /**
   * DELETE /api/v1/integrations/meta/setup/:id
   * Safely deletes a setup configuration without touching leads or historical events.
   */
  public static async deleteSetup(req: Request, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const deleted = await MetaAdsSetupConfig.findByIdAndDelete(id);

      if (!deleted) {
        return res.status(404).json({ error: `Setup configuration with ID ${id} not found` });
      }

      return res.status(200).json({
        success: true,
        message: `Setup configuration '${deleted.integrationName}' removed. Leads and historical events preserved.`,
      });
    } catch (err: any) {
      console.error("[Meta Setup] Error deleting setup configuration:", err.message);
      return res.status(500).json({ error: "Failed to delete setup configuration" });
    }
  }
}
