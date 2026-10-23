import { Request, Response, NextFunction } from "express";

type Role = "admin" | "team_leader" | "agent" | "mis" | "marketing";

/**
 * Role-Based Access Control Guard
 * Restricts route access to specified roles.
 */
export function requireRole(allowedRoles: Role | Role[]) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Authentication required.",
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: "Forbidden",
        message: `Access denied. Role "${req.user.role}" does not have permission to access this resource.`,
      });
    }

    next();
  };
}
