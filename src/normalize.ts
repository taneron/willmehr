/**
 * willhaben returns every field as a `{name, values[]}` pair in a flat bag.
 * This turns that bag into a typed `Listing`.
 */

import { ORIGIN } from "./http.js";
import type { Listing, RawAdvertSummary, RawAttribute } from "./types.js";

const IMAGE_CDN = "https://cache.willhaben.at/mmo";

export function attributeMap(attributes: RawAttribute[] | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const attr of attributes ?? []) {
    if (attr?.name) map.set(attr.name, attr.values ?? []);
  }
  return map;
}

const first = (map: Map<string, string[]>, key: string): string | null =>
  map.get(key)?.[0] ?? null;

function num(map: Map<string, string[]>, key: string): number | null {
  const raw = first(map, key);
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** willhaben sends epoch-millis as a string in `PUBLISHED`, and ISO in `PUBLISHED_String`. */
function isoDate(map: Map<string, string[]>, isoKey: string, epochKey: string): string | null {
  const iso = first(map, isoKey);
  if (iso) return iso;
  const epoch = num(map, epochKey);
  if (epoch === null) return null;
  const date = new Date(epoch);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function coordinates(map: Map<string, string[]>): { lat: number; lng: number } | null {
  const raw = first(map, "COORDINATES");
  if (!raw) return null;
  const [lat, lng] = raw.split(",").map((part) => Number(part.trim()));
  if (lat === undefined || lng === undefined) return null;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function images(map: Map<string, string[]>): string[] {
  // ALL_IMAGE_URLS is one string of `;`-separated CDN paths.
  const raw = first(map, "ALL_IMAGE_URLS") ?? first(map, "MMO");
  if (!raw) return [];
  return raw
    .split(";")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => `${IMAGE_CDN}/${path}`);
}

function categoryIds(map: Map<string, string[]>): number[] {
  const raw = first(map, "categorytreeids");
  if (!raw) return [];
  return raw
    .split(";")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id));
}

/** `ISPRIVATE` is "1" for private sellers, "0" for dealers. */
function isPrivate(map: Map<string, string[]>): boolean | null {
  const raw = first(map, "ISPRIVATE");
  if (raw === null) return null;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function normalizeListing(raw: RawAdvertSummary): Listing {
  const map = attributeMap(raw.attributes?.attribute);
  const seoUrl = first(map, "SEO_URL");

  return {
    id: String(raw.id),
    title: first(map, "HEADING") ?? raw.description ?? "",
    price: num(map, "PRICE"),
    priceLabel: first(map, "PRICE_FOR_DISPLAY"),
    url: seoUrl ? `${ORIGIN}/iad/${stripLeadingSlash(seoUrl)}` : `${ORIGIN}/iad/object?adId=${raw.id}`,
    description: first(map, "BODY_DYN") ?? first(map, "DESCRIPTION"),
    location: first(map, "LOCATION"),
    postcode: first(map, "POSTCODE"),
    district: first(map, "DISTRICT"),
    state: first(map, "STATE"),
    coordinates: coordinates(map),
    publishedAt: isoDate(map, "PUBLISHED_String", "PUBLISHED"),
    changedAt: isoDate(map, "CHANGED_String", "CHANGED"),
    seller: {
      name: first(map, "ORGNAME") ?? first(map, "CONTACT/NAME"),
      isPrivate: isPrivate(map),
      organisationId: first(map, "ORGID"),
    },
    payliveryEnabled: first(map, "p2penabled") === "true",
    bumped: first(map, "IS_BUMPED") === "1",
    categoryIds: categoryIds(map),
    imageUrls: images(map),
    status: raw.advertStatus?.id ?? null,
  };
}

const stripLeadingSlash = (value: string): string => value.replace(/^\/+/, "");
