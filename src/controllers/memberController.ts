import { Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";

/**
 * GET /api/v1/members
 * Admin and Team Leader access.
 * Returns non-admin members: team_leader, agent, mis, marketing.
 */
export async function getMembers(req: Request, res: Response) {
  try {
    const members = await User.find({
      role: { $in: ["team_leader", "agent", "mis", "marketing"] },
    })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ members });
  } catch (error: any) {
    console.error("Error fetching members:", error);
    return res.status(500).json({
      error: error.message || "Failed to fetch members",
    });
  }
}

/**
 * POST /api/v1/members
 * Admin and Team Leader access.
 * Team Leaders can only create Agents.
 * Admins can create team_leader, agent, mis, marketing.
 */
export async function createMember(req: Request, res: Response) {
  try {
    const authUser = req.user!;
    const { name, mobile, email, password, role } = req.body;

    if (!name || !mobile || !email || !password || !role) {
      return res.status(400).json({
        error: "Please fill all fields: name, mobile, email, password, role.",
      });
    }

    const cleanRole = String(role).trim().toLowerCase();

    // Team Leader role restriction: can only add agent
    if (authUser.role === "team_leader") {
      if (cleanRole !== "agent") {
        return res.status(403).json({
          error: "Team Leaders are only permitted to add Agents.",
        });
      }
    } else {
      if (!["team_leader", "agent", "mis", "marketing"].includes(cleanRole)) {
        return res.status(400).json({
          error: "Invalid role selected. Must be Team Leader, Agent, MIS, or Marketing.",
        });
      }
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({
        error: "A user with this email already exists.",
      });
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);

    const newMember = await User.create({
      name: String(name).trim(),
      mobile: String(mobile).trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: cleanRole,
      status: "active",
      createdBy: new mongoose.Types.ObjectId(authUser.id),
    });

    const roleName =
      cleanRole === "team_leader"
        ? "Team Leader"
        : cleanRole === "mis"
        ? "MIS"
        : cleanRole === "marketing"
        ? "Marketing"
        : "Agent";

    return res.status(201).json({
      message: `${roleName} added successfully!`,
      member: {
        _id: newMember._id,
        name: newMember.name,
        mobile: newMember.mobile,
        email: newMember.email,
        role: newMember.role,
        status: newMember.status || "active",
        createdAt: newMember.createdAt,
      },
    });
  } catch (error: any) {
    console.error("Error creating member:", error);
    return res.status(500).json({
      error: error.message || "Failed to create member",
    });
  }
}

/**
 * GET /api/v1/members/:id
 * Fetches single member details.
 * Team leaders can only view Agents.
 */
export async function getMemberById(req: Request, res: Response) {
  try {
    const authUser = req.user!;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid member ID format." });
    }

    const member = await User.findById(id).select("-password");
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    // Team Leader can only view Agent profiles
    if (authUser.role === "team_leader" && member.role !== "agent") {
      return res.status(403).json({
        error: "Access denied. Team leaders can only view agents.",
      });
    }

    return res.status(200).json({ member });
  } catch (error: any) {
    console.error("Error fetching member:", error);
    return res.status(500).json({
      error: error.message || "Failed to fetch member",
    });
  }
}

/**
 * PUT /api/v1/members/:id
 * Updates member profile, status (active/inactive), role, or resets password.
 * Team Leaders can only manage Agents and cannot promote agents.
 */
export async function updateMember(req: Request, res: Response) {
  try {
    const authUser = req.user!;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid member ID format." });
    }

    const body = req.body;
    const { name, mobile, email, role, status, password } = body;

    const member = await User.findById(id);
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    // Team Leader restrictions
    if (authUser.role === "team_leader") {
      if (member.role !== "agent") {
        return res.status(403).json({
          error: "Team Leaders are only permitted to manage Agents.",
        });
      }
      if (role && role !== "agent") {
        return res.status(403).json({
          error: "Team Leaders cannot promote agents to other roles.",
        });
      }
    }

    // Email uniqueness check if email changed
    if (email && email.toLowerCase() !== member.email) {
      const normalizedEmail = email.toLowerCase().trim();
      const existing = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: id },
      });
      if (existing) {
        return res.status(400).json({
          error: "A user with this email already exists.",
        });
      }
      member.email = normalizedEmail;
    }

    const updateFields: any = {};
    if (name) updateFields.name = String(name).trim();
    if (mobile) updateFields.mobile = String(mobile).trim();
    if (role && ["team_leader", "agent", "mis", "marketing"].includes(role)) {
      updateFields.role = role;
    }
    if (status && ["active", "inactive"].includes(status)) {
      updateFields.status = status;
    }

    // Optional password reset
    if (password && String(password).trim().length > 0) {
      updateFields.password = await bcrypt.hash(String(password), 10);
    }

    const updatedMember = await User.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: true }
    ).select("-password");

    return res.status(200).json({
      message: "Member updated successfully",
      member: updatedMember,
    });
  } catch (error: any) {
    console.error("Error updating member:", error);
    return res.status(500).json({
      error: error.message || "Failed to update member",
    });
  }
}

/**
 * DELETE /api/v1/members/:id
 * Admin-only permission.
 * Cannot delete other admins.
 */
export async function deleteMember(req: Request, res: Response) {
  try {
    const authUser = req.user!;

    // Strictly admin only
    if (authUser.role !== "admin") {
      return res.status(403).json({
        error: "Unauthorized. Admin access required.",
      });
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid member ID format." });
    }

    const member = await User.findById(id);
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    // Protect administrator accounts
    if (member.role === "admin") {
      return res.status(400).json({
        error: "Cannot delete an administrator account",
      });
    }

    await User.findByIdAndDelete(id);

    return res.status(200).json({ message: "Member deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting member:", error);
    return res.status(500).json({
      error: error.message || "Failed to delete member",
    });
  }
}
