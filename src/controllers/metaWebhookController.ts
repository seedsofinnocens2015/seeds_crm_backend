import { Request, Response } from "express";
import { config } from "../config/env.js";
import { ingestMetaLead } from "../services/metaLeadService.js";
import { MetaWebhookEvent } from "../models/MetaWebhookEvent.js";

/**
 * GET /api/v1/integrations/meta/webhook
 * Meta Webhook verification handshake handler.
 */
export function verifyMetaWebhook(req: Request, res: Response): Response {
  const mode = req.query["hub.mode"] as string | undefined;
  const token = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"] as string | undefined;

  const expectedToken = config.metaWebhookVerifyToken || process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (!expectedToken) {
    console.warn("[Meta Webhook] Verification attempted but META_WEBHOOK_VERIFY_TOKEN is not configured.");
    return res.status(403).json({ error: "Webhook verification token is not configured on server" });
  }

  if (mode === "subscribe" && token && token === expectedToken && challenge !== undefined) {
    console.info("[Meta Webhook] Verification successful.");
    return res.status(200).send(challenge);
  }

  console.warn("[Meta Webhook] Verification failed. Mode or verify_token mismatch.");
  return res.status(403).json({ error: "Forbidden: verification failed" });
}

/**
 * POST /api/v1/integrations/meta/webhook
 * Meta Webhook notification event receiver.
 * Accepts events, logs non-sensitive metadata, records events in MetaWebhookEvent for durability,
 * returns 200 OK immediately to Meta, and asynchronously processes ingestion.
 */
export async function handleMetaWebhookEvent(req: Request, res: Response): Promise<Response> {
  const body = req.body;

  if (!body || typeof body !== "object") {
    console.warn("[Meta Webhook] Received malformed or non-object webhook body.");
    return res.status(400).json({ error: "Invalid webhook payload structure" });
  }

  const objectType = typeof body.object === "string" ? body.object : undefined;
  const entries = Array.isArray(body.entry) ? body.entry : [];

  console.info("[Meta Webhook] Received notification event", {
    objectType: objectType || "unknown",
    entryCount: entries.length,
    timestamp: new Date().toISOString(),
  });

  const leadgenItems: { leadgenId: string; pageId: string; formId?: string; adId?: string }[] = [];

  for (const entry of entries) {
    const entryPageId = typeof entry?.id === "string" ? entry.id : undefined;
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      if (change?.field === "leadgen") {
        const leadgenId = change?.value?.leadgen_id;
        const formId = change?.value?.form_id;
        const adId = change?.value?.ad_id;
        const pageId = change?.value?.page_id || entryPageId;

        if (typeof leadgenId === "string" && leadgenId.trim().length > 0 && pageId) {
          leadgenItems.push({
            leadgenId: leadgenId.trim(),
            pageId: pageId.trim(),
            formId: typeof formId === "string" ? formId : undefined,
            adId: typeof adId === "string" ? adId : undefined,
          });
        }
      }
    }
  }

  // Pre-record incoming events into MetaWebhookEvent collection for guaranteed audit & queueing
  for (const item of leadgenItems) {
    try {
      await MetaWebhookEvent.findOneAndUpdate(
        { leadgenId: item.leadgenId },
        {
          $setOnInsert: {
            leadgenId: item.leadgenId,
            pageId: item.pageId,
            formId: item.formId || "",
            adId: item.adId || "",
            status: "pending",
            retryCount: 0,
            rawPayloadSummary: {
              objectType: objectType || "page",
              field: "leadgen",
              timestamp: new Date().toISOString(),
            },
          },
        },
        { upsert: true, new: true }
      );
    } catch (saveErr: any) {
      console.warn(`[Meta Webhook] Warning pre-recording event ${item.leadgenId}:`, saveErr.message);
    }
  }

  // Meta expects prompt 200 OK
  res.status(200).send("EVENT_RECEIVED");

  // Asynchronously trigger ingestion
  if (leadgenItems.length > 0) {
    (async () => {
      for (const item of leadgenItems) {
        try {
          console.info(
            `[Meta Webhook] Processing lead ingestion for leadgen_id: ${item.leadgenId} from Page: ${item.pageId}`
          );
          const result = await ingestMetaLead(item.leadgenId, { pageId: item.pageId });
          console.info(`[Meta Webhook] Ingestion outcome for ${item.leadgenId}:`, {
            status: result.status,
            crmUniqueId: result.uniqueId,
          });
        } catch (procErr: any) {
          console.error(
            `[Meta Webhook] Unhandled error during async ingestion for ${item.leadgenId}:`,
            procErr.message
          );
        }
      }
    })().catch((err) => {
      console.error("[Meta Webhook] Fatal error in async lead processing loop:", err.message);
    });
  }

  return res;
}
