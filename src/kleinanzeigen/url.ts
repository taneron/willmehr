/**
 * Read the filters out of a kleinanzeigen search or category URL.
 *
 * Kleinanzeigen encodes most filters in the path rather than the query string:
 *
 *   /s-wohnwagen-mobile/berlin/preis:1000:15000/seite:2/k0c220+wohnwagen.art_s:wohnwagen
 *    └ category slug   └ sub  └ price range    └ page  └ filter segment
 *
 * The filter segment is the interesting one — `c220` is the category id and the
 * `key:value` pairs after it are category-specific facets (make, year, article
 * type). Only a few of those have an equivalent in the structured search tool;
 * the rest come back under `unmappedFilters` so a caller can see what a URL
 * asks for that `kleinanzeigen_search` cannot reproduce.
 *
 * Ported from upstream's `utils/parse_kleinanzeigen_url.py`, including its
 * segment precedence: page segments are recognised before the `s-` category
 * slug, so `s-seite:2` is never mistaken for a category.
 */

export interface ParsedSearchUrl {
  query?: string;
  location?: string;
  radius?: number;
  minPrice?: number;
  maxPrice?: number;
  page?: number;
  categorySlug?: string;
  subcategory?: string;
  pathKeyword?: string;
  categoryId?: number;
  /** Model year lower bound, from a `*.ez_i:2008,` facet. */
  yearFrom?: number;
  /** Article type, from a `*.art_s:` facet. */
  art?: string;
  brands?: string[];
  /** Facets with no known meaning, kept verbatim for transparency. */
  unknownAttrs?: Record<string, string>;
}

/** Filters `kleinanzeigen_search` can express; everything else is "unmapped". */
export interface SearchArgs {
  query?: string;
  location?: string;
  radiusKm?: number;
  minPrice?: number;
  maxPrice?: number;
  pages?: number;
}

export function parseSearchUrl(input: string): ParsedSearchUrl {
  const url = new URL(input);
  const result: ParsedSearchUrl = {};

  const params = url.searchParams;
  const keywords = params.get("keywords");
  const locationStr = params.get("locationStr");
  const radius = params.get("radius");
  if (keywords) result.query = keywords;
  if (locationStr) result.location = locationStr;
  if (radius && Number.isFinite(Number(radius))) result.radius = Number(radius);

  const segments = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  let filterSegment: string | null = null;

  segments.forEach((segment, index) => {
    if (segment.startsWith("seite:")) {
      const page = Number(segment.slice("seite:".length));
      if (Number.isInteger(page)) result.page = page;
    } else if (/^s-seite:\d+$/.test(segment)) {
      result.page = Number(segment.slice("s-seite:".length));
    } else if (segment.startsWith("s-") && result.categorySlug === undefined) {
      result.categorySlug = segment;
    } else if (segment.startsWith("preis:")) {
      const [, min, max] = segment.split(":");
      if (min) result.minPrice = Number(min);
      if (max) result.maxPrice = Number(max);
    } else if (/^k?\d*c\d+/.test(segment)) {
      filterSegment = segment;
    } else if (index === 1) {
      result.subcategory = segment;
    } else if (filterSegment === null && index > 1) {
      result.pathKeyword = segment;
    }
  });

  if (filterSegment) parseFilterSegment(filterSegment, result);
  return result;
}

function parseFilterSegment(segment: string, result: ParsedSearchUrl): void {
  const body = segment.startsWith("k0") ? segment.slice(2) : segment;

  for (const attribute of body.split("+")) {
    if (/^c\d+$/.test(attribute)) {
      result.categoryId = Number(attribute.slice(1));
      continue;
    }

    const separator = attribute.indexOf(":");
    if (separator === -1) continue;
    const key = attribute.slice(0, separator);
    const value = attribute.slice(separator + 1);

    if (key.endsWith(".ez_i")) {
      // "2008," means "2008 or later" — the trailing comma is an open upper bound.
      const year = Number(value.replace(/,$/, ""));
      if (Number.isFinite(year)) result.yearFrom = year;
    } else if (key.endsWith(".art_s")) {
      result.art = value;
    } else if (key.endsWith(".marke_s")) {
      // Either "fendt" or "(fendt,knaus)" for a multi-select.
      result.brands = value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1).split(",") : [value];
    } else {
      result.unknownAttrs = { ...result.unknownAttrs, [key]: value };
    }
  }
}

const MAPPED_KEYS = new Set(["query", "pathKeyword", "location", "radius", "minPrice", "maxPrice", "page"]);

/** Split a parsed URL into what `kleinanzeigen_search` can take, and what it cannot. */
export function toSearchArgs(parsed: ParsedSearchUrl): {
  searchArgs: SearchArgs;
  unmappedFilters: Record<string, unknown>;
} {
  const searchArgs: SearchArgs = {};

  // An explicit `keywords=` beats a keyword baked into the path.
  const query = parsed.query ?? parsed.pathKeyword;
  if (query !== undefined) searchArgs.query = query;
  if (parsed.location !== undefined) searchArgs.location = parsed.location;
  if (parsed.radius !== undefined) searchArgs.radiusKm = parsed.radius;
  if (parsed.minPrice !== undefined) searchArgs.minPrice = parsed.minPrice;
  if (parsed.maxPrice !== undefined) searchArgs.maxPrice = parsed.maxPrice;
  searchArgs.pages = parsed.page ?? 1;

  const unmappedFilters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!MAPPED_KEYS.has(key)) unmappedFilters[key] = value;
  }

  return { searchArgs, unmappedFilters };
}
