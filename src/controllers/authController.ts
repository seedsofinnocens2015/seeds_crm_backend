import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { config } from "../config/env.js";

const COOKIE_NAME = "token";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * POST /api/v1/auth/login
 * Preserves role check, account active status check, and password comparison.
 */
export async function login(req: Request, res: Response) {
  try {
    const { email, password, requiredRole } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // 1. Strictly check if user is active - Inactive members cannot log in
    if (user.status !== "active") {
      res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        path: "/",
      });
      return res.status(403).json({
        error: "Invalid user. Your account has been deactivated by the administrator.",
      });
    }

    // 2. Verify password
    const isMatch = await bcrypt.compare(String(password), user.password || "");
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // 3. Optional portal role verification
    if (requiredRole && user.role !== requiredRole) {
      return res.status(403).json({
        error: `Access denied. Your account role is "${user.role}". Please use your designated login portal.`,
      });
    }

    // 4. Create JWT token
    const token = jwt.sign(
      {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
      },
      config.jwtSecret,
      { expiresIn: "7d" }
    );

    // Set secure HTTP-only cookie
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      maxAge: SEVEN_DAYS_MS,
      path: "/",
    });

    return res.status(200).json({
      message: "Login successful",
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        role: user.role,
        smartfloAgentId: user.smartfloAgentId || user.smartfloAgentNumber || "",
        smartfloAgentNumber: user.smartfloAgentNumber || user.smartfloAgentId || "",
        smartfloCallerId: user.smartfloCallerId || "",
      },
      // Note: We also return token in body for automated API testing/tools while cookies handle the browser
      token,
    });
  } catch (error: any) {
    console.error("Login error:", error);
    return res.status(500).json({ error: error.message || "Failed to login" });
  }
}

/**
 * GET /api/v1/auth/me
 * Validates session and checks active status against database.
 */
export async function getMe(req: Request, res: Response) {
  try {
    let token = req.cookies?.token;
    if (!token && req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ user: null });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch {
      return res.status(401).json({ user: null });
    }

    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(401).json({ user: null });
    }

    if (user.status !== "active") {
      res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        path: "/",
      });
      return res.status(403).json({
        user: null,
        error: "Invalid user. Your account has been deactivated by the administrator.",
      });
    }

    return res.status(200).json({
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        role: user.role,
        status: user.status,
        smartfloAgentId: user.smartfloAgentId || user.smartfloAgentNumber || "",
        smartfloAgentNumber: user.smartfloAgentNumber || user.smartfloAgentId || "",
        smartfloCallerId: user.smartfloCallerId || "",
        createdAt: user.createdAt,
      },
      token,
    });
  } catch (error: any) {
    return res.status(401).json({ user: null });
  }
}

/**
 * POST /api/v1/auth/logout
 * Clears authentication cookie.
 */
export async function logout(req: Request, res: Response) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    path: "/",
  });
  return res.status(200).json({ message: "Logged out successfully" });
}

/**
 * POST /api/v1/auth/signup
 * Admin bootstrap / registration endpoint.
 * Protects against duplicate admin creation or public creation if an admin already exists.
 */
export async function signupAdmin(req: Request, res: Response) {
  try {
    const { name, mobile, email, password } = req.body;

    if (!name || !mobile || !email || !password) {
      return res.status(400).json({ error: "Please provide all required fields." });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // Check if user with this email already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ error: "A user with this email already exists." });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(String(password), 10);

    const newAdmin = await User.create({
      name: String(name).trim(),
      mobile: String(mobile).trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: "admin",
      status: "active",
    });

    return res.status(201).json({
      message: "Admin registered successfully!",
      user: {
        id: newAdmin._id,
        name: newAdmin.name,
        email: newAdmin.email,
        role: newAdmin.role,
        smartfloAgentId: newAdmin.smartfloAgentId || newAdmin.smartfloAgentNumber || "",
        smartfloAgentNumber: newAdmin.smartfloAgentNumber || newAdmin.smartfloAgentId || "",
      },
    });
  } catch (error: any) {
    console.error("Admin signup error:", error);
    return res.status(500).json({
      error: error.message || "Something went wrong during signup.",
    });
  }
}

/**
 * PUT /api/v1/auth/smartflo-extension
 * Protected self-service endpoint for authenticated users to update their own Smartflo Extension ID and Caller ID.
 * Strictly derives the user ID from req.user (authenticated JWT/session), never accepting client userId.
 */
export async function updateMySmartfloExtension(req: Request, res: Response) {
  try {
    const authUser = req.user;
    if (!authUser || !authUser.id) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Authentication token missing or invalid.",
      });
    }

    const { smartfloAgentId, smartfloAgentNumber, smartfloCallerId } = req.body || {};
    const rawVal = smartfloAgentId !== undefined ? smartfloAgentId : smartfloAgentNumber;

    if ((rawVal === undefined || rawVal === null) && smartfloCallerId === undefined) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Missing 'smartfloAgentId' or 'smartfloCallerId' parameter.",
      });
    }

    const updateSet: Record<string, string> = {};

    if (rawVal !== undefined && rawVal !== null) {
      const cleanVal = String(rawVal).trim();

      // Validate alphanumeric/digits format up to 30 chars (handles extensions like 0608426290047, softphone IDs, mobiles)
      if (cleanVal.length > 30) {
        return res.status(400).json({
          error: "Invalid extension ID",
          message: "Extension ID cannot exceed 30 characters.",
        });
      }

      if (cleanVal && !/^[0-9a-zA-Z_-]+$/.test(cleanVal)) {
        return res.status(400).json({
          error: "Invalid extension ID",
          message: "Extension ID may only contain numbers, letters, underscores, and hyphens.",
        });
      }

      updateSet.smartfloAgentId = cleanVal;
      updateSet.smartfloAgentNumber = cleanVal;
    }

    if (smartfloCallerId !== undefined) {
      const cleanCallerId = String(smartfloCallerId).trim();
      if (cleanCallerId.length > 20) {
        return res.status(400).json({
          error: "Invalid Caller ID",
          message: "Caller ID cannot exceed 20 characters.",
        });
      }
      if (cleanCallerId && !/^\+?[0-9]{8,15}$/.test(cleanCallerId)) {
        return res.status(400).json({
          error: "Invalid Caller ID",
          message: "Caller ID must be a valid phone number format (e.g. +919228173971 or 9228173971).",
        });
      }
      updateSet.smartfloCallerId = cleanCallerId;
    }

    const updatedUser = await User.findByIdAndUpdate(
      authUser.id,
      {
        $set: updateSet,
      },
      { new: true }
    ).select("-password");

    if (!updatedUser) {
      return res.status(404).json({
        error: "User not found",
        message: "Authenticated user profile does not exist.",
      });
    }

    return res.status(200).json({
      status: "success",
      message: "Smartflo settings updated successfully.",
      smartfloAgentId: updatedUser.smartfloAgentId || updatedUser.smartfloAgentNumber || "",
      smartfloAgentNumber: updatedUser.smartfloAgentNumber || updatedUser.smartfloAgentId || "",
      smartfloCallerId: updatedUser.smartfloCallerId || "",
      user: {
        id: updatedUser._id,
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        smartfloAgentId: updatedUser.smartfloAgentId || updatedUser.smartfloAgentNumber || "",
        smartfloAgentNumber: updatedUser.smartfloAgentNumber || updatedUser.smartfloAgentId || "",
        smartfloCallerId: updatedUser.smartfloCallerId || "",
      },
    });
  } catch (error: any) {
    console.error("Error updating Smartflo settings:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to update Smartflo settings.",
    });
  }
}
