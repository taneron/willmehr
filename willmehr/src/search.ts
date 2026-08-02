/**
 * The ad-search API.
 *
 * Endpoint shape and every filter parameter below were read off the willhaben
 * web app's own facet metadata (`navigatorGroups[].navigatorList[]`), which
 * self-describes the query parameter each filter maps to.
 */

import { ORIGIN, type WillhabenClient } from "./http.js";
import { normalizeListing } from "./normalize.js";
import type { FilterDimension, Listing, RawSearchResponse, SearchResult } from "./types.js";

const SEARCH_PATH = "/webapi/ad-search/search/atz/seo/kaufen-und-verkaufen/marktplatz";

/** Verified empirically against the live API; willhaben exposes no names for these. */
export const SORT_ORDERS = {
  relevance: 0,
  newest: 1,
  price_asc: 3,
  price_desc: 4,
} as const;

export type SortOrder = keyof typeof SORT_ORDERS;

/** `treeAttributes` ids for the marketplace "Zustand" facet. */
export const CONDITIONS = {
  new: 22,
  as_new: 2546,
  refurbished: 5013256,
  used: 23,
  defective: 24,
  display_item: 2539,
} as const;

export type Condition = keyof typeof CONDITIONS;

/** `areaId` values for the "Bundesland" facet. */
export const STATES = {
  burgenland: 1,
  kaernten: 2,
  niederoesterreich: 3,
  oberoesterreich: 4,
  salzburg: 5,
  steiermark: 6,
  tirol: 7,
  vorarlberg: 8,
  wien: 900,
  abroad: 22000,
} as const;

export type AustrianState = keyof typeof STATES;

export interface SearchQuery {
  keyword?: string;
  priceFrom?: number;
  priceTo?: number;
  /** Narrow to a category. Discover ids with `discoverFilters`. */
  categoryId?: number;
  condition?: Condition[];
  /** Restrict by seller type. Omit for both. */
  sellerType?: "private" | "dealer";
  states?: AustrianState[];
  /** Only ads offering buyer protection + shipping. */
  payliveryOnly?: boolean;
  /** Only ads published within the last N days. */
  publishedWithinDays?: number;
  /** Extra `treeAttributes` ids (brand, screen size, ...) from `discoverFilters`. */
  treeAttributes?: number[];
  sort?: SortOrder;
  page?: number;
  rows?: number;
}

export function buildSearchUrl(query: SearchQuery): string {
  const url = new URL(SEARCH_PATH, ORIGIN);
  const params = url.searchParams;

  if (query.keyword) params.set("keyword", query.keyword);
  if (query.priceFrom !== undefined) params.set("PRICE_FROM", String(query.priceFrom));
  if (query.priceTo !== undefined) params.set("PRICE_TO", String(query.priceTo));
  if (query.categoryId !== undefined) params.set("ATTRIBUTE_TREE", String(query.categoryId));
  if (query.sellerType) params.set("ISPRIVATE", query.sellerType === "private" ? "1" : "0");
  if (query.payliveryOnly) params.set("paylivery", "true");
  if (query.publishedWithinDays !== undefined) {
    params.set("periode", String(query.publishedWithinDays));
  }

  // Multi-select facets repeat the parameter rather than using a delimiter.
  for (const state of query.states ?? []) params.append("areaId", String(STATES[state]));
  for (const condition of query.condition ?? []) {
    params.append("treeAttributes", String(CONDITIONS[condition]));
  }
  for (const attribute of query.treeAttributes ?? []) {
    params.append("treeAttributes", String(attribute));
  }

  if (query.sort) params.set("sort", String(SORT_ORDERS[query.sort]));
  params.set("rows", String(clamp(query.rows ?? 30, 1, 100)));
  if (query.page !== undefined && query.page > 1) params.set("page", String(query.page));

  return url.toString();
}

export async function searchAds(
  client: WillhabenClient,
  query: SearchQuery,
): Promise<SearchResult> {
  const requestUrl = buildSearchUrl(query);
  const raw = await client.getJson<RawSearchResponse>(requestUrl);
  const summaries = raw.advertSummaryList?.advertSummary ?? [];

  return {
    totalFound: raw.rowsFound ?? summaries.length,
    returned: summaries.length,
    page: raw.pageRequested ?? query.page ?? 1,
    listings: summaries.map(normalizeListing),
    requestUrl,
  };
}

/**
 * Walk pages until `limit` listings are collected or results run out.
 * Deduplicates by ad id — willhaben repeats promoted ads across pages.
 */
export async function searchAllAds(
  client: WillhabenClient,
  query: SearchQuery,
  limit: number,
): Promise<SearchResult> {
  const rows = clamp(query.rows ?? 100, 1, 100);
  const seen = new Map<string, Listing>();
  let totalFound = 0;
  let requestUrl = "";
  let page = query.page ?? 1;

  while (seen.size < limit) {
    const result = await searchAds(client, { ...query, page, rows });
    if (!requestUrl) requestUrl = result.requestUrl;
    totalFound = result.totalFound;

    for (const listing of result.listings) {
      if (seen.size >= limit) break;
      if (!seen.has(listing.id)) seen.set(listing.id, listing);
    }

    if (result.returned === 0 || page * rows >= totalFound) break;
    page++;
  }

  return {
    totalFound,
    returned: seen.size,
    page: query.page ?? 1,
    listings: [...seen.values()],
    requestUrl,
  };
}

/**
 * Return the filter dimensions willhaben offers *for this specific query*,
 * including the opaque numeric ids each value maps to. Brand, screen size and
 * other facets only appear once the query is narrow enough to imply a category,
 * so agents should call this before trying to filter on them.
 */
export async function discoverFilters(
  client: WillhabenClient,
  query: SearchQuery,
): Promise<{ dimensions: FilterDimension[]; totalFound: number; requestUrl: string }> {
  const requestUrl = buildSearchUrl({ ...query, rows: 1 });
  const raw = await client.getJson<RawSearchResponse>(requestUrl);

  const dimensions: FilterDimension[] = [];
  for (const group of raw.navigatorGroups ?? []) {
    for (const navigator of group.navigatorList ?? []) {
      if (!navigator.id) continue;

      // Values live in `possibleValues` for flat facets and under
      // `groupedPossibleValues` for grouped ones; both can be populated.
      const rawValues = [
        ...(navigator.possibleValues ?? []),
        ...(navigator.groupedPossibleValues ?? []).flatMap((g) => g.possibleValues ?? []),
      ];

      const values = rawValues.flatMap((value) =>
        (value.urlParamRepresentationForValue ?? [])
          .filter((param) => param.urlParameterName && param.value !== undefined)
          .map((param) => ({
            label: value.label ?? "",
            parameter: param.urlParameterName as string,
            value: param.value as string,
            hits: value.hits ?? null,
          })),
      );

      dimensions.push({
        id: navigator.id,
        label: navigator.label ?? null,
        type: navigator.navigatorType ?? null,
        selection: navigator.navigatorSelectionType ?? null,
        parameters: [
          ...new Set(
            (navigator.urlConstructionInformation?.urlParams ?? [])
              .map((param) => param.urlParameterName)
              .filter((name): name is string => Boolean(name)),
          ),
        ],
        values,
      });
    }
  }

  return { dimensions, totalFound: raw.rowsFound ?? 0, requestUrl };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value), min), max);
