# willmehr

MCP servers for hunting deals on the German-speaking classifieds sites. TypeScript,
over stdio locally or Streamable HTTP self-hosted; works with Claude Code, Claude
Desktop, or any other MCP client.

Two servers ship from this repo, each registered separately:

| Server | Site | Entry point |
| --- | --- | --- |
| `willmehr` | [willhaben.at](https://www.willhaben.at) (Austria) | `dist/index.js` |
| `kleinanzeigen-mcp` | [kleinanzeigen.de](https://www.kleinanzeigen.de) (Germany) | `dist/kleinanzeigen/index.js` |

They publish as two npm packages, [`willmehr`](https://www.npmjs.com/package/willmehr)
and [`kleinanzeigen-mcp`](https://www.npmjs.com/package/kleinanzeigen-mcp), released
together from this repo at the same version.

The willhaben server was built by reverse-engineering the willhaben web app's own JSON
API from a HAR capture. The Kleinanzeigen server is a port of
[`jnslmk/kleinanzeigen-mcp`](https://github.com/jnslmk/kleinanzeigen-mcp) — see
[Kleinanzeigen](#kleinanzeigen) below.

## Quick start

```bash
claude mcp add willmehr -- npx -y willmehr
claude mcp add kleinanzeigen -- npx -y kleinanzeigen-mcp
```

Or from a clone, which is what you want for hacking on it or self-hosting:

```bash
git clone https://github.com/taneron/willmehr.git && cd willmehr
npm install && npm run build

claude mcp add willmehr -- node "$PWD/dist/index.js"
claude mcp add kleinanzeigen -- node "$PWD/dist/kleinanzeigen/index.js"
```

Either way you get both servers locally, in `full` mode. The willhaben account tools need
a session cookie of your own — see [Authentication](#authentication); everything else
works anonymously and needs no setup.

To run it as a shared HTTP server instead, on your own box, see [Hosting](#hosting).
Nothing in this project phones home to anyone else's instance.


## Modes

Both servers run in one of two modes. Same code, same binary — the mode is chosen at
startup with `--public` / `--full` or `WILLMEHR_MODE`, and defaults to `full`.

| | `full` (default) | `public` |
| --- | --- | --- |
| willhaben account tools | registered | **not registered** |
| `.env` / `WILLHABEN_COOKIE` | loaded | never read; ignored with a warning on stderr |
| willhaben request spacing | 400 ms | 900 ms |
| Kleinanzeigen spacing / pages / batch | 800 ms / 5 / 20 | 1500 ms / 3 / 10 |

`public` is what makes this safe to host for other people: the process holds no
credential, and registers no tool that could use one, so a shared deployment cannot
leak a session it never loads. The tighter pacing is the other half — in `public` mode
every user shares one outbound IP, and both sites rate-limit per IP.

```bash
node dist/index.js --public               # willhaben, anonymous
WILLMEHR_MODE=public node dist/kleinanzeigen/index.js
```

Account tools deliberately have no hosted equivalent. willhaben authenticates through
Keycloak with PKCE, so there is no scoped token a third party could be granted — the
only thing a hosted server could ask for is the raw session cookie, which reads
messages and acts as the account. Anyone who wants those four tools runs `full` mode
locally with their own cookie. See [Hosting](#hosting).


# willhaben

## What it does

Four public tools, no account needed:

| Tool | Purpose |
| --- | --- |
| `willhaben_search` | Search the marketplace with structured filters; auto-paginates |
| `willhaben_get_ad` | Full detail for one ad: description, images, seller trust signals |
| `willhaben_find_deals` | Price the market for a query, rank listings below the median |
| `willhaben_discover_filters` | Resolve willhaben's opaque numeric category/brand ids |

Four account tools, requiring a session cookie:

| Tool | Purpose |
| --- | --- |
| `willhaben_my_profile` | Your profile and numeric user id |
| `willhaben_my_watchlist` | Ads saved to your watchlist |
| `willhaben_my_conversations` | Recent buyer/seller chats |
| `willhaben_my_alert_count` | Number of active saved-search alerts |

## Install

```bash
claude mcp add willmehr -- npx -y willmehr
```

Or from source:

```bash
npm install
npm run build
npm run pack:kz                      # stage build/kleinanzeigen-mcp for publishing
```

`willmehr` publishes from the repo root. `kleinanzeigen-mcp` publishes from
`build/kleinanzeigen-mcp`, staged by `npm run pack:kz` — it copies the built output the
Kleinanzeigen entry point reaches (its own directory plus the shared mode module) and
generates a manifest around it, so both packages ship the same commit at the same
version. `server.json` and `server.kleinanzeigen.json` are the matching MCP registry
entries.

Register it with Claude Code:

```bash
claude mcp add willmehr -- node "$PWD/dist/index.js"
```

Or in a client's MCP config:

```json
{
  "mcpServers": {
    "willmehr": {
      "command": "node",
      "args": ["/path/to/willmehr/dist/index.js"],
      "env": { "WILLHABEN_COOKIE": "BBX_JSESSIONID=...; x-bbx-csrf-token=..." }
    }
  }
}
```

## Authentication

willhaben authenticates through Keycloak with PKCE, so there is no username/password
grant to automate. Instead, lift the session from a logged-in browser:

1. Log in to willhaben.at, then visit your profile or messages so the page loads an
   authenticated endpoint.
2. DevTools → Network → export dropdown → **"Export HAR (with sensitive data)"**. The
   plain download button strips cookies and produces a file this cannot use.
3. `npm run session -- ~/Downloads/www.willhaben.at.har`
4. `npm run check:auth`

`npm run session` writes `.env` (mode `0600`, gitignored) and never prints cookie
values. `npm run check:auth` exercises all four account tools and stops at the first
`401` rather than repeatedly failing auth against your account.

The cookie must contain `BBX_JSESSIONID` (the session) and `x-bbx-csrf-token`. The
CSRF token is read out of the cookie automatically — willhaben's web app mirrors that
cookie into a same-named request header on every `/webapi/` call, and the server
reproduces that. `WILLHABEN_CSRF_TOKEN` only exists to override it.

The server loads `.env` from the package root itself, so MCP clients don't need to
pass the cookie through their config.

### Sessions expire faster than the cookie claims

`BBX_JSESSIONID` is sent with a five-day `Max-Age`, but the server invalidates it well
before that — a session captured and replayed **38 minutes later** was already
rejected. It is not IP- or header-binding: the same jar, replayed verbatim with the
browser's complete header set from the same machine and IP, still returns `401` while
anonymous requests continue to work.

Treat the session as short-lived. Re-run `npm run session` right before you need the
account tools, rather than expecting a capture to keep working for days.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `WILLHABEN_COOKIE` | — | Session cookie for account tools |
| `WILLHABEN_CSRF_TOKEN` | from cookie | Override the CSRF token |
| `WILLHABEN_MIN_INTERVAL_MS` | `400` (`900` public) | Minimum spacing between requests |
| `WILLMEHR_MODE` | `full` | `full` or `public` — see [Modes](#modes) |

## Using it well

**Resolve ids before filtering.** Categories and brands are opaque integers. Ask
`willhaben_discover_filters` first — it returns each filter value with its id *and* a
hit count for your current query:

> Which laptop brands have listings under €300 in Vienna right now?

**Narrow before ranking deals.** `willhaben_find_deals` compares each listing against
the median of its result set, so the query has to describe one kind of item. Searching
`thinkpad` mixes €900 laptops with €5 docking stations and every "discount" it reports
is noise. Searching `thinkpad x1 carbon` inside category `5831` (Notebooks) with
`priceFrom: 150` gives a median worth measuring against.

**Watch for `suspiciouslyCheap`.** Any listing under 20% of the median is flagged.
Sometimes that's a genuine bargain; more often it's a placeholder price, a parts-only
listing, or bait. The flag is a prompt to read the ad, not a verdict.

**Sniping.** Combine `sort: "newest"` with `maxAgeHours: 2` to see only what appeared
in the last couple of hours.

### Example

> Find me underpriced ThinkPad X1 Carbons from private sellers in Vienna, posted in
> the last day, and tell me which are worth messaging about.

The agent chains `willhaben_discover_filters` → `willhaben_find_deals` →
`willhaben_get_ad` on the top candidates to check seller age and ad text.

## How it works

Notes from the HAR analysis, since none of this is documented publicly:

- **`x-wh-client` is required.** Every `/webapi/` route returns a bare `400` with an
  empty body without it. This looks exactly like a malformed query parameter and is
  the single easiest thing to get stuck on.
- **Search needs no cookies at all.** Only account routes do.
- **Filters are self-describing.** Search responses carry `navigatorGroups[]`, where
  each facet declares the query parameter it maps to and every legal value with a hit
  count. `willhaben_discover_filters` is a thin projection of that, which is why it
  stays correct when willhaben adds categories.
- **Sort ids are undocumented integers.** Verified empirically:
  `1` newest, `3` price ascending, `4` price descending, `0` relevance.
- **There is no public single-ad JSON endpoint.** `publicapi.willhaben.at` and
  `api.willhaben.at` both refuse anonymous callers. The ad page is Next.js, so the
  full payload is read from `__NEXT_DATA__`, using the lighter
  `/_next/data/<buildId>/...json` route when the buildId is known and falling back to
  HTML when willhaben redeploys and the id rotates.
- **Every field arrives as a `{name, values[]}` bag.** `src/normalize.ts` flattens it.

## Rate limiting and terms

Requests are serialised through a single queue with a 400 ms floor between them, plus
exponential backoff with jitter on `429`/`5xx`. Please leave that in place.

Be aware that willhaben's `robots.txt` states *"It is expressively forbidden to use
spiders, search robots or other automatic methods to access willhaben.at"*, disallows
`/webapi/`, and specifically disallows the `keyword`, `PRICE_FROM`, `PRICE_TO` and
`periode` parameters this server uses. Their Terms of Use likewise prohibit automated
copying without consent. This tool performs exactly that kind of access.

That is a real constraint, not a formality: it's your account that would be suspended.
This is built for personal, low-volume, occasional use against your own account. Don't
point it at bulk collection, don't redistribute the data, and don't run it on a tight
schedule.

## Prior art

[`aliildan/willhaben-mcp`](https://github.com/aliildan/willhaben-mcp) covers more
verticals (cars, real estate, jobs) but is anonymous-only and has no price analysis.
If you want broad read-only browsing rather than deal hunting on the marketplace, use
that one instead.

# Kleinanzeigen

A port of [`jnslmk/kleinanzeigen-mcp`](https://github.com/jnslmk/kleinanzeigen-mcp)
(Python) to TypeScript, covering [kleinanzeigen.de](https://www.kleinanzeigen.de),
Germany's largest classifieds site. No account needed.

## Tools

| Tool | Purpose |
| --- | --- |
| `kleinanzeigen_search` | Search by keyword, location, radius and price; auto-paginates |
| `kleinanzeigen_search_by_url` | Search from a pasted Kleinanzeigen URL, keeping filters the structured search can't express |
| `kleinanzeigen_get_listing` | Full detail for one ad: description, images, seller, attributes |
| `kleinanzeigen_get_listings_batch` | Full detail for several ids at once — the normal follow-up to a search |
| `kleinanzeigen_parse_search_url` | Explain which filters a URL encodes. Makes no network request |

The intended flow is `kleinanzeigen_search` → pick interesting ids →
`kleinanzeigen_get_listings_batch`. Search results carry only the site's own teaser
text, so a broad search does not blow up the model's context window.

## Install

Its own package, so it installs without the willhaben half:

```bash
claude mcp add kleinanzeigen -- npx -y kleinanzeigen-mcp
```

Or from source:

```bash
npm install && npm run build
claude mcp add kleinanzeigen -- node "$PWD/dist/kleinanzeigen/index.js"
```

Or in a client's MCP config:

```json
{
  "mcpServers": {
    "kleinanzeigen": {
      "command": "node",
      "args": ["/path/to/willmehr/dist/kleinanzeigen/index.js"]
    }
  }
}
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `KZ_MIN_INTERVAL_MS` | `800` (`1500` public) | Minimum spacing between requests |
| `KZ_MAX_PAGE_COUNT` | `5` (`3` public) | Cap on pages per search (~25 listings each) |
| `KZ_MAX_BATCH_SIZE` | `20` (`10` public) | Cap on ids per batch call |
| `WILLMEHR_MODE` | `full` | `full` or `public` — see [Modes](#modes) |
| `TZ` | host default | Listing dates are timezone-less; set `Europe/Berlin` to be exact |

## What changed in the port

**No browser.** The Python original drives a headless Chromium through
[`DanielWTE/ebay-kleinanzeigen-api`](https://github.com/DanielWTE/ebay-kleinanzeigen-api),
pinned at a commit and baked into a ~1.5 GB image. That turns out to be unnecessary:
search results, ad detail pages and the view counter are all fully server-rendered and
answer a plain `GET` with a browser-shaped `User-Agent`. This port is `fetch`-only,
which removes the container, the ~1.5 GB memory floor and the browser-context pool
along with the deadlock and context-leak bugs the original had to patch around.

**One request queue instead of a semaphore.** Kleinanzeigen blocks parallel requests
from one IP even when they are staggered, so every request — search page, ad page,
view counter — is serialised through a single queue with an 800 ms floor and
exponential backoff with jitter on `429`/`5xx`. That replaces upstream's
`KZ_MAX_CONCURRENT`/`KZ_MAX_CONTEXTS` knobs, which were browser-pool sizing.

**One name per thing.** Upstream returned `adid` when searching but `id` on detail
pages, and named the same knob `page_count` on one tool and `max_pages` on another;
the Python server carried compatibility shims for both. Neither drift exists here, so
the shims are gone: it is `id` and `pages` everywhere.

**Typed values instead of strings.** Prices come back as
`{amount, label, negotiable, previousAmount}` rather than a pre-mangled string —
`amount: 0` means *Zu verschenken* (free), `null` means no figure was shown. A gone ad
raises `ListingGoneError` instead of returning a hollow object full of nulls, and in a
batch call it lands in `errors` while the rest of the ids still return.

**Fields the original dropped**, because they change what a listing means:

- `wanted` — a *Gesuch* listing is someone looking to **buy**. Upstream returned these
  mixed in with offers, which reads to a model as a suspiciously cheap sale.
- `distanceKm` — the results page appends "(4 km)" to the location when a radius is
  set; that belongs to the search, not the ad, so it is split out.
- `shippingPossible`/`tags`, `previousAmount`, and `seller.shopUrl`.
- Locality parts are named for what they are. Upstream parsed
  "13088 Pankow - Weissensee" into `{zip, city: "Weissensee", state: "Pankow"}`; here
  it is `{postcode, city: "Pankow", district: "Weissensee"}`.

**View counts are opt-in.** `#viewad-cntr-num` is the one thing on the page that JS
fills in, from `/s-vac-inc-get.json`. That endpoint answers a plain `GET`, so the count
is still reachable — but the "inc" is literal: reading it increments the seller's
counter exactly as opening the page would. Pass `includeViewCount: true` when you want
it; it costs one extra request per ad.

**Not ported:** the HTTP transport and `/healthz` route. Both servers here are stdio,
matching how they get registered with a local client.

## Caveats

Kleinanzeigen has no public API, so this reads the site's HTML. It can break whenever
they change their markup — which is what the parsing checks in `npm run smoke:kz` are
for. Heavy or parallel use trips bot detection, and a datacenter IP will get `403`s
where a home connection does not.

Scraping is also at odds with Kleinanzeigen's terms of service. The request throttle is
there for a reason; please leave it in place and keep this to personal-scale use.

# Hosting

`dist/serve-http.js` serves both servers over MCP's Streamable HTTP transport, for
anyone who would rather point a client at a URL than install anything.

```bash
npm run build && npm run serve      # http://0.0.0.0:8080
docker build -t willmehr-http . && docker run -p 8080:8080 willmehr-http
```

| Endpoint | Contents |
| --- | --- |
| `POST /willhaben/mcp` | the four public willhaben tools |
| `POST /kleinanzeigen/mcp` | all five Kleinanzeigen tools |
| `GET /healthz` | liveness probe |

```bash
claude mcp add --transport http willhaben https://<your-host>/willhaben/mcp
claude mcp add --transport http kleinanzeigen https://<your-host>/kleinanzeigen/mcp
```

The mode is pinned to `public` and cannot be overridden: `WILLMEHR_MODE=full` makes the
host refuse to start rather than expose the operator's own account to every caller.

Transports are stateless — a fresh server per request, nothing retained between them.
The two upstream clients are process-wide on purpose: their queues are what hold the
whole deployment to one polite stream of traffic per site.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `MCP_RATE_BURST` | `10` | Requests one IP may burst |
| `MCP_RATE_PER_MINUTE` | `20` | Refill rate per IP |
| `MCP_MAX_INFLIGHT` | `8` | Concurrent tool calls before `503` |
| `MCP_MAX_BODY_BYTES` | `1000000` | Request body ceiling |
| `MCP_REQUEST_TIMEOUT_MS` | `120000` | Ceiling on one request |
| `TRUST_PROXY` | off | Take the client IP from `X-Forwarded-For` (set behind a reverse proxy) |
| `MCP_ALLOWED_ORIGINS` | unset (allow) | Comma-separated `Origin` allowlist |
| `MCP_ALLOWED_HOSTS` | unset (allow) | Comma-separated `Host` allowlist |

## Deploying to a fresh VPS

A €4/month box is enough — this is I/O-bound waiting on two websites, not CPU-bound.
Put it on a machine that does nothing else: if a classifieds site blocks the IP, that
should cost you nothing but this.

1. **Create the VPS.** Debian 12 or Ubuntu 24.04, smallest size (Hetzner CX22, DO
   basic, whatever). Add your SSH key at creation.
2. **Point DNS at it.** An `A` record for the subdomain you want, at the box's IPv4.
   Do this first — Caddy needs the name to resolve before it can be issued a
   certificate. Check with `dig +short mcp.example.com`.
3. **Prepare the box** (installs Docker, opens 80/443, enables unattended upgrades):

   ```bash
   ssh root@<ip> 'bash -s' < deploy/bootstrap-server.sh
   ```

4. **Deploy:**

   ```bash
   HOST=root@<ip> MCP_HOSTNAME=mcp.example.com ./deploy/deploy.sh
   ```

   It syncs the tree, writes the server's `.env`, builds, starts, and waits for
   `https://mcp.example.com/healthz`. Re-run it to ship a change; Caddy's certificate
   lives in a named volume and is not re-issued.

5. **Register it:**

   ```bash
   claude mcp add --transport http willhaben https://mcp.example.com/willhaben/mcp
   claude mcp add --transport http kleinanzeigen https://mcp.example.com/kleinanzeigen/mcp
   ```

`deploy.sh` excludes `.env` and `*.har` from the sync on purpose — the local ones hold
a willhaben session cookie and the capture it came from. The server writes its own
`.env` containing nothing but the hostname.

Operating it:

```bash
ssh <host> 'cd /opt/willmehr && docker compose logs -f --tail 100'
ssh <host> 'cd /opt/willmehr && docker compose restart mcp'
curl -s https://mcp.example.com/healthz     # mode, in-flight count, endpoints
```


## What hosting costs you

Not secrets — those never reach the server. It costs you an IP. Locally each user
scrapes from their own address; hosted, everyone's traffic leaves through yours, and
both sites bot-detect per IP. Concurrent Kleinanzeigen requests from one address trip
detection even when spaced, which is why the outbound queue is global and why the
public defaults are slower. Expect to need response caching and, past a handful of
users, egress proxies. Datacenter ranges belonging to the large serverless platforms
are challenged most aggressively.

Hosting a scraper for third parties is also a different posture towards both sites'
terms than scraping for yourself. Keep the deployment small, unmonetised, and easy to
turn off.

# Development

```bash
npm run typecheck                    # tsc --noEmit
npm run smoke                        # end-to-end checks against the live willhaben API
npm run smoke:kz                     # end-to-end checks against live kleinanzeigen.de
npm run session -- <path-to.har>     # refresh the account session from a HAR
npm run check:auth                   # verify the session + account tools
npm run build
```

`scripts/smoke.ts` is a live integration test: it asserts that filters actually narrow
results, that `price_asc` really sorts ascending, that ad detail round-trips from a
search result, and that deal ranking is ordered and below-median.

`scripts/smoke-kleinanzeigen.ts` does the same for the Kleinanzeigen server, and puts
the pure parsing (German dates, prices, URL filters, page injection) under test without
a network call — so a failure there is a logic bug, while a failure below it means the
site's markup moved.

# License

MIT — see [LICENSE](LICENSE). The Kleinanzeigen server is a port of
[`jnslmk/kleinanzeigen-mcp`](https://github.com/jnslmk/kleinanzeigen-mcp) (MIT,
© Jonas Lemke), whose notice is kept in [NOTICE](NOTICE).

Neither site endorses this. It reads public pages and the willhaben web app's own JSON
API at a deliberately slow pace; if you host it for others, read
[What hosting costs you](#what-hosting-costs-you) first.
