import mongoose, { Schema, Document, Model } from "mongoose";

export interface IMetaWebhookEvent extends Document {
  leadgenId: string;
  pageId: string;
  formId?: string;
  adId?: string;
  status: "pending" | "processed" | "skipped_duplicate_phone" | "already_exists" | "failed";
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  rawPayloadSummary: {
    objectType: string;
    field: string;
    timestamp?: string;
  };
  crmLeadId?: mongoose.Types.ObjectId;
  crmLeadUniqueId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MetaWebhookEventSchema = new Schema<IMetaWebhookEvent>(
  {
    leadgenId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    pageId: {
      type: String,
      required: true,
      index: true,
    },
    formId: {
      type: String,
      default: "",
    },
    adId: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "processed", "skipped_duplicate_phone", "already_exists", "failed"],
      default: "pending",
      index: true,
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    maxRetries: {
      type: Number,
      default: 3,
    },
    lastError: {
      type: String,
      default: "",
    },
    rawPayloadSummary: {
      objectType: { type: String, default: "page" },
      field: { type: String, default: "leadgen" },
      timestamp: { type: String },
    },
    crmLeadId: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },
    crmLeadUniqueId: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

MetaWebhookEventSchema.index({ status: 1, retryCount: 1 });

export const MetaWebhookEvent: Model<IMetaWebhookEvent> =
  mongoose.models.MetaWebhookEvent ||
  mongoose.model<IMetaWebhookEvent>("MetaWebhookEvent", MetaWebhookEventSchema);
