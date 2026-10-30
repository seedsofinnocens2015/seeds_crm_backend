import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { config } from "./config/env.js";
import { AuthenticatedUserPayload } from "./middleware/auth.js";

let ioInstance: SocketIOServer | null = null;

export interface InboundCallNotification {
  callId: string;
  uuid?: string;
  did: string;
  callerNumber: string;
  normalizedPhone: string;
  status: "ringing" | "answered" | "missed" | "ended";
  timestamp: string;
  agentExtension?: string;
  agentName?: string;
  leadMatched: boolean;
  lead?: {
    id: string;
    uniqueId: string;
    name: string;
    stage?: string;
    owner?: string;
    primaryMobileNumber?: string;
    gender?: string;
  } | null;
}

/**
 * Initializes authenticated Socket.IO server mounted on the HTTP server.
 */
export function initSocketServer(server: HttpServer): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: {
      origin: (origin, callback) => {
        // Disallow requests with no origin if not allowed by config
        if (!origin) {
          // Allow server-to-server or non-browser if configured, otherwise require matched origin
          return callback(null, true);
        }
        const allowedOrigins = config.corsOrigin;
        if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
          return callback(null, true);
        }
        return callback(new Error(`Socket.IO CORS policy does not allow origin: ${origin}`));
      },
      credentials: true,
    },
    path: "/socket.io",
  });

  // Authentication Middleware: inspects cookie or auth token in handshake
  io.use((socket: Socket, next) => {
    try {
      let token: string | undefined;

      // 1. From auth payload { token: "..." }
      if (socket.handshake.auth && typeof socket.handshake.auth.token === "string" && socket.handshake.auth.token.trim()) {
        token = socket.handshake.auth.token.trim();
      }

      // 2. From handshake query parameter ?token=...
      if (!token && socket.handshake.query && typeof socket.handshake.query.token === "string" && socket.handshake.query.token.trim()) {
        token = socket.handshake.query.token.trim();
      }

      // 3. From Authorization header
      if (!token && socket.handshake.headers.authorization?.startsWith("Bearer ")) {
        token = socket.handshake.headers.authorization.split(" ")[1]?.trim();
      }

      // 4. From cookie string
      if (!token && socket.handshake.headers.cookie) {
        const cookies = socket.handshake.headers.cookie.split(";").map((c) => c.trim());
        const tokenCookie = cookies.find((c) => c.startsWith("token="));
        if (tokenCookie) {
          token = tokenCookie.substring("token=".length).trim();
        }
      }

      if (!token) {
        return next(new Error("Authentication token required for WebSocket connection."));
      }

      const decoded = jwt.verify(token, config.jwtSecret) as AuthenticatedUserPayload;
      (socket as any).user = decoded;
      next();
    } catch (err: any) {
      return next(new Error("Invalid or expired authentication token."));
    }
  });

  io.on("connection", (socket: Socket) => {
    const user: AuthenticatedUserPayload = (socket as any).user;
    if (!user) return;

    // Join user-specific room
    socket.join(`user:${user.id}`);
    socket.join(`role:${user.role}`);

    // Common room for all agents and managers handling inbound telephony
    socket.join("telephony:inbound");

    socket.on("disconnect", () => {
      // Clean disconnect
    });
  });

  ioInstance = io;
  return io;
}

/**
 * Returns active Socket.IO server instance.
 */
export function getSocketServer(): SocketIOServer | null {
  return ioInstance;
}

/**
 * Broadcasts an incoming or active call event to authenticated telephony agents.
 */
export function broadcastInboundCallEvent(event: "inbound:ringing" | "inbound:answered" | "inbound:ended" | "inbound:missed", data: InboundCallNotification) {
  if (!ioInstance) return;

  // Broadcast to all active telephony agents & managers
  ioInstance.to("telephony:inbound").emit(event, data);
}
