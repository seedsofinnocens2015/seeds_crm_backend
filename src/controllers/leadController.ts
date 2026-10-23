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

// Projection for table view: excludes heavy auditLogs and notesHistory
const TABLE_VIEW_PROJECTION = {
  auditLogs: 0,
  notesHistory: 0,
};

/**
 * GET /api/v1/leads
 * Server-side pagination, projection, and role-based filtering.
 * Agents are strictly restricted to leads assigned to their callerName.
 */
export async function getLeads(req: Request, res: Response) {
  const startTime = Date.now();
  try {
    const session = req.user!;
    const view = req.query.view as string | undefined;
    const pageParam = req.query.page as string | undefined;
    const limitParam = req.query.limit as string | undefined;

    // Agent scoping: restrict strictly by agent name
    let query: any = {};
    if (session.role === "agent") {
      const agentName = (session.name || "").trim();
      query = {
        callerName: {
          $regex: new RegExp(`^${agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
        },
      };
    }

    // Special lightweight view for dashboard calculations if requested
    if (view === "dashboard") {
      const dashboardProjection = {
        uniqueId: 1,
        patientName: 1,
        mobileNumber: 1,
        callerName: 1,
        month: 1,
        date: 1,
        appointmentMonth: 1,
        appointmentDate: 1,
        surgeryMonth: 1,
        surgeryDate: 1,
        surgeryCost: 1,
        location: 1,
        otherCity: 1,
        lookingForTreatment: 1,
        teleconsultationSlot: 1,
        assignedDate: 1,
        assignedAt: 1,
        createdAt: 1,
        followUpDate: 1,
        followUpDates: 1,
        dispositions: 1,
        validStatus: 1,
        consultationCharges: 1,
        surgeryPaymentReceived: 1,
        subDispositions: 1,
        leadSource: 1,
        leadTimestamp: 1,
        auditLogs: 1,
      };

      const leads = await Lead.find(query)
        .select(dashboardProjection)
        .sort({ createdAt: -1 })
        .lean();

      return res.status(200).json({ leads, totalCount: leads.length });
    }

    // Bounded Pagination Parameters: default 50, maximum 200. Never allow uncapped limit=0 or limit=all
    let page = parseInt(pageParam || "1", 10);
    if (isNaN(page) || page < 1) {
      page = 1;
    }

    let limit = 50; // default safe page size
    if (limitParam !== undefined && limitParam !== null && limitParam !== "") {
      const parsedLimit = parseInt(limitParam, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        limit = Math.min(parsedLimit, 200); // hard cap at 200
      }
    }

    const skip = (page - 1) * limit;

    let leadQuery = Lead.find(query)
      .select(TABLE_VIEW_PROJECTION)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const [leads, totalCount, nextUniqueId] = await Promise.all([
      leadQuery,
      Lead.countDocuments(query),
      getNextUniqueId(),
    ]);

    const totalPages = limit > 0 ? Math.max(1, Math.ceil(totalCount / limit)) : 1;

    res.setHeader("X-Response-Time", `${Date.now() - startTime}ms`);
    return res.status(200).json({
      leads,
      totalCount,
      page,
      limit: limit > 0 ? limit : totalCount,
      totalPages,
      nextUniqueId,
    });
  } catch (error: any) {
    console.error("Error fetching leads:", error);
    return res.status(500).json({
      error: error.message || "Failed to fetch leads",
    });
  }
}

/**
 * POST /api/v1/leads
 * Lead creation with auto-unique ID, disposition cascading, and initial audit log.
 */
export async function createLead(req: Request, res: Response) {
  try {
    const session = req.user!;
    const body = req.body;

    let {
      uniqueId,
      date,
      month,
      mobileNumber,
      phoneNumber,
      alternateNumber,
      callerName,
      patientName,
      patientAge,
      spouseName,
      spouseAge,
      location,
      otherCity,
      lookingForTreatment,
      treatment,
      preConditions,
      preCondition,
      surgeryDetails,
      surgicalData,
      treatmentRequirements,
      treatmentRequired,
      referredBy,
      leadSource,
      followUpDate,
      followUpDates,
      subDispositions,
      subDisposition,
      dispositions,
      disposition,
      validStatus,
      appointmentDate,
      appointmentMonth,
      teleconsultationSlot,
      appointmentSlot,
      consultationCharges,
      teleConsultationCharges,
      notes,
      surgeryPaymentReceived,
      surgeryReceipt,
      surgeryCost,
      surgeryDate,
      customFields,
    } = body;

    const finalMobile = (mobileNumber || phoneNumber || "").trim();
    if (!finalMobile) {
      return res.status(400).json({ error: "Mobile number is required." });
    }

    const finalPatient = (patientName || "").trim();
    if (!finalPatient) {
      return res.status(400).json({ error: "Patient name is required." });
    }

    // Auto-generate unique ID if missing
    if (!uniqueId || !uniqueId.trim()) {
      uniqueId = await getNextUniqueId();
    } else {
      uniqueId = uniqueId.trim();
      const existing = await Lead.findOne({ uniqueId });
      if (existing) {
        uniqueId = await getNextUniqueId();
      }
    }

    // Agent role auto-assignment
    if (session.role === "agent") {
      callerName = (session.name || "").trim();
    }

    // Auto-cascade subDispositions
    const finalSubDisp = (subDispositions || subDisposition || "").trim();
    let finalDisp = (dispositions || disposition || "").trim();
    let finalValidStatus = (validStatus || "").trim();

    if (finalSubDisp && SUB_DISPOSITIONS_MAP[finalSubDisp]) {
      if (!finalDisp) finalDisp = SUB_DISPOSITIONS_MAP[finalSubDisp].disposition;
      if (!finalValidStatus) finalValidStatus = SUB_DISPOSITIONS_MAP[finalSubDisp].validStatus;
    }

    const todayDate = getTodayDDMMMYY();
    const currentMonth = getCurrentMonthMMMYY();
    const currentTimestamp = getFormattedTimestamp(new Date());

    const initialAudit = {
      performedBy: session.name || "System",
      performedByRole: session.role || "unknown",
      performedByEmail: session.email || "",
      timestamp: new Date().toISOString(),
      changes: [
        {
          field: "created",
          fieldLabel: "Lead Created",
          oldValue: "",
          newValue: `Lead created by ${session.name || "User"} (${session.role})`,
        },
      ],
    };

    const initialNoteHistory = [];
    const submittedNote = (notes || "").trim();
    if (submittedNote) {
      initialNoteHistory.push({
        performedBy: session.name || "User",
        performedByRole: session.role || "unknown",
        performedByEmail: session.email || "",
        timestamp: new Date().toISOString(),
        oldNotes: "",
        newNotes: submittedNote,
      });
    }

    const normalizedPhone = normalizePhoneNumber(finalMobile) || finalMobile;
    const normalizedAlternate = alternateNumber ? normalizePhoneNumber(alternateNumber) || "" : "";

    const newLead = await Lead.create({
      uniqueId,
      date: (date || "").trim() || todayDate,
      month: (month || "").trim() || currentMonth,
      leadTimestamp: currentTimestamp,
      mobileNumber: finalMobile,
      phoneNumber: finalMobile,
      alternateNumber: (alternateNumber || "").trim(),
      normalizedPhone,
      normalizedAlternate,
      callerName: (callerName || "").trim(),
      patientName: finalPatient,
      patientAge: (patientAge || "").trim(),
      spouseName: (spouseName || "").trim(),
      spouseAge: (spouseAge || "").trim(),
      location: (location || otherCity || "").trim(),
      otherCity: (otherCity || "").trim(),
      lookingForTreatment: (lookingForTreatment || treatment || "").trim(),
      treatmentRequirements: (treatmentRequirements || treatmentRequired || "").trim(),
      preConditions: (preConditions || preCondition || "").trim(),
      surgeryDetails: (surgeryDetails || surgicalData || "").trim(),
      referredBy: (referredBy || "").trim(),
      leadSource: (leadSource || "").trim(),
      followUpDate: (followUpDate || followUpDates || "").trim(),
      subDispositions: finalSubDisp,
      dispositions: finalDisp,
      validStatus: finalValidStatus,
      appointmentDate: (appointmentDate || "").trim(),
      appointmentMonth: (appointmentMonth || "").trim(),
      teleconsultationSlot: (teleconsultationSlot || appointmentSlot || "").trim(),
      consultationCharges: (consultationCharges || teleConsultationCharges || "").trim(),
      notes: "", // Reset after saving to history as per business rule
      notesHistory: initialNoteHistory,
      surgeryPaymentReceived: (surgeryPaymentReceived || surgeryReceipt || "").trim(),
      surgeryCost: (surgeryCost || "").trim(),
      surgeryDate: (surgeryDate || "").trim(),
      assignedDate: callerName ? todayDate : "",
      assignedAt: callerName ? new Date().toISOString() : "",
      customFields: customFields || {},
      auditLogs: [initialAudit],
    });

    invalidateDashboardCache();

    return res.status(201).json({
      message: "Lead created successfully",
      lead: newLead,
    });
  } catch (error: any) {
    console.error("Error creating lead:", error);
    return res.status(500).json({
      error: error.message || "Failed to create lead",
    });
  }
}

/**
 * GET /api/v1/leads/:id
 * Fetches a single lead by uniqueId or mongoId with agent ownership enforcement.
 */
export async function getLeadById(req: Request, res: Response) {
  try {
    const session = req.user!;
    const { id } = req.params;

    let lead = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      lead = await Lead.findById(id);
    }
    if (!lead) {
      lead = await Lead.findOne({ uniqueId: id });
    }

    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    // Agent permission check
    if (session.role === "agent") {
      const agentName = (session.name || "").trim().toLowerCase();
      const leadCaller = (lead.callerName || "").trim().toLowerCase();
      if (!leadCaller || leadCaller !== agentName) {
        return res.status(403).json({
          error: "Access denied. This lead is not assigned to you.",
        });
      }
    }

    return res.status(200).json({ lead });
  } catch (error: any) {
    console.error("Error fetching lead:", error);
    return res.status(500).json({
      error: error.message || "Failed to fetch lead",
    });
  }
}

/**
 * PUT /api/v1/leads/:id
 * Updates lead fields with strict agent field protection, mandatory notes/sub-disposition,
 * audit logging, and notes history.
 */
export async function updateLead(req: Request, res: Response) {
  try {
    const session = req.user!;
    const { id } = req.params;
    const body = req.body;

    let query: any = { uniqueId: id };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { $or: [{ _id: id }, { uniqueId: id }] };
    }

    const existingLead = await Lead.findOne(query);
    if (!existingLead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    // ── Agent Security & Validation ───────────────────────────────────────
    if (session.role === "agent") {
      const agentName = (session.name || "").trim().toLowerCase();
      const leadCaller = (existingLead.callerName || "").trim().toLowerCase();
      if (!leadCaller || leadCaller !== agentName) {
        return res.status(403).json({
          error: "Access denied. You can only update leads assigned to you.",
        });
      }

      // Preserve protected Section 1 values from existing lead
      body.uniqueId = existingLead.uniqueId;
      body.date = existingLead.date;
      body.dateOfLead = existingLead.dateOfLead;
      body.month = existingLead.month;
      body.leadTimestamp = existingLead.leadTimestamp;
      body.mobileNumber = existingLead.mobileNumber;
      body.phoneNumber = existingLead.phoneNumber;
      body.alternateNumber = existingLead.alternateNumber;
      body.callerName = existingLead.callerName;
      body.referredBy = existingLead.referredBy;
      body.patientName = body.patientName !== undefined ? body.patientName : existingLead.patientName;
      body.leadSource = body.leadSource !== undefined ? body.leadSource : existingLead.leadSource;

      const newNotes = (body.notes || "").trim();
      const newSubDisp = (body.subDispositions || "").trim();

      // Mandatory check: Both must be provided
      if (!newSubDisp) {
        return res.status(400).json({
          error: "Sub Dispositions is mandatory. Please select a Sub Disposition.",
        });
      }
      if (!newNotes) {
        return res.status(400).json({
          error: "Notes & Observations is mandatory. Please enter call remarks.",
        });
      }

      // Check if something changed
      const latestNoteInHistory =
        existingLead.notesHistory && existingLead.notesHistory.length > 0
          ? (existingLead.notesHistory[0]?.newNotes || "").trim()
          : "";
      const oldNotes = (existingLead.notes || "").trim() || latestNoteInHistory;
      const oldSubDisp = (existingLead.subDispositions || "").trim();
      const hadExistingData = oldNotes !== "" || oldSubDisp !== "";

      if (hadExistingData && oldNotes === newNotes && oldSubDisp === newSubDisp) {
        return res.status(400).json({ error: "not update any thing" });
      }
    }

    // Normalize phone numbers if modified
    if (body.mobileNumber) {
      body.normalizedPhone = normalizePhoneNumber(body.mobileNumber) || body.mobileNumber;
    }
    if (body.alternateNumber) {
      body.normalizedAlternate = normalizePhoneNumber(body.alternateNumber) || body.alternateNumber;
    }

    const submittedNotes = (body.notes || "").trim();

    // ── Audit Diff Tracking ──────────────────────────────────────────────
    const FIELD_LABELS: Record<string, string> = {
      patientName: "Patient Name",
      patientAge: "Patient Age",
      spouseName: "Spouse Name",
      spouseAge: "Spouse Age",
      location: "Location",
      otherCity: "Other City",
      lookingForTreatment: "Looking for Treatment",
      treatmentRequirements: "Treatment Requirements",
      preConditions: "Pre Conditions",
      surgeryDetails: "Surgery Details",
      referredBy: "Referred By",
      leadSource: "Lead Source",
      callerName: "Caller Name",
      date: "Lead Date",
      dateOfLead: "Lead Date",
      month: "Lead Month",
      mobileNumber: "Mobile Number",
      phoneNumber: "Mobile Number",
      alternateNumber: "Alternate #",
      followUpDate: "Follow Up Date",
      subDispositions: "Sub Dispositions",
      dispositions: "Dispositions",
      validStatus: "Valid Status",
      appointmentDate: "Appointment Date",
      appointmentMonth: "Appointment Month",
      teleconsultationSlot: "Teleconsultation Slot",
      consultationCharges: "Consultation Charges",
      surgeryDate: "Surgery Date",
      surgeryCost: "Surgery Cost",
      surgeryPaymentReceived: "Surgery Payment Received",
    };

    const changes: Array<{
      field: string;
      fieldLabel: string;
      oldValue: string;
      newValue: string;
    }> = [];

    const ignoredFields = new Set([
      "_id",
      "__v",
      "createdAt",
      "updatedAt",
      "auditLogs",
      "notesHistory",
      "createdBy",
      "treatment",
      "notes",
      "phoneNumber",
      "dateOfLead",
      "normalizedPhone",
      "normalizedAlternate",
    ]);

    for (const [key, label] of Object.entries(FIELD_LABELS)) {
      if (ignoredFields.has(key)) continue;
      if (body[key] !== undefined) {
        const oldVal = (existingLead.get(key) ?? "").toString().trim();
        const newVal = (body[key] ?? "").toString().trim();
        if (oldVal !== newVal) {
          changes.push({
            field: key,
            fieldLabel: label,
            oldValue: oldVal || "(empty)",
            newValue: newVal || "(empty)",
          });
        }
      }
    }

    // Build surgical atomic update operations
    const setUpdates: Record<string, any> = {};
    const pushUpdates: Record<string, any> = {};

    // Copy modified scalar fields to $set, excluding subdocument history arrays
    for (const [key, val] of Object.entries(body)) {
      if (key !== "auditLogs" && key !== "notesHistory" && key !== "_id") {
        setUpdates[key] = val;
      }
    }

    // Atomic push for note history entry if a new note was submitted
    if (submittedNotes) {
      const currentNotesHistory = existingLead.notesHistory || [];
      const previousNote =
        (existingLead.notes || "").trim() ||
        (currentNotesHistory.length > 0 ? (currentNotesHistory[0]?.newNotes || "").trim() : "");

      const newNoteEntry = {
        performedBy: session.name || "Unknown Member",
        performedByRole: session.role || "unknown",
        performedByEmail: session.email || "",
        timestamp: new Date().toISOString(),
        oldNotes: previousNote,
        newNotes: submittedNotes,
      };

      pushUpdates.notesHistory = {
        $each: [newNoteEntry],
        $position: 0,
      };
    }
    setUpdates.notes = ""; // Reset notes field

    // Atomic push for new audit log entry if changes occurred
    if (changes.length > 0) {
      const newAuditLog = {
        performedBy: session.name || "Unknown Member",
        performedByRole: session.role || "unknown",
        performedByEmail: session.email || "",
        timestamp: new Date().toISOString(),
        changes,
      };
      pushUpdates.auditLogs = {
        $each: [newAuditLog],
        $position: 0,
      };
    }

    // Stamp assignment date when callerName changes (for non-agents)
    if (session.role !== "agent") {
      const oldCaller = (existingLead.callerName || "").trim().toLowerCase();
      const newCaller = (body.callerName || "").trim().toLowerCase();
      if (newCaller && newCaller !== oldCaller) {
        setUpdates.assignedDate = getTodayDDMMMYY();
        setUpdates.assignedAt = new Date().toISOString();
      }
    }

    const updateOps: any = {};
    if (Object.keys(setUpdates).length > 0) updateOps.$set = setUpdates;
    if (Object.keys(pushUpdates).length > 0) updateOps.$push = pushUpdates;

    const updatedLead = await Lead.findOneAndUpdate(
      query,
      updateOps,
      { new: true, runValidators: true }
    );

    invalidateDashboardCache();

    return res.status(200).json({
      message: "Lead updated successfully",
      lead: updatedLead,
    });
  } catch (error: any) {
    console.error("Error updating lead:", error);
    return res.status(500).json({
      error: error.message || "Failed to update lead",
    });
  }
}

/**
 * DELETE /api/v1/leads/:id
 * Deletes a lead. Agents are strictly forbidden from deleting leads.
 */
export async function deleteLead(req: Request, res: Response) {
  try {
    const session = req.user!;

    if (session.role === "agent") {
      return res.status(403).json({
        error: "Forbidden. Agents are not permitted to delete leads.",
      });
    }

    const { id } = req.params;

    let query: any = { uniqueId: id };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { $or: [{ _id: id }, { uniqueId: id }] };
    }

    const deleted = await Lead.findOneAndDelete(query);
    if (!deleted) {
      return res.status(404).json({ error: "Lead not found" });
    }

    invalidateDashboardCache();

    return res.status(200).json({ message: "Lead deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting lead:", error);
    return res.status(500).json({
      error: error.message || "Failed to delete lead",
    });
  }
}

/**
 * GET /api/v1/leads/check-phone
 * Fast duplicate-phone check returning minimal identification fields.
 */
export async function checkPhone(req: Request, res: Response) {
  try {
    const session = req.user!;
    const rawInput = (req.query.phone as string) || "";
    const cleanDigits = rawInput.trim().replace(/\D/g, "");

    // If less than 4 digits, return empty array immediately without querying database
    if (cleanDigits.length < 4) {
      return res.status(200).json({ duplicates: [] });
    }

    const normalized = normalizePhoneNumber(rawInput);

    let orConditions: any[] = [];
    if (normalized) {
      // 1. High-Performance Indexed Exact Match on normalized fields
      orConditions.push(
        { normalizedPhone: normalized },
        { normalizedAlternate: normalized },
        // Exact match on raw fields as well
        { mobileNumber: normalized },
        { alternateNumber: normalized },
        { phoneNumber: normalized }
      );
    } else {
      // Fallback for partial/short phone queries (e.g. 4-6 digits)
      const phoneRegex = new RegExp(cleanDigits, "i");
      orConditions.push(
        { mobileNumber: { $regex: phoneRegex } },
        { alternateNumber: { $regex: phoneRegex } },
        { phoneNumber: { $regex: phoneRegex } }
      );
    }

    const query: any = { $or: orConditions };

    // If agent, restrict to agent's assigned leads
    if (session.role === "agent") {
      const agentName = (session.name || "").trim();
      query.callerName = {
        $regex: new RegExp(`^${agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      };
    }

    const duplicates = await Lead.find(query)
      .select({
        uniqueId: 1,
        patientName: 1,
        mobileNumber: 1,
        alternateNumber: 1,
        phoneNumber: 1,
        location: 1,
        callerName: 1,
        dispositions: 1,
      })
      .limit(10)
      .lean();

    return res.status(200).json({ duplicates });
  } catch (error: any) {
    console.error("Error checking phone duplicate:", error);
    return res.status(500).json({
      error: error.message || "Failed to check phone number",
    });
  }
}
