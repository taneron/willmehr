/**
 * Full ad detail.
 *
 * There is no public JSON endpoint for a single ad — `publicapi.willhaben.at`
 * and `api.willhaben.at` both refuse anonymous callers. The ad page is a Next.js
 * route though, so the complete server-rendered payload sits in `__NEXT_DATA__`.
 *
 * We use the lighter `/_next/data/<buildId>/...json` route when we know the
 * current buildId, and fall back to the HTML page (which also refreshes the
 * buildId) whenever willhaben deploys and the old id 404s.
 */

import { ORIGIN, WillhabenError, type WillhabenClient } from "./http.js";
import { attributeMap, normalizeListing } from "./normalize.js";
import type { RawAdvertSummary, RawAttribute } from "./types.js";

interface NextData {
  buildId?: string;
  props?: { pageProps?: { advertDetails?: RawAdvertDetail } };
}

interface RawAdvertDetail extends RawAdvertSummary {
  uuid?: string;
  publishedDate?: string;
  changedDate?: string;
  createdDate?: string;
  categoryTreeId?: number;
  chatEnabled?: boolean;
  contactOption?: { contactType?: string };
  advertImageList?: { advertImage?: Array<{ mainImageUrl?: string; reference?: string }> };
  advertAddressDetails?: {
    postCode?: string;
    postalName?: string;
    province?: string;
    district?: string;
    country?: string;
    addressLines?: { value?: string[] };
  };
  organisationDetails?: { orgName?: string; orgPhone?: string; orgEmail?: string; id?: string };
  sellerProfileUserData?: {
    name?: string;
    registerDate?: string;
    location?: string;
    activeAdCount?: number;
    private?: boolean;
    orgUUID?: string;
    pictureUrl?: string;
  };
}

export interface AdDetail {
  id: string;
  uuid: string | null;
  title: string;
  price: number | null;
  priceLabel: string | null;
  url: string;
  /** Full ad text. Line breaks are preserved. */
  description: string | null;
  categoryId: number | null;
  status: string | null;
  createdAt: string | null;
  publishedAt: string | null;
  changedAt: string | null;
  location: {
    postcode: string | null;
    city: string | null;
    district: string | null;
    state: string | null;
    country: string | null;
    address: string | null;
  };
  seller: {
    name: string | null;
    isPrivate: boolean | null;
    /** Account age is the single best trust signal willhaben exposes anonymously. */
    memberSince: string | null;
    activeAdCount: number | null;
    location: string | null;
    phone: string | null;
  };
  /** How to reach the seller: chat, email, or phone. */
  contactVia: string | null;
  chatEnabled: boolean;
  imageUrls: string[];
  /** Category-specific attributes (RAM, condition, size, ...) as label → value. */
  attributes: Record<string, string>;
}

/** Cached across calls; refreshed automatically when willhaben redeploys. */
let cachedBuildId: string | null = null;

/** Accepts an ad id, a seopath, or any willhaben ad URL. */
export function resolveAdPath(input: string): { id: string | null; seopath: string | null } {
  const trimmed = input.trim();

  if (/^\d+$/.test(trimmed)) return { id: trimmed, seopath: null };

  const withoutOrigin = trimmed
    .replace(/^https?:\/\/(www\.)?willhaben\.at/i, "")
    .replace(/^\/iad\//, "")
    .replace(/^\/+/, "");

  const adIdParam = /[?&]adId=(\d+)/i.exec(trimmed);
  if (adIdParam?.[1]) return { id: adIdParam[1], seopath: null };

  // Seopaths always end in the numeric ad id.
  const seopath = withoutOrigin.split("?")[0]?.replace(/\/+$/, "") ?? "";
  const trailingId = /-(\d+)$/.exec(seopath);
  return { id: trailingId?.[1] ?? null, seopath: seopath || null };
}

export async function getAd(client: WillhabenClient, input: string): Promise<AdDetail> {
  const { id, seopath } = resolveAdPath(input);
  if (!id && !seopath) throw new Error(`Could not read an ad id out of "${input}".`);

  const detail = seopath
    ? await fetchBySeopath(client, seopath)
    : await fetchByAdId(client, id as string);

  return normalizeDetail(detail, seopath);
}

async function fetchBySeopath(
  client: WillhabenClient,
  seopath: string,
): Promise<RawAdvertDetail> {
  const path = seopath.startsWith("kaufen-und-verkaufen/")
    ? seopath
    : `kaufen-und-verkaufen/d/${seopath}`;

  if (cachedBuildId) {
    try {
      const url =
        `${ORIGIN}/_next/data/${cachedBuildId}/iad/${path}.json` +
        `?seopath=${encodeURIComponent(seopath.replace(/^kaufen-und-verkaufen\/d\//, ""))}`;
      const data = await client.getJson<{ pageProps?: { advertDetails?: RawAdvertDetail } }>(url);
      const detail = data.pageProps?.advertDetails;
      if (detail) return detail;
    } catch (err) {
      // A rotated buildId shows up as a 404; fall through to the HTML page.
      if (!(err instanceof WillhabenError) || err.status !== 404) throw err;
      cachedBuildId = null;
    }
  }

  const html = await client.getText(`${ORIGIN}/iad/${path}/`);
  const next = parseNextData(html);
  if (next.buildId) cachedBuildId = next.buildId;

  const detail = next.props?.pageProps?.advertDetails;
  if (!detail) throw new Error(`No ad data found at ${ORIGIN}/iad/${path}/ — ad may be deleted.`);
  return detail;
}

/**
 * `/iad/object?adId=<id>` redirects to the canonical seopath; `fetch` follows it
 * and we parse the page it lands on.
 */
async function fetchByAdId(client: WillhabenClient, id: string): Promise<RawAdvertDetail> {
  const html = await client.getText(`${ORIGIN}/iad/object?adId=${id}`);
  const next = parseNextData(html);
  if (next.buildId) cachedBuildId = next.buildId;

  const detail = next.props?.pageProps?.advertDetails;
  if (!detail) throw new Error(`Ad ${id} not found (it may be sold, expired, or deleted).`);
  return detail;
}

function parseNextData(html: string): NextData {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("Could not find __NEXT_DATA__ — willhaben changed its markup.");
  return JSON.parse(match[1]) as NextData;
}

/** Attributes we surface as first-class fields, so we don't repeat them in the bag. */
const STRUCTURAL_ATTRIBUTES = new Set([
  "DESCRIPTION",
  "HEADING",
  "BODY_DYN",
  "PRICE",
  "PRICE/AMOUNT",
  "PRICE_FOR_DISPLAY",
  "COORDINATES",
  "SHOW_MAP",
  "SHOW_SHADOWMAP",
  "AREA_ID",
  "REGION_AREA_ID",
  "ISPRIVATE",
  "DEALER",
  "ORG_TYPE",
  "SEO_URL",
  "ALL_IMAGE_URLS",
  "MMO",
]);

function normalizeDetail(raw: RawAdvertDetail, seopath: string | null): AdDetail {
  const attributes = raw.attributes?.attribute ?? [];
  const map = attributeMap(attributes);

  // Reuse the summary normalizer for the fields that share a representation.
  const summary = normalizeListing({ ...raw, attributes: { attribute: attributes } });
  const address = raw.advertAddressDetails;
  const seller = raw.sellerProfileUserData;

  const images = (raw.advertImageList?.advertImage ?? [])
    .map((image) => image.mainImageUrl ?? image.reference)
    .filter((url): url is string => Boolean(url))
    .map((url) => (url.startsWith("http") ? url : `https://cache.willhaben.at/mmo/${url}`));

  return {
    id: String(raw.id),
    uuid: raw.uuid ?? null,
    title: raw.description ?? summary.title,
    price: summary.price,
    priceLabel: summary.priceLabel,
    url: seopath ? `${ORIGIN}/iad/${seopath}` : summary.url,
    description: map.get("DESCRIPTION")?.[0] ?? summary.description,
    categoryId: raw.categoryTreeId ?? null,
    status: raw.advertStatus?.id ?? null,
    createdAt: isoOrNull(raw.createdDate),
    publishedAt: isoOrNull(raw.publishedDate) ?? summary.publishedAt,
    changedAt: isoOrNull(raw.changedDate) ?? summary.changedAt,
    location: {
      postcode: address?.postCode ?? summary.postcode,
      city: address?.postalName ?? summary.location,
      district: address?.district ?? summary.district,
      state: address?.province ?? summary.state,
      country: address?.country ?? null,
      address: address?.addressLines?.value?.[0] ?? null,
    },
    seller: {
      name: seller?.name ?? raw.organisationDetails?.orgName ?? summary.seller.name,
      isPrivate: seller?.private ?? summary.seller.isPrivate,
      memberSince: isoOrNull(seller?.registerDate),
      activeAdCount: seller?.activeAdCount ?? null,
      location: seller?.location ?? null,
      phone: raw.organisationDetails?.orgPhone ?? null,
    },
    contactVia: raw.contactOption?.contactType ?? null,
    chatEnabled: raw.chatEnabled ?? false,
    imageUrls: images.length > 0 ? images : summary.imageUrls,
    attributes: descriptiveAttributes(attributes),
  };
}

function descriptiveAttributes(attributes: RawAttribute[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const attribute of attributes) {
    if (!attribute?.name || STRUCTURAL_ATTRIBUTES.has(attribute.name)) continue;
    if (attribute.name.startsWith("LOCATION/") || attribute.name.startsWith("CONTACT/")) continue;
    const value = (attribute.values ?? []).filter(Boolean).join(", ");
    if (value) result[attribute.name] = value;
  }
  return result;
}

/** willhaben sends `+0200` offsets, which `Date` parses fine; normalise to UTC ISO. */
function isoOrNull(value: string | undefined | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
