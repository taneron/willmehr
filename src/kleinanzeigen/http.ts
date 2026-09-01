/**
 * Low-level HTTP access to kleinanzeigen.de.
 *
 * The Python original drives a headless Chromium (via DanielWTE/ebay-kleinanzeigen-api)
 * because it assumes the site needs JS. It does not: search results, ad detail pages
 * and the view counter are all reachable with a plain GET and a browser-shaped
 * `User-Agent`, which is why this port is fetch-only. See README for the trade-off.
 *
 * Two things the site is picky about:
 *  - A non-browser `User-Agent` gets served a challenge page instead of results.
 *  - Concurrent requests from one IP trip bot detection even when they are staggered,
 *    so every request goes through one serialised, spaced-out queue. That queue is
 *    this port's replacement for the upstream `KZ_MAX_CONCURRENT` semaphore.
 */

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export const ORIGIN = "https://www.kleinanzeigen.de";

export class KleinanzeigenError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string | undefined;

  constructor(message: string, status: number, url: string, body?: string) {
    super(message);
    this.name = "KleinanzeigenError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Thrown when an ad id no longer resolves to an ad page. */
export class ListingGoneError extends Error {
  readonly listingId: string;

  constructor(listingId: string) {
    super(`Listing ${listingId} is deleted or expired.`);
    this.name = "ListingGoneError";
    this.listingId = listingId;
  }
}

export interface ClientOptions {
  userAgent?: string;
  /** Minimum spacing between requests, in ms. Keeps us a polite client. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface FetchResult {
  html: string;
  /** Where we ended up. A redirect off `/s-anzeige/` means the ad is gone. */
  finalUrl: string;
  status: number;
}

export class KleinanzeigenClient {
  private readonly opts: Required<ClientOptions>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: ClientOptions = {}) {
    this.opts = {
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      minIntervalMs: options.minIntervalMs ?? 800,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
    };
  }

  /** GET a page as HTML, following redirects and reporting where we landed. */
  async getPage(url: string): Promise<FetchResult> {
    const res = await this.request(url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    return { html: await res.text(), finalUrl: res.url || url, status: res.status };
  }

  /** GET a JSON endpoint and parse it. */
  async getJson<T>(url: string, referer?: string): Promise<T> {
    const res = await this.request(url, "application/json", referer);
    return (await res.json()) as T;
  }

  /**
   * Serialised, rate-limited, retrying fetch. Requests chain through a single
   * promise so concurrent callers still respect `minIntervalMs` — the site
   * blocks parallel requests from one IP.
   */
  private request(url: string, accept: string, referer?: string): Promise<Response> {
    const run = this.queue.then(
      () => this.executeWithRetry(url, accept, referer),
      () => this.executeWithRetry(url, accept, referer),
    );
    // Keep the chain alive even when a caller's request rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async executeWithRetry(url: string, accept: string, referer?: string): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      await this.throttle();
      try {
        const res = await this.execute(url, accept, referer);
        // 429/5xx are worth another go; other 4xx are not.
        if (res.status === 429 || res.status >= 500) {
          const body = await res.text().catch(() => "");
          lastError = new KleinanzeigenError(
            res.status === 429
              ? `kleinanzeigen rate-limited this client (429). Raise KZ_MIN_INTERVAL_MS or slow down.`
              : `kleinanzeigen returned ${res.status} for ${url}`,
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
          throw new KleinanzeigenError(describeStatus(res.status, url), res.status, url, body.slice(0, 400));
        }
        return res;
      } catch (err) {
        if (err instanceof KleinanzeigenError && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
        if (attempt < this.opts.maxRetries) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async execute(url: string, accept: string, referer?: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept,
      "accept-language": "de-DE,de;q=0.9,en;q=0.8",
      "user-agent": this.opts.userAgent,
      "upgrade-insecure-requests": "1",
    };
    if (referer) headers.referer = referer;

    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    this.lastRequestAt = Date.now();
    return await fetch(url, { headers, redirect: "follow", signal });
  }

  private async throttle(): Promise<void> {
    const waitFor = this.lastRequestAt + this.opts.minIntervalMs - Date.now();
    if (waitFor > 0) await sleep(waitFor);
  }
}

function describeStatus(status: number, url: string): string {
  if (status === 403) {
    return `kleinanzeigen denied the request (403) for ${url}. Bot detection — most likely a datacenter IP or too many requests.`;
  }
  if (status === 404) return `Not found (404): ${url}`;
  return `kleinanzeigen returned ${status} for ${url}`;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  }
  // 1s, 2s, 4s ... with jitter to avoid lockstep retries.
  return Math.min(1000 * 2 ** attempt, 8_000) + Math.random() * 400;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
