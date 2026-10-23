import { Router } from "express";
import { getDashboardStats } from "../controllers/dashboardStatsController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// Dashboard analytics statistics endpoint (authenticated)
router.get("/dashboard-stats", requireAuth, getDashboardStats);

export default router;
