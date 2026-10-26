import mongoose, { Schema, Document, Model } from "mongoose";

export interface IChangeItem {
  field: string;
  fieldLabel: string;
  oldValue: string;
  newValue: string;
}

export interface IAuditLog {
  _id?: string;
  performedBy: string; // Member name
  performedByRole: string; // "admin" | "team_leader" | "agent"
  performedByEmail?: string;
  timestamp: string; // ISO / formatted string
  changes: IChangeItem[];
}

export interface INoteHistory {
  _id?: string;
  performedBy: string;
  performedByRole: string; // "admin" | "team_leader" | "agent"
  performedByEmail?: string;
  timestamp: string;
  oldNotes?: string;
  newNotes: string;
}

export interface ILead extends Document {
  // Primary Identifiers
      uniqueId: string; // Internal Unique ID e.g. "SOI-1" (for compatibility)
  firstActivityDate?: string; // Autofill Mandate timestamp

  // Couple Profile
  husbandName?: string; // Agent Mandate
  wifeName?: string; // Agent Mandate
  husbandAge?: string; // Agent Mandate (2 digit)
  wifeAge?: string; // Agent Mandate (2 digit)

  // Treatment & Clinical
  whenPlanningToStartTreatment?: string; // Agent Non-mandate (Dropdown)
  preMedicalConditions?: string; // Agent Mandate ("Yes" | "No")
  marriedSince?: string; // Agent Mandate (Numbers only)
  tryingToConceiveYears?: string; // Agent Mandate (Numbers only)

  // Emails
  primaryEmail?: string; // Agent Non-mandate (Pt Email)
  secondaryEmail?: string; // Agent Non-mandate (Spouse Email)

  // Phone Numbers
  primaryMobileNumber: string; // Agent Mandate (Wife Mobile #, country code req, min 10 max 14)
  secondaryMobileNumber?: string; // Agent Non-mandate
  whatsappMobileNumber?: string; // Agent Non-mandate
  otherNumbers?: string; // Agent Non-mandate

  // Consents
  whatsappConsent?: string; // Agent Non-mandate ("Yes" | "No")
  callingConsent?: string; // Agent Non-mandate ("Yes" | "No")

  // Source & Attribution
  leadSource?: string; // Autofill Mandate (Lead Source / UTM Source)
  utmSource?: string; // Alias
  campaignName?: string; // Autofill Mandate (Dropdown List)
  sourceName?: string; // Source Name identifier/phone/campaign mapping
  source?: string; // Autofill Mandate (Meta/Google/General)
  leadScore?: string; // Autofill Mandate (Score based on 5 Questions)

  // Status & Disposition
  subStatus?: string; // Agent Mandate (Defined Disposition)
  leadStage?: string; // Autofill Mandate (Based on Sub Status)
  leadValidStatus?: string; // Autofill Mandate (Based on Sub Status)

  // System & Audit
  createdByMember?: string; // Autofill Mandate (Name of creator)
  createdOn?: string; // Autofill Mandate (Time Stamp)
  modifiedByMember?: string; // Autofill Mandate (Name of modifier)
  modifiedOn?: string; // Autofill Mandate (Time Stamp)

  // Address Details
  centreAddress?: string; // Autofill Mandate (Centre Address with location link)
  ptAddress?: string; // Agent Non-mandate (Patient complete Address)
  ptPincode?: string; // Agent Non-mandate (Patient Residing Pincode)
  ptCountry?: string; // Agent Non-mandate (Patient Residing Country)
  ptState?: string; // Autofill Non-mandate (Patient Residing State)
  ptCity?: string; // Autofill Non-mandate (Patient Residing City)

  // Ownership & Dates
  leadOwner?: string; // Autofill Mandate (Owner of the lead)
  leadAge?: string; // Autofill Mandate ((Today) - (Created Date))
  campLocation?: string; // Agent Optional (Dropdown)
  centreLocation?: string; // Agent Mandate (Dropdown of Centre Locations. Autofilled if Camp Location filled)
  followUpDateTime?: string; // Agent Optional (Next date & time to follow up. Empty if Converted/Closed)
  centreVisitedDate?: string; // Agent Optional (Mandate if Sub status is "Visited at Centre")
  campVisitedDate?: string; // Agent Optional (Mandate if Sub status is "Visited at Camp")
  appointmentDate?: string; // Agent Optional (Date of appointment to visit)

  // Registration & Plan
  registrationStatus?: string; // Autofill Non-mandate ("Yes" | "No")
  registrationNumber?: string; // Autofill Non-mandate
  registrationAmount?: string; // Autofill Non-mandate
  package?: string; // Autofill Non-mandate
  plan?: string; // Autofill Non-mandate

  // Notes
  notes?: string; // Agent Mandate (Open text for adding notes)

  // Normalized phone fields for high performance lookup
  normalizedPhone?: string;
  normalizedAlternate?: string;

  // Legacy field support for backwards-compatibility
  patientName?: string;
  patientAge?: string;
  spouseName?: string;
  spouseAge?: string;
  mobileNumber?: string;
  phoneNumber?: string;
  alternateNumber?: string;
  callerName?: string;
  date?: string;
  dateOfLead?: string;
  month?: string;
  leadTimestamp?: string;
  location?: string;
  otherCity?: string;
  lookingForTreatment?: string;
  preConditions?: string;
  surgeryDetails?: string;
  treatmentRequirements?: string;
  referredBy?: string;
  followUpDate?: string;
  subDispositions?: string;
  dispositions?: string;
  validStatus?: string;
  appointmentMonth?: string;
  teleconsultationSlot?: string;
  consultationCharges?: string;
  surgeryPaymentReceived?: string;
  surgeryCost?: string;
  surgeryDate?: string;
  assignedDate?: string;
  assignedAt?: string;

  createdBy?: mongoose.Types.ObjectId;
  customFields?: Record<string, any>;
  auditLogs?: IAuditLog[];
  notesHistory?: INoteHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const ChangeItemSchema = new Schema<IChangeItem>(
  {
    field: { type: String, required: true },
    fieldLabel: { type: String, required: true },
    oldValue: { type: String, default: "" },
    newValue: { type: String, default: "" },
  },
  { _id: false }
);

const AuditLogSchema = new Schema<IAuditLog>(
  {
    performedBy: { type: String, required: true },
    performedByRole: { type: String, required: true },
    performedByEmail: { type: String, default: "" },
    timestamp: { type: String, default: () => new Date().toISOString() },
    changes: [ChangeItemSchema],
  },
  { _id: true }
);

const NoteHistorySchema = new Schema<INoteHistory>(
  {
    performedBy: { type: String, required: true },
    performedByRole: { type: String, required: true },
    performedByEmail: { type: String, default: "" },
    timestamp: { type: String, default: () => new Date().toISOString() },
    oldNotes: { type: String, default: "" },
    newNotes: { type: String, required: true },
  },
  { _id: true }
);

const LeadSchema = new Schema<ILead>(
  {
    // Primary Identifiers
    
    
    uniqueId: {
      type: String,
      required: [true, "Unique ID is required"],
      trim: true,
      unique: true,
      index: true,
    },
    firstActivityDate: {
      type: String,
      default: "",
      trim: true,
    },

    // Couple Profile
    husbandName: {
      type: String,
      default: "",
      trim: true,
    },
    wifeName: {
      type: String,
      default: "",
      trim: true,
    },
    husbandAge: {
      type: String,
      default: "",
      trim: true,
    },
    wifeAge: {
      type: String,
      default: "",
      trim: true,
    },

    // Treatment & Clinical
    whenPlanningToStartTreatment: {
      type: String,
      default: "",
      trim: true,
    },
    preMedicalConditions: {
      type: String,
      default: "",
      trim: true,
    },
    marriedSince: {
      type: String,
      default: "",
      trim: true,
    },
    tryingToConceiveYears: {
      type: String,
      default: "",
      trim: true,
    },

    // Emails
    primaryEmail: {
      type: String,
      default: "",
      trim: true,
    },
    secondaryEmail: {
      type: String,
      default: "",
      trim: true,
    },

    // Mobile numbers
    primaryMobileNumber: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    secondaryMobileNumber: {
      type: String,
      default: "",
      trim: true,
    },
    whatsappMobileNumber: {
      type: String,
      default: "",
      trim: true,
    },
    otherNumbers: {
      type: String,
      default: "",
      trim: true,
    },

    // Consents
    whatsappConsent: {
      type: String,
      default: "No",
      trim: true,
    },
    callingConsent: {
      type: String,
      default: "No",
      trim: true,
    },

    // Source & Attribution
    leadSource: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    utmSource: {
      type: String,
      default: "",
      trim: true,
    },
    campaignName: {
      type: String,
      default: "",
      trim: true,
    },
    sourceName: {
      type: String,
      default: "",
      trim: true,
    },
    source: {
      type: String,
      default: "General",
      trim: true,
    },
    leadScore: {
      type: String,
      default: "0",
      trim: true,
    },

    // Status & Dispositions
    subStatus: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    leadStage: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    leadValidStatus: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    // Creator & Modifier Details
    createdByMember: {
      type: String,
      default: "",
      trim: true,
    },
    createdOn: {
      type: String,
      default: "",
      trim: true,
    },
    modifiedByMember: {
      type: String,
      default: "",
      trim: true,
    },
    modifiedOn: {
      type: String,
      default: "",
      trim: true,
    },

    // Address Details
    centreAddress: {
      type: String,
      default: "",
      trim: true,
    },
    ptAddress: {
      type: String,
      default: "",
      trim: true,
    },
    ptPincode: {
      type: String,
      default: "",
      trim: true,
    },
    ptCountry: {
      type: String,
      default: "India",
      trim: true,
    },
    ptState: {
      type: String,
      default: "",
      trim: true,
    },
    ptCity: {
      type: String,
      default: "",
      trim: true,
    },

    // Ownership & Dates
    leadOwner: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    leadAge: {
      type: String,
      default: "0 days",
      trim: true,
    },
    campLocation: {
      type: String,
      default: "",
      trim: true,
    },
    centreLocation: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    followUpDateTime: {
      type: String,
      default: "",
      trim: true,
    },
    centreVisitedDate: {
      type: String,
      default: "",
      trim: true,
    },
    campVisitedDate: {
      type: String,
      default: "",
      trim: true,
    },
    appointmentDate: {
      type: String,
      default: "",
      trim: true,
    },

    // Registration & Plan
    registrationStatus: {
      type: String,
      default: "No",
      trim: true,
    },
    registrationNumber: {
      type: String,
      default: "",
      trim: true,
    },
    registrationAmount: {
      type: String,
      default: "",
      trim: true,
    },
    package: {
      type: String,
      default: "",
      trim: true,
    },
    plan: {
      type: String,
      default: "",
      trim: true,
    },

    // Notes
    notes: {
      type: String,
      default: "",
      trim: true,
    },

    // Indexed normalized phone fields for high-performance exact lookup
    normalizedPhone: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    normalizedAlternate: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    // Backwards Compatibility / Legacy Field Aliases
    mobileNumber: {
      type: String,
      default: "",
      trim: true,
    },
    phoneNumber: {
      type: String,
      default: "",
      trim: true,
    },
    alternateNumber: {
      type: String,
      default: "",
      trim: true,
    },
    patientName: {
      type: String,
      default: "",
      trim: true,
    },
    patientAge: {
      type: String,
      default: "",
      trim: true,
    },
    spouseName: {
      type: String,
      default: "",
      trim: true,
    },
    spouseAge: {
      type: String,
      default: "",
      trim: true,
    },
    callerName: {
      type: String,
      default: "",
      trim: true,
    },
    date: {
      type: String,
      default: "",
      trim: true,
    },
    dateOfLead: {
      type: String,
      default: "",
      trim: true,
    },
    month: {
      type: String,
      default: "",
      trim: true,
    },
    leadTimestamp: {
      type: String,
      default: "",
      trim: true,
    },
    location: {
      type: String,
      default: "",
      trim: true,
    },
    otherCity: {
      type: String,
      default: "",
      trim: true,
    },
    lookingForTreatment: {
      type: String,
      default: "",
      trim: true,
    },
    preConditions: {
      type: String,
      default: "",
      trim: true,
    },
    surgeryDetails: {
      type: String,
      default: "",
      trim: true,
    },
    treatmentRequirements: {
      type: String,
      default: "",
      trim: true,
    },
    referredBy: {
      type: String,
      default: "",
      trim: true,
    },
    followUpDate: {
      type: String,
      default: "",
      trim: true,
    },
    subDispositions: {
      type: String,
      default: "",
      trim: true,
    },
    dispositions: {
      type: String,
      default: "",
      trim: true,
    },
    validStatus: {
      type: String,
      default: "",
      trim: true,
    },
    appointmentMonth: {
      type: String,
      default: "",
      trim: true,
    },
    teleconsultationSlot: {
      type: String,
      default: "",
      trim: true,
    },
    consultationCharges: {
      type: String,
      default: "",
      trim: true,
    },
    surgeryPaymentReceived: {
      type: String,
      default: "",
      trim: true,
    },
    surgeryCost: {
      type: String,
      default: "",
      trim: true,
    },
    surgeryDate: {
      type: String,
      default: "",
      trim: true,
    },
    assignedDate: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    assignedAt: {
      type: String,
      default: "",
      trim: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    customFields: {
      type: Schema.Types.Mixed,
      default: {},
    },
    auditLogs: {
      type: [AuditLogSchema],
      default: [],
    },
    notesHistory: {
      type: [NoteHistorySchema],
      default: [],
    },
  },
  { timestamps: true, strict: false }
);

// High-Performance Query & Sorting Indexes
LeadSchema.index({ createdAt: -1 });
LeadSchema.index({ leadOwner: 1, createdAt: -1 });
LeadSchema.index({ callerName: 1, createdAt: -1 });
LeadSchema.index({ centreLocation: 1 });
LeadSchema.index({ subStatus: 1 });
LeadSchema.index({ leadStage: 1 });
LeadSchema.index({ leadValidStatus: 1 });
LeadSchema.index({ followUpDateTime: 1 });
LeadSchema.index({ appointmentDate: 1 });
LeadSchema.index({ centreVisitedDate: 1 });
LeadSchema.index({ campVisitedDate: 1 });
LeadSchema.index({ leadSource: 1 });
LeadSchema.index({ wifeName: "text", husbandName: "text", primaryMobileNumber: "text" });

export const Lead: Model<ILead> =
  mongoose.models.Lead || mongoose.model<ILead>("Lead", LeadSchema);
