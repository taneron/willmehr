/**
 * Search scraping.
 *
 * Two entry points, both walking the same results markup:
 *  - `search` builds a URL from structured filters (keyword, location, price).
 *  - `searchByUrl` takes a URL the user pasted and only injects page numbers,
 *    which preserves category filters that `search` cannot express — vehicle
 *    make, model year, fuel type, room count and so on.
 *
 * Pages are fetched strictly one after another. The site blocks parallel
 * requests from a single IP even when they are staggered, and after page 1 the
 * result-count breadcrumb tells us the real page count, so a sequential walk
 * also stops before requesting pages that do not exist.
 */

import { parse, type HTMLElement } from "node-html-parser";

import { ORIGIN, type KleinanzeigenClient } from "./http.js";
import {
  collapse,
  parseListingDate,
  parseLocality,
  parsePageCount,
  parsePrice,
  parseTotalResults,
  toEpoch,
} from "./parse.js";
import type { ListingSummary, SearchResult } from "./types.js";

export interface SearchFilters {
  query?: string;
  location?: string;
  radiusKm?: number;
  minPrice?: number;
  maxPrice?: number;
}

export interface SearchOptions {
  pages?: number;
  /** Naive local ISO 8601; drops anything older and stops paging early. */
  publishedAfter?: string;
}

/** Build the results URL for one page of a structured search. */
export function buildSearchUrl(filters: SearchFilters, page = 1): string {
  const { query, location, radiusKm, minPrice, maxPrice } = filters;

  // Price is a path segment, not a query parameter: /preis:100:400
  const pricePath =
    minPrice !== undefined || maxPrice !== undefined
      ? `/preis:${minPrice ?? ""}:${maxPrice ?? ""}`
      : "";

  const params = new URLSearchParams();
  if (query) params.set("keywords", query);
  if (location) params.set("locationStr", location);
  if (radiusKm !== undefined) params.set("radius", String(radiusKm));

  const search = params.toString();
  return `${ORIGIN}${pricePath}/s-seite:${page}${search ? `?${search}` : ""}`;
}

/**
 * Replace whatever page a URL asks for with `page`.
 *
 * Category URLs want `seite:N` immediately before the filter segment (the
 * `c220`/`k0c220+…` part), keeping any segments in between (`anzeige:angebote`,
 * `preis::15000`). Plain keyword searches want `s-seite:N` appended instead.
 */
export function injectPage(url: string, page: number): string {
  const parsed = new URL(url);
  const segments = decodeURIComponent(parsed.pathname)
    .split("/")
    .filter((segment) => segment && !/^s?-?seite:\d+$/.test(segment) && !/^s-seite:\d+$/.test(segment));

  if (page > 1) {
    const filterIndex = segments.findIndex((segment) => /^k?\d*c\d+/.test(segment));
    if (filterIndex === -1) segments.push(`s-seite:${page}`);
    else segments.splice(filterIndex, 0, `seite:${page}`);
  }

  parsed.pathname = `/${segments.join("/")}`;
  return parsed.toString();
}

export async function search(
  client: KleinanzeigenClient,
  filters: SearchFilters,
  options: SearchOptions = {},
): Promise<SearchResult> {
  return await walkPages(client, (page) => buildSearchUrl(filters, page), options);
}

export async function searchByUrl(
  client: KleinanzeigenClient,
  url: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  if (!/(^|\.)kleinanzeigen\.de$/i.test(new URL(url).hostname)) {
    throw new Error("url must point at kleinanzeigen.de");
  }
  return await walkPages(client, (page) => injectPage(url, page), options);
}

async function walkPages(
  client: KleinanzeigenClient,
  urlForPage: (page: number) => string,
  options: SearchOptions,
): Promise<SearchResult> {
  const wanted = Math.max(1, options.pages ?? 1);
  const cutoff = options.publishedAfter ? toEpoch(options.publishedAfter) : null;

  const listings: ListingSummary[] = [];
  const warnings: string[] = [];
  let totalFound: number | null = null;
  let availablePages: number | null = null;
  let pagesFetched = 0;
  const firstUrl = urlForPage(1);

  for (let page = 1; page <= wanted; page++) {
    if (availablePages !== null && page > availablePages) break;

    const url = urlForPage(page);
    let html: string;
    try {
      ({ html } = await client.getPage(url));
    } catch (err) {
      warnings.push(`Page ${page} failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    pagesFetched++;

    const root = parse(html);
    const summary = collapse(root.querySelector(".breadcrump-summary")?.text ?? "");
    if (page === 1) {
      totalFound = parseTotalResults(summary);
      availablePages = parsePageCount(summary);
    }

    const pageListings = extractListings(root);
    if (pageListings.length === 0) break;

    // A page that reaches past the cutoff is the last one worth requesting:
    // results are newest-first, so everything after it is older still.
    const reachedCutoff =
      cutoff !== null &&
      pageListings.some((listing) => listing.publishedAt !== null && toEpoch(listing.publishedAt) < cutoff);

    listings.push(...(cutoff === null ? pageListings : pageListings.filter((l) => keep(l, cutoff))));
    if (reachedCutoff) break;
  }

  return { url: firstUrl, totalFound, pagesFetched, returned: listings.length, listings, warnings };
}

/** Undated listings are kept — dropping them would hide ads we simply cannot date. */
function keep(listing: ListingSummary, cutoff: number): boolean {
  if (listing.publishedAt === null) return true;
  return toEpoch(listing.publishedAt) >= cutoff;
}

/**
 * Pull the listing cards out of a results page.
 *
 * Top ads (`is-topad`) and the pro-seller promo card are paid placements that
 * repeat on every page, so they are skipped — otherwise a three-page search
 * returns the same sponsored ads three times.
 */
export function extractListings(root: HTMLElement): ListingSummary[] {
  const listings: ListingSummary[] = [];
  const now = new Date();

  for (const item of root.querySelectorAll("li.ad-listitem")) {
    const classes = item.classList;
    if (classes.contains("is-topad") || classes.contains("badge-hint-pro-small-srp")) continue;

    const article = item.querySelector("article[data-adid]");
    if (!article) continue;

    const id = article.getAttribute("data-adid");
    const href = article.getAttribute("data-href");
    if (!id || !href) continue;

    const price = parsePrice(article.querySelector("p.aditem-main--middle--price-shipping--price")?.text);
    const locality = parseLocality(article.querySelector(".aditem-main--top--left")?.text);
    const tags = article
      .querySelectorAll(".aditem-main--bottom .simpletag")
      .map((tag) => collapse(tag.text))
      .filter(Boolean);

    listings.push({
      id,
      url: `${ORIGIN}${href}`,
      title: collapse(article.querySelector("h2.text-module-begin a")?.text ?? ""),
      price: { amount: price.amount, label: price.label, negotiable: price.negotiable },
      description: collapse(article.querySelector("p.aditem-main--middle--description")?.text ?? ""),
      postcode: locality.postcode,
      city: locality.city,
      distanceKm: locality.distanceKm,
      publishedAt: parseListingDate(article.querySelector(".aditem-main--top--right")?.text, now),
      wanted: tags.some((tag) => /^Gesuch$/i.test(tag)),
      shippingPossible: tags.some((tag) => /Versand möglich/i.test(tag)),
      tags,
      thumbnailUrl: article.querySelector(".aditem-image img")?.getAttribute("src") ?? null,
    });
  }

  return listings;
}
