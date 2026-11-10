import mongoose, { Schema, Document, Model } from "mongoose";

export interface ILeadCreationLock extends Document {
  phone: string;
  createdAt: Date;
}

const LeadCreationLockSchema = new Schema<ILeadCreationLock>(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 30, // TTL index: automatically expires and cleans up after 30 seconds
    },
  },
  { timestamps: false }
);

export const LeadCreationLock: Model<ILeadCreationLock> =
  mongoose.models.LeadCreationLock ||
  mongoose.model<ILeadCreationLock>("LeadCreationLock", LeadCreationLockSchema);
