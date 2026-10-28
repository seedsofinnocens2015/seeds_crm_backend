import { Request, Response } from "express";
import mongoose from "mongoose";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import {
  getFormattedTimestamp,
  getTodayDDMMMYY,
  getCurrentMonthMMMYY,
  calculateLeadAge,
  calculateLeadScore,
  SUB_DISPOSITIONS_MAP,
  CAMP_TO_CENTRE_MAP,
} from "../utils/dateUtils.js";
import { normalizePhoneNumber } from "../utils/phoneUtils.js";
import {
  getNextUniqueId,
  peekNextUniqueId,
  resetCounterToActualMax,
} from "../utils/idGenerator.js";
import { invalidateDashboardCache } from "../utils/cacheInvalidation.js";
import { enqueueLeadForSmartflo } from "../services/smartflo/smartfloSyncService.js";

// Projection for table view: excludes heavy auditLogs and notesHistory
const TABLE_VIEW_PROJECTION = {
  auditLogs: 0,
  notesHistory: 0,
};

/**
 * GET /api/v1/leads
 * Server-side pagination, projection, and role-based filtering.
 * Agents are strictly restricted to leads assigned to their callerName / leadOwner.
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
      const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query = {
        $or: [
          { callerName: { $regex: new RegExp(`^${escaped}$`, "i") } },
          { leadOwner: { $regex: new RegExp(`^${escaped}$`, "i") } },
        ],
      };
    }

    // Special lightweight view for dashboard calculations if requested
    if (view === "dashboard") {
      const dashboardProjection = {
        uniqueId: 1,
        patientName: 1,
        wifeName: 1,
        husbandName: 1,
        primaryMobileNumber: 1,
        mobileNumber: 1,
        callerName: 1,
        leadOwner: 1,
        month: 1,
        date: 1,
        createdOn: 1,
        firstActivityDate: 1,
        appointmentMonth: 1,
        appointmentDate: 1,
        centreLocation: 1,
        campLocation: 1,
        location: 1,
        subStatus: 1,
        leadStage: 1,
        leadValidStatus: 1,
        subDispositions: 1,
        dispositions: 1,
        validStatus: 1,
        leadSource: 1,
        campaignName: 1,
        source: 1,
        followUpDateTime: 1,
        followUpDate: 1,
        createdAt: 1,
      };

      const leads = await Lead.find(query)
        .select(dashboardProjection)
        .sort({ createdAt: -1 })
        .lean();

      return res.status(200).json({ leads, totalCount: leads.length });
    }

    // Pagination Parameters
    let page = parseInt(pageParam || "1", 10);
    if (isNaN(page) || page < 1) {
      page = 1;
    }

    let limit = 10000;
    if (limitParam !== undefined && limitParam !== null && limitParam !== "") {
      if (limitParam.toLowerCase() === "all" || limitParam === "0") {
        limit = 0;
      } else {
        const parsedLimit = parseInt(limitParam, 10);
        if (!isNaN(parsedLimit) && parsedLimit > 0) {
          limit = parsedLimit;
        }
      }
    }

    const [leads, totalCount, nextUniqueId] = await Promise.all([
      limit === 0
        ? Lead.find(query)
            .select(TABLE_VIEW_PROJECTION)
            .sort({ createdAt: -1 })
            .lean()
        : Lead.find(query)
            .select(TABLE_VIEW_PROJECTION)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
      Lead.countDocuments(query),
      peekNextUniqueId(),
    ]);

    // Dynamic real-time calculation of leadAge for each lead
    const enrichedLeads = leads.map((l: any) => ({
      ...l,
      leadAge: calculateLeadAge(l.createdOn || l.createdAt || l.date),
    }));

    const duration = Date.now() - startTime;
    res.setHeader("Server-Timing", `db;dur=${duration}`);

    return res.status(200).json({
      leads: enrichedLeads,
      totalCount,
      page: limit === 0 ? 1 : page,
      totalPages: limit === 0 ? 1 : Math.ceil(totalCount / limit),
      limit,
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
 * GET /api/v1/leads/:id
 * Fetches single lead document by uniqueId, or _id.
 */
export async function getLeadById(req: Request, res: Response) {
  try {
    const session = req.user!;
    const { id } = req.params;

    let query: any = {
      $or: [
        { uniqueId: id },
        ],
    };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query.$or.push({ _id: id });
    }

    const lead = await Lead.findOne(query).lean();
    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    // Role-based access control: agents can only view their own leads
    if (session.role === "agent") {
      const agentName = (session.name || "").trim().toLowerCase();
      const leadCaller = (lead.callerName || "").trim().toLowerCase();
      const leadOwner = (lead.leadOwner || "").trim().toLowerCase();
      if (leadCaller !== agentName && leadOwner !== agentName) {
        return res.status(403).json({
          error: "Access denied. You can only view leads assigned to you.",
        });
      }
    }

    // Enrich real-time lead age
    (lead as any).leadAge = calculateLeadAge(lead.createdOn || lead.createdAt || lead.date);

    return res.status(200).json({ lead });
  } catch (error: any) {
    console.error("Error fetching lead:", error);
    return res.status(500).json({
      error: error.message || "Failed to fetch lead",
    });
  }
}

/**
 * POST /api/v1/leads
 * Creates a new lead with all mandated & auto-filled fields.
 */
export async function createLead(req: Request, res: Response) {
  try {
    const session = req.user!;
    const body = req.body;

    let {
      uniqueId,
      firstActivityDate,
      husbandName,
      wifeName,
      husbandAge,
      wifeAge,
      whenPlanningToStartTreatment,
      preMedicalConditions,
      marriedSince,
      tryingToConceiveYears,
      primaryEmail,
      secondaryEmail,
      primaryMobileNumber,
      secondaryMobileNumber,
      whatsappMobileNumber,
      otherNumbers,
      whatsappConsent,
      callingConsent,
      leadSource,
      utmSource,
      campaignName,
      sourceName,
      source,
      leadScore,
      subStatus,
      leadStage,
      leadValidStatus,
      centreAddress,
      ptAddress,
      ptPincode,
      ptCountry,
      ptState,
      ptCity,
      leadOwner,
      campLocation,
      centreLocation,
      followUpDateTime,
      centreVisitedDate,
      campVisitedDate,
      appointmentDate,
      registrationStatus,
      registrationNumber,
      registrationAmount,
      package: pkg,
      plan,
      notes,
      customFields,
      // Legacy fields
      mobileNumber,
      phoneNumber,
      patientName,
      patientAge,
      spouseName,
      spouseAge,
      callerName,
      location,
      otherCity,
      lookingForTreatment,
      preConditions,
      surgeryDetails,
      treatmentRequirements,
      referredBy,
      followUpDate,
      subDispositions,
      dispositions,
      validStatus,
    } = body;

    // Field normalization: Primary Mobile Number
    const finalPrimaryMobile = (primaryMobileNumber || mobileNumber || phoneNumber || "").trim();
    if (!finalPrimaryMobile) {
      return res.status(400).json({ error: "Primary Mobile number is mandatory." });
    }

    // Validation: Wife Name / Patient Name
    const finalWife = (wifeName || patientName || "").trim();
    if (!finalWife) {
      return res.status(400).json({ error: "Wife Name is mandatory." });
    }

    // Validation: Husband Name
    const finalHusband = (husbandName || spouseName || "").trim();
    if (!finalHusband) {
      return res.status(400).json({ error: "Husband Name is mandatory." });
    }

    // Validation: Ages (2 digits)
    const finalHusbandAge = (husbandAge || spouseAge || "").toString().trim();
    const finalWifeAge = (wifeAge || patientAge || "").toString().trim();
    if (!finalHusbandAge || !/^\d{2}$/.test(finalHusbandAge)) {
      return res.status(400).json({ error: "Husband Age is mandatory and must be a 2 digit number." });
    }
    if (!finalWifeAge || !/^\d{2}$/.test(finalWifeAge)) {
      return res.status(400).json({ error: "Wife Age is mandatory and must be a 2 digit number." });
    }

    // Pre Medical Conditions (Mandate)
    const finalPreMedical = (preMedicalConditions || preConditions || "No").trim();

    // Married Since & Trying to conceive (Mandate Numbers only)
    const finalMarriedSince = (marriedSince || "").toString().trim();
    const finalTryingYears = (tryingToConceiveYears || "").toString().trim();
    if (!finalMarriedSince) {
      return res.status(400).json({ error: "Married Since is mandatory and should only be numbers." });
    }
    if (!finalTryingYears) {
      return res.status(400).json({ error: "How long you are trying to conceive is mandatory and should only be numbers." });
    }

    // Centre Location & Camp Location auto-fill
    let finalCampLocation = (campLocation || "").trim();
    let finalCentreLocation = (centreLocation || location || otherCity || "").trim();
    if (finalCampLocation && CAMP_TO_CENTRE_MAP[finalCampLocation]) {
      if (!finalCentreLocation) {
        finalCentreLocation = CAMP_TO_CENTRE_MAP[finalCampLocation];
      }
    }
    if (!finalCentreLocation) {
      return res.status(400).json({ error: "Centre Location is mandatory." });
    }

    // Sub Status -> Auto fills Lead Stage & Lead Valid Status
    const finalSubStatus = (subStatus || subDispositions || "").trim();
    if (!finalSubStatus) {
      return res.status(400).json({ error: "Sub Status is mandatory." });
    }

    let finalLeadStage = (leadStage || dispositions || "").trim();
    let finalLeadValidStatus = (leadValidStatus || validStatus || "").trim();
    if (SUB_DISPOSITIONS_MAP[finalSubStatus]) {
      finalLeadStage = SUB_DISPOSITIONS_MAP[finalSubStatus].disposition;
      finalLeadValidStatus = SUB_DISPOSITIONS_MAP[finalSubStatus].validStatus;
    }

    // Calculate Lead Score dynamically based on 6 clinical criteria
    const computedLeadScore = calculateLeadScore({
      husbandAge: finalHusbandAge,
      wifeAge: finalWifeAge,
      preMedicalConditions: finalPreMedical,
      marriedSince: finalMarriedSince,
      tryingToConceiveYears: finalTryingYears,
      whenPlanningToStartTreatment: whenPlanningToStartTreatment || lookingForTreatment,
    });
    if ((finalSubStatus === "Visited Centre" || finalSubStatus === "Visited at Centre") && !centreVisitedDate) {
      return res.status(400).json({
        error: "Centre Visited Date is mandatory when Sub status is 'Visited Centre'.",
      });
    }
    if ((finalSubStatus === "Visited Camp" || finalSubStatus === "Visited at Camp") && !campVisitedDate) {
      return res.status(400).json({
        error: "Camp Visited Date is mandatory when Sub status is 'Visited Camp'.",
      });
    }

    // Follow Up Date and Time: empty if Stage is Converted/Closed
    let finalFollowUp = (followUpDateTime || followUpDate || "").trim();
    if (finalLeadStage === "Converted" || finalLeadStage === "Closed") {
      finalFollowUp = "";
    }

    // Notes is mandatory
    const submittedNotes = (notes || "").trim();
    if (!submittedNotes) {
      return res.status(400).json({ error: "Notes is mandatory." });
    }

    // Auto-generate IDs
    uniqueId = await getNextUniqueId();
    const todayDate = getTodayDDMMMYY();
    const currentMonth = getCurrentMonthMMMYY();
    const currentTimestamp = getFormattedTimestamp(new Date());

    if (!firstActivityDate) {
      firstActivityDate = currentTimestamp;
    }

    // Lead Owner (Optional): if not provided by admin/user, can remain empty / unassigned
    let finalOwner = (leadOwner || callerName || "").trim();
    if (session.role === "agent" && !finalOwner) {
      finalOwner = (session.name || "").trim();
    }

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

    const initialNoteHistory = [
      {
        performedBy: session.name || "User",
        performedByRole: session.role || "unknown",
        performedByEmail: session.email || "",
        timestamp: new Date().toISOString(),
        oldNotes: "",
        newNotes: submittedNotes,
      },
    ];

    const normalizedPhone = normalizePhoneNumber(finalPrimaryMobile) || finalPrimaryMobile;
    const normalizedAlternate = secondaryMobileNumber
      ? normalizePhoneNumber(secondaryMobileNumber) || ""
      : "";

    const newLead = await Lead.create({
      // Primary Identifiers
      uniqueId,
      firstActivityDate,

      // Couple Profile
      husbandName: finalHusband,
      wifeName: finalWife,
      husbandAge: finalHusbandAge,
      wifeAge: finalWifeAge,

      // Treatment & Clinical
      whenPlanningToStartTreatment: (whenPlanningToStartTreatment || lookingForTreatment || "").trim(),
      preMedicalConditions: finalPreMedical,
      marriedSince: finalMarriedSince,
      tryingToConceiveYears: finalTryingYears,

      // Emails
      primaryEmail: (primaryEmail || "").trim(),
      secondaryEmail: (secondaryEmail || "").trim(),

      // Mobile numbers
      primaryMobileNumber: finalPrimaryMobile,
      secondaryMobileNumber: (secondaryMobileNumber || "").trim(),
      whatsappMobileNumber: (whatsappMobileNumber || "").trim(),
      otherNumbers: (otherNumbers || "").trim(),

      // Consents
      whatsappConsent: (whatsappConsent || "No").trim(),
      callingConsent: (callingConsent || "No").trim(),

      // Source & Attribution
      leadSource: (leadSource || utmSource || "General").trim(),
      utmSource: (utmSource || leadSource || "").trim(),
      campaignName: (campaignName || "General").trim(),
      sourceName: (sourceName || "").trim(),
      source: (source || "General").trim(),
      leadScore: computedLeadScore || (leadScore || "0").trim(),

      // Status & Dispositions
      subStatus: finalSubStatus,
      leadStage: finalLeadStage,
      leadValidStatus: finalLeadValidStatus,

      // Audit & Timestamps
      createdByMember: session.name || "User",
      createdOn: currentTimestamp,
      modifiedByMember: session.name || "User",
      modifiedOn: currentTimestamp,

      // Address Details
      centreAddress: (centreAddress || `${finalCentreLocation} Centre`).trim(),
      ptAddress: (ptAddress || "").trim(),
      ptPincode: (ptPincode || "").trim(),
      ptCountry: (ptCountry || "India").trim(),
      ptState: (ptState || "").trim(),
      ptCity: (ptCity || "").trim(),

      // Ownership & Dates
      leadOwner: finalOwner,
      leadAge: "0 days",
      campLocation: finalCampLocation,
      centreLocation: finalCentreLocation,
      followUpDateTime: finalFollowUp,
      centreVisitedDate: (centreVisitedDate || "").trim(),
      campVisitedDate: (campVisitedDate || "").trim(),
      appointmentDate: (appointmentDate || "").trim(),

      // Registration & Plan
      registrationStatus: (registrationStatus || "No").trim(),
      registrationNumber: (registrationNumber || "").trim(),
      registrationAmount: (registrationAmount || "").trim(),
      package: (pkg || "").trim(),
      plan: (plan || "").trim(),

      // Notes
      notes: submittedNotes,
      notesHistory: initialNoteHistory,

      // Indexed normalized phones
      normalizedPhone,
      normalizedAlternate,

      // Backwards-compatible fields
      patientName: finalWife,
      patientAge: finalWifeAge,
      spouseName: finalHusband,
      spouseAge: finalHusbandAge,
      mobileNumber: finalPrimaryMobile,
      phoneNumber: finalPrimaryMobile,
      alternateNumber: (secondaryMobileNumber || "").trim(),
      callerName: finalOwner,
      location: finalCentreLocation,
      subDispositions: finalSubStatus,
      dispositions: finalLeadStage,
      validStatus: finalLeadValidStatus,
      date: todayDate,
      dateOfLead: todayDate,
      month: currentMonth,
      leadTimestamp: currentTimestamp,
      followUpDate: finalFollowUp,
      assignedDate: finalOwner ? todayDate : "",
      assignedAt: finalOwner ? new Date().toISOString() : "",

      customFields: customFields || {},
      auditLogs: [initialAudit],
    });

    invalidateDashboardCache();

    // Asynchronously enqueue lead for Smartflo synchronization (non-blocking)
    enqueueLeadForSmartflo(newLead._id, newLead.uniqueId).catch((err) => {
      console.error("[Smartflo Lead Hook] Background enqueue error:", err.message);
    });

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
 * PUT /api/v1/leads/:id
 * Updates lead with comprehensive audit logging, status cascade, and validation.
 */
export async function updateLead(req: Request, res: Response) {
  try {
    const session = req.user!;
    const { id } = req.params;
    const body = req.body;

    let query: any = {
      $or: [
        { uniqueId: id },
        ],
    };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query.$or.push({ _id: id });
    }

    const existingLead = await Lead.findOne(query);
    if (!existingLead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    // Role check for agents
    if (session.role === "agent") {
      const agentName = (session.name || "").trim().toLowerCase();
      const leadCaller = (existingLead.callerName || "").trim().toLowerCase();
      const leadOwner = (existingLead.leadOwner || "").trim().toLowerCase();
      if (leadCaller !== agentName && leadOwner !== agentName) {
        return res.status(403).json({
          error: "Access denied. You can only update leads assigned to you.",
        });
      }
    }

    // Handle Sub Status cascading
    if (body.subStatus && SUB_DISPOSITIONS_MAP[body.subStatus]) {
      body.leadStage = SUB_DISPOSITIONS_MAP[body.subStatus].disposition;
      body.leadValidStatus = SUB_DISPOSITIONS_MAP[body.subStatus].validStatus;
      // Also update legacy
      body.subDispositions = body.subStatus;
      body.dispositions = body.leadStage;
      body.validStatus = body.leadValidStatus;
    } else if (body.subDispositions && SUB_DISPOSITIONS_MAP[body.subDispositions]) {
      body.subStatus = body.subDispositions;
      body.leadStage = SUB_DISPOSITIONS_MAP[body.subDispositions].disposition;
      body.leadValidStatus = SUB_DISPOSITIONS_MAP[body.subDispositions].validStatus;
      body.dispositions = body.leadStage;
      body.validStatus = body.leadValidStatus;
    }

    // Camp to Centre Location cascade
    if (body.campLocation && CAMP_TO_CENTRE_MAP[body.campLocation] && !body.centreLocation) {
      body.centreLocation = CAMP_TO_CENTRE_MAP[body.campLocation];
      body.location = body.centreLocation;
    }

    // Recompute Lead Score if any of the 6 clinical/demographic criteria are modified
    const hAge = body.husbandAge !== undefined ? body.husbandAge : existingLead.husbandAge;
    const wAge = body.wifeAge !== undefined ? body.wifeAge : existingLead.wifeAge;
    const med = body.preMedicalConditions !== undefined ? body.preMedicalConditions : existingLead.preMedicalConditions;
    const ms = body.marriedSince !== undefined ? body.marriedSince : existingLead.marriedSince;
    const ttc = body.tryingToConceiveYears !== undefined ? body.tryingToConceiveYears : existingLead.tryingToConceiveYears;
    const when = body.whenPlanningToStartTreatment !== undefined ? body.whenPlanningToStartTreatment : existingLead.whenPlanningToStartTreatment;

    body.leadScore = calculateLeadScore({
      husbandAge: hAge,
      wifeAge: wAge,
      preMedicalConditions: med,
      marriedSince: ms,
      tryingToConceiveYears: ttc,
      whenPlanningToStartTreatment: when,
    });

    // Empty followUpDateTime if Converted or Closed
    const effectiveStage = body.leadStage || existingLead.leadStage;
    if (effectiveStage === "Converted" || effectiveStage === "Closed") {
      body.followUpDateTime = "";
      body.followUpDate = "";
    }

    // Normalizations
    if (body.primaryMobileNumber || body.mobileNumber) {
      const p = body.primaryMobileNumber || body.mobileNumber;
      body.primaryMobileNumber = p;
      body.mobileNumber = p;
      body.normalizedPhone = normalizePhoneNumber(p) || p;
    }
    if (body.secondaryMobileNumber || body.alternateNumber) {
      const a = body.secondaryMobileNumber || body.alternateNumber;
      body.secondaryMobileNumber = a;
      body.alternateNumber = a;
      body.normalizedAlternate = normalizePhoneNumber(a) || a;
    }

    // Sync legacy/new couple names
    if (body.wifeName && !body.patientName) body.patientName = body.wifeName;
    if (body.husbandName && !body.spouseName) body.spouseName = body.husbandName;
    if (body.wifeAge && !body.patientAge) body.patientAge = body.wifeAge;
    if (body.husbandAge && !body.spouseAge) body.spouseAge = body.husbandAge;

    const currentTimestamp = getFormattedTimestamp(new Date());
    body.modifiedByMember = session.name || "User";
    body.modifiedOn = currentTimestamp;

    // Track Audit Log
    const FIELD_LABELS: Record<string, string> = {
      husbandName: "Husband Name",
      wifeName: "Wife Name",
      husbandAge: "Husband Age",
      wifeAge: "Wife Age",
      whenPlanningToStartTreatment: "Planning Treatment",
      preMedicalConditions: "Pre Medical Conditions",
      marriedSince: "Married Since",
      tryingToConceiveYears: "Trying to Conceive",
      primaryEmail: "Primary Email",
      secondaryEmail: "Secondary Email",
      primaryMobileNumber: "Primary Mobile",
      secondaryMobileNumber: "Secondary Mobile",
      whatsappMobileNumber: "Whatsapp Mobile",
      subStatus: "Sub Status",
      leadStage: "Lead Stage",
      leadValidStatus: "Lead Valid Status",
      centreLocation: "Centre Location",
      campLocation: "Camp Location",
      centreAddress: "Centre Address",
      ptAddress: "Pt Address",
      ptPincode: "Pt Pincode",
      ptCity: "Pt City",
      ptState: "Pt State",
      leadOwner: "Lead Owner",
      followUpDateTime: "Follow Up Date & Time",
      appointmentDate: "Appointment Date",
      centreVisitedDate: "Centre Visited Date",
      campVisitedDate: "Camp Visited Date",
      registrationStatus: "Registration Status",
      registrationNumber: "Registration Number",
      registrationAmount: "Registration Amount",
      package: "Package",
      plan: "Plan",
    };

    const changes: Array<{
      field: string;
      fieldLabel: string;
      oldValue: string;
      newValue: string;
    }> = [];

    for (const [key, label] of Object.entries(FIELD_LABELS)) {
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

    const setUpdates: Record<string, any> = { ...body };
    delete setUpdates._id;
    delete setUpdates.auditLogs;
    delete setUpdates.notesHistory;

    const pushUpdates: Record<string, any> = {};

    if (changes.length > 0) {
      pushUpdates.auditLogs = {
        $each: [
          {
            performedBy: session.name || "User",
            performedByRole: session.role || "unknown",
            performedByEmail: session.email || "",
            timestamp: new Date().toISOString(),
            changes,
          },
        ],
        $position: 0,
      };
    }

    // Notes history
    const submittedNotes = (body.notes || "").trim();
    if (submittedNotes) {
      pushUpdates.notesHistory = {
        $each: [
          {
            performedBy: session.name || "User",
            performedByRole: session.role || "unknown",
            performedByEmail: session.email || "",
            timestamp: new Date().toISOString(),
            oldNotes: existingLead.notes || "",
            newNotes: submittedNotes,
          },
        ],
        $position: 0,
      };
      setUpdates.notes = submittedNotes;
    }

    const updateOps: any = { $set: setUpdates };
    if (Object.keys(pushUpdates).length > 0) {
      updateOps.$push = pushUpdates;
    }

    const updatedLead = await Lead.findByIdAndUpdate(existingLead._id, updateOps, {
      new: true,
      runValidators: false,
    });

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
 */
export async function deleteLead(req: Request, res: Response) {
  try {
    const session = req.user!;
    if (session.role !== "admin") {
      return res.status(403).json({ error: "Only admins can delete leads" });
    }

    const { id } = req.params;
    let query: any = {
      $or: [
        { uniqueId: id },
        ],
    };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query.$or.push({ _id: id });
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
 * Real-time duplication checker for phone numbers.
 */
export async function checkPhone(req: Request, res: Response) {
  try {
    const raw = req.query.phone as string | undefined;
    if (!raw || !raw.trim()) {
      return res.status(200).json({ duplicates: [] });
    }

    const clean = raw.trim();
    const normalized = normalizePhoneNumber(clean) || clean;

    const duplicates = await Lead.find({
      $or: [
        { primaryMobileNumber: clean },
        { secondaryMobileNumber: clean },
        { normalizedPhone: normalized },
        { normalizedAlternate: normalized },
        { mobileNumber: clean },
        { phoneNumber: clean },
      ],
    })
      .select({
        uniqueId: 1,
        wifeName: 1,
        husbandName: 1,
        patientName: 1,
        primaryMobileNumber: 1,
        secondaryMobileNumber: 1,
        mobileNumber: 1,
        centreLocation: 1,
        location: 1,
      })
      .limit(5)
      .lean();

    return res.status(200).json({ duplicates });
  } catch (error: any) {
    console.error("Error checking phone duplicate:", error);
    return res.status(500).json({ error: "Failed to check phone duplicates" });
  }
}


/**
 * POST /api/v1/leads/reset-counter
 * Resets counter to match actual existing leads in the database
 */
export async function resetLeadCounter(req: Request, res: Response) {
  try {
    const maxNum = await resetCounterToActualMax();
    const nextUniqueId = await peekNextUniqueId();
    return res.status(200).json({
      message: 'Counter synchronized successfully',
      currentMaxSeq: maxNum,
      nextUniqueId,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to reset counter' });
  }
}
