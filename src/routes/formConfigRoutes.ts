import { Router } from "express";
import {
  getFormConfig,
  updateFormConfig,
  resetFormConfig,
} from "../controllers/formConfigController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// All form-config endpoints require authentication
router.use(requireAuth);

router.get("/", getFormConfig);
router.put("/", updateFormConfig);
router.post("/reset", resetFormConfig);

export default router;
