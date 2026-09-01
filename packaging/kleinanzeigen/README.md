# kleinanzeigen-mcp

MCP server for [kleinanzeigen.de](https://www.kleinanzeigen.de), Germany's largest
classifieds site. Search listings, read full ad detail with seller data, and work
directly from a Kleinanzeigen search URL.

```bash
claude mcp add kleinanzeigen -- npx -y kleinanzeigen-mcp
```

| Tool | Purpose |
| --- | --- |
| `kleinanzeigen_search` | Keyword, location, radius and price search; pages automatically |
| `kleinanzeigen_search_by_url` | Search from a pasted Kleinanzeigen URL, keeping every filter it encodes |
| `kleinanzeigen_get_listing` | Full detail for one ad: description, seller, attributes, images |
| `kleinanzeigen_get_listings_batch` | The same for several ads at once; failed ids are reported, not fatal |
| `kleinanzeigen_parse_search_url` | Explain what a Kleinanzeigen URL filters on, without a request |

No account or API key. Requests go through one serialised, spaced-out queue, because
concurrent requests from a single IP trip the site's bot detection.

Two run modes: `full` (default) for a local install, and `public` — slower pacing and
lower page and batch caps — for an instance shared by several people. Set
`WILLMEHR_MODE=public` or pass `--public`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `KZ_MIN_INTERVAL_MS` | `800` (`1500` public) | Minimum spacing between requests |
| `KZ_MAX_PAGE_COUNT` | `5` (`3` public) | Cap on pages per search (~25 listings each) |
| `KZ_MAX_BATCH_SIZE` | `20` (`10` public) | Cap on ids per batch call |
| `TZ` | host default | Listing dates are timezone-less; set `Europe/Berlin` to be exact |

This package ships from the [willmehr](https://github.com/taneron/willmehr) repo, which
also holds a willhaben.at (Austria) server and a self-hostable HTTP host for both. Full
documentation, including self-hosting, is in that README.

MIT. A TypeScript port of
[`jnslmk/kleinanzeigen-mcp`](https://github.com/jnslmk/kleinanzeigen-mcp) — see NOTICE.
