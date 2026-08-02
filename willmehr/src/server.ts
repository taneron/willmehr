import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getActiveAlertCount, getProfile, getWatchlist, listConversations } from "./account.js";
import { findDeals } from "./deals.js";
import { getAd } from "./detail.js";
import { WillhabenClient, WillhabenError } from "./http.js";
import {
  CONDITIONS,
  STATES,
  discoverFilters,
  searchAds,
  searchAllAds,
  type SearchQuery,
} from "./search.js";

const conditionSchema = z.enum(
  Object.keys(CONDITIONS) as [keyof typeof CONDITIONS, ...Array<keyof typeof CONDITIONS>],
);
const stateSchema = z.enum(
  Object.keys(STATES) as [keyof typeof STATES, ...Array<keyof typeof STATES>],
);

/** Shared filter surface. Kept as a raw shape so tools can spread it. */
const filterShape = {
  keyword: z.string().optional().describe("Free-text search, e.g. 'thinkpad t480'"),
  priceFrom: z.number().int().nonnegative().optional().describe("Minimum price in EUR"),
  priceTo: z.number().int().nonnegative().optional().describe("Maximum price in EUR"),
  categoryId: z
    .number()
    .int()
    .optional()
    .describe("Category id (ATTRIBUTE_TREE). Use willhaben_discover_filters to find one."),
  condition: z
    .array(conditionSchema)
    .optional()
    .describe("Item condition; multiple values are OR-ed"),
  sellerType: z
    .enum(["private", "dealer"])
    .optional()
    .describe("Private sellers are usually where the bargains are"),
  states: z.array(stateSchema).optional().describe("Austrian states to restrict to"),
  payliveryOnly: z
    .boolean()
    .optional()
    .describe("Only ads with buyer protection and shipping (PayLivery)"),
  publishedWithinDays: z.number().int().positive().optional().describe("Only ads newer than N days"),
  treeAttributes: z
    .array(z.number().int())
    .optional()
    .describe("Extra facet ids (brand, size, ...) from willhaben_discover_filters"),
} as const;

const sortSchema = z
  .enum(["relevance", "newest", "price_asc", "price_desc"])
  .optional()
  .describe("Result ordering; defaults to newest");

export function createServer(client: WillhabenClient): McpServer {
  const server = new McpServer({ name: "willmehr", version: "0.1.0" });

  server.registerTool(
    "willhaben_search",
    {
      title: "Search willhaben listings",
      description:
        "Search the willhaben.at marketplace (Kaufen & Verkaufen). Returns normalized listings " +
        "with price, location, seller type and timestamps. Use this for ordinary lookups; use " +
        "willhaben_find_deals when the goal is to spot underpriced items.",
      inputSchema: {
        ...filterShape,
        sort: sortSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("How many listings to return; pages automatically. Default 30."),
      },
    },
    async ({ limit, ...query }) =>
      wrap(async () => {
        const target = limit ?? 30;
        const result =
          target <= 100
            ? await searchAds(client, { ...(query as SearchQuery), rows: target })
            : await searchAllAds(client, query as SearchQuery, target);
        return {
          totalFound: result.totalFound,
          returned: result.returned,
          requestUrl: result.requestUrl,
          listings: result.listings,
        };
      }),
  );

  server.registerTool(
    "willhaben_get_ad",
    {
      title: "Get full ad detail",
      description:
        "Fetch the complete detail for one ad: full description text, all images, exact location, " +
        "seller trust signals (member since, active ad count) and category-specific attributes. " +
        "Accepts an ad id, a willhaben URL, or a seopath.",
      inputSchema: {
        ad: z.string().describe("Ad id (e.g. '1853265735') or full willhaben ad URL"),
      },
    },
    async ({ ad }) => wrap(() => getAd(client, ad)),
  );

  server.registerTool(
    "willhaben_find_deals",
    {
      title: "Find underpriced listings",
      description:
        "Sample the market for a query, build a price distribution, and return the listings " +
        "priced furthest below the median. Each result carries its discount, price percentile, " +
        "age in hours, and a flag for prices so low they suggest a placeholder or scam. " +
        "This is the main tool for sale hunting.\n\n" +
        "IMPORTANT: the median is only meaningful if the query describes ONE kind of item. " +
        "willhaben's keyword matching is loose, so a broad query like 'thinkpad' mixes laptops " +
        "with chargers and docks and the resulting 'discounts' are meaningless. Narrow the query " +
        "with categoryId (from willhaben_discover_filters), a specific model, and a priceFrom " +
        "floor before trusting the ranking.",
      inputSchema: {
        ...filterShape,
        sampleLimit: z
          .number()
          .int()
          .min(20)
          .max(400)
          .optional()
          .describe("Listings to sample before ranking. Default 200; more is steadier but slower."),
        minDiscount: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum fraction below median to qualify. Default 0.25."),
        maxResults: z.number().int().min(1).max(100).optional().describe("Cap on deals returned"),
        maxAgeHours: z
          .number()
          .positive()
          .optional()
          .describe("Only listings published within this many hours — use for sniping"),
      },
    },
    async ({ sampleLimit, minDiscount, maxResults, maxAgeHours, ...query }) =>
      wrap(() =>
        findDeals(client, query as SearchQuery, {
          sampleLimit,
          minDiscount,
          maxResults,
          maxAgeHours,
        }),
      ),
  );

  server.registerTool(
    "willhaben_discover_filters",
    {
      title: "Discover available filters and category ids",
      description:
        "Return the filter dimensions willhaben offers for a given query, with the opaque numeric " +
        "ids each value maps to and a hit count per value. Category, brand and size filters only " +
        "appear once a query is narrow enough to imply a category, so call this before filtering " +
        "on categoryId or treeAttributes.",
      inputSchema: filterShape,
    },
    async (query) => wrap(() => discoverFilters(client, query as SearchQuery)),
  );

  registerAccountTools(server, client);
  return server;
}

function registerAccountTools(server: McpServer, client: WillhabenClient): void {
  server.registerTool(
    "willhaben_my_profile",
    {
      title: "Get my willhaben profile",
      description:
        "Return the logged-in account's profile. Requires WILLHABEN_COOKIE. Also the way to get " +
        "the numeric user id that willhaben_my_watchlist needs.",
      inputSchema: {},
    },
    async () => wrap(() => getProfile(client)),
  );

  server.registerTool(
    "willhaben_my_watchlist",
    {
      title: "List my saved ads",
      description: "Return the ads saved to the account's watchlist. Requires WILLHABEN_COOKIE.",
      inputSchema: {
        userId: z.string().describe("Numeric user id from willhaben_my_profile"),
      },
    },
    async ({ userId }) => wrap(() => getWatchlist(client, userId)),
  );

  server.registerTool(
    "willhaben_my_conversations",
    {
      title: "List my chat conversations",
      description:
        "Return recent buyer/seller conversations with their last message. Requires WILLHABEN_COOKIE.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      },
    },
    async ({ limit }) => wrap(() => listConversations(client, limit ?? 20)),
  );

  server.registerTool(
    "willhaben_my_alert_count",
    {
      title: "Count my active search alerts",
      description: "Number of saved searches with alerts enabled. Requires WILLHABEN_COOKIE.",
      inputSchema: {},
    },
    async () => wrap(async () => ({ activeAlerts: await getActiveAlertCount(client) })),
  );
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
      err instanceof WillhabenError
        ? `${err.message}${err.body ? `\n\nResponse: ${err.body}` : ""}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}
