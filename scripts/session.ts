/**
 * Extract a logged-in session cookie from a HAR export into .env.
 *
 *   npm run session -- ~/Downloads/www.willhaben.at.har
 *
 * The session rotates every few days, so this exists to make refreshing it one
 * command. Cookie values are written straight to .env (mode 0600) and never
 * printed. Export the HAR with DevTools' "Export HAR (with sensitive data)" —
 * the plain download button strips cookies and produces a useless file.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

interface HarEntry {
  startedDateTime?: string;
  request: {
    url: string;
    headers: Array<{ name: string; value: string }>;
    cookies?: Array<{ name: string; value: string }>;
  };
}

/** Routes that only answer for a logged-in session, so their jar is post-login. */
const AUTHENTICATED_ROUTES = [
  "/webapi/userprofile-service/userprofile/me",
  "/webapi/chat-api/v1/conversations",
  "/webapi/iad/userfolders/",
  "/webapi/ad-search/alert/user/",
];

const harPath = process.argv[2];
if (!harPath) {
  console.error("usage: npm run session -- <path-to.har>");
  process.exit(1);
}

const har = JSON.parse(readFileSync(harPath, "utf8")) as { log: { entries: HarEntry[] } };

// Take the LAST authenticated request: logging in rotates BBX_JSESSIONID, and an
// earlier entry may still carry the anonymous pre-login session.
let chosen: HarEntry | undefined;
for (const entry of har.log.entries) {
  if (!entry.request.url.includes("www.willhaben.at")) continue;
  if (!AUTHENTICATED_ROUTES.some((route) => entry.request.url.includes(route))) continue;
  if (header(entry, "cookie")?.includes("BBX_JSESSIONID")) chosen = entry;
}

if (!chosen) {
  console.error(
    "No authenticated request with a BBX_JSESSIONID cookie found.\n" +
      "Make sure you were logged in, visited a page that loads your profile or chats,\n" +
      "and exported with 'Export HAR (with sensitive data)'.",
  );
  process.exit(1);
}

const cookie = header(chosen, "cookie");
if (!cookie) {
  console.error("Chosen request has no Cookie header.");
  process.exit(1);
}

const names = cookie.split(";").map((part) => part.split("=")[0]?.trim() ?? "");
writeFileSync(
  ".env",
  [
    "# Session lifted from a browser HAR. Rotates every few days.",
    `# Captured: ${chosen.startedDateTime ?? "unknown"}`,
    `# Source:   ${chosen.request.url.split("?")[0]}`,
    "# Refresh:  npm run session -- <path-to.har>",
    `WILLHABEN_COOKIE="${cookie.replace(/"/g, '\\"')}"`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
chmodSync(".env", 0o600);

console.log(`Wrote .env from ${chosen.request.url.split("?")[0]}`);
console.log(`Captured at: ${chosen.startedDateTime ?? "unknown"}`);
console.log(`Cookies:     ${names.join(", ")}`);
console.log(
  names.includes("x-bbx-csrf-token")
    ? "CSRF token present — it is derived from the cookie automatically."
    : "WARNING: no x-bbx-csrf-token cookie; authenticated writes may fail.",
);
console.log("\nVerify with: npm run check:auth");

function header(entry: HarEntry, name: string): string | undefined {
  return entry.request.headers.find((h) => h.name.toLowerCase() === name)?.value;
}
