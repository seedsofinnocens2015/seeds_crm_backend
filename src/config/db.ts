import mongoose from "mongoose";
import dns from "dns";
import { config } from "./env.js";

// Ensure Node.js can resolve MongoDB Atlas SRV records even if local ISP router/DNS blocks them
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {
  // Ignore if custom servers cannot be set
}

interface ConnectionState {
  isConnected: boolean;
  stateText: "disconnected" | "connected" | "connecting" | "disconnecting" | "unknown";
  host?: string;
  name?: string;
}

const STATE_MAP: Record<number, ConnectionState["stateText"]> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

export function getDatabaseStatus(): ConnectionState {
  const readyState = mongoose.connection.readyState;
  const stateText = STATE_MAP[readyState] || "unknown";
  const isConnected = readyState === 1;

  return {
    isConnected,
    stateText,
    host: isConnected ? mongoose.connection.host : undefined,
    name: isConnected ? mongoose.connection.name : undefined,
  };
}

export async function connectDB(): Promise<typeof mongoose | null> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  try {
    const conn = await mongoose.connect(config.mongodbUri, {
      bufferCommands: true,
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 100, // Handle high concurrent queries for 300+ active members
      minPoolSize: 10,  // Maintain warm connection pool
      socketTimeoutMS: 45000,
    });
    console.log(`[Database] MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error: any) {
    console.error(`[Database] MongoDB connection failed: ${error.message}`);
    return null;
  }
}

export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log("[Database] MongoDB disconnected cleanly.");
  }
}
