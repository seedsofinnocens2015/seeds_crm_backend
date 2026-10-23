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
  uniqueId: string;
  date: string;
  month: string;
  leadTimestamp?: string;
  mobileNumber: string;
  alternateNumber?: string;
  normalizedPhone?: string;
  normalizedAlternate?: string;
  callerName?: string;
  patientName: string;
  patientAge?: string;
  spouseName?: string;
  spouseAge?: string;
  location?: string;
  otherCity?: string;
  lookingForTreatment?: string;
  preConditions?: string;
  surgeryDetails?: string;
  treatmentRequirements?: string;
  referredBy?: string;
  leadSource?: string;
  followUpDate?: string;
  subDispositions?: string;
  dispositions?: string;
  validStatus?: string;
  appointmentDate?: string;
  appointmentMonth?: string;
  teleconsultationSlot?: string;
  consultationCharges?: string;
  notes?: string;
  surgeryPaymentReceived?: string;
  surgeryCost?: string;
  surgeryDate?: string;
  // Assignment tracking
  assignedDate?: string; // DD-MMM-YY e.g. "28-Sep-26"
  assignedAt?: string; // ISO string
  // Dynamic custom fields
  customFields?: Record<string, any>;
  // Audit logs / change history
  auditLogs?: IAuditLog[];
  // Dedicated Notes & Observations history
  notesHistory?: INoteHistory[];
  // Legacy aliases
  phoneNumber?: string;
  dateOfLead?: string;
  createdBy?: mongoose.Types.ObjectId;
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
    uniqueId: {
      type: String,
      required: [true, "Unique ID is required"],
      trim: true,
      unique: true,
      index: true,
    },
    date: {
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
    mobileNumber: {
      type: String,
      default: "",
      trim: true,
    },
    alternateNumber: {
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
    callerName: {
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
    leadSource: {
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
    appointmentDate: {
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
    notes: {
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
    // Backwards compatibility
    phoneNumber: {
      type: String,
      default: "",
      trim: true,
    },
    dateOfLead: {
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

// High-Performance Query & Sorting Indexes for 15+ Lakh (1.5M+) Leads
LeadSchema.index({ createdAt: -1 });
LeadSchema.index({ callerName: 1, createdAt: -1 });
LeadSchema.index({ month: 1, location: 1 });
LeadSchema.index({ appointmentDate: 1 });
LeadSchema.index({ surgeryDate: 1 });
LeadSchema.index({ followUpDate: 1 });
LeadSchema.index({ date: 1 });
LeadSchema.index({ location: 1 });
LeadSchema.index({ dispositions: 1 });
LeadSchema.index({ subDispositions: 1 });
LeadSchema.index({ leadSource: 1 });
LeadSchema.index({ patientName: "text", mobileNumber: "text" });

export const Lead: Model<ILead> =
  mongoose.models.Lead || mongoose.model<ILead>("Lead", LeadSchema);
