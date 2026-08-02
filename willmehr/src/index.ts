#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { WillhabenClient } from "./http.js";
import { createServer } from "./server.js";

/**
 * Load .env from the package root if present. MCP clients launch the server with
 * an arbitrary cwd and often a stripped environment, so relying on the shell to
 * export the session cookie is unreliable.
 */
function loadEnvFile(): void {
  const envPath = new URL("../.env", import.meta.url);
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Absent or unreadable .env is fine — the public tools need no credentials.
  }
}

async function main(): Promise<void> {
  loadEnvFile();

  const client = new WillhabenClient({
    cookie: process.env.WILLHABEN_COOKIE,
    csrfToken: process.env.WILLHABEN_CSRF_TOKEN,
    minIntervalMs: numberFromEnv("WILLHABEN_MIN_INTERVAL_MS", 400),
  });

  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

main().catch((err: unknown) => {
  // stdout carries the MCP protocol; diagnostics must go to stderr.
  console.error("willmehr failed to start:", err);
  process.exit(1);
});
