/**
 * Ad detail scraping.
 *
 * The whole detail page is server-rendered, with one exception: the view
 * counter (`#viewad-cntr-num`) is left empty and filled in by the page's own
 * JS from `/s-vac-inc-get.json`. That endpoint answers a plain GET, so views
 * are still reachable without a browser — but the "inc" in its name is
 * literal: reading it increments the seller's counter, exactly as a real page
 * view would. It therefore costs an extra request and is opt-in.
 */

import { parse, type HTMLElement } from "node-html-parser";

import { ListingGoneError, ORIGIN, type KleinanzeigenClient } from "./http.js";
import { collapse, collapseKeepingLines, parseLocality, parsePrice } from "./parse.js";
import type { ListingDetail } from "./types.js";

const AD_PATH = "/s-anzeige/";

/** Accepts a bare ad id or any kleinanzeigen ad URL. */
export function resolveListingId(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  // Ad URLs end in `<id>-<categoryId>-<locationId>`; the id is the first group.
  const fromUrl = /\/s-anzeige\/[^/]+\/(\d+)/.exec(trimmed) ?? /\/s-anzeige\/(\d+)/.exec(trimmed);
  if (fromUrl?.[1]) return fromUrl[1];

  const trailing = /(\d{6,})/.exec(trimmed);
  if (trailing?.[1]) return trailing[1];

  throw new Error(`Could not read a listing id out of "${input}".`);
}

export interface DetailOptions {
  /** Fetch the view counter. One extra request, and it increments the counter. */
  includeViewCount?: boolean;
}

export async function getListing(
  client: KleinanzeigenClient,
  input: string,
  options: DetailOptions = {},
): Promise<ListingDetail> {
  const id = resolveListingId(input);
  const url = `${ORIGIN}${AD_PATH}${id}`;

  const { html, finalUrl } = await client.getPage(url);
  const root = parse(html);

  // The site signals a gone ad two ways: a redirect off /s-anzeige/, or an
  // "expired" panel served under the original URL.
  if (!new URL(finalUrl).pathname.startsWith(AD_PATH) || root.querySelector("#srchrslt-adexpired")) {
    throw new ListingGoneError(id);
  }

  const detail = extractDetail(root, { id, url, finalUrl });

  if (options.includeViewCount) {
    detail.views = await fetchViewCount(client, id, finalUrl);
  }
  return detail;
}

export interface BatchResult {
  requested: number;
  returned: number;
  listings: ListingDetail[];
  errors: Array<{ id: string; error: string }>;
}

/**
 * Fetch several ads in one call.
 *
 * Sequential on purpose — the shared client serialises and spaces out requests
 * anyway, and a failed id lands in `errors` instead of failing the whole call,
 * so one deleted ad does not cost you the rest.
 */
export async function getListingsBatch(
  client: KleinanzeigenClient,
  inputs: string[],
  options: DetailOptions = {},
): Promise<BatchResult> {
  const listings: ListingDetail[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const input of inputs) {
    try {
      listings.push(await getListing(client, input, options));
    } catch (err) {
      errors.push({
        id: input,
        error:
          err instanceof ListingGoneError
            ? "listing deleted or expired"
            : err instanceof Error
              ? err.message
              : String(err),
      });
    }
  }

  return { requested: inputs.length, returned: listings.length, listings, errors };
}

function extractDetail(
  root: HTMLElement,
  refs: { id: string; url: string; finalUrl: string },
): ListingDetail {
  const titleElement = root.querySelector("#viewad-title");
  const rawTitle = collapse(titleElement?.text ?? "");
  const price = parsePrice(root.querySelector("#viewad-price")?.text);
  const previous = parsePrice(root.querySelector(".boxedarticle--old-price")?.text);

  return {
    // The sidebar carries the canonical id; fall back to what we asked for.
    id: collapse(root.querySelector("#viewad-ad-id-box li:nth-child(2)")?.text ?? "") || refs.id,
    url: refs.url,
    finalUrl: refs.finalUrl,
    // A prefixed status renders as "Verkauft • Real title"; keep the title only.
    title: rawTitle.includes(" • ") ? rawTitle.split(" • ").slice(-1)[0]!.trim() : rawTitle,
    status: readStatus(root, rawTitle, titleElement),
    price: {
      amount: price.amount,
      label: price.label,
      negotiable: price.negotiable,
      previousAmount: previous.amount,
    },
    description: readDescription(root),
    categories: root
      .querySelectorAll(".breadcrump-link")
      .map((link) => collapse(link.text))
      .filter(Boolean),
    location: readLocation(root),
    delivery: readDelivery(root),
    imageUrls: readImages(root),
    details: readDetails(root),
    features: root
      .querySelectorAll("#viewad-configuration .checktag")
      .map((tag) => collapse(tag.text))
      .filter(Boolean),
    seller: readSeller(root),
    createdAt: collapse(root.querySelector("#viewad-extra-info div span")?.text ?? "") || null,
  };
}

/** Ad pages carry no distance, so only the three address parts are kept. */
function readLocation(root: HTMLElement): ListingDetail["location"] {
  const { postcode, city, district } = parseLocality(root.querySelector("#viewad-locality")?.text);
  return { postcode, city, district };
}

function readStatus(root: HTMLElement, rawTitle: string, titleElement: HTMLElement | null): string {
  if (root.querySelector(".badge-sold") || titleElement?.classList.contains("is-sold")) return "sold";
  if (rawTitle.startsWith("Verkauft")) return "sold";
  if (rawTitle.startsWith("Reserviert")) return "reserved";
  if (rawTitle.startsWith("Gelöscht")) return "deleted";
  return "active";
}

function readDescription(root: HTMLElement): string | null {
  const element = root.querySelector("#viewad-description-text");
  if (!element) return null;
  // The ad text uses <br> for line breaks, which `.text` would otherwise eat.
  const text = collapseKeepingLines(
    element.innerHTML.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""),
  );
  return decodeEntities(text) || null;
}

function readDelivery(root: HTMLElement): string | null {
  const text = collapse(root.querySelector(".boxedarticle--details--shipping")?.text ?? "");
  if (!text) return null;
  if (/Nur Abholung/i.test(text)) return "pickup";
  if (/Versand/i.test(text)) return "shipping";
  return null;
}

function readImages(root: HTMLElement): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const img of root.querySelectorAll(".galleryimage-element img")) {
    const src = img.getAttribute("src") ?? img.getAttribute("data-imgsrc") ?? "";
    // The page also inlines placeholder and tracking pixels; real ad photos
    // all live under the prod-ads CDN path.
    if (!src.includes("prod-ads") || seen.has(src)) continue;
    seen.add(src);
    urls.push(src);
  }
  return urls;
}

function readDetails(root: HTMLElement): Record<string, string> {
  const details: Record<string, string> = {};
  for (const item of root.querySelectorAll("#viewad-details .addetailslist--detail")) {
    const valueElement = item.querySelector(".addetailslist--detail--value");
    if (!valueElement) continue;
    const value = collapse(valueElement.text);
    // The label is the list item minus its value span, e.g. "Marke" + "Lenovo".
    const label = collapse(item.text.replace(valueElement.text, ""));
    if (label) details[label] = value;
  }
  return details;
}

function readSeller(root: HTMLElement): ListingDetail["seller"] {
  const profile = root.querySelector(".userprofile-vip");
  const link =
    root.querySelector("a.userprofile-vip") ??
    profile?.querySelector("a") ??
    root.querySelector("a[href*='s-bestandsliste']") ??
    root.querySelector("a[href*='s-anzeigen-des-nutzers']");
  const href = link?.getAttribute("href") ?? "";
  const userId =
    /s-anzeigen-des-nutzers\/(\d+)/.exec(href)?.[1] ??
    /[?&]userId=(\d+)/.exec(href)?.[1] ??
    // Commercial sellers render their name as plain text with no profile link;
    // their id only surfaces on the imprint block further down the page.
    root.querySelector("[data-user-id]")?.getAttribute("data-user-id") ??
    null;

  const shopPath = root.querySelector("#viewad-bizteaser--title a")?.getAttribute("href");

  const detailTexts = root
    .querySelectorAll(".userprofile-vip-details-text")
    .map((element) => collapse(element.text));

  return {
    name: collapse(profile?.text ?? "") || null,
    userId,
    type: detailTexts.some((text) => /Gewerblicher/i.test(text)) ? "business" : "private",
    since: detailTexts.find((text) => text.startsWith("Aktiv seit"))?.replace("Aktiv seit", "").trim() ?? null,
    badges: root
      .querySelectorAll(".userbadge-tag")
      .map((badge) => collapse(badge.text))
      .filter(Boolean),
    shopUrl: shopPath ? new URL(shopPath, ORIGIN).toString() : null,
  };
}

async function fetchViewCount(
  client: KleinanzeigenClient,
  id: string,
  referer: string,
): Promise<number | null> {
  try {
    const payload = await client.getJson<{ numVisits?: number }>(
      `${ORIGIN}/s-vac-inc-get.json?adId=${encodeURIComponent(id)}`,
      referer,
    );
    return typeof payload.numVisits === "number" ? payload.numVisits : null;
  } catch {
    // A missing counter is not worth failing an otherwise complete ad over.
    return null;
  }
}

/** The handful of entities that survive stripping tags out of an ad body. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}
