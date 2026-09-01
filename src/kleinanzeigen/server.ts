import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Mode } from "../mode.js";
import { getListing, getListingsBatch } from "./detail.js";
import { KleinanzeigenClient, KleinanzeigenError, ListingGoneError } from "./http.js";
import { search, searchByUrl } from "./search.js";
import { parseSearchUrl, toSearchArgs } from "./url.js";

export interface ServerLimits {
  /** Cap on result pages per search (~25 listings each). */
  maxPages: number;
  /** Cap on ids per batch call. */
  maxBatchSize: number;
  /** Run mode; `public` tells the model it is on a shared instance. */
  mode?: Mode;
}

/**
 * Numbers, leniently.
 *
 * Models routinely send `"600"` where an integer is declared, and a strict
 * schema rejects that outright — with an error that names no field, leaving the
 * model to guess what to fix. `z.coerce` accepts either form.
 */
const int = (description: string, min = 0) =>
  z.coerce.number().int().min(min).describe(description);

const publishedAfter = z
  .string()
  .optional()
  .describe(
    "Only listings published at or after this local ISO 8601 datetime, e.g. '2026-08-01T00:00:00'. " +
      "Also stops paging once older listings appear.",
  );

export function createServer(client: KleinanzeigenClient, limits: ServerLimits): McpServer {
  const server = new McpServer(
    { name: "kleinanzeigen", version: "0.1.0" },
    {
      instructions:
        "Search Kleinanzeigen.de, Germany's largest classifieds site, for second-hand listings. " +
        "Start with kleinanzeigen_search (or kleinanzeigen_search_by_url if the user pasted a " +
        "Kleinanzeigen search link) to get ids and summaries, then kleinanzeigen_get_listings_batch " +
        "for the full description and seller data of the ones worth a closer look. Prices are in " +
        "EUR; a price of 0 means 'Zu verschenken' (free) and null means no figure was shown. " +
        "Listings tagged 'Gesuch' (wanted:true) are people looking to BUY, not sell." +
        (limits.mode === "public"
          ? " This is a shared public instance behind one IP and one request queue, so searches " +
            "are paced and the page and batch caps are lower than on a local install. Ask for the " +
            "pages you need rather than the maximum."
          : ""),
    },
  );

  const pages = (max: number) =>
    z.coerce
      .number()
      .int()
      .min(1)
      .max(max)
      .optional()
      .describe(`Result pages to fetch, ~25 listings each. Default 1, max ${max}.`);

  server.registerTool(
    "kleinanzeigen_search",
    {
      title: "Search Kleinanzeigen listings",
      description:
        "Search by keyword, location, radius and price. Returns listing summaries — id, title, " +
        "price, location, teaser and URL. Follow up with kleinanzeigen_get_listings_batch for full " +
        "descriptions and seller details. Every filter is optional, but a search with neither " +
        "query nor location returns an arbitrary slice of the site and is rarely useful.",
      inputSchema: {
        query: z.string().optional().describe("Search terms, e.g. 'ThinkPad T14' or 'Fahrrad 28 Zoll'"),
        location: z
          .string()
          .optional()
          .describe("City name or German postal code, e.g. 'Berlin' or '10115'"),
        radiusKm: int("Search radius around `location` in kilometres").optional(),
        minPrice: int("Minimum price in EUR").optional(),
        maxPrice: int("Maximum price in EUR").optional(),
        pages: pages(limits.maxPages),
        publishedAfter,
      },
    },
    async ({ pages: pageCount, publishedAfter: after, ...filters }) =>
      wrap(() => search(client, filters, { pages: pageCount ?? 1, publishedAfter: after })),
  );

  server.registerTool(
    "kleinanzeigen_search_by_url",
    {
      title: "Search from a Kleinanzeigen URL",
      description:
        "Search using a Kleinanzeigen URL, preserving all of its filters. Use this when the user " +
        "pastes a Kleinanzeigen search link. Category URLs encode filters that kleinanzeigen_search " +
        "cannot express — vehicle make, model year, fuel type, room count — and this keeps every " +
        "one of them. Page numbers are injected automatically.",
      inputSchema: {
        url: z.string().describe("A kleinanzeigen.de search or category URL"),
        pages: pages(limits.maxPages),
        publishedAfter,
      },
    },
    async ({ url, pages: pageCount, publishedAfter: after }) =>
      wrap(() => searchByUrl(client, url, { pages: pageCount ?? 1, publishedAfter: after })),
  );

  server.registerTool(
    "kleinanzeigen_get_listing",
    {
      title: "Get full listing detail",
      description:
        "Fetch the full detail page of one listing: complete description, price, seller profile, " +
        "location, images, category path and category-specific attributes. For more than one " +
        "listing use kleinanzeigen_get_listings_batch instead.",
      inputSchema: {
        listing: z
          .string()
          .describe("Numeric listing id (e.g. '3487590681') or a full kleinanzeigen ad URL"),
        includeViewCount: z
          .boolean()
          .optional()
          .describe(
            "Also fetch how many times the ad was viewed. Costs one extra request and increments " +
              "the seller's counter, exactly as opening the page in a browser would.",
          ),
      },
    },
    async ({ listing, includeViewCount }) =>
      wrap(() => getListing(client, listing, { includeViewCount })),
  );

  server.registerTool(
    "kleinanzeigen_get_listings_batch",
    {
      title: "Get full detail for several listings",
      description:
        "Fetch full details for several listings in one call — the normal follow-up to a search. " +
        "Failed ids are reported in `errors` rather than failing the whole call, so a deleted " +
        "listing does not lose you the rest.",
      inputSchema: {
        listings: z
          .array(z.string())
          .min(1)
          .max(limits.maxBatchSize)
          .describe(`Listing ids or ad URLs, typically from a search. At most ${limits.maxBatchSize}.`),
        includeViewCount: z
          .boolean()
          .optional()
          .describe("Also fetch view counts. Doubles the number of requests this call makes."),
      },
    },
    async ({ listings, includeViewCount }) =>
      wrap(() => getListingsBatch(client, listings, { includeViewCount })),
  );

  server.registerTool(
    "kleinanzeigen_parse_search_url",
    {
      title: "Explain a Kleinanzeigen search URL",
      description:
        "Explain which filters a Kleinanzeigen URL encodes, without scraping it. Returns the " +
        "filters that map onto kleinanzeigen_search arguments plus any that do not — handy for " +
        "telling the user what a link actually searches for, or for deciding whether " +
        "kleinanzeigen_search is enough or kleinanzeigen_search_by_url is required. Makes no " +
        "network request.",
      inputSchema: {
        url: z.string().describe("A kleinanzeigen.de search or category URL"),
      },
    },
    async ({ url }) => wrap(async () => toSearchArgs(parseSearchUrl(url))),
  );

  return server;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Serialise a result as JSON, and turn failures into readable tool errors. */
async function wrap(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (err) {
    const message =
      err instanceof ListingGoneError
        ? err.message
        : err instanceof KleinanzeigenError
          ? `${err.message}${err.body ? `\n\nResponse: ${err.body.slice(0, 200)}` : ""}`
          : err instanceof Error
            ? err.message
            : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}
