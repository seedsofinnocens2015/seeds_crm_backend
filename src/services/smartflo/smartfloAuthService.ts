import { config } from "../../config/env.js";

interface TokenCache {
  accessToken: string;
  expiresAt: number; // Timestamp in milliseconds
}

// In-memory token cache: never written to DB, logs, or disk
let tokenCache: TokenCache | null = null;
let activeAuthPromise: Promise<string> | null = null;

// Refresh 5 minutes (300,000 ms) before expiry where possible
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Obtains a valid Smartflo Bearer access token using configured server credentials.
 * Automatically handles in-memory caching, expiration checking with a 5-minute pre-expiry buffer,
 * and concurrent request synchronization (preventing dogpiling/multiple simultaneous logins).
 */
export async function getSmartfloAccessToken(fetchFn: typeof fetch = fetch): Promise<string> {
  const loginId = config.smartfloLoginId.trim();
  const password = config.smartfloPassword.trim();

  if (!loginId || !password) {
    throw new Error(
      "Smartflo authentication credentials not configured. Please set SMARTFLO_LOGIN_ID and SMARTFLO_PASSWORD."
    );
  }

  const now = Date.now();

  // If cached token is present and valid past the 5-minute buffer, reuse it
  if (tokenCache && tokenCache.expiresAt > now + EXPIRY_BUFFER_MS) {
    return tokenCache.accessToken;
  }

  // If a login request is already in-flight, return the existing promise to avoid concurrent logins
  if (activeAuthPromise) {
    return activeAuthPromise;
  }

  activeAuthPromise = (async () => {
    try {
      const loginUrl = `${config.smartfloApiBaseUrl.replace(/\/+$/, "")}/auth/login`;

      const response = await fetchFn(loginUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          email: loginId,
          password: password,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Smartflo login failed with HTTP status ${response.status}: ${errorText.slice(0, 150)}`
        );
      }

      const data = (await response.json()) as {
        success?: boolean;
        access_token?: string;
        token_type?: string;
        expires_in?: number;
        message?: string;
        [key: string]: any;
      };

      const accessToken = data.access_token;
      if (!accessToken || typeof accessToken !== "string") {
        throw new Error("Smartflo login response did not contain a valid access_token.");
      }

      // Default to 3600 seconds (1 hour) if expires_in is omitted or invalid
      const expiresInSec = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
      const expiresAt = Date.now() + expiresInSec * 1000;

      tokenCache = {
        accessToken,
        expiresAt,
      };

      return accessToken;
    } finally {
      activeAuthPromise = null;
    }
  })();

  return activeAuthPromise;
}

/**
 * Invalidates the cached token (e.g. upon receiving an HTTP 401 Unauthorized from Smartflo).
 * Does not throw and does not log credentials or token data.
 */
export function invalidateSmartfloAccessToken(): void {
  tokenCache = null;
  activeAuthPromise = null;
}

/**
 * Helper to inspect cache state in unit tests without revealing token contents.
 */
export function getSmartfloTokenCacheStatus(): { hasToken: boolean; isExpired: boolean; expiresInSec: number } {
  if (!tokenCache) {
    return { hasToken: false, isExpired: true, expiresInSec: 0 };
  }
  const remainingMs = tokenCache.expiresAt - Date.now();
  return {
    hasToken: true,
    isExpired: remainingMs <= EXPIRY_BUFFER_MS,
    expiresInSec: Math.max(0, Math.floor(remainingMs / 1000)),
  };
}

/**
 * Helper for test isolation to directly prime or clear token cache.
 */
export function _setMockTokenCache(cache: TokenCache | null): void {
  tokenCache = cache;
  activeAuthPromise = null;
}
