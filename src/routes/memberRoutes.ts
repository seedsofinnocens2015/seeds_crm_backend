import { Router } from "express";
import {
  getMembers,
  createMember,
  getMemberById,
  updateMember,
  deleteMember,
} from "../controllers/memberController.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roleGuard.js";

const router = Router();

// All member management routes require authentication and either admin or team_leader role
router.use(requireAuth);
router.get("/", getMembers);

// Modification operations require admin or team_leader
router.use(requireRole(["admin", "team_leader"]));
router.post("/", createMember);
router.get("/:id", getMemberById);
router.put("/:id", updateMember);
router.delete("/:id", deleteMember);

export default router;
