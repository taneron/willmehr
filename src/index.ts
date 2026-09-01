#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { WillhabenClient } from "./http.js";
import { numberFromEnv, resolveMode, warnIgnoredCredentials, type Mode } from "./mode.js";
import { createServer } from "./server.js";

/**
 * Load .env from the package root if present. MCP clients launch the server with
 * an arbitrary cwd and often a stripped environment, so relying on the shell to
 * export the session cookie is unreliable.
 *
 * Skipped entirely in public mode — a public process should not even read the
 * file, let alone send what is in it.
 */
function loadEnvFile(): void {
  const envPath = new URL("../.env", import.meta.url);
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Absent or unreadable .env is fine — the public tools need no credentials.
  }
}

/** Default request spacing. Public mode is slower: every user shares one IP. */
function defaultInterval(mode: Mode): number {
  return mode === "public" ? 900 : 400;
}

async function main(): Promise<void> {
  const mode = resolveMode();
  if (mode === "full") loadEnvFile();
  warnIgnoredCredentials(mode);

  const client = new WillhabenClient({
    cookie: mode === "full" ? process.env.WILLHABEN_COOKIE : undefined,
    csrfToken: mode === "full" ? process.env.WILLHABEN_CSRF_TOKEN : undefined,
    minIntervalMs: numberFromEnv("WILLHABEN_MIN_INTERVAL_MS", defaultInterval(mode)),
  });

  const server = createServer(client, { mode });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout carries the MCP protocol; diagnostics must go to stderr.
  console.error("willmehr failed to start:", err);
  process.exit(1);
});
