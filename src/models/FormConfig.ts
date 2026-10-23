import mongoose, { Schema, Document, Model } from "mongoose";

export type FormFieldType =
  | "text"
  | "number"
  | "tel"
  | "date"
  | "month"
  | "time"
  | "datetime-local"
  | "email"
  | "url"
  | "select"
  | "textarea"
  | "checkbox";

export interface IFormField {
  id: string; // e.g., "patientName", "custom_abc123"
  label: string; // Display label
  type: FormFieldType;
  section: 1 | 2 | 3 | 4; // Which of the 4 sections
  order: number; // Order index within the section
  required?: boolean;
  options?: string[]; // If select dropdown, list of options
  placeholder?: string;
  enabled?: boolean; // Whether active or hidden
  isSystem?: boolean; // System fields can't be deleted, but can be edited/reordered
  readOnly?: boolean;
  subDispositionMappings?: Record<string, { disposition: string; validStatus: string }>;
}

export interface IFormConfig extends Document {
  version: number;
  sections: {
    id: 1 | 2 | 3 | 4;
    title: string;
  }[];
  fields: IFormField[];
  subDispositionMappings?: Record<string, { disposition: string; validStatus: string }>;
  updatedBy?: string;
  updatedAt: Date;
  createdAt: Date;
}

const FormFieldSchema = new Schema<IFormField>(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    type: {
      type: String,
      enum: [
        "text",
        "number",
        "tel",
        "date",
        "month",
        "time",
        "datetime-local",
        "email",
        "url",
        "select",
        "textarea",
        "checkbox",
      ],
      default: "text",
    },
    section: { type: Number, enum: [1, 2, 3, 4], required: true },
    order: { type: Number, default: 0 },
    required: { type: Boolean, default: false },
    options: { type: [String], default: [] },
    placeholder: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
    subDispositionMappings: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const FormConfigSchema = new Schema<IFormConfig>(
  {
    version: { type: Number, default: 1 },
    sections: {
      type: [
        {
          id: { type: Number, required: true },
          title: { type: String, required: true },
        },
      ],
      default: [
        { id: 1, title: "Lead Date, Contact & Caller" },
        { id: 2, title: "Patient & Family Profile" },
        { id: 3, title: "Clinical & Surgical Information" },
        { id: 4, title: "Disposition, Appointments & Follow-up" },
      ],
    },
    fields: {
      type: [FormFieldSchema],
      default: [],
    },
    subDispositionMappings: {
      type: Schema.Types.Mixed,
      default: {},
    },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

export const FormConfig: Model<IFormConfig> =
  mongoose.models.FormConfig ||
  mongoose.model<IFormConfig>("FormConfig", FormConfigSchema);
