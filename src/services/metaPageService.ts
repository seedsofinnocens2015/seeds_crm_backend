import { config } from "../config/env.js";
import { MetaPageConnection, IMetaPageConnection } from "../models/MetaPageConnection.js";
import { MetaAccountConnection, IMetaAccountConnection } from "../models/MetaAccountConnection.js";

export interface MetaPageInfo {
  id: string;
  name: string;
  access_token?: string;
  tasks?: string[];
}

export interface MetaInstantForm {
  id: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED" | "DELETED" | string;
  leadgen_export_csv_url?: string;
  leads_count?: number;
  created_time?: string;
}

export interface MetaAdAccount {
  id: string;
  name: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
}

export interface MetaCampaign {
  id: string;
  name: string;
  status: string;
  objective?: string;
  created_time?: string;
}

export interface MetaAd {
  id: string;
  name: string;
  status: string;
  campaign_id?: string;
  adset_id?: string;
}

export interface MetaOAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

/**
 * Service to manage Meta Pages, Ad Accounts, Campaigns, OAuth exchanges,
 * Leadgen Webhook subscriptions, and Form Discovery.
 */
export class MetaPageService {
  public static async graphApiRequest(
    endpoint: string,
    options: RequestInit = {},
    fetchFn: typeof fetch = fetch
  ): Promise<any> {
    const version = config.metaGraphApiVersion || "v21.0";
    const cleanEndpoint = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
    const url = `https://graph.facebook.com/${version}/${cleanEndpoint}`;

    const res = await fetchFn(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });

    const bodyText = await res.text();
    let data: any;
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = { raw: bodyText };
    }

    if (!res.ok) {
      const errMsg = data?.error?.message || `HTTP ${res.status} ${res.statusText}`;
      const errType = data?.error?.type || "GraphApiError";
      const errCode = data?.error?.code ? ` (code ${data.error.code})` : "";
      throw new Error(`Meta Graph API [${errType}]${errCode}: ${errMsg}`);
    }

    return data;
  }

  /**
   * Generates Facebook OAuth Login Dialog URL with Marketing API & Leadgen scopes.
   */
  public static getOAuthDialogUrl(state: string): string {
    const appId = config.metaAppId;
    if (!appId) {
      throw new Error("META_APP_ID is not configured in server environment.");
    }

    const redirectUri = config.metaOAuthRedirectUri;
    const version = config.metaGraphApiVersion || "v21.0";

    // Required scopes: Lead Ads + Page Management + Marketing API Ad discovery
    const scopes = [
      "leads_retrieval",
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_metadata",
      "ads_read",
    ].join(",");

    return `https://www.facebook.com/${version}/dialog/oauth?client_id=${encodeURIComponent(
      appId
    )}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(
      state
    )}&scope=${encodeURIComponent(scopes)}&response_type=code`;
  }

  public static async exchangeCodeForUserToken(
    code: string,
    fetchFn: typeof fetch = fetch
  ): Promise<MetaOAuthTokenResponse> {
    const appId = config.metaAppId;
    const appSecret = config.metaAppSecret;
    const redirectUri = config.metaOAuthRedirectUri;

    if (!appId || !appSecret) {
      throw new Error("META_APP_ID or META_APP_SECRET is not configured.");
    }

    const endpoint = `oauth/access_token?client_id=${encodeURIComponent(
      appId
    )}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${encodeURIComponent(
      appSecret
    )}&code=${encodeURIComponent(code)}`;

    return await this.graphApiRequest(endpoint, { method: "GET" }, fetchFn);
  }

  public static async exchangeForLongLivedToken(
    shortLivedToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<MetaOAuthTokenResponse> {
    const appId = config.metaAppId;
    const appSecret = config.metaAppSecret;

    const endpoint = `oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(
      appId
    )}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(
      shortLivedToken
    )}`;

    return await this.graphApiRequest(endpoint, { method: "GET" }, fetchFn);
  }

  /**
   * Fetches the identity of the authenticated Meta user.
   */
  public static async fetchUserProfile(
    userAccessToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<{ id: string; name: string }> {
    const endpoint = `me?fields=id,name&access_token=${encodeURIComponent(userAccessToken)}`;
    return await this.graphApiRequest(endpoint, { method: "GET" }, fetchFn);
  }

  /**
   * Fetches accessible Meta Ad Accounts for the user.
   * Calls: GET /me/adaccounts?fields=id,name,currency,timezone_name,account_status
   */
  public static async fetchUserAdAccounts(
    userAccessToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<MetaAdAccount[]> {
    const endpoint = `me/adaccounts?fields=id,name,currency,timezone_name,account_status&access_token=${encodeURIComponent(
      userAccessToken
    )}`;

    try {
      const data = await this.graphApiRequest(endpoint, { method: "GET" }, fetchFn);
      return Array.isArray(data?.data) ? data.data : [];
    } catch (err: any) {
      console.warn("[Meta Page Service] fetchUserAdAccounts warning:", err.message);
      return [];
    }
  }

  /**
   * Fetches campaigns for an ad account (e.g. act_12345/campaigns).
   */
  public static async fetchAdAccountCampaigns(
    adAccountId: string,
    userAccessToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<MetaCampaign[]> {
    const cleanId = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
    const endpoint = `${cleanId}/campaigns?fields=id,name,status,objective,created_time&access_token=${encodeURIComponent(
      userAccessToken
    )}`;

    try {
      const data = await this.graphApiRequest(endpoint, { method: "GET" }, fetchFn);
      return Array.isArray(data?.data) ? data.data : [];
    } catch (err: any) {
      console.warn(`[Meta Page Service] fetchAdAccountCampaigns warning for ${adAccountId}:`, err.message);
      return [];
    }
  }

  /**
   * Fetches ads for a campaign or ad account.
   */
  public static async fetchCampaignAds(
    campaignId: string,
    userAccessToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<MetaAd[]> {
    const endpoint = `${campaignId}/ads?fields=id,name,status,campaign_id,adset_id&access_token=${encodeURIComponent(
      userAccessToken
    )}`;

    try {
      const data = await this.graphApiRequest(endpoint, { method: "GET" }, fetchFn);
      return Array.isArray(data?.data) ? data.data : [];
    } catch (err: any) {
      console.warn(`[Meta Page Service] fetchCampaignAds warning for ${campaignId}:`, err.message);
      return [];
    }
  }

  public static async fetchUserPages(
    userAccessToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<MetaPageInfo[]> {
    const endpoint = `me/accounts?fields=id,name,access_token,tasks&access_token=${encodeURIComponent(
      userAccessToken
    )}`;

    const data = await this.graphApiRequest(endpoint, { method: "GET" }, fetchFn);
    return Array.isArray(data?.data) ? data.data : [];
  }

  public static async fetchPageForms(
    pageId: string,
    customPageToken?: string,
    fetchFn: typeof fetch = fetch
  ): Promise<MetaInstantForm[]> {
    const pageToken =
      customPageToken || (await this.resolvePageToken(pageId))?.token;

    if (!pageToken) {
      throw new Error(`Cannot fetch forms: no access token found for Page ${pageId}`);
    }

    const endpoint = `${pageId}/leadgen_forms?fields=id,name,status,created_time,leads_count&access_token=${encodeURIComponent(
      pageToken
    )}`;

    const data = await this.graphApiRequest(endpoint, { method: "GET" }, fetchFn);
    return Array.isArray(data?.data) ? data.data : [];
  }

  public static async subscribePageToWebhook(
    pageId: string,
    pageAccessToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<boolean> {
    if (!pageId || !pageAccessToken) {
      throw new Error("pageId and pageAccessToken are required to subscribe to webhooks");
    }

    const endpoint = `${pageId}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(
      pageAccessToken
    )}`;

    const res = await this.graphApiRequest(endpoint, { method: "POST" }, fetchFn);
    return Boolean(res?.success);
  }

  public static async unsubscribePageFromWebhook(
    pageId: string,
    pageAccessToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<boolean> {
    if (!pageId || !pageAccessToken) {
      throw new Error("pageId and pageAccessToken are required to unsubscribe");
    }

    const endpoint = `${pageId}/subscribed_apps?access_token=${encodeURIComponent(
      pageAccessToken
    )}`;

    const res = await this.graphApiRequest(endpoint, { method: "DELETE" }, fetchFn);
    return Boolean(res?.success);
  }

  public static async resolvePageToken(
    pageId: string
  ): Promise<{ token: string; pageName: string } | null> {
    if (!pageId) return null;

    const registered = await MetaPageConnection.findOne({
      pageId: pageId.trim(),
      status: "active",
    });

    if (registered && registered.accessToken) {
      return {
        token: registered.accessToken,
        pageName: registered.pageName,
      };
    }

    if (config.metaPageAccessToken) {
      return {
        token: config.metaPageAccessToken,
        pageName: "Default Configured Page",
      };
    }

    return null;
  }

  public static async listConnectedPages(): Promise<any[]> {
    return MetaPageConnection.find()
      .select("-accessToken")
      .sort({ createdAt: -1 })
      .lean();
  }

  public static async connectPage(
    params: {
      pageId: string;
      pageName: string;
      accessToken: string;
      connectedBy?: string;
      selectedForms?: string[];
      metadata?: Record<string, any>;
    },
    fetchFn: typeof fetch = fetch
  ): Promise<IMetaPageConnection> {
    const { pageId, pageName, accessToken, connectedBy, selectedForms, metadata } = params;

    if (!pageId || !pageName || !accessToken) {
      throw new Error("pageId, pageName, and accessToken are mandatory to connect a Page");
    }

    let isSubscribed = false;
    try {
      isSubscribed = await this.subscribePageToWebhook(pageId, accessToken, fetchFn);
      console.info(`[Meta Page Service] Successfully subscribed Page ${pageName} (${pageId}) to leadgen webhook.`);
    } catch (err: any) {
      console.warn(
        `[Meta Page Service] Webhook subscription failed during connection for Page ${pageId}: ${err.message}. Saving page in inactive state.`
      );
    }

    const updateDoc: any = {
      pageName,
      accessToken,
      status: "active",
      isSubscribed,
      connectedBy: connectedBy || "admin",
    };

    if (isSubscribed) {
      updateDoc.subscribedAt = new Date();
    }
    if (selectedForms !== undefined) {
      updateDoc.selectedForms = selectedForms;
    }
    if (metadata) {
      updateDoc.metadata = metadata;
    }

    const connection = await MetaPageConnection.findOneAndUpdate(
      { pageId },
      { $set: updateDoc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return connection;
  }

  public static async disconnectPage(
    pageId: string,
    fetchFn: typeof fetch = fetch
  ): Promise<boolean> {
    const existing = await MetaPageConnection.findOne({ pageId });
    if (!existing) {
      throw new Error(`Page with ID ${pageId} not found in connection registry`);
    }

    try {
      if (existing.accessToken) {
        await this.unsubscribePageFromWebhook(pageId, existing.accessToken, fetchFn);
      }
    } catch (err: any) {
      console.warn(`[Meta Page Service] Could not unsubscribe page from Meta during disconnect: ${err.message}`);
    }

    existing.status = "inactive";
    existing.isSubscribed = false;
    await existing.save();

    return true;
  }

  public static async updatePageSyncedForms(
    pageId: string,
    formIds: string[]
  ): Promise<IMetaPageConnection> {
    const existing = await MetaPageConnection.findOne({ pageId });
    if (!existing) {
      throw new Error(`Page with ID ${pageId} not found in connection registry`);
    }

    existing.selectedForms = Array.isArray(formIds) ? formIds.map((id) => String(id).trim()) : [];
    await existing.save();

    return existing;
  }

  /**
   * Helper to fetch details of a specific Ad by adId (to resolve campaign & form attribution).
   */
  public static async fetchAdDetails(
    adId: string,
    userAccessToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<{ id: string; name: string; campaign_id?: string; campaign_name?: string } | null> {
    try {
      const endpoint = `${adId}?fields=id,name,campaign{id,name}&access_token=${encodeURIComponent(
        userAccessToken
      )}`;
      const data = await this.graphApiRequest(endpoint, { method: "GET" }, fetchFn);
      return {
        id: data.id,
        name: data.name,
        campaign_id: data?.campaign?.id,
        campaign_name: data?.campaign?.name,
      };
    } catch {
      return null;
    }
  }
}
