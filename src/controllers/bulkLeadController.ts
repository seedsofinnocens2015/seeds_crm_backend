import { Request, Response } from "express";
import mongoose from "mongoose";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import {
  getFormattedTimestamp,
  getTodayDDMMMYY,
  getCurrentMonthMMMYY,
  SUB_DISPOSITIONS_MAP,
} from "../utils/dateUtils.js";
import { normalizePhoneNumber } from "../utils/phoneUtils.js";
import { getNextUniqueId } from "../utils/idGenerator.js";
import { invalidateDashboardCache } from "../utils/cacheInvalidation.js";
import { enqueueBulkLeadsForSmartflo } from "../services/smartflo/smartfloSyncService.js";

const MONTH_NAMES_S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseAnyDateServer(raw: any): string {
  if (!raw && raw !== 0) return "";
  const str = String(raw).trim();
  if (!str) return "";

  const asNum = Number(str);
  if (!isNaN(asNum) && asNum > 25000 && asNum < 60000 && !str.includes("-") && !str.includes("/")) {
    const d = new Date((asNum - (25567 + 2)) * 86400 * 1000);
    if (!isNaN(d.getTime())) {
      return `${String(d.getDate()).padStart(2, "0")}-${MONTH_NAMES_S[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
    }
  }
  const m1 = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(str);
  if (m1) {
    const mmm = m1[2].charAt(0).toUpperCase() + m1[2].slice(1, 3).toLowerCase();
    const yr = m1[3].length === 4 ? m1[3].slice(-2) : m1[3];
    return `${m1[1].padStart(2, "0")}-${mmm}-${yr}`;
  }
  const m2 = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(str);
  if (m2) {
    const monthIdx = parseInt(m2[2], 10) - 1;
    return `${m2[1].padStart(2, "0")}-${MONTH_NAMES_S[monthIdx] || m2[2]}-${m2[3].slice(-2)}`;
  }
  const m3 = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (m3) {
    const monthIdx = parseInt(m3[2], 10) - 1;
    return `${m3[3]}-${MONTH_NAMES_S[monthIdx] || m3[2]}-${m3[1].slice(-2)}`;
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return `${String(d.getDate()).padStart(2, "0")}-${MONTH_NAMES_S[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
  }
  return str;
}

function monthFromDDMMMYYServer(s: string): string {
  const p = s.split("-");
  return p.length === 3 && MONTH_NAMES_S.includes(p[1]) ? `${p[1]}-${p[2]}` : "";
}

// Allowed fields for bulk update
const ALLOWED_BULK_UPDATE_FIELDS = new Set([
  "callerName",
  "dispositions",
  "subDispositions",
  "validStatus",
  "leadSource",
  "location",
  "otherCity",
  "lookingForTreatment",
  "preConditions",
  "surgeryDetails",
  "treatmentRequirements",
  "referredBy",
  "followUpDate",
  "appointmentDate",
  "appointmentMonth",
  "teleconsultationSlot",
  "consultationCharges",
  "surgeryDate",
  "surgeryCost",
  "surgeryPaymentReceived",
  "notes",
  "patientAge",
  "spouseName",
  "spouseAge",
]);

/**
 * POST /api/v1/leads/bulk-upload
 * Bulk lead upload/import.
 * Preserves duplicate phone deduplication/replacement, uniqueId continuity,
 * active member validation, batch chunking, and dashboard cache invalidation.
 */
export async function bulkUploadLeads(req: Request, res: Response) {
  try {
    const session = req.user!;
    if (session.role !== "admin" && session.role !== "team_leader") {
      return res.status(403).json({
        error: "Forbidden. Admin or Team Leader access required for bulk upload.",
      });
    }

    const { leads } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: "No leads data provided in payload" });
    }

    // Enforce reasonable batch-size limit (max 5,000 per request)
    if (leads.length > 5000) {
      return res.status(400).json({
        error: "Batch limit exceeded. Maximum 5,000 leads can be uploaded per batch.",
      });
    }

    // 1. Gather all incoming normalized phone numbers
    const incomingMobiles = new Set<string>();
    for (const item of leads) {
      const rawMob = String(item.mobileNumber || item.phoneNumber || "");
      const norm = normalizePhoneNumber(rawMob);
      if (norm) {
        incomingMobiles.add(norm);
      } else {
        const clean = rawMob.replace(/\D/g, "").slice(-10);
        if (clean && clean.length >= 10) incomingMobiles.add(clean);
      }
    }

    // 2. Find and remove old matching duplicate leads from the database
    let deletedCount = 0;
    const existingMatchesByMobile: Record<string, string> = {}; // norm -> old uniqueId

    if (incomingMobiles.size > 0) {
      const mobArray = Array.from(incomingMobiles);
      const oldDuplicates = await Lead.find(
        {
          $or: [
            { normalizedPhone: { $in: mobArray } },
            { normalizedAlternate: { $in: mobArray } },
            { mobileNumber: { $in: mobArray } },
            { phoneNumber: { $in: mobArray } },
          ],
        },
        { _id: 1, uniqueId: 1, mobileNumber: 1, phoneNumber: 1, normalizedPhone: 1 }
      ).lean();

      if (oldDuplicates.length > 0) {
        const idsToDelete = oldDuplicates.map((d: any) => d._id);
        for (const d of oldDuplicates) {
          const normKey = d.normalizedPhone || String(d.mobileNumber || d.phoneNumber || "").replace(/\D/g, "").slice(-10);
          if (normKey && !existingMatchesByMobile[normKey] && d.uniqueId) {
            existingMatchesByMobile[normKey] = d.uniqueId;
          }
        }
        const delRes = await Lead.deleteMany({ _id: { $in: idsToDelete } });
        deletedCount = delRes.deletedCount || 0;
      }
    }

    // 3. Fetch valid active agent member names
    const activeMembers = await User.find({ status: { $ne: "inactive" } }, { name: 1 }).lean();
    const validCallerNamesMap = new Map<string, string>();
    for (const m of activeMembers) {
      if (m.name && m.name.trim()) {
        validCallerNamesMap.set(m.name.trim().toLowerCase(), m.name.trim());
      }
    }

    const defaultDate = getTodayDDMMMYY();
    const defaultMonth = getCurrentMonthMMMYY();
    const currentTimestamp = getFormattedTimestamp(new Date());

    const assignedIdsInBatch = new Set<string>();
    const leadsToInsert = [];

    for (const item of leads) {
      const mobile = String(item.mobileNumber || item.phoneNumber || "").trim();
      const normMob = normalizePhoneNumber(mobile) || mobile.replace(/\D/g, "").slice(-10);

      let assignedId = "";
      if (normMob && existingMatchesByMobile[normMob] && !assignedIdsInBatch.has(existingMatchesByMobile[normMob])) {
        // Reuse previous uniqueId so history is maintained
        assignedId = existingMatchesByMobile[normMob];
        assignedIdsInBatch.add(assignedId);
      } else {
        // Atomic sequential ID generation
        assignedId = await getNextUniqueId();
        assignedIdsInBatch.add(assignedId);
      }

      const subDisp = String(item.subDispositions || item.subDisposition || "").trim();
      let disp = String(item.dispositions || item.disposition || "").trim();
      let valid = String(item.validStatus || "").trim();

      if (subDisp && SUB_DISPOSITIONS_MAP[subDisp]) {
        if (!disp) disp = SUB_DISPOSITIONS_MAP[subDisp].disposition;
        if (!valid) valid = SUB_DISPOSITIONS_MAP[subDisp].validStatus;
      }

      let finalDate = parseAnyDateServer(item.date || "");
      let finalMonth = String(item.month || "").trim() || monthFromDDMMMYYServer(finalDate);
      let finalTimestamp = String(item.leadTimestamp || "").trim();

      const rawTimeCandidate = item.created_time || item.createdAt || "";
      if (rawTimeCandidate && (!finalTimestamp || !finalDate)) {
        try {
          const d = new Date(rawTimeCandidate);
          if (!isNaN(d.getTime())) {
            const yr = String(d.getFullYear()).slice(-2);
            const dy = String(d.getDate()).padStart(2, "0");
            const mmm = MONTH_NAMES_S[d.getMonth()] || "Jan";
            if (!finalDate) finalDate = `${dy}-${mmm}-${yr}`;
            if (!finalMonth) finalMonth = `${mmm}-${yr}`;
            let hrs = d.getHours();
            const mins = String(d.getMinutes()).padStart(2, "0");
            const ampm = hrs >= 12 ? "PM" : "AM";
            hrs = hrs % 12;
            hrs = hrs ? hrs : 12;
            if (!finalTimestamp) finalTimestamp = `${finalDate}, ${String(hrs).padStart(2, "0")}:${mins} ${ampm}`;
          }
        } catch {}
      }

      if (!finalDate) finalDate = defaultDate;
      if (!finalMonth) finalMonth = monthFromDDMMMYYServer(finalDate) || defaultMonth;
      if (!finalTimestamp) finalTimestamp = currentTimestamp;

      let rawCaller = String(item.callerName || "").trim();
      let sanitizedCaller = "";
      if (rawCaller && rawCaller.toUpperCase() !== "NA") {
        const matchedName = validCallerNamesMap.get(rawCaller.toLowerCase());
        if (matchedName) sanitizedCaller = matchedName;
      }

      const normPhone = normalizePhoneNumber(mobile) || mobile;
      const altNumber = String(item.alternateNumber || "").trim();
      const normAlt = altNumber ? normalizePhoneNumber(altNumber) || "" : "";

      leadsToInsert.push({
        uniqueId: assignedId,
        date: finalDate,
        month: finalMonth,
        leadTimestamp: finalTimestamp,
        mobileNumber: mobile,
        phoneNumber: mobile,
        alternateNumber: altNumber,
        normalizedPhone: normPhone,
        normalizedAlternate: normAlt,
        callerName: sanitizedCaller,
        patientName: String(item.patientName || "").trim(),
        patientAge: String(item.patientAge || "").trim(),
        spouseName: String(item.spouseName || "").trim(),
        spouseAge: String(item.spouseAge || "").trim(),
        location: String(item.location || item.otherCity || "").trim(),
        otherCity: String(item.otherCity || "").trim(),
        lookingForTreatment: String(
          item.lookingForTreatment || item.treatmentRequired || item.treatment || ""
        ).trim(),
        treatmentRequirements: String(
          item.treatmentRequirements || item.treatmentRequired || ""
        ).trim(),
        preConditions: String(item.preConditions || item.preCondition || "").trim(),
        surgeryDetails: String(item.surgeryDetails || item.surgicalData || "").trim(),
        referredBy: String(item.referredBy || "").trim(),
        leadSource: String(item.leadSource || "").trim(),
        followUpDate: parseAnyDateServer(item.followUpDate || item.followUpDates || ""),
        subDispositions: subDisp,
        dispositions: disp,
        validStatus: valid,
        appointmentDate: parseAnyDateServer(item.appointmentDate || ""),
        appointmentMonth: (() => {
          const ad = parseAnyDateServer(item.appointmentDate || "");
          const stored = String(item.appointmentMonth || "").trim();
          return monthFromDDMMMYYServer(ad) || stored;
        })(),
        teleconsultationSlot: String(item.teleconsultationSlot || item.appointmentSlot || "").trim(),
        consultationCharges: String(
          item.consultationCharges || item.teleConsultationCharges || ""
        ).trim(),
        notes: String(item.notes || "").trim(),
        surgeryPaymentReceived: String(
          item.surgeryPaymentReceived || item.surgeryReceipt || ""
        ).trim(),
        surgeryCost: String(item.surgeryCost || "").trim(),
        surgeryDate: parseAnyDateServer(item.surgeryDate || ""),
      });
    }

    // Chunked insert (1,000 documents per batch)
    const CHUNK_SIZE = 1000;
    const insertedLeads = [];
    for (let i = 0; i < leadsToInsert.length; i += CHUNK_SIZE) {
      const chunk = leadsToInsert.slice(i, i + CHUNK_SIZE);
      const resChunk = await Lead.insertMany(chunk, { ordered: false });
      insertedLeads.push(...resChunk);
    }

    const nextId = await getNextUniqueId();

    invalidateDashboardCache();

    // Asynchronously bulk enqueue imported leads for Smartflo synchronization (non-blocking)
    if (insertedLeads.length > 0) {
      enqueueBulkLeadsForSmartflo(
        insertedLeads.map((l: any) => ({ _id: l._id, uniqueId: l.uniqueId }))
      ).catch((err) => {
        console.error("[Smartflo Bulk Hook] Background bulk enqueue error:", err.message);
      });
    }

    return res.status(200).json({
      success: true,
      count: insertedLeads.length,
      deletedCount,
      leads: insertedLeads,
      nextUniqueId: nextId,
    });
  } catch (error: any) {
    console.error("Bulk upload error:", error);
    return res.status(500).json({
      error: error.message || "Failed to bulk import leads",
    });
  }
}

/**
 * POST /api/v1/leads/assign-bulk
 * Bulk assign leads to an agent.
 * Admin and Team Leader access only. Target must be an Agent.
 */
export async function bulkAssignLeads(req: Request, res: Response) {
  try {
    const authUser = req.user!;
    if (authUser.role !== "admin" && authUser.role !== "team_leader") {
      return res.status(403).json({
        error: "Unauthorized. Admin or Team Leader access required.",
      });
    }

    const { leadIds, agentId, agentName } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: "Please select at least one lead to assign." });
    }

    if (leadIds.length > 5000) {
      return res.status(400).json({
        error: "Batch limit exceeded. Maximum 5,000 leads can be assigned at a time.",
      });
    }

    if (!agentName || !agentName.trim()) {
      return res.status(400).json({ error: "Agent name is required for assignment." });
    }

    let targetAgent = null;
    if (agentId && mongoose.Types.ObjectId.isValid(agentId)) {
      targetAgent = await User.findById(agentId);
    } else {
      targetAgent = await User.findOne({ name: agentName.trim(), role: "agent" });
    }

    if (!targetAgent) {
      return res.status(404).json({ error: "Target agent not found." });
    }

    if (targetAgent.role !== "agent") {
      return res.status(400).json({
        error: "Bulk lead assignments can only be made to Agent members.",
      });
    }

    const assignedAgentName = targetAgent.name.trim();
    const todayDDMMMYY = getTodayDDMMMYY();
    const nowISO = new Date().toISOString();

    const idFilters = leadIds.map((id: string) => {
      if (mongoose.Types.ObjectId.isValid(id)) {
        return { $or: [{ _id: id }, { uniqueId: id }] };
      }
      return { uniqueId: id };
    });

    const targetLeads = await Lead.find({ $or: idFilters });

    if (targetLeads.length === 0) {
      return res.status(404).json({ error: "No matching leads found to assign." });
    }

    const auditEntry = {
      performedBy: authUser.name || "Admin / Team Leader",
      performedByRole: authUser.role || "admin",
      performedByEmail: authUser.email || "",
      timestamp: nowISO,
      changes: [
        {
          field: "callerName",
          fieldLabel: "Caller Name (Assigned)",
          oldValue: "Unassigned / Previous Caller",
          newValue: assignedAgentName,
        },
      ],
    };

    const bulkOps = targetLeads.map((lead) => {
      const oldCaller = lead.callerName || "(Unassigned)";
      const leadAudit = {
        ...auditEntry,
        changes: [
          {
            field: "callerName",
            fieldLabel: "Caller Name (Bulk Assigned)",
            oldValue: oldCaller,
            newValue: assignedAgentName,
          },
        ],
      };

      return {
        updateOne: {
          filter: { _id: lead._id },
          update: {
            $set: {
              callerName: assignedAgentName,
              assignedDate: todayDDMMMYY,
              assignedAt: nowISO,
            },
            $push: {
              auditLogs: {
                $each: [leadAudit],
                $position: 0,
              },
            },
          },
        },
      };
    });

    const result = await Lead.bulkWrite(bulkOps);

    invalidateDashboardCache();

    return res.status(200).json({
      message: `Successfully assigned ${result.modifiedCount} lead(s) to agent ${assignedAgentName}!`,
      modifiedCount: result.modifiedCount,
      assignedAgent: assignedAgentName,
      assignedDate: todayDDMMMYY,
    });
  } catch (error: any) {
    console.error("Bulk lead assignment error:", error);
    return res.status(500).json({
      error: error.message || "Failed to assign leads in bulk.",
    });
  }
}

/**
 * POST /api/v1/leads/bulk-update
 * Updates a single field across multiple selected leads.
 * Admin-only authorization.
 */
export async function bulkUpdateLeads(req: Request, res: Response) {
  try {
    const adminUser = req.user!;
    if (adminUser.role !== "admin") {
      return res.status(403).json({
        error: "Unauthorized. Admin privileges required.",
      });
    }

    const { leadIds, fieldName, fieldValue, isCustomField } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: "No leads selected for bulk update." });
    }

    if (leadIds.length > 5000) {
      return res.status(400).json({
        error: "Batch limit exceeded. Maximum 5,000 leads can be updated at a time.",
      });
    }

    if (!fieldName || typeof fieldName !== "string") {
      return res.status(400).json({ error: "Field name is required." });
    }

    const updateObj: Record<string, any> = {};

    if (isCustomField) {
      updateObj[`customFields.${fieldName}`] = fieldValue;
    } else {
      if (!ALLOWED_BULK_UPDATE_FIELDS.has(fieldName) && !fieldName.startsWith("customFields.")) {
        return res.status(400).json({
          error: `Field "${fieldName}" is not allowed for bulk updates.`,
        });
      }

      updateObj[fieldName] = fieldValue;

      // Auto-cascade subDispositions mapping to dispositions and validStatus
      if (fieldName === "subDispositions" && fieldValue) {
        const mapping = SUB_DISPOSITIONS_MAP[fieldValue];
        if (mapping) {
          if (mapping.disposition) updateObj.dispositions = mapping.disposition;
          if (mapping.validStatus) updateObj.validStatus = mapping.validStatus;
        }
      }
    }

    const auditEntry = {
      performedBy: adminUser.name || "Admin",
      performedByRole: "admin",
      performedByEmail: adminUser.email || "",
      timestamp: new Date().toISOString(),
      changes: [
        {
          field: fieldName,
          fieldLabel: fieldName,
          oldValue: "(bulk updated)",
          newValue: String(fieldValue ?? ""),
        },
      ],
    };

    const targetQuery = {
      $or: [
        { uniqueId: { $in: leadIds } },
        { _id: { $in: leadIds.filter((id: string) => mongoose.Types.ObjectId.isValid(id)) } },
      ],
    };

    const result = await Lead.updateMany(targetQuery, {
      $set: updateObj,
      $push: {
        auditLogs: {
          $each: [auditEntry],
          $position: 0,
        },
      },
    });

    invalidateDashboardCache();

    return res.status(200).json({
      success: true,
      modifiedCount: result.modifiedCount,
      matchedCount: result.matchedCount,
      fieldName,
      fieldValue,
    });
  } catch (err: any) {
    console.error("Bulk update error:", err);
    return res.status(500).json({
      error: err.message || "Failed to bulk update leads.",
    });
  }
}

/**
 * POST /api/v1/leads/merge
 * Consolidates secondary leads into a master lead.
 * Admin-only authorization. Max 20 leads.
 */
export async function mergeLeads(req: Request, res: Response) {
  try {
    const adminUser = req.user!;
    if (adminUser.role !== "admin") {
      return res.status(403).json({
        error: "Unauthorized. Admin privileges required.",
      });
    }

    const { masterLeadId, otherLeadIds, selectedFieldValues } = req.body;

    if (!masterLeadId || typeof masterLeadId !== "string") {
      return res.status(400).json({ error: "Master Lead ID is required." });
    }

    if (!Array.isArray(otherLeadIds) || otherLeadIds.length === 0) {
      return res.status(400).json({ error: "At least one secondary lead is required to merge." });
    }

    const totalLeadsToMerge = 1 + otherLeadIds.length;
    if (totalLeadsToMerge > 20) {
      return res.status(400).json({ error: "Maximum 20 leads can be merged at a time." });
    }

    const isValidObjectId = (id: string) => mongoose.Types.ObjectId.isValid(id);

    // 1. Fetch Master Lead
    const masterConditions: any[] = [{ uniqueId: masterLeadId }];
    if (isValidObjectId(masterLeadId)) masterConditions.push({ _id: masterLeadId });
    const masterLead = await Lead.findOne({ $or: masterConditions });

    if (!masterLead) {
      return res.status(404).json({ error: `Master lead (${masterLeadId}) not found.` });
    }

    // 2. Fetch Secondary Leads
    const otherConditions: any[] = [{ uniqueId: { $in: otherLeadIds } }];
    const validOtherIds = otherLeadIds.filter((id: string) => isValidObjectId(id));
    if (validOtherIds.length > 0) otherConditions.push({ _id: { $in: validOtherIds } });

    const otherLeads = await Lead.find({ $or: otherConditions });

    if (otherLeads.length === 0) {
      return res.status(404).json({ error: "No secondary leads found to merge." });
    }

    // 3. Preserve Lowest SC Unique ID across all merging leads
    const allMerging = [masterLead, ...otherLeads];
    let chosenLowestUniqueId = masterLead.uniqueId;
    let lowestSerial = Infinity;

    for (const l of allMerging) {
      if (l.uniqueId) {
        const match = l.uniqueId.match(/(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num < lowestSerial) {
            lowestSerial = num;
            chosenLowestUniqueId = l.uniqueId;
          }
        }
      }
    }

    if (chosenLowestUniqueId) {
      masterLead.uniqueId = chosenLowestUniqueId;
    }

    // 4. Collect and consolidate audit logs, notes history, notes from secondary leads
    const combinedAuditLogs: any[] = Array.isArray(masterLead.auditLogs) ? [...masterLead.auditLogs] : [];
    const combinedNotesHistory: any[] = Array.isArray(masterLead.notesHistory) ? [...masterLead.notesHistory] : [];
    const otherIdentifiers: string[] = [];

    for (const ol of otherLeads) {
      const olId = ol.uniqueId || ol._id?.toString();
      otherIdentifiers.push(olId);

      if (Array.isArray(ol.auditLogs)) combinedAuditLogs.push(...ol.auditLogs);
      if (Array.isArray(ol.notesHistory)) combinedNotesHistory.push(...ol.notesHistory);

      if (ol.notes && ol.notes.trim()) {
        combinedNotesHistory.push({
          performedBy: ol.callerName || "System (Merged)",
          performedByRole: "admin",
          performedByEmail: adminUser.email || "",
          timestamp: ol.updatedAt ? new Date(ol.updatedAt).toISOString() : new Date().toISOString(),
          oldNotes: "",
          newNotes: `[From Merged Lead ${olId}]: ${ol.notes}`,
        });
      }
    }

    // 5. Apply selected field values to Master Lead
    if (selectedFieldValues && typeof selectedFieldValues === "object") {
      const allowedFields = [
        "patientName",
        "mobileNumber",
        "spouseName",
        "patientAge",
        "spouseAge",
        "location",
        "otherCity",
        "leadSource",
        "referredBy",
        "lookingForTreatment",
        "treatmentRequirements",
        "preConditions",
        "surgeryDetails",
        "callerName",
        "subDispositions",
        "dispositions",
        "validStatus",
        "followUpDate",
        "appointmentDate",
        "appointmentMonth",
        "teleconsultationSlot",
        "consultationCharges",
        "surgeryDate",
        "surgeryCost",
        "surgeryPaymentReceived",
        "notes",
      ];

      for (const field of allowedFields) {
        if (selectedFieldValues[field] !== undefined) {
          (masterLead as any)[field] = selectedFieldValues[field];
        }
      }

      if (selectedFieldValues.subDispositions) {
        const mapping = SUB_DISPOSITIONS_MAP[selectedFieldValues.subDispositions];
        if (mapping) {
          if (!selectedFieldValues.dispositions) masterLead.dispositions = mapping.disposition;
          if (!selectedFieldValues.validStatus) masterLead.validStatus = mapping.validStatus;
        }
      }

      if (selectedFieldValues.mobileNumber) {
        masterLead.normalizedPhone = normalizePhoneNumber(selectedFieldValues.mobileNumber) || selectedFieldValues.mobileNumber;
      }
      if (selectedFieldValues.alternateNumber) {
        masterLead.normalizedAlternate = normalizePhoneNumber(selectedFieldValues.alternateNumber) || selectedFieldValues.alternateNumber;
      }
    }

    // Add merge audit record
    const timestampStr = getFormattedTimestamp();
    combinedAuditLogs.unshift({
      performedBy: adminUser.name || "Admin",
      performedByRole: "admin",
      performedByEmail: adminUser.email || "",
      timestamp: new Date().toISOString(),
      changes: [
        {
          field: "mergeLeads",
          fieldLabel: "Merge Leads",
          oldValue: "Merged Leads",
          newValue: `Merged ${otherIdentifiers.length} leads (${otherIdentifiers.join(", ")}) into Master Lead (${masterLead.uniqueId || masterLead._id}) on ${timestampStr}`,
        },
      ],
    });

    masterLead.auditLogs = combinedAuditLogs;
    masterLead.notesHistory = combinedNotesHistory;
    masterLead.updatedAt = new Date();

    await masterLead.save();

    // 6. Delete secondary leads from the database
    const deleteIds = otherLeads.map((ol) => ol._id);
    await Lead.deleteMany({ _id: { $in: deleteIds } });

    invalidateDashboardCache();

    return res.status(200).json({
      success: true,
      message: `Successfully merged ${otherIdentifiers.length} leads into Master Lead ${masterLead.uniqueId || masterLead._id}.`,
      masterLeadId: masterLead.uniqueId || masterLead._id,
      deletedCount: deleteIds.length,
    });
  } catch (error: any) {
    console.error("Error in merge leads route:", error);
    return res.status(500).json({
      error: error.message || "Failed to merge leads.",
    });
  }
}
