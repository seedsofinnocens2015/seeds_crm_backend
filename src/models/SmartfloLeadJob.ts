import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISmartfloLeadJob extends Document {
  leadId: mongoose.Types.ObjectId;
  uniqueId: string;
  targetLeadListId: string;
  status: "pending" | "processing" | "synced" | "failed";
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  smartfloLeadId?: string;
  requestPayload?: Record<string, any>;
  responsePayload?: Record<string, any>;
  scheduledAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SmartfloLeadJobSchema = new Schema<ISmartfloLeadJob>(
  {
    leadId: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },
    uniqueId: {
      type: String,
      required: true,
      index: true,
    },
    targetLeadListId: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "synced", "failed"],
      default: "pending",
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 5,
    },
    lastError: {
      type: String,
      default: "",
    },
    smartfloLeadId: {
      type: String,
      default: "",
      index: true,
    },
    requestPayload: {
      type: Schema.Types.Mixed,
      default: null,
    },
    responsePayload: {
      type: Schema.Types.Mixed,
      default: null,
    },
    scheduledAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    completedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Prevent duplicate jobs for same lead and same target list
SmartfloLeadJobSchema.index({ leadId: 1, targetLeadListId: 1 }, { unique: true });
SmartfloLeadJobSchema.index({ status: 1, scheduledAt: 1 });

export const SmartfloLeadJob: Model<ISmartfloLeadJob> =
  mongoose.models.SmartfloLeadJob ||
  mongoose.model<ISmartfloLeadJob>("SmartfloLeadJob", SmartfloLeadJobSchema);
