/**
 * Run mode — one property of the process, shared by both servers.
 *
 * Both entry points ship every tool they have; the mode decides which of them
 * get registered and how politely the process talks to the upstream site.
 *
 *  - `full`   — the local install. Reads `.env`, registers the willhaben
 *               account tools, and paces requests for a single user on their
 *               own IP.
 *  - `public` — a shared or hosted install. No credential is read from the
 *               environment and no tool that could use one is registered, so
 *               a public deployment cannot leak a session cookie it never
 *               loads. Request spacing and per-call caps are tightened,
 *               because every user shares one outbound IP.
 *
 * This is deliberately a mode and not a build: one codebase, one binary, the
 * decision made at startup. A separate "public build" would drift from the
 * local one, and the drift would be invisible until the hosted server started
 * behaving differently from the one that was tested.
 */
export type Mode = "full" | "public";

const ENV_VAR = "WILLMEHR_MODE";

/**
 * Resolve the mode from `--public` / `--full` or `WILLMEHR_MODE`, flag first.
 *
 * An unrecognised value throws rather than falling back: silently defaulting
 * to `full` on a typo in a deployment would register the account tools on a
 * server meant to be anonymous.
 */
export function resolveMode(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Mode {
  const flag = argv.includes("--public") ? "public" : argv.includes("--full") ? "full" : undefined;
  const raw = flag ?? env[ENV_VAR]?.trim().toLowerCase();
  if (!raw) return "full";
  if (raw === "public" || raw === "full") return raw;
  throw new Error(
    `Invalid ${ENV_VAR}=${JSON.stringify(raw)}. Expected "full" or "public" (or pass --public/--full).`,
  );
}

/** Credentials that `public` mode refuses to read. */
const CREDENTIAL_VARS = ["WILLHABEN_COOKIE", "WILLHABEN_CSRF_TOKEN"] as const;

/**
 * Tell the operator on stderr that a credential in the environment is being
 * ignored. Silence here would look like the account tools are merely broken.
 */
export function warnIgnoredCredentials(mode: Mode, env: NodeJS.ProcessEnv = process.env): void {
  if (mode !== "public") return;
  const present = CREDENTIAL_VARS.filter((name) => env[name]);
  if (present.length === 0) return;
  console.error(
    `[public mode] Ignoring ${present.join(", ")}. Public mode never sends a session cookie ` +
      "and registers no account tools. Run without --public to use them.",
  );
}

/**
 * Read a positive number from the environment, falling back to the mode's
 * default. Explicit configuration always wins over the mode.
 */
export function numberFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
