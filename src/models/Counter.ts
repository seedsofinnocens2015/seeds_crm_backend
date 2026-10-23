import mongoose, { Schema, Model } from "mongoose";

export interface ICounter {
  _id: string; // Identifier e.g. "lead_unique_id"
  seq: number;
}

const CounterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Counter: Model<ICounter> =
  mongoose.models.Counter || mongoose.model<ICounter>("Counter", CounterSchema);
