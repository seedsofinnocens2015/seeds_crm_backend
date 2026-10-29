import dotenv from "dotenv";

// Load .env from backend directory
dotenv.config();

export interface AppConfig {
  port: number;
  nodeEnv: "development" | "production" | "test";
  mongodbUri: string;
  jwtSecret: string;
  corsOrigin: string[];
  metaAppId: string;
  metaAppSecret: string;
  metaWebhookVerifyToken: string;
  metaOAuthRedirectUri: string;
  metaPageAccessToken: string;
  metaGraphApiVersion: string;
  smartfloApiBaseUrl: string;
  smartfloLoginId: string;
  smartfloPassword: string;
  smartfloSyncType: "contact" | "broadcast";
  smartfloContactGroupId: string;
  smartfloBroadcastListId: string;
  smartfloLeadListId: string;
  smartfloSyncEnabled: boolean;
  smartfloWebhookSecret: string;
  smartfloApiKey: string; // Key for Smartflo custom connector to query CRM read endpoints
  smartfloCallerId: string; // Account-approved outbound Caller ID / Pilot DID for Click-to-Call
}

function getEnvNumber(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function getSyncType(val: string | undefined): "contact" | "broadcast" {
  const clean = (val || "").trim().toLowerCase();
  return clean === "broadcast" ? "broadcast" : "contact";
}

export const config: AppConfig = {
  port: getEnvNumber("PORT", 5000),
  nodeEnv: (process.env.NODE_ENV as "development" | "production" | "test") || "development",
  mongodbUri: process.env.MONGODB_URI || "0",
  jwtSecret: process.env.JWT_SECRET || "0",
  corsOrigin: (process.env.CORS_ORIGIN || "0")
    .split(",")
    .map((origin) => origin.trim()),
  metaAppId: process.env.META_APP_ID || "",
  metaAppSecret: process.env.META_APP_SECRET || "",
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || "",
  metaOAuthRedirectUri:
    process.env.META_OAUTH_REDIRECT_URI || "0",
  metaPageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || "",
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION || "v21.0",
  smartfloApiBaseUrl:
    process.env.SMARTFLO_API_BASE_URL || "0",
  smartfloLoginId: process.env.SMARTFLO_LOGIN_ID || "",
  smartfloPassword: process.env.SMARTFLO_PASSWORD || "",
  smartfloSyncType: getSyncType(process.env.SMARTFLO_SYNC_TYPE),
  smartfloContactGroupId: process.env.SMARTFLO_CONTACT_GROUP_ID || "",
  smartfloBroadcastListId: process.env.SMARTFLO_BROADCAST_LIST_ID || process.env.SMARTFLO_LEAD_LIST_ID || "",
  smartfloLeadListId:
    process.env.SMARTFLO_BROADCAST_LIST_ID ||
    process.env.SMARTFLO_LEAD_LIST_ID ||
    process.env.SMARTFLO_CONTACT_GROUP_ID ||
    "",
  smartfloSyncEnabled: process.env.SMARTFLO_SYNC_ENABLED === "0",
  smartfloWebhookSecret: process.env.SMARTFLO_WEBHOOK_SECRET || "",
  smartfloApiKey: process.env.SMARTFLO_API_KEY || "",
  smartfloCallerId: process.env.SMARTFLO_CALLER_ID || "",
};
