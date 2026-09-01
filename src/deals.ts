/**
 * Deal hunting: price the market for a query, then rank listings against it.
 *
 * The API has no notion of "cheap". What it does have is enough volume to build
 * a price distribution per query, which is all you need to spot an outlier.
 */

import type { WillhabenClient } from "./http.js";
import { searchAllAds, type SearchQuery } from "./search.js";
import type { Listing } from "./types.js";

export interface PriceStats {
  /** Listings that carried a usable price; the basis for every number below. */
  sampleSize: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
}

export interface ScoredListing extends Listing {
  /** Fraction below the median, e.g. 0.4 means 40% under. Negative if above. */
  discountFromMedian: number;
  /** Percentile of this price within the sample (0 = cheapest). */
  pricePercentile: number;
  /**
   * Price is far enough below the market to suggest a placeholder, a parts-only
   * listing, or a scam rather than a bargain. Worth a closer look before acting.
   */
  suspiciouslyCheap: boolean;
  /** Hours since publication. Useful for sniping fresh listings. */
  ageHours: number | null;
}

export interface DealReport {
  query: SearchQuery;
  stats: PriceStats | null;
  /** Ranked best-value first. */
  deals: ScoredListing[];
  /** How many listings were examined, including ones without a price. */
  examined: number;
  totalAvailable: number;
  requestUrl: string;
}

export interface FindDealsOptions {
  /** How many listings to sample before ranking. More is slower but steadier. */
  sampleLimit?: number;
  /** Minimum discount from median to qualify, 0–1. */
  minDiscount?: number;
  /** Cap on returned deals. */
  maxResults?: number;
  /** Only consider listings published within this many hours. */
  maxAgeHours?: number;
}

export async function findDeals(
  client: WillhabenClient,
  query: SearchQuery,
  options: FindDealsOptions = {},
): Promise<DealReport> {
  const sampleLimit = options.sampleLimit ?? 200;
  const minDiscount = options.minDiscount ?? 0.25;
  const maxResults = options.maxResults ?? 20;

  // Sort by newest so a large sample stays representative of the live market
  // rather than drifting into stale, never-selling listings.
  const result = await searchAllAds(client, { sort: query.sort ?? "newest", ...query }, sampleLimit);

  const priced = result.listings.filter(
    (listing): listing is Listing & { price: number } =>
      typeof listing.price === "number" && listing.price > 0,
  );

  if (priced.length < 3) {
    return {
      query,
      stats: null,
      deals: [],
      examined: result.listings.length,
      totalAvailable: result.totalFound,
      requestUrl: result.requestUrl,
    };
  }

  const prices = priced.map((listing) => listing.price).sort((a, b) => a - b);
  const stats = computeStats(prices);
  const now = Date.now();

  const scored = priced
    .map((listing): ScoredListing => {
      const ageHours = hoursSince(listing.publishedAt, now);
      return {
        ...listing,
        discountFromMedian: round((stats.median - listing.price) / stats.median, 4),
        pricePercentile: round(percentileOf(prices, listing.price), 4),
        suspiciouslyCheap: listing.price < stats.median * 0.2,
        ageHours: ageHours === null ? null : round(ageHours, 2),
      };
    })
    .filter((listing) => listing.discountFromMedian >= minDiscount)
    .filter((listing) => {
      if (options.maxAgeHours === undefined) return true;
      return listing.ageHours !== null && listing.ageHours <= options.maxAgeHours;
    })
    .sort((a, b) => b.discountFromMedian - a.discountFromMedian)
    .slice(0, maxResults);

  return {
    query,
    stats,
    deals: scored,
    examined: result.listings.length,
    totalAvailable: result.totalFound,
    requestUrl: result.requestUrl,
  };
}

/** `sorted` must be ascending. */
export function computeStats(sorted: number[]): PriceStats {
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    sampleSize: sorted.length,
    min: sorted[0] as number,
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1] as number,
    mean: round(sum / sorted.length, 2),
  };
}

/** Linear interpolation between order statistics. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0] as number;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  if (lower === upper) return round(low, 2);
  const high = sorted[upper] as number;
  return round(low + (high - low) * (position - lower), 2);
}

/** Share of the sample priced at or below `value`. */
function percentileOf(sorted: number[], value: number): number {
  let count = 0;
  for (const price of sorted) {
    if (price <= value) count++;
    else break;
  }
  return count / sorted.length;
}

function hoursSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return null;
  return (now - timestamp) / 3_600_000;
}

const round = (value: number, digits: number): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;
