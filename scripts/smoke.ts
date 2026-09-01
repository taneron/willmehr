/**
 * End-to-end check against the live API. Run with `npm run smoke`.
 * Read-only: search, detail, filter discovery and deal ranking.
 */
import { WillhabenClient } from "../src/http.ts";
import { searchAds, discoverFilters } from "../src/search.ts";
import { getAd, resolveAdPath } from "../src/detail.ts";
import { findDeals } from "../src/deals.ts";

const client = new WillhabenClient({ minIntervalMs: 600 });
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

// 1. Plain search
const search = await searchAds(client, { keyword: "thinkpad", rows: 10, sort: "newest" });
check("search returns listings", search.listings.length > 0, `${search.totalFound} total`);
const sample = search.listings[0]!;
check("listing has id + title", Boolean(sample.id && sample.title), sample.title.slice(0, 50));
check("listing has usable url", sample.url.startsWith("https://www.willhaben.at/iad/"));
check("listing has price or explicit null", "price" in sample, String(sample.price));
check("listing has timestamps", sample.publishedAt !== null, String(sample.publishedAt));

// 2. Filters compose and actually narrow
const wide = await searchAds(client, { keyword: "thinkpad", rows: 1 });
const narrow = await searchAds(client, {
  keyword: "thinkpad",
  priceFrom: 100,
  priceTo: 400,
  sellerType: "private",
  states: ["wien"],
  rows: 1,
});
check("filters narrow results", narrow.totalFound < wide.totalFound, `${wide.totalFound} -> ${narrow.totalFound}`);

// 3. Sort ordering
const asc = await searchAds(client, { keyword: "thinkpad", sort: "price_asc", rows: 5 });
const ascPrices = asc.listings.map((l) => l.price ?? 0);
check("price_asc is ascending", ascPrices.every((p, i) => i === 0 || p >= ascPrices[i - 1]!), ascPrices.join(","));

// 4. Filter discovery exposes category ids
const filters = await discoverFilters(client, { keyword: "thinkpad" });
const category = filters.dimensions.find((d) => d.id === "category");
check("discover_filters returns category ids", (category?.values.length ?? 0) > 0,
  category?.values.slice(0, 2).map((v) => `${v.label}=${v.value}`).join(" "));

// 5. URL / id parsing
check("parses bare id", resolveAdPath("1853265735").id === "1853265735");
check("parses full url",
  resolveAdPath("https://www.willhaben.at/iad/kaufen-und-verkaufen/d/foo-bar-1853265735/").id === "1853265735");

// 6. Ad detail, using an id from the live search above
const detail = await getAd(client, sample.id);
check("detail resolves same ad", detail.id === sample.id, detail.title.slice(0, 50));
check("detail has description", (detail.description?.length ?? 0) > 0,
  `${detail.description?.length ?? 0} chars`);
check("detail has seller signals", detail.seller.name !== null,
  `${detail.seller.name} / private=${detail.seller.isPrivate} / since=${detail.seller.memberSince}`);
check("detail has images", detail.imageUrls.length > 0, `${detail.imageUrls.length} images`);

// 7. Deal ranking
const report = await findDeals(client, { keyword: "thinkpad", sellerType: "private" },
  { sampleLimit: 100, minDiscount: 0.3, maxResults: 5 });
check("deal report has stats", report.stats !== null,
  report.stats ? `median €${report.stats.median} over n=${report.stats.sampleSize}` : "");
check("deals are below median",
  report.deals.every((d) => report.stats !== null && d.price! < report.stats.median),
  `${report.deals.length} deals`);
check("deals ranked by discount",
  report.deals.every((d, i) => i === 0 || d.discountFromMedian <= report.deals[i - 1]!.discountFromMedian));

if (report.deals[0]) {
  const top = report.deals[0];
  console.log(`\n  top deal: €${top.price} (${Math.round(top.discountFromMedian * 100)}% below median)` +
    `${top.suspiciouslyCheap ? " [suspiciously cheap]" : ""}\n  ${top.title.slice(0, 70)}\n  ${top.url}`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
