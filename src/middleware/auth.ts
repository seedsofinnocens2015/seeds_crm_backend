import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/env.js";

export interface AuthenticatedUserPayload {
  id: string;
  name: string;
  email: string;
  role: "admin" | "team_leader" | "agent" | "mis" | "marketing";
}

// Extend Express Request object to carry auth session
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUserPayload;
    }
  }
}

/**
 * Extracts and verifies JWT from:
 * 1. HTTP-only cookie named "token" (standard web portal flow)
 * 2. Authorization header "Bearer <token>" (API/tools/testing flow)
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  let token = req.cookies?.token;

  if (!token && req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Authentication token missing.",
    });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AuthenticatedUserPayload;
    req.user = decoded;
    next();
  } catch (err: any) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired authentication token.",
    });
  }
}
