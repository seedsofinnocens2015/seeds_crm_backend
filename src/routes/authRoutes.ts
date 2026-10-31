import { Router } from "express";
import { login, getMe, logout, signupAdmin, updateMySmartfloExtension } from "../controllers/authController.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/login", authLimiter, login);
router.get("/me", getMe);
router.post("/logout", logout);
router.post("/signup", authLimiter, signupAdmin);
router.put("/smartflo-extension", requireAuth, updateMySmartfloExtension);

export default router;
