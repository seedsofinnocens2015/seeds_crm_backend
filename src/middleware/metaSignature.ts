import crypto from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { config } from "../config/env.js";

/**
 * Middleware to verify Meta's X-Hub-Signature-256 header.
 * Meta hashes the raw request body with your App Secret using HMAC SHA-256.
 *
 * Rules:
 * 1. If META_APP_SECRET is configured, enforce strict verification.
 * 2. If META_APP_SECRET is empty (in minimal dev test mode), warn and permit or skip depending on config.
 * 3. Use crypto.timingSafeEqual to prevent timing attacks.
 */
export function verifyMetaSignature(
  req: Request,
  res: Response,
  next: NextFunction
): Response | void {
  const appSecret = config.metaAppSecret || process.env.META_APP_SECRET;

  // In production or when app secret is set, signature header is strictly mandatory
  if (!appSecret) {
    if (config.nodeEnv === "production") {
      console.error("[Meta Security] META_APP_SECRET is not configured in production!");
      return res.status(500).json({ error: "Server misconfiguration: missing app secret" });
    }
    // In local dev without secret configured yet, warn and proceed
    console.warn(
      "[Meta Security] META_APP_SECRET is not set. Skipping signature verification in dev mode."
    );
    return next();
  }

  const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;

  if (!signatureHeader) {
    console.warn("[Meta Security] Request missing X-Hub-Signature-256 header.");
    return res.status(401).json({ error: "Missing X-Hub-Signature-256 header" });
  }

  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    console.error("[Meta Security] Raw body buffer not available for signature verification.");
    return res.status(500).json({ error: "Unable to verify request signature" });
  }

  try {
    const signatureHash = signatureHeader.startsWith("sha256=")
      ? signatureHeader.slice(7)
      : signatureHeader;

    const expectedHash = crypto
      .createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex");

    const sigBuffer = Buffer.from(signatureHash, "hex");
    const expectedBuffer = Buffer.from(expectedHash, "hex");

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      console.warn("[Meta Security] Invalid X-Hub-Signature-256 signature mismatch.");
      return res.status(403).json({ error: "Invalid request signature" });
    }

    return next();
  } catch (err: any) {
    console.error("[Meta Security] Error computing signature verification:", err.message);
    return res.status(403).json({ error: "Signature verification failed" });
  }
}
