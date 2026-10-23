import crypto from "node:crypto";
import { config } from "../config/env.js";

export interface OAuthStatePayload {
  userId: string;
  userEmail: string;
  userRole: string;
  nonce: string;
  timestamp: number;
}

/**
 * Creates a signed, tamper-proof state parameter with a 10-minute expiry.
 * Format: base64Url(payload) + "." + hmacSignature
 */
export function generateOAuthState(user: { id: string; email: string; role: string }): string {
  const payload: OAuthStatePayload = {
    userId: user.id,
    userEmail: user.email,
    userRole: user.role,
    nonce: crypto.randomBytes(16).toString("hex"),
    timestamp: Date.now(),
  };

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", config.jwtSecret)
    .update(payloadStr)
    .digest("base64url");

  return `${payloadStr}.${signature}`;
}

/**
 * Validates the state parameter signature and checks for expiration (10 min).
 * Returns decoded payload on success; throws error on invalid/expired state.
 */
export function verifyOAuthState(stateStr: string): OAuthStatePayload {
  if (!stateStr || typeof stateStr !== "string") {
    throw new Error("Missing or invalid state parameter");
  }

  const parts = stateStr.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed OAuth state token");
  }

  const [payloadStr, signature] = parts;
  const expectedSignature = crypto
    .createHmac("sha256", config.jwtSecret)
    .update(payloadStr)
    .digest("base64url");

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error("Invalid OAuth state signature (potential CSRF tampering)");
  }

  const payloadJson = Buffer.from(payloadStr, "base64url").toString("utf8");
  const payload = JSON.parse(payloadJson) as OAuthStatePayload;

  // Enforce 10-minute expiration window
  const MAX_AGE_MS = 10 * 60 * 1000;
  if (Date.now() - payload.timestamp > MAX_AGE_MS) {
    throw new Error("OAuth state has expired. Please initiate Facebook Login again.");
  }

  return payload;
}
