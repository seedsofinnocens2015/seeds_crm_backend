import rateLimit from "express-rate-limit";

// Limit login attempts: relaxed in development (100) and strict in production (15)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 15 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too Many Requests",
    message: "Too many login/signup attempts from this IP, please try again after 15 minutes.",
  },
});
