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
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        role: user.role,
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

    return res.status(200).json({ user });
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

    // Check if an admin already exists in the system
    const existingAdminCount = await User.countDocuments({ role: "admin" });
    if (existingAdminCount > 0) {
      // If admins already exist, registration requires an existing admin session
      let token = req.cookies?.token;
      if (!token && req.headers.authorization?.startsWith("Bearer ")) {
        token = req.headers.authorization.split(" ")[1];
      }

      let callerIsAdmin = false;
      if (token) {
        try {
          const decoded = jwt.verify(token, config.jwtSecret) as any;
          if (decoded.role === "admin") callerIsAdmin = true;
        } catch {}
      }

      if (!callerIsAdmin) {
        return res.status(403).json({
          error: "Admin account creation is restricted. An existing administrator must perform this action.",
        });
      }
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
      },
    });
  } catch (error: any) {
    console.error("Admin signup error:", error);
    return res.status(500).json({
      error: error.message || "Something went wrong during signup.",
    });
  }
}
