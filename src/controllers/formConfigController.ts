import { Request, Response } from "express";
import { FormConfig } from "../models/FormConfig.js";
import { DEFAULT_FORM_FIELDS } from "../utils/defaultFormFields.js";
import { SUB_DISPOSITIONS_MAP } from "../utils/dateUtils.js";

const DEFAULT_SECTIONS = [
  { id: 1 as const, title: "1. Lead Identification & Overview" },
  { id: 2 as const, title: "2. Couple Profile & Medical Details" },
  { id: 3 as const, title: "3. Contact & Address Information" },
  { id: 4 as const, title: "4. Disposition, Centre, Visits & Registration" },
];

/**
 * GET /api/v1/form-config
 * Fetches dynamic form configuration, initializing defaults if none exist.
 */
export async function getFormConfig(req: Request, res: Response) {
  try {
    let config: any = await FormConfig.findOne().lean();

    if (!config) {
      const created = await FormConfig.create({
        version: 2,
        sections: DEFAULT_SECTIONS,
        fields: DEFAULT_FORM_FIELDS,
        subDispositionMappings: { ...SUB_DISPOSITIONS_MAP },
        updatedBy: "System Default",
      });
      config = created.toObject();
    } else {
      let needsSave = false;
      // Auto upgrade if config has older subDispositionMappings or missing new fields
      const hasLatestSubStatus = config.subDispositionMappings && config.subDispositionMappings["Visited Centre"];
      const hasNewFields = config.fields && config.fields.some((f: any) => f.id === "husbandName" || f.id === "wifeName");
      
      if (!hasLatestSubStatus || !hasNewFields) {
        config.fields = DEFAULT_FORM_FIELDS;
        config.sections = DEFAULT_SECTIONS;
        config.subDispositionMappings = { ...SUB_DISPOSITIONS_MAP };
        config.version = (config.version || 1) + 1;
        needsSave = true;
      } else if (
        !config.subDispositionMappings ||
        Object.keys(config.subDispositionMappings).length === 0
      ) {
        config.subDispositionMappings = { ...SUB_DISPOSITIONS_MAP };
        needsSave = true;
      }

      if (needsSave) {
        await FormConfig.findByIdAndUpdate(config._id, {
          $set: {
            fields: config.fields,
            sections: config.sections,
            subDispositionMappings: config.subDispositionMappings,
            version: config.version,
          },
        });
      }
    }

    return res.status(200).json({ config });
  } catch (error: any) {
    console.error("Error fetching form-config:", error);
    return res.status(500).json({
      error: error.message || "Failed to fetch form configuration",
    });
  }
}

/**
 * PUT /api/v1/form-config
 * Updates fields order, sections, dropdown options, and sub-disposition mappings.
 * Restricted to Admin and Team Leader.
 */
export async function updateFormConfig(req: Request, res: Response) {
  try {
    const session = req.user!;
    if (session.role !== "admin" && session.role !== "team_leader") {
      return res.status(403).json({
        error: "Access denied. Only Admin or Team Leader can edit form fields.",
      });
    }

    const { fields, sections, subDispositionMappings } = req.body;

    if (!Array.isArray(fields)) {
      return res.status(400).json({
        error: "Invalid payload: fields must be an array",
      });
    }

    const updateData: any = {
      fields,
      version: Date.now(),
      updatedBy: `${session.name || "User"} (${session.role})`,
    };

    if (sections && Array.isArray(sections)) {
      updateData.sections = sections;
    }

    if (subDispositionMappings && typeof subDispositionMappings === "object") {
      updateData.subDispositionMappings = subDispositionMappings;
    }

    const config = await FormConfig.findOneAndUpdate(
      {},
      { $set: updateData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({
      message: "Form configuration saved successfully",
      config,
    });
  } catch (error: any) {
    console.error("Error updating form-config:", error);
    return res.status(500).json({
      error: error.message || "Failed to update form configuration",
    });
  }
}

/**
 * POST /api/v1/form-config/reset
 * Resets form fields and sub-disposition mappings back to defaults.
 * Restricted to Admin and Team Leader.
 */
export async function resetFormConfig(req: Request, res: Response) {
  try {
    const session = req.user!;
    if (session.role !== "admin" && session.role !== "team_leader") {
      return res.status(403).json({
        error: "Access denied. Only Admin or Team Leader can reset form fields.",
      });
    }

    let config = await FormConfig.findOne();
    if (!config) {
      config = new FormConfig({
        version: 1,
        sections: DEFAULT_SECTIONS,
        fields: DEFAULT_FORM_FIELDS,
        subDispositionMappings: { ...SUB_DISPOSITIONS_MAP },
        updatedBy: `Reset by ${session.name || "Admin"}`,
      });
    } else {
      config.sections = DEFAULT_SECTIONS;
      config.fields = DEFAULT_FORM_FIELDS;
      config.subDispositionMappings = { ...SUB_DISPOSITIONS_MAP };
      config.version = (config.version || 1) + 1;
      config.updatedBy = `Reset by ${session.name || "Admin"}`;
    }

    await config.save();

    return res.status(200).json({
      message: "Form configuration reset to default successfully",
      config,
    });
  } catch (error: any) {
    console.error("Error resetting form-config:", error);
    return res.status(500).json({
      error: error.message || "Failed to reset form configuration",
    });
  }
}
