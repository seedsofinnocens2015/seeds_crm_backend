import mongoose, { Schema, Document, Model } from "mongoose";

export interface IFieldMapping {
  crmField: string; // e.g. "patientName", "mobileNumber", "location", "email", "notes"
  formFieldKey: string; // e.g. "full_name", "phone_number", "city", "email"
}

export interface IMetaAdsSetupConfig extends Document {
  integrationName: string; // e.g. "Patna IVF Summer Campaign"
  leadSource: "Meta Instant Form" | "Facebook Lead Ads" | "Instagram Lead Ads";
  metaUserId?: string;
  metaUserName?: string;
  adAccountId?: string;
  adAccountName?: string;
  pageId: string;
  pageName: string;
  formId: string;
  formName: string;
  campaignName?: string;
  campaignId?: string;
  adId?: string;
  adName?: string;
  autoSync: boolean;
  fieldMappings: IFieldMapping[];
  status: "draft" | "active" | "paused" | "error";
  lastVerifiedAt?: Date;
  lastSyncAt?: Date;
  lastError?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const FieldMappingSchema = new Schema<IFieldMapping>(
  {
    crmField: { type: String, required: true },
    formFieldKey: { type: String, required: true },
  },
  { _id: false }
);

const MetaAdsSetupConfigSchema = new Schema<IMetaAdsSetupConfig>(
  {
    integrationName: {
      type: String,
      required: [true, "Integration Name is required"],
      trim: true,
      index: true,
    },
    leadSource: {
      type: String,
      enum: ["Meta Instant Form", "Facebook Lead Ads", "Instagram Lead Ads"],
      default: "Meta Instant Form",
    },
    metaUserId: {
      type: String,
      trim: true,
      default: "",
    },
    metaUserName: {
      type: String,
      trim: true,
      default: "",
    },
    adAccountId: {
      type: String,
      trim: true,
      default: "",
    },
    adAccountName: {
      type: String,
      trim: true,
      default: "",
    },
    pageId: {
      type: String,
      required: [true, "Facebook Page ID is required"],
      trim: true,
      index: true,
    },
    pageName: {
      type: String,
      required: [true, "Page Name is required"],
      trim: true,
    },
    formId: {
      type: String,
      required: [true, "Instant Form ID is required"],
      trim: true,
      index: true,
    },
    formName: {
      type: String,
      required: [true, "Form Name is required"],
      trim: true,
    },
    campaignName: {
      type: String,
      trim: true,
      default: "",
    },
    campaignId: {
      type: String,
      trim: true,
      default: "",
    },
    adId: {
      type: String,
      trim: true,
      default: "",
    },
    adName: {
      type: String,
      trim: true,
      default: "",
    },
    autoSync: {
      type: Boolean,
      default: true,
      index: true,
    },
    fieldMappings: {
      type: [FieldMappingSchema],
      default: [
        { crmField: "patientName", formFieldKey: "full_name" },
        { crmField: "mobileNumber", formFieldKey: "phone_number" },
        { crmField: "location", formFieldKey: "city" },
        { crmField: "email", formFieldKey: "email" },
      ],
    },
    status: {
      type: String,
      enum: ["draft", "active", "paused", "error"],
      default: "draft",
      index: true,
    },
    lastVerifiedAt: {
      type: Date,
    },
    lastSyncAt: {
      type: Date,
    },
    lastError: {
      type: String,
      default: "",
    },
    createdBy: {
      type: String,
      default: "marketing",
    },
  },
  {
    timestamps: true,
  }
);

MetaAdsSetupConfigSchema.index({ pageId: 1, formId: 1 });

export const MetaAdsSetupConfig: Model<IMetaAdsSetupConfig> =
  mongoose.models.MetaAdsSetupConfig ||
  mongoose.model<IMetaAdsSetupConfig>("MetaAdsSetupConfig", MetaAdsSetupConfigSchema);
