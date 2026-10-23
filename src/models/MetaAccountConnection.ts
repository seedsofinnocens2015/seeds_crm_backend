import mongoose, { Schema, Document, Model } from "mongoose";

export interface IMetaAccountConnection extends Document {
  metaUserId: string;
  metaUserName: string;
  connectedEmail: string;
  userAccessToken?: string; // Stored securely on backend; never returned to frontend
  tokenExpiresAt?: Date;
  status: "active" | "expired" | "revoked";
  grantedScopes: string[];
  adAccounts?: Array<{
    id: string;
    name: string;
    currency?: string;
    timezone_name?: string;
    account_status?: number;
  }>;
  selectedAdAccountId?: string;
  lastSyncAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MetaAccountConnectionSchema = new Schema<IMetaAccountConnection>(
  {
    metaUserId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    metaUserName: {
      type: String,
      default: "Meta Advertiser",
      trim: true,
    },
    connectedEmail: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    userAccessToken: {
      type: String,
      required: true,
      trim: true,
    },
    tokenExpiresAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["active", "expired", "revoked"],
      default: "active",
      index: true,
    },
    grantedScopes: {
      type: [String],
      default: [],
    },
    adAccounts: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    selectedAdAccountId: {
      type: String,
      default: "",
    },
    lastSyncAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.userAccessToken;
        return ret;
      },
    },
    toObject: {
      transform: (_doc, ret) => {
        delete ret.userAccessToken;
        return ret;
      },
    },
  }
);

export const MetaAccountConnection: Model<IMetaAccountConnection> =
  mongoose.models.MetaAccountConnection ||
  mongoose.model<IMetaAccountConnection>("MetaAccountConnection", MetaAccountConnectionSchema);
