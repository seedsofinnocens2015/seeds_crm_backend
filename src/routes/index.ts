import { Router } from "express";
import authRoutes from "./authRoutes.js";
import memberRoutes from "./memberRoutes.js";
import leadRoutes from "./leadRoutes.js";
import formConfigRoutes from "./formConfigRoutes.js";
import dashboardRoutes from "./dashboardRoutes.js";
import integrationRoutes from "./integrationRoutes.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/members", memberRoutes);
router.use("/leads", leadRoutes);
router.use("/form-config", formConfigRoutes);
router.use("/integrations", integrationRoutes); // mounts /api/v1/integrations/*
router.use("/", dashboardRoutes); // mounts GET /api/v1/dashboard-stats
router.use("/dashboard", dashboardRoutes); // alias: GET /api/v1/dashboard/dashboard-stats

export default router;
