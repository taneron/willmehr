/**
 * Low-level HTTP access to willhaben.at.
 *
 * Two things learned from the HAR capture that are easy to get wrong:
 *  - `x-wh-client` is REQUIRED on /webapi/ routes. Without it every request is a
 *    bare 400 with an empty body, which reads like a bad query parameter but is not.
 *  - The JSON search API itself needs no cookies at all. Only the account-scoped
 *    routes (chat, watchlist, offers) do.
 */

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** The value the willhaben web app sends. Required; the exact string is not validated. */
const WH_CLIENT = "api@willhaben.at;responsive_web;server;1.0.0;desktop";

export const ORIGIN = "https://www.willhaben.at";

export class WillhabenError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string | undefined;

  constructor(message: string, status: number, url: string, body?: string) {
    super(message);
    this.name = "WillhabenError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export interface ClientOptions {
  /**
   * Raw `Cookie` header from a logged-in browser session. Must include
   * `BBX_JSESSIONID`; `x-bbx-csrf-token` is picked up from it automatically.
   */
  cookie?: string;
  /** Overrides the CSRF token normally read out of the cookie. */
  csrfToken?: string;
  userAgent?: string;
  /** Minimum spacing between requests, in ms. Keeps us a polite client. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export class WillhabenClient {
  private readonly opts: Required<Omit<ClientOptions, "cookie" | "csrfToken">> &
    Pick<ClientOptions, "cookie" | "csrfToken">;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: ClientOptions = {}) {
    this.opts = {
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      minIntervalMs: options.minIntervalMs ?? 400,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxRetries: options.maxRetries ?? 3,
      cookie: options.cookie,
      // The web app copies the `x-bbx-csrf-token` cookie into a same-named
      // header on every /webapi/ call (double-submit). Verified against the
      // capture: header and cookie are byte-identical.
      csrfToken: options.csrfToken ?? readCookie(options.cookie, "x-bbx-csrf-token"),
    };
  }

  get isAuthenticated(): boolean {
    return Boolean(this.opts.cookie);
  }

  /** GET a JSON endpoint and parse it. */
  async getJson<T>(url: string, init?: { auth?: boolean }): Promise<T> {
    const res = await this.request(url, { accept: "application/json", auth: init?.auth });
    return (await res.json()) as T;
  }

  /** GET a page and return it as text. */
  async getText(url: string, init?: { auth?: boolean }): Promise<string> {
    const res = await this.request(url, { accept: "text/html", auth: init?.auth });
    return await res.text();
  }

  /**
   * Serialised, rate-limited, retrying fetch. Requests are chained through a
   * single promise so concurrent callers still respect `minIntervalMs`.
   */
  private request(
    url: string,
    init: { accept: string; auth?: boolean; method?: string; body?: string },
  ): Promise<Response> {
    const run = this.queue.then(
      () => this.executeWithRetry(url, init),
      () => this.executeWithRetry(url, init),
    );
    // Keep the chain alive even when a caller's request rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async executeWithRetry(
    url: string,
    init: { accept: string; auth?: boolean; method?: string; body?: string },
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      await this.throttle();
      try {
        const res = await this.execute(url, init);
        // 429/5xx are worth another go; 4xx are not.
        if (res.status === 429 || res.status >= 500) {
          const body = await res.text().catch(() => "");
          lastError = new WillhabenError(
            `willhaben returned ${res.status} for ${url}`,
            res.status,
            url,
            body.slice(0, 400),
          );
          if (attempt < this.opts.maxRetries) {
            await sleep(backoffMs(attempt, res.headers.get("retry-after")));
            continue;
          }
          throw lastError;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new WillhabenError(
            describeStatus(res.status, url),
            res.status,
            url,
            body.slice(0, 400),
          );
        }
        return res;
      } catch (err) {
        if (err instanceof WillhabenError && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
        if (attempt < this.opts.maxRetries) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async execute(
    url: string,
    init: { accept: string; auth?: boolean; method?: string; body?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: init.accept,
      "accept-language": "de-AT,de;q=0.9,en;q=0.8",
      "user-agent": this.opts.userAgent,
      "x-wh-client": WH_CLIENT,
      referer: `${ORIGIN}/iad`,
    };

    if (init.auth) {
      if (!this.opts.cookie) {
        throw new WillhabenError(
          "This action needs a logged-in session. Set WILLHABEN_COOKIE (see README).",
          401,
          url,
        );
      }
      headers.cookie = this.opts.cookie;
      if (this.opts.csrfToken) headers["x-bbx-csrf-token"] = this.opts.csrfToken;
    }
    if (init.body) headers["content-type"] = "application/json";

    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    this.lastRequestAt = Date.now();
    return await fetch(url, { method: init.method ?? "GET", headers, body: init.body, signal });
  }

  private async throttle(): Promise<void> {
    const waitFor = this.lastRequestAt + this.opts.minIntervalMs - Date.now();
    if (waitFor > 0) await sleep(waitFor);
  }
}

/** Pull a single value out of a raw `Cookie` header string. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function describeStatus(status: number, url: string): string {
  if (status === 400) {
    return `willhaben rejected the request (400) for ${url}. Usually an invalid filter value or an unknown category id.`;
  }
  if (status === 401 || status === 403) {
    return `willhaben denied access (${status}) for ${url}. The session cookie is probably expired.`;
  }
  if (status === 404) return `Not found (404): ${url}`;
  return `willhaben returned ${status} for ${url}`;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  }
  // 500ms, 1s, 2s ... with jitter to avoid lockstep retries.
  return Math.min(500 * 2 ** attempt, 8_000) + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
