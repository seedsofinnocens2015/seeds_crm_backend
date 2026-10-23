import { Router } from "express";
import { login, getMe, logout, signupAdmin } from "../controllers/authController.js";
import { authLimiter } from "../middleware/rateLimiter.js";

const router = Router();

router.post("/login", authLimiter, login);
router.get("/me", getMe);
router.post("/logout", logout);
router.post("/signup", authLimiter, signupAdmin);

export default router;
