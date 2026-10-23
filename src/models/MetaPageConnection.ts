import mongoose, { Schema, Document, Model } from "mongoose";

export interface IMetaPageConnection extends Document {
  pageId: string; // Facebook Page ID (e.g. "1029384756")
  pageName: string; // Human-readable Facebook Page name
  accessToken?: string; // Page Access Token (stored encrypted or protected, never sent to frontend)
  status: "active" | "inactive" | "revoked";
  isSubscribed: boolean; // Whether the 'leadgen' webhook field is confirmed subscribed for this page
  subscribedAt?: Date;
  lastLeadReceivedAt?: Date;
  connectedBy?: string; // User who registered/authorized the page
  selectedForms?: string[]; // Specific Instant Lead Form IDs enabled for sync (empty or undefined = all forms synced)
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const MetaPageConnectionSchema = new Schema<IMetaPageConnection>(
  {
    pageId: {
      type: String,
      required: [true, "Meta Page ID is required"],
      unique: true,
      trim: true,
      index: true,
    },
    pageName: {
      type: String,
      required: [true, "Meta Page Name is required"],
      trim: true,
    },
    accessToken: {
      type: String,
      required: [true, "Page Access Token is required"],
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "revoked"],
      default: "active",
      index: true,
    },
    isSubscribed: {
      type: Boolean,
      default: false,
      index: true,
    },
    subscribedAt: {
      type: Date,
    },
    lastLeadReceivedAt: {
      type: Date,
    },
    connectedBy: {
      type: String,
      default: "admin",
    },
    selectedForms: {
      type: [String],
      default: [],
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: {
      // Security measure: NEVER expose accessToken in JSON responses to frontend/admin clients
      transform: (_doc, ret) => {
        delete ret.accessToken;
        return ret;
      },
    },
    toObject: {
      transform: (_doc, ret) => {
        delete ret.accessToken;
        return ret;
      },
    },
  }
);

MetaPageConnectionSchema.index({ status: 1, pageId: 1 });

export const MetaPageConnection: Model<IMetaPageConnection> =
  mongoose.models.MetaPageConnection ||
  mongoose.model<IMetaPageConnection>("MetaPageConnection", MetaPageConnectionSchema);
