#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { numberFromEnv, resolveMode, type Mode } from "../mode.js";
import { KleinanzeigenClient } from "./http.js";
import { createServer } from "./server.js";

/**
 * Kleinanzeigen needs no credentials, so `public` here is not about secrets —
 * it is about sharing one outbound IP. Spacing goes up and the per-call caps
 * come down, so a single user cannot spend the whole instance's bot-detection
 * budget on one 5-page search. Explicit env vars still override both.
 */
function defaultsFor(mode: Mode): { intervalMs: number; maxPages: number; maxBatchSize: number } {
  return mode === "public"
    ? { intervalMs: 1500, maxPages: 3, maxBatchSize: 10 }
    : { intervalMs: 800, maxPages: 5, maxBatchSize: 20 };
}

async function main(): Promise<void> {
  const mode = resolveMode();
  const defaults = defaultsFor(mode);

  const client = new KleinanzeigenClient({
    // Kleinanzeigen throttles aggressively. The default spacing is deliberately
    // slower than willhaben's — it is the whole bot-detection defence here.
    minIntervalMs: numberFromEnv("KZ_MIN_INTERVAL_MS", defaults.intervalMs),
  });

  // Search responses feed straight into a context window, so the page cap sits
  // well below what the site would serve (~25 listings per page).
  const server = createServer(client, {
    mode,
    maxPages: numberFromEnv("KZ_MAX_PAGE_COUNT", defaults.maxPages),
    maxBatchSize: numberFromEnv("KZ_MAX_BATCH_SIZE", defaults.maxBatchSize),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout carries the MCP protocol; diagnostics must go to stderr.
  console.error("kleinanzeigen-mcp failed to start:", err);
  process.exit(1);
});
