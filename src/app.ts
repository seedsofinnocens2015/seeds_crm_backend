import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config/env.js";
import { getDatabaseStatus } from "./config/db.js";
import apiRouter from "./routes/index.js";

const app = express();

// Standard Security & Parsing Middlewares
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (config.corsOrigin.includes(origin) || config.corsOrigin.includes("*")) {
        return callback(null, true);
      }
      return callback(new Error(`CORS policy does not allow access from ${origin}`));
    },
    credentials: true,
  })
);
app.use(
  express.json({
    limit: "10mb",
    verify: (req: Request, _res: Response, buf: Buffer) => {
      // Retain the raw request body buffer for HMAC signature verification (e.g. Meta webhooks)
      (req as any).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// GET /health - Reports service and database status safely without exposing secrets
app.get("/health", (req: Request, res: Response) => {
  const dbStatus = getDatabaseStatus();

  res.status(200).json({
    status: "ok",
    service: "seeds-crm-backend",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    database: {
      status: dbStatus.stateText,
      connected: dbStatus.isConnected,
    },
  });
});

// Mount versioned API routes under /api/v1
app.use("/api/v1", apiRouter);

// Centralized 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

// Centralized Error Handling Middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(`[Error] ${req.method} ${req.originalUrl}:`, err);

  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  res.status(statusCode).json({
    error: statusCode === 500 ? "Internal Server Error" : "Request Error",
    message: config.nodeEnv === "production" && statusCode === 500 ? "An unexpected error occurred" : message,
  });
});

export default app;
