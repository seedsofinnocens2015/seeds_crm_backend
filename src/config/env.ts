import dotenv from "dotenv";
import path from "path";

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
}

function getEnvNumber(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export const config: AppConfig = {
  port: getEnvNumber("PORT", 5000),
  nodeEnv: (process.env.NODE_ENV as "development" | "production" | "test") || "development",
  mongodbUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/seeds_crm_dev",
  jwtSecret: process.env.JWT_SECRET || "seeds_crm_dev_fallback_secret",
  corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:3000,https://seedscrm.seedsofinnocens.com")
    .split(",")
    .map((origin) => origin.trim()),
  metaAppId: process.env.META_APP_ID || "",
  metaAppSecret: process.env.META_APP_SECRET || "",
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || "",
  metaOAuthRedirectUri:
    process.env.META_OAUTH_REDIRECT_URI || "https://seedscrm.seedsofinnocens.com/admin/integrations/meta/callback",
  metaPageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || "",
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION || "v21.0",
};
