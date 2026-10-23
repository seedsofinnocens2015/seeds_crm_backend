import { config } from "../config/env.js";
import { Lead, ILead } from "../models/Lead.js";
import { MetaPageConnection } from "../models/MetaPageConnection.js";
import { MetaWebhookEvent } from "../models/MetaWebhookEvent.js";
import { MetaAdsSetupConfig } from "../models/MetaAdsSetupConfig.js";
import { MetaPageService } from "./metaPageService.js";
import { getNextUniqueId } from "../utils/idGenerator.js";
import { normalizePhoneNumber } from "../utils/phoneUtils.js";

export interface MetaFieldData {
  name: string;
  values: string[];
}

export interface MetaLeadDetails {
  id: string; // leadgen_id
  created_time?: string;
  ad_id?: string;
  form_id?: string;
  page_id?: string;
  field_data?: MetaFieldData[];
}

export interface IngestionResult {
  status: "created" | "already_exists" | "skipped_duplicate_phone" | "skipped_form_not_synced" | "error";
  leadId?: string;
  uniqueId?: string;
  metaLeadId: string;
  message?: string;
}

/**
 * Fetch lead details from Meta Graph API using leadgen_id with retry capability.
 */
export async function fetchMetaLeadDetails(
  leadgenId: string,
  customAccessToken?: string,
  fetchFn: typeof fetch = fetch,
  retries: number = 2
): Promise<MetaLeadDetails> {
  const token =
    customAccessToken || config.metaPageAccessToken || process.env.META_PAGE_ACCESS_TOKEN;

  if (!token) {
    throw new Error("Meta Page Access Token is not configured or resolved for this Page.");
  }

  const version = config.metaGraphApiVersion || "v21.0";
  const url = `https://graph.facebook.com/${version}/${leadgenId}?access_token=${encodeURIComponent(
    token
  )}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchFn(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let parsedMessage = `HTTP ${response.status} ${response.statusText}`;
        try {
          const parsed = JSON.parse(errorBody);
          if (parsed?.error?.message) {
            parsedMessage = `${parsedMessage}: ${parsed.error.message}`;
          }
        } catch {
          parsedMessage = `${parsedMessage}: ${errorBody}`;
        }

        // Retry on 5xx or rate limit (429 / code 4)
        if (response.status >= 500 || response.status === 429) {
          throw new Error(`Transient Graph API error: ${parsedMessage}`);
        }
        throw new Error(`Meta Graph API fetch failed: ${parsedMessage}`);
      }

      return (await response.json()) as MetaLeadDetails;
    } catch (err: any) {
      lastError = err;
      if (attempt < retries && err.message.includes("Transient")) {
        // Exponential backoff wait (short for tests)
        await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
        continue;
      }
      break;
    }
  }

  throw lastError || new Error("Failed to fetch Meta lead details after retries");
}

/**
 * Helper to map standard Indian calendar date strings
 */
function formatCurrentDateIndian(): { dateStr: string; monthStr: string } {
  const now = new Date();
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  const day = String(now.getDate()).padStart(2, "0");
  const monthName = months[now.getMonth()];
  const yearShort = String(now.getFullYear()).slice(-2);

  return {
    dateStr: `${day}-${monthName}-${yearShort}`,
    monthStr: monthName,
  };
}

/**
 * Maps raw Meta lead details & field_data into CRM Lead fields.
 */
export function mapMetaLeadToCrmFields(
  details: MetaLeadDetails,
  pageNameContext?: string
): Partial<ILead> {
  const fieldMap: Record<string, string> = {};
  if (Array.isArray(details.field_data)) {
    for (const item of details.field_data) {
      if (item.name && Array.isArray(item.values) && item.values.length > 0) {
        fieldMap[item.name.toLowerCase().trim()] = item.values[0].trim();
      }
    }
  }

  // Extract Patient Name
  const patientName =
    fieldMap["full_name"] ||
    fieldMap["name"] ||
    fieldMap["first_name"] ||
    fieldMap["patient_name"] ||
    fieldMap["caller_name"] ||
    "Meta Lead";

  // Extract Phone Number
  const rawPhone =
    fieldMap["phone_number"] ||
    fieldMap["phone"] ||
    fieldMap["mobile_number"] ||
    fieldMap["mobile"] ||
    fieldMap["contact_number"] ||
    "";

  const normalized = normalizePhoneNumber(rawPhone) || rawPhone.replace(/\D/g, "");

  // Extract City / Location
  const location =
    fieldMap["city"] ||
    fieldMap["location"] ||
    fieldMap["state"] ||
    fieldMap["address"] ||
    "";

  // Extract Treatment requirements or inquiries
  const lookingForTreatment =
    fieldMap["looking_for_treatment"] ||
    fieldMap["treatment"] ||
    fieldMap["service"] ||
    fieldMap["inquiry"] ||
    "IVF / Fertility Consultation";

  // Extract Email or other custom fields
  const email = fieldMap["email"] || "";

  const { dateStr, monthStr } = formatCurrentDateIndian();

  return {
    date: dateStr,
    month: monthStr,
    leadTimestamp: details.created_time || new Date().toISOString(),
    mobileNumber: rawPhone,
    phoneNumber: rawPhone,
    normalizedPhone: normalized,
    callerName: patientName,
    patientName: patientName,
    location: location,
    lookingForTreatment: lookingForTreatment,
    leadSource: "Meta Instant Form",
    dispositions: "Fresh Lead",
    subDispositions: "New Inquiry",
    customFields: {
      metaLeadId: details.id,
      metaPageId: details.page_id || "",
      metaPageName: pageNameContext || "",
      metaFormId: details.form_id || "",
      metaAdId: details.ad_id || "",
      email: email,
      rawFieldData: fieldMap,
    },
    notes: `Ingested automatically from Meta Lead Ad (Page: ${pageNameContext || details.page_id || "N/A"}, Form: ${details.form_id || "N/A"}, Ad: ${details.ad_id || "N/A"}). Email: ${email || "N/A"}`,
  };
}

/**
 * Idempotently ingests a single Meta lead by leadgen_id into MongoDB.
 * Resolves the authorized Page token dynamically from the MetaPageConnection registry.
 */
export async function ingestMetaLead(
  leadgenId: string,
  options?: {
    pageId?: string;
    customAccessToken?: string;
    mockDetails?: MetaLeadDetails;
    fetchFn?: typeof fetch;
  }
): Promise<IngestionResult> {
  if (!leadgenId) {
    return {
      status: "error",
      metaLeadId: "",
      message: "Missing leadgen_id",
    };
  }

  // 1. Idempotency Check: Already ingested this exact Meta Lead ID?
  const existingByMetaId = await Lead.findOne({
    "customFields.metaLeadId": leadgenId,
  });

  if (existingByMetaId) {
    console.info(
      `[Meta Ingestion] Lead already ingested for metaLeadId: ${leadgenId} (CRM ID: ${existingByMetaId.uniqueId})`
    );

    // Update or insert webhook event record
    await MetaWebhookEvent.findOneAndUpdate(
      { leadgenId },
      {
        $set: {
          status: "already_exists",
          crmLeadId: existingByMetaId._id,
          crmLeadUniqueId: existingByMetaId.uniqueId,
        },
        $setOnInsert: {
          pageId: options?.pageId || existingByMetaId.customFields?.metaPageId || "unknown",
          formId: existingByMetaId.customFields?.metaFormId || "",
          adId: existingByMetaId.customFields?.metaAdId || "",
          rawPayloadSummary: { objectType: "page", field: "leadgen" },
        },
      },
      { upsert: true }
    );

    return {
      status: "already_exists",
      leadId: existingByMetaId._id.toString(),
      uniqueId: existingByMetaId.uniqueId,
      metaLeadId: leadgenId,
      message: "Lead already exists with this Meta Lead ID.",
    };
  }

  // 2. Resolve Page Access Token
  let pageToken = options?.customAccessToken;
  let pageName = "";

  if (!pageToken && options?.pageId) {
    const resolved = await MetaPageService.resolvePageToken(options.pageId);
    if (resolved) {
      pageToken = resolved.token;
      pageName = resolved.pageName;
    }
  }

  // 3. Fetch Lead Details from Meta Graph API (or mock)
  let details: MetaLeadDetails;
  try {
    if (options?.mockDetails) {
      details = options.mockDetails;
      if (options?.pageId && !details.page_id) {
        details.page_id = options.pageId;
      }
    } else {
      details = await fetchMetaLeadDetails(
        leadgenId,
        pageToken,
        options?.fetchFn
      );
      if (options?.pageId && !details.page_id) {
        details.page_id = options.pageId;
      }
    }
  } catch (err: any) {
    console.error(`[Meta Ingestion] Error fetching lead details for ${leadgenId}:`, err.message);

    // Record failure in webhook event tracking
    await MetaWebhookEvent.findOneAndUpdate(
      { leadgenId },
      {
        status: "failed",
        lastError: err.message,
        $inc: { retryCount: 1 },
      }
    );

    return {
      status: "error",
      metaLeadId: leadgenId,
      message: err.message,
    };
  }

  // 3b. MetaAdsSetupConfig check:
  // Check if there is an active setup config for this formId or pageId
  let setupConfig = null;
  if (details.form_id) {
    setupConfig = await MetaAdsSetupConfig.findOne({
      formId: details.form_id,
      status: { $ne: "paused" },
    });
  }
  if (!setupConfig && details.page_id) {
    setupConfig = await MetaAdsSetupConfig.findOne({
      pageId: details.page_id,
      status: { $ne: "paused" },
    });
  }

  // If setupConfig exists and autoSync is disabled, skip ingestion
  if (setupConfig && setupConfig.autoSync === false) {
    console.info(
      `[Meta Ingestion] Skipping lead ${leadgenId}: AutoSync is disabled in MetaAdsSetupConfig (${setupConfig.integrationName}).`
    );
    await MetaWebhookEvent.findOneAndUpdate(
      { leadgenId },
      {
        status: "skipped_duplicate_phone",
        lastError: `AutoSync is disabled in setup config: ${setupConfig.integrationName}`,
      }
    );
    return {
      status: "skipped_form_not_synced",
      metaLeadId: leadgenId,
      message: `AutoSync is disabled for ${setupConfig.integrationName}.`,
    };
  }

  // 3c. Selective Form Sync Check (from Page connection):
  // If the Page connection has specific selectedForms configured, ensure this lead's form_id is included.
  // Backward compatibility: If selectedForms is empty or undefined, sync all forms.
  if (details.page_id && details.form_id) {
    const pageConn = await MetaPageConnection.findOne({ pageId: details.page_id });
    if (
      pageConn &&
      Array.isArray(pageConn.selectedForms) &&
      pageConn.selectedForms.length > 0 &&
      !pageConn.selectedForms.includes(details.form_id)
    ) {
      console.info(
        `[Meta Ingestion] Skipping lead ${leadgenId}: Form ${details.form_id} is not enabled for sync on Page ${details.page_id}.`
      );

      await MetaWebhookEvent.findOneAndUpdate(
        { leadgenId },
        {
          status: "skipped_duplicate_phone", // Use existing terminal state or update
          lastError: `Form ${details.form_id} is not selected for sync.`,
        }
      );

      return {
        status: "skipped_form_not_synced",
        metaLeadId: leadgenId,
        message: `Form ${details.form_id} is not enabled for sync on Page ${details.page_id}.`,
      };
    }
  }

  const mappedFields = mapMetaLeadToCrmFields(details, pageName);

  // Apply custom field mappings and campaign info from setupConfig if available
  if (setupConfig) {
    if (setupConfig.leadSource) {
      mappedFields.leadSource = setupConfig.leadSource;
    }
    if (mappedFields.customFields) {
      if (setupConfig.campaignName) {
        mappedFields.customFields.metaCampaignName = setupConfig.campaignName;
      }
      if (setupConfig.campaignId) {
        mappedFields.customFields.metaCampaignId = setupConfig.campaignId;
      }
      if (setupConfig.adId) {
        mappedFields.customFields.metaAdId = setupConfig.adId;
      }
    }

    // Apply custom fieldMappings if defined
    if (Array.isArray(setupConfig.fieldMappings) && setupConfig.fieldMappings.length > 0) {
      const rawMap: Record<string, string> = mappedFields.customFields?.rawFieldData || {};
      for (const mapping of setupConfig.fieldMappings) {
        const val = rawMap[mapping.formFieldKey] || rawMap[mapping.formFieldKey.toLowerCase()];
        if (val) {
          if (mapping.crmField === "patientName" || mapping.crmField === "callerName") {
            mappedFields.patientName = val;
            mappedFields.callerName = val;
          } else if (mapping.crmField === "mobileNumber" || mapping.crmField === "phoneNumber") {
            mappedFields.mobileNumber = val;
            mappedFields.phoneNumber = val;
            const norm = normalizePhoneNumber(val);
            if (norm) mappedFields.normalizedPhone = norm;
          } else if (mapping.crmField === "location") {
            mappedFields.location = val;
          } else if (mapping.crmField === "email") {
            if (mappedFields.customFields) mappedFields.customFields.email = val;
          } else if (mapping.crmField === "lookingForTreatment") {
            mappedFields.lookingForTreatment = val;
          } else if (mapping.crmField === "notes") {
            mappedFields.notes = `${mappedFields.notes || ""} | ${val}`;
          }
        }
      }
    }

    // Record lastSyncAt on setupConfig
    setupConfig.lastSyncAt = new Date();
    await setupConfig.save().catch(() => {});
  }

  const normalizedPhone = mappedFields.normalizedPhone;

  // 4. Duplicate Phone Handling: Check if phone already belongs to an existing lead
  if (normalizedPhone && normalizedPhone.length >= 7) {
    const existingByPhone = await Lead.findOne({
      $or: [
        { normalizedPhone: normalizedPhone },
        { normalizedAlternate: normalizedPhone },
      ],
    });

    if (existingByPhone) {
      console.warn(
        `[Meta Ingestion] Duplicate phone detected (${normalizedPhone}). Existing CRM Lead: ${existingByPhone.uniqueId}. Preserving existing lead without destructive overwrite.`
      );

      // Append an audit entry / note to the existing lead instead of overwriting existing data
      const appendNote = `[${new Date().toISOString()}] Repeat submission from Meta Lead Ad (Page: ${pageName || details.page_id || "N/A"}, Leadgen ID: ${leadgenId}, Form: ${details.form_id || "N/A"}).`;

      await Lead.findByIdAndUpdate(existingByPhone._id, {
        $push: {
          notesHistory: {
            performedBy: "Meta Integration Bot",
            performedByRole: "system",
            performedByEmail: "system@seeds-crm.dev",
            timestamp: new Date().toISOString(),
            oldNotes: existingByPhone.notes || "",
            newNotes: appendNote,
          },
        },
      });

      await MetaWebhookEvent.findOneAndUpdate(
        { leadgenId },
        {
          status: "skipped_duplicate_phone",
          crmLeadId: existingByPhone._id,
          crmLeadUniqueId: existingByPhone.uniqueId,
        }
      );

      return {
        status: "skipped_duplicate_phone",
        leadId: existingByPhone._id.toString(),
        uniqueId: existingByPhone.uniqueId,
        metaLeadId: leadgenId,
        message: `Phone number already exists in CRM Lead ${existingByPhone.uniqueId}. Added cross-reference note without overwriting.`,
      };
    }
  }

  // 5. Create New Lead with atomic sequential SC-<number> ID
  const nextUniqueId = await getNextUniqueId();
  mappedFields.uniqueId = nextUniqueId;

  const newLead = new Lead(mappedFields);
  await newLead.save();

  // Update Page connection's lastLeadReceivedAt timestamp
  if (details.page_id) {
    await MetaPageConnection.findOneAndUpdate(
      { pageId: details.page_id },
      { $set: { lastLeadReceivedAt: new Date() } }
    );
  }

  // Mark event as processed in event queue
  await MetaWebhookEvent.findOneAndUpdate(
    { leadgenId },
    {
      status: "processed",
      crmLeadId: newLead._id,
      crmLeadUniqueId: nextUniqueId,
    }
  );

  console.info(
    `[Meta Ingestion] Successfully created CRM Lead ${nextUniqueId} for Meta Lead ID ${leadgenId} (Page: ${pageName || details.page_id || "N/A"}).`
  );

  return {
    status: "created",
    leadId: newLead._id.toString(),
    uniqueId: nextUniqueId,
    metaLeadId: leadgenId,
  };
}
