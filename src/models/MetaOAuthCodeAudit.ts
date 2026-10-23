import mongoose, { Schema, Document, Model } from "mongoose";

export interface IMetaOAuthCodeAudit extends Document {
  codeHash: string; // SHA-256 hash of code
  stateNonce: string; // state payload nonce
  userEmail: string;
  status: "processing" | "completed" | "failed";
  metaUserId?: string;
  metaUserName?: string;
  pagesCount?: number;
  adAccountsCount?: number;
  responsePayload?: Record<string, any>;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MetaOAuthCodeAuditSchema = new Schema<IMetaOAuthCodeAudit>(
  {
    codeHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    stateNonce: {
      type: String,
      required: true,
      index: true,
    },
    userEmail: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["processing", "completed", "failed"],
      default: "processing",
      index: true,
    },
    metaUserId: { type: String },
    metaUserName: { type: String },
    pagesCount: { type: Number, default: 0 },
    adAccountsCount: { type: Number, default: 0 },
    responsePayload: { type: Schema.Types.Mixed },
    errorMessage: { type: String },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 86400 * 7, // Auto-expire after 7 days
    },
  },
  {
    timestamps: true,
  }
);

export const MetaOAuthCodeAudit: Model<IMetaOAuthCodeAudit> =
  mongoose.models.MetaOAuthCodeAudit ||
  mongoose.model<IMetaOAuthCodeAudit>("MetaOAuthCodeAudit", MetaOAuthCodeAuditSchema);
