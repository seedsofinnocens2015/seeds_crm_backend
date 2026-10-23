import http from "node:http";
import { URL } from "node:url";

/**
 * Dedicated, temporary development reverse proxy.
 * ONLY exposes /api/v1/integrations/meta/webhook for GET and POST methods.
 * Forwards matching requests to the primary Express backend running at TARGET_URL.
 * All other paths and methods are rejected with 404/405 without forwarding.
 */

const PROXY_PORT = parseInt(process.env.META_PROXY_PORT || "5001", 10);
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1";
const TARGET_PORT = parseInt(process.env.TARGET_PORT || "5000", 10);
const ALLOWED_PATH = "/api/v1/integrations/meta/webhook";
const ALLOWED_METHODS = ["GET", "POST"];

const server = http.createServer((req, res) => {
  const reqMethod = (req.method || "").toUpperCase();
  
  // Parse path without query parameters
  let reqPath = "";
  try {
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    reqPath = parsedUrl.pathname;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Request", message: "Invalid URL" }));
    return;
  }

  // Strictly enforce path isolation: reject any request not exactly targeting the Meta webhook route
  if (reqPath !== ALLOWED_PATH) {
    console.warn(`[Meta Proxy BLOCKED] 404 Not Found - Path not allowed: ${reqMethod} ${reqPath}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Not Found",
        message: "Endpoint not exposed on this proxy",
      })
    );
    return;
  }

  // Strictly enforce allowed HTTP methods (GET for verification handshake, POST for event webhook)
  if (!ALLOWED_METHODS.includes(reqMethod)) {
    console.warn(`[Meta Proxy BLOCKED] 405 Method Not Allowed: ${reqMethod} ${reqPath}`);
    res.writeHead(405, {
      "Content-Type": "application/json",
      Allow: ALLOWED_METHODS.join(", "),
    });
    res.end(
      JSON.stringify({
        error: "Method Not Allowed",
        message: `Only ${ALLOWED_METHODS.join(", ")} are supported on this endpoint`,
      })
    );
    return;
  }

  console.info(`[Meta Proxy FORWARD] ${reqMethod} ${req.url} -> http://${TARGET_HOST}:${TARGET_PORT}${req.url}`);

  // Forward request headers, adjusting host and forwarding markers
  const forwardHeaders = { ...req.headers };
  forwardHeaders.host = `${TARGET_HOST}:${TARGET_PORT}`;
  forwardHeaders["x-forwarded-for"] = req.socket.remoteAddress || "";
  forwardHeaders["x-forwarded-proto"] = "http";
  forwardHeaders["x-forwarded-port"] = PROXY_PORT.toString();

  const proxyReq = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url, // Preserves query parameters like hub.mode, hub.challenge, hub.verify_token
      method: reqMethod,
      headers: forwardHeaders,
    },
    (targetRes) => {
      // Forward status code and target headers back to client
      res.writeHead(targetRes.statusCode || 502, targetRes.headers);
      targetRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    console.error(`[Meta Proxy Error] Failed to connect to Express backend at ${TARGET_HOST}:${TARGET_PORT}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Bad Gateway",
          message: "Express backend is unreachable. Ensure the backend server is running on port 5000.",
        })
      );
    }
  });

  // Stream client request body (e.g. Meta webhook POST event payload) to target request
  req.pipe(proxyReq);
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.info(`=======================================================`);
  console.info(`Meta Webhook Isolated Proxy running on port ${PROXY_PORT}`);
  console.info(`Exposing ONLY: ${ALLOWED_PATH} (${ALLOWED_METHODS.join(", ")})`);
  console.info(`Forwarding to: http://${TARGET_HOST}:${TARGET_PORT}`);
  console.info(`All other paths and methods will be rejected (404/405).`);
  console.info(`=======================================================`);
});

// Graceful termination handling
process.on("SIGINT", () => {
  console.info("\nShutting down Meta Webhook Isolated Proxy...");
  server.close(() => {
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  server.close(() => {
    process.exit(0);
  });
});
