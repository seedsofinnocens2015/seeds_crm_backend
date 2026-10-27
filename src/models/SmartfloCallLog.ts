import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISmartfloCallLog extends Document {
  callId: string; // Smartflo unique call_id (Primary identifier & idempotency key)
  uuid?: string; // Smartflo internal UUID
  refId?: string; // Click-to-call or dial reference ID

  // Lead Association
  crmLeadId?: mongoose.Types.ObjectId;
  crmLeadUniqueId?: string;
  matchingMethod: "crm_unique_id" | "phone_primary" | "phone_alternate" | "ambiguous" | "unmatched";

  // Telephony Metadata
  customerNumber: string;
  normalizedCustomerPhone: string;
  agentName?: string;
  agentNumber?: string;
  direction: "inbound" | "outbound" | "broadcast" | "unknown";
  status: "answered" | "missed" | "busy" | "failed" | "no_answer" | "in_progress" | "unknown";
  durationSeconds: number;
  answeredDurationSeconds: number;
  startTime?: Date;
  endTime?: Date;

  // Campaign & Dispositions
  leadListId?: string;
  campaignId?: string;
  disposition?: string;
  hangupCause?: string;
  notes?: string;

  // Recording
  recordingUrl?: string; // Smartflo secure direct stream/download URL
  recordingAvailable: boolean;

  // Raw storage & Audit
  rawPayload: Record<string, any>;
  receivedAt: Date;
  updatedAt: Date;
}

const SmartfloCallLogSchema = new Schema<ISmartfloCallLog>(
  {
    callId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    uuid: {
      type: String,
      default: "",
      trim: true,
    },
    refId: {
      type: String,
      default: "",
      trim: true,
    },
    crmLeadId: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
      index: true,
    },
    crmLeadUniqueId: {
      type: String,
      default: "",
      index: true,
      trim: true,
    },
    matchingMethod: {
      type: String,
      enum: ["crm_unique_id", "phone_primary", "phone_alternate", "ambiguous", "unmatched"],
      default: "unmatched",
      index: true,
    },
    customerNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    normalizedCustomerPhone: {
      type: String,
      default: "",
      index: true,
      trim: true,
    },
    agentName: {
      type: String,
      default: "",
      trim: true,
    },
    agentNumber: {
      type: String,
      default: "",
      trim: true,
    },
    direction: {
      type: String,
      enum: ["inbound", "outbound", "broadcast", "unknown"],
      default: "outbound",
      index: true,
    },
    status: {
      type: String,
      enum: ["answered", "missed", "busy", "failed", "no_answer", "in_progress", "unknown"],
      default: "unknown",
      index: true,
    },
    durationSeconds: {
      type: Number,
      default: 0,
    },
    answeredDurationSeconds: {
      type: Number,
      default: 0,
    },
    startTime: {
      type: Date,
      default: null,
    },
    endTime: {
      type: Date,
      default: null,
    },
    leadListId: {
      type: String,
      default: "",
      trim: true,
    },
    campaignId: {
      type: String,
      default: "",
      trim: true,
    },
    disposition: {
      type: String,
      default: "",
      trim: true,
    },
    hangupCause: {
      type: String,
      default: "",
      trim: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    recordingUrl: {
      type: String,
      default: "",
      trim: true,
    },
    recordingAvailable: {
      type: Boolean,
      default: false,
      index: true,
    },
    rawPayload: {
      type: Schema.Types.Mixed,
      default: {},
    },
    receivedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

// High-performance search indexes
SmartfloCallLogSchema.index({ crmLeadUniqueId: 1, receivedAt: -1 });
SmartfloCallLogSchema.index({ crmLeadId: 1, receivedAt: -1 });
SmartfloCallLogSchema.index({ normalizedCustomerPhone: 1, receivedAt: -1 });

export const SmartfloCallLog: Model<ISmartfloCallLog> =
  mongoose.models.SmartfloCallLog ||
  mongoose.model<ISmartfloCallLog>("SmartfloCallLog", SmartfloCallLogSchema);
