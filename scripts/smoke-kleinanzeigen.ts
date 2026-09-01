/**
 * End-to-end check against the live site. Run with `npm run smoke:kz`.
 * Read-only apart from the view counter, which is exercised once.
 */
import { KleinanzeigenClient, ListingGoneError } from "../src/kleinanzeigen/http.ts";
import { getListing, getListingsBatch, resolveListingId } from "../src/kleinanzeigen/detail.ts";
import { buildSearchUrl, injectPage, search, searchByUrl } from "../src/kleinanzeigen/search.ts";
import { parseListingDate, parsePrice, parseLocality, parsePageCount } from "../src/kleinanzeigen/parse.ts";
import { parseSearchUrl, toSearchArgs } from "../src/kleinanzeigen/url.ts";

const client = new KleinanzeigenClient({ minIntervalMs: 1200 });
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

// 1. Pure parsing — no network, so a site change cannot mask a logic bug.
const noon = new Date(2026, 7, 20, 12, 0, 0);
check("parses 'Heute'", parseListingDate("Heute, 12:37", noon) === "2026-08-20T12:37:00");
check("parses 'Gestern'", parseListingDate("Gestern, 19:30", noon) === "2026-08-19T19:30:00");
check("parses German date", parseListingDate("26.04.2026", noon) === "2026-04-26T00:00:00");
check("rejects nonsense date", parseListingDate("irgendwann", noon) === null);
check("rejects impossible date", parseListingDate("31.02.2026", noon) === null);

const vb = parsePrice("444 € VB");
check("parses price + VB", vb.amount === 444 && vb.negotiable, JSON.stringify(vb));
check("parses thousands", parsePrice("1.250 €").amount === 1250);
check("parses giveaway", parsePrice("Zu verschenken").amount === 0);
check("parses empty price", parsePrice("").amount === null);

const locality = parseLocality("13088 Pankow - Weissensee");
check("parses locality", locality.postcode === "13088" && locality.city === "Pankow" && locality.district === "Weissensee",
  JSON.stringify(locality));
const withDistance = parseLocality("13357 Wedding (4 km)");
check("splits distance out of locality", withDistance.city === "Wedding" && withDistance.distanceKm === 4,
  JSON.stringify(withDistance));
check("counts pages", parsePageCount("1 - 25 von 564 Ergebnissen") === 23);
check("refuses page count off page 1", parsePageCount("26 - 50 von 564 Ergebnissen") === null);

check("builds search url",
  buildSearchUrl({ query: "thinkpad", location: "Berlin", minPrice: 100, maxPrice: 400 }, 2) ===
    "https://www.kleinanzeigen.de/preis:100:400/s-seite:2?keywords=thinkpad&locationStr=Berlin");
check("injects page into category url",
  injectPage("https://www.kleinanzeigen.de/s-notebooks/c278", 2) ===
    "https://www.kleinanzeigen.de/s-notebooks/seite:2/c278");
check("injects page into keyword url",
  injectPage("https://www.kleinanzeigen.de/s-seite:5?keywords=thinkpad", 2) ===
    "https://www.kleinanzeigen.de/s-seite:2?keywords=thinkpad");

const parsed = parseSearchUrl(
  "https://www.kleinanzeigen.de/s-wohnwagen-mobile/berlin/preis:1000:15000/seite:2/k0c220+wohnwagen.art_s:wohnwagen+wohnwagen.marke_s:(fendt,knaus)+wohnwagen.ez_i:2008,",
);
check("parses category id", parsed.categoryId === 220, String(parsed.categoryId));
check("parses brands", parsed.brands?.join(",") === "fendt,knaus", String(parsed.brands));
check("parses year + art + price", parsed.yearFrom === 2008 && parsed.art === "wohnwagen" && parsed.maxPrice === 15000);
const mapped = toSearchArgs(parsed);
check("splits mapped vs unmapped", mapped.searchArgs.minPrice === 1000 && "categoryId" in mapped.unmappedFilters,
  Object.keys(mapped.unmappedFilters).join(","));
check("resolves id from ad url",
  resolveListingId("https://www.kleinanzeigen.de/s-anzeige/lenovo-thinkpad/3487590681-278-3477") === "3487590681");

// 2. Live search
const results = await search(client, { query: "thinkpad", location: "Berlin", radiusKm: 20 }, { pages: 1 });
check("search returns listings", results.listings.length > 0, `${results.totalFound} total`);
const sample = results.listings.find((l) => !l.wanted) ?? results.listings[0]!;
check("listing has id + title", Boolean(sample.id && sample.title), sample.title.slice(0, 50));
check("listing has ad url", sample.url.startsWith("https://www.kleinanzeigen.de/s-anzeige/"), sample.url);
check("listing has price field", "amount" in sample.price, sample.price.label ?? "null");
check("listing has clean location", (sample.postcode !== null || sample.city !== null) && !/km\)/.test(sample.city ?? ""),
  `${sample.postcode} ${sample.city} @ ${sample.distanceKm}km`);
check("listing has date", sample.publishedAt !== null, String(sample.publishedAt));
check("no sponsored duplicates", new Set(results.listings.map((l) => l.id)).size === results.listings.length);

// 3. Price filter actually narrows
const cheap = await search(client, { query: "thinkpad", maxPrice: 100 }, { pages: 1 });
const wide = await search(client, { query: "thinkpad" }, { pages: 1 });
check("price filter narrows", (cheap.totalFound ?? 0) < (wide.totalFound ?? 0),
  `${wide.totalFound} -> ${cheap.totalFound}`);

// 4. Pagination
const twoPages = await search(client, { query: "thinkpad" }, { pages: 2 });
check("pages accumulate", twoPages.pagesFetched === 2 && twoPages.returned > results.returned,
  `${twoPages.pagesFetched} pages, ${twoPages.returned} listings`);

// 5. searchByUrl keeps category filters
const byUrl = await searchByUrl(client, "https://www.kleinanzeigen.de/s-notebooks/c278", { pages: 1 });
check("search_by_url returns listings", byUrl.listings.length > 0, `${byUrl.totalFound} total`);

// 6. publishedAfter trims and stops early
const recent = await search(client, { query: "thinkpad" }, { pages: 3, publishedAfter: isoDaysAgo(1) });
check("publishedAfter filters", recent.listings.every((l) => l.publishedAt === null || l.publishedAt >= isoDaysAgo(1)),
  `${recent.returned} listings over ${recent.pagesFetched} page(s)`);

// 7. Detail, using an id from the live search above
const detail = await getListing(client, sample.id, { includeViewCount: true });
check("detail resolves same ad", detail.id === sample.id, detail.title.slice(0, 50));
check("detail has description", (detail.description?.length ?? 0) > 0, `${detail.description?.length ?? 0} chars`);
check("detail has categories", detail.categories.length > 0, detail.categories.join(" > "));
check("detail has seller id", detail.seller.userId !== null, String(detail.seller.userId));
check("detail has seller", detail.seller.name !== null,
  `${detail.seller.name} / ${detail.seller.type} / since ${detail.seller.since} / id ${detail.seller.userId}`);
check("detail has images", detail.imageUrls.length > 0, `${detail.imageUrls.length} images`);
check("detail has status", ["active", "reserved", "sold", "deleted"].includes(detail.status), detail.status);
check("detail has created date", detail.createdAt !== null, String(detail.createdAt));
check("view count resolves", typeof detail.views === "number", String(detail.views));

// 8. Batch, with a deliberately dead id mixed in
const batch = await getListingsBatch(client, [sample.id, "1"]);
check("batch returns the good id", batch.returned === 1 && batch.listings[0]?.id === sample.id);
check("batch isolates the bad id", batch.errors.length === 1, batch.errors[0]?.error ?? "");

// 9. A gone listing raises, rather than returning a hollow object
let gone = false;
try {
  await getListing(client, "1");
} catch (err) {
  gone = err instanceof ListingGoneError;
}
check("deleted listing throws ListingGoneError", gone);

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T00:00:00`;
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
