#!/usr/bin/env node
/**
 * Streamable HTTP host for the anonymous half of both servers.
 *
 * Two endpoints, one process:
 *
 *   POST /willhaben/mcp      the four public willhaben tools
 *   POST /kleinanzeigen/mcp  all five kleinanzeigen tools
 *   GET  /healthz            liveness for the platform's health check
 *
 * Transports are stateless: a fresh McpServer and transport per request, torn
 * down when the response ends. The two upstream clients, by contrast, are
 * process-wide on purpose — their request queues are what keeps the whole
 * deployment to one polite stream of traffic per site, no matter how many
 * users are connected. That is also the main limit on how far this scales:
 * every user shares one outbound IP and one queue.
 *
 * The mode is pinned to `public` here and cannot be overridden. A hosted
 * process must never read a session cookie, so `WILLMEHR_MODE=full` in the
 * environment is treated as a misconfigured deployment and refuses to start
 * rather than quietly exposing the operator's own willhaben account to
 * everyone who finds the URL.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { WillhabenClient } from "./http.js";
import { KleinanzeigenClient } from "./kleinanzeigen/http.js";
import { createServer as createKleinanzeigenServer } from "./kleinanzeigen/server.js";
import { numberFromEnv } from "./mode.js";
import { createServer as createWillhabenServer } from "./server.js";

const MODE = "public" as const;

const PORT = numberFromEnv("PORT", 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
/** Requests a single IP may burst, then a slow refill. Searches are expensive. */
const RATE_BURST = numberFromEnv("MCP_RATE_BURST", 10);
const RATE_PER_SEC = numberFromEnv("MCP_RATE_PER_MINUTE", 20) / 60;
/** Ceiling on concurrent tool calls, so a burst queues at the door, not upstream. */
const MAX_INFLIGHT = numberFromEnv("MCP_MAX_INFLIGHT", 8);
const MAX_BODY_BYTES = numberFromEnv("MCP_MAX_BODY_BYTES", 1_000_000);
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? "");
const ALLOWED_ORIGINS = list(process.env.MCP_ALLOWED_ORIGINS);
const ALLOWED_HOSTS = list(process.env.MCP_ALLOWED_HOSTS);

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

if (process.env.WILLMEHR_MODE?.trim().toLowerCase() === "full") {
  console.error(
    "Refusing to start: WILLMEHR_MODE=full on the HTTP host. This process is reachable by " +
      "anyone and must stay anonymous. Unset it, or run dist/index.js over stdio for account tools.",
  );
  process.exit(1);
}

// Shared across every request: one queue per upstream site.
const willhaben = new WillhabenClient({
  minIntervalMs: numberFromEnv("WILLHABEN_MIN_INTERVAL_MS", 900),
});
const kleinanzeigen = new KleinanzeigenClient({
  minIntervalMs: numberFromEnv("KZ_MIN_INTERVAL_MS", 1500),
});

const ROUTES: Record<string, () => McpServer> = {
  "/willhaben/mcp": () => createWillhabenServer(willhaben, { mode: MODE }),
  "/kleinanzeigen/mcp": () =>
    createKleinanzeigenServer(kleinanzeigen, {
      mode: MODE,
      maxPages: numberFromEnv("KZ_MAX_PAGE_COUNT", 3),
      maxBatchSize: numberFromEnv("KZ_MAX_BATCH_SIZE", 10),
    }),
};

let inflight = 0;

const http = createHttpServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error("unhandled request error:", err);
    if (!res.headersSent) fail(res, 500, -32603, "Internal server error");
    else res.end();
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: MODE, inflight, endpoints: Object.keys(ROUTES) }));
    return;
  }

  const factory = ROUTES[path];
  if (!factory) {
    fail(res, 404, -32601, `No MCP endpoint at ${path}. Try ${Object.keys(ROUTES).join(" or ")}.`);
    return;
  }

  // Stateless: there is no session to resume and no server-initiated stream,
  // so GET (SSE) and DELETE (session teardown) have nothing to act on.
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    fail(res, 405, -32000, "This endpoint is stateless; use POST.");
    return;
  }

  if (!originAllowed(req)) {
    fail(res, 403, -32000, "Origin or Host not allowed.");
    return;
  }

  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    fail(res, 413, -32000, "Request body too large.");
    return;
  }

  if (!allow(clientIp(req))) {
    res.setHeader("retry-after", "30");
    fail(res, 429, -32000, "Rate limit exceeded. This is a shared instance — slow down.");
    return;
  }

  if (inflight >= MAX_INFLIGHT) {
    res.setHeader("retry-after", "10");
    fail(res, 503, -32000, "Server busy. Retry shortly.");
    return;
  }

  inflight += 1;
  const server = factory();
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session id, nothing retained between requests.
    sessionIdGenerator: undefined,
    // Plain JSON rather than SSE. Nothing here streams progress, and a single
    // JSON response survives proxies and buffering that SSE does not.
    enableJsonResponse: true,
  });

  res.on("close", () => {
    inflight -= 1;
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

/** JSON-RPC shaped error, so a client surfaces the reason instead of "fetch failed". */
function fail(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * DNS-rebinding and cross-site protection, opt-in. Unset lists mean "allow",
 * because the normal client here is an MCP host with no Origin at all.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin?.toLowerCase();
  if (origin && ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) return false;
  const host = req.headers.host?.toLowerCase();
  if (host && ALLOWED_HOSTS.length > 0 && !ALLOWED_HOSTS.includes(host)) return false;
  return true;
}

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();

/** Token bucket per IP. Refills continuously; `RATE_BURST` is the ceiling. */
function allow(ip: string, now = Date.now()): boolean {
  const bucket = buckets.get(ip) ?? { tokens: RATE_BURST, updated: now };
  bucket.tokens = Math.min(RATE_BURST, bucket.tokens + ((now - bucket.updated) / 1000) * RATE_PER_SEC);
  bucket.updated = now;
  buckets.set(ip, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Drop buckets that have refilled to full; keeping them is just a slow leak.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (bucket.tokens + ((now - bucket.updated) / 1000) * RATE_PER_SEC >= RATE_BURST) buckets.delete(ip);
  }
}, 300_000).unref();

// A stalled upstream fetch must not pin a connection open forever.
http.requestTimeout = numberFromEnv("MCP_REQUEST_TIMEOUT_MS", 120_000);
http.headersTimeout = 30_000;

http.listen(PORT, HOST, () => {
  console.error(`willmehr HTTP host (${MODE}) on http://${HOST}:${PORT}`);
  for (const path of Object.keys(ROUTES)) console.error(`  POST ${path}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.error(`${signal} received, draining...`);
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
