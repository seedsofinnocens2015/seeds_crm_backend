import { config } from "../../config/env.js";
import { processSmartfloWebhook, SmartfloWebhookPayload } from "./smartfloWebhookService.js";

export interface SmartfloCdrResultItem {
  id?: string;
  call_id: string;
  uuid?: string;
  direction?: string;
  status?: string;
  caller_id_number?: string;
  customer_number?: string;
  call_to_number?: string;
  duration?: number;
  answered_duration?: number;
  start_stamp?: string;
  end_stamp?: string;
  recording_url?: string;
  answered_agent?: string;
  agent_name?: string;
  [key: string]: any;
}

export interface CdrReconciliationResponse {
  totalFetched: number;
  processed: number;
  synced: number;
  errors: number;
}

/**
 * Queries Smartflo CDR API (GET /v1/call/records) for a given date-time window.
 * Format for from_date / to_date: 'YYYY-MM-DD HH:mm:ss'
 */
export async function syncSmartfloCdrRange(
  fromDate: string,
  toDate: string,
  fetchFn: typeof fetch = fetch
): Promise<CdrReconciliationResponse> {
  const resultSummary: CdrReconciliationResponse = {
    totalFetched: 0,
    processed: 0,
    synced: 0,
    errors: 0,
  };

  if (!config.smartfloApiToken) {
    throw new Error("Smartflo API token is missing. Please configure SMARTFLO_API_TOKEN.");
  }

  let page = 1;
  const limit = 50;
  let hasMore = true;

  while (hasMore && page <= 20) {
    const url = new URL(`${config.smartfloApiBaseUrl}/call/records`);
    url.searchParams.set("from_date", fromDate);
    url.searchParams.set("to_date", toDate);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));

    const response = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.smartfloApiToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Smartflo CDR API error (HTTP ${response.status}): ${errText}`);
    }

    const json = (await response.json()) as {
      count?: number;
      results?: SmartfloCdrResultItem[];
      size?: number;
    };

    const records = json.results || [];
    resultSummary.totalFetched += records.length;

    for (const record of records) {
      if (!record.call_id) continue;
      try {
        const webhookPayload: SmartfloWebhookPayload = {
          call_id: record.call_id,
          uuid: record.uuid,
          direction: record.direction,
          call_status: record.status,
          caller_id_number: record.caller_id_number || record.customer_number,
          call_to_number: record.call_to_number,
          duration: record.duration,
          answered_duration: record.answered_duration,
          start_stamp: record.start_stamp,
          end_stamp: record.end_stamp,
          recording_url: record.recording_url,
          answered_agent: record.answered_agent || record.agent_name,
        };

        const res = await processSmartfloWebhook(webhookPayload);
        resultSummary.processed += 1;
        if (res.leadMatched) {
          resultSummary.synced += 1;
        }
      } catch (err) {
        resultSummary.errors += 1;
      }
    }

    if (records.length < limit) {
      hasMore = false;
    } else {
      page += 1;
    }
  }

  return resultSummary;
}
