import { Router } from "express";
import {
  getLeads,
  createLead,
  getLeadById,
  updateLead,
  deleteLead,
  checkPhone,
} from "../controllers/leadController.js";
import {
  bulkUploadLeads,
  bulkAssignLeads,
  bulkUpdateLeads,
  mergeLeads,
} from "../controllers/bulkLeadController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// All lead routes require authentication
router.use(requireAuth);

// Static / specialized routes (must precede /:id)
router.get("/check-phone", checkPhone);

// Bulk operations
router.post("/bulk-upload", bulkUploadLeads);
router.post("/bulk", bulkUploadLeads); // Alias matching Next.js /api/admin/leads/bulk
router.post("/assign-bulk", bulkAssignLeads);
router.post("/bulk-update", bulkUpdateLeads);
router.post("/merge", mergeLeads);

// CRUD routes
router.get("/", getLeads);
router.post("/", createLead);
router.get("/:id", getLeadById);
router.put("/:id", updateLead);
router.delete("/:id", deleteLead);

export default router;
