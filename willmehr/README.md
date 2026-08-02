# willmehr

An MCP server for hunting deals on [willhaben.at](https://www.willhaben.at), Austria's
largest classifieds marketplace. TypeScript, stdio transport, works with Claude Code,
Claude Desktop, or any other MCP client.

Built by reverse-engineering the willhaben web app's own JSON API from a HAR capture.

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
npm install
npm run build
```

Register it with Claude Code:

```bash
claude mcp add willmehr -- node /Users/taner/code/willmehr/dist/index.js
```

Or in a client's MCP config:

```json
{
  "mcpServers": {
    "willmehr": {
      "command": "node",
      "args": ["/Users/taner/code/willmehr/dist/index.js"],
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
| `WILLHABEN_MIN_INTERVAL_MS` | `400` | Minimum spacing between requests |

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

## Development

```bash
npm run typecheck                    # tsc --noEmit
npm run smoke                        # 17 end-to-end checks against the live API
npm run session -- <path-to.har>     # refresh the account session from a HAR
npm run check:auth                   # verify the session + account tools
npm run build
```

`scripts/smoke.ts` is a live integration test: it asserts that filters actually narrow
results, that `price_asc` really sorts ascending, that ad detail round-trips from a
search result, and that deal ranking is ordered and below-median.

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
