import http from "http";
import app from "./app.js";
import { config } from "./config/env.js";
import { connectDB, disconnectDB } from "./config/db.js";
import { startSmartfloScheduler, stopSmartfloScheduler } from "./services/smartflo/smartfloScheduler.js";

const server = http.createServer(app);

async function startServer() {
  // Connect to database before accepting incoming requests
  try {
    await connectDB();
  } catch (err: any) {
    console.error(`[Startup] Initial MongoDB connection error: ${err.message}`);
  }

  server.listen(config.port, () => {
    console.log(`[Server] seeds-crm-backend running on port ${config.port} in ${config.nodeEnv} mode`);
    console.log(`[Server] Health check available at: http://localhost:${config.port}/health`);

    // Register Smartflo queue and CDR scheduler if feature flag is active
    startSmartfloScheduler();
  });
}

// Graceful Shutdown Logic
async function shutdown(signal: string) {
  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);

  server.close(async () => {
    console.log("[Server] HTTP server closed.");
    try {
      stopSmartfloScheduler();
      await disconnectDB();
      console.log("[Server] Cleanup complete. Exiting process.");
      process.exit(0);
    } catch (err: any) {
      console.error("[Server] Error during shutdown:", err.message);
      process.exit(1);
    }
  });

  // Force close after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error("[Server] Force shutdown timeout reached. Terminating.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startServer().catch((err) => {
  console.error("[Server] Fatal startup error:", err);
  process.exit(1);
});
