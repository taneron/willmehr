/** Shapes returned by the kleinanzeigen tools. */

export interface Price {
  /** EUR. `0` means "Zu verschenken"; `null` means no figure was shown. */
  amount: number | null;
  /** The site's own label, e.g. "444 € VB" or "Zu verschenken". */
  label: string | null;
  /** "VB" (Verhandlungsbasis) — the seller invites an offer. */
  negotiable: boolean;
  /** Set when the ad shows a struck-through previous price. */
  previousAmount?: number | null;
}

export interface ListingSummary {
  id: string;
  url: string;
  title: string;
  price: Price;
  /** Truncated teaser from the results page, not the full ad text. */
  description: string;
  postcode: string | null;
  city: string | null;
  /** Distance from the search centre, only set when `radiusKm` was used. */
  distanceKm: number | null;
  /** Naive local ISO 8601, e.g. "2026-08-20T12:37:00". See `dates.ts`. */
  publishedAt: string | null;
  /** True for "Gesuch" ads — someone WANTS this, they are not selling it. */
  wanted: boolean;
  shippingPossible: boolean;
  /** Raw tags shown under the ad ("Gesuch", "Versand möglich", ...). */
  tags: string[];
  thumbnailUrl: string | null;
}

export interface SearchResult {
  url: string;
  /** Total hits the site reports for this search, across all pages. */
  totalFound: number | null;
  pagesFetched: number;
  returned: number;
  listings: ListingSummary[];
  /** Non-fatal problems, e.g. a page that failed to load. */
  warnings: string[];
}

export interface ListingDetail {
  id: string;
  url: string;
  /** Where the request actually landed. Differs from `url` after a redirect. */
  finalUrl: string;
  title: string;
  /** "active" | "reserved" | "sold" | "deleted" */
  status: string;
  price: Price;
  description: string | null;
  /** Breadcrumb trail, outermost first. */
  categories: string[];
  location: {
    postcode: string | null;
    city: string | null;
    district: string | null;
  };
  /** "pickup" | "shipping" | null */
  delivery: string | null;
  imageUrls: string[];
  /** Category-specific fields (Typ, Marke, Zustand, ...) as label → value. */
  details: Record<string, string>;
  /** Checkbox-style extras ("Klimaanlage", "Balkon", ...). */
  features: string[];
  seller: {
    name: string | null;
    userId: string | null;
    /** "private" | "business" */
    type: string;
    /** German date the account was opened, e.g. "21.04.2017". */
    since: string | null;
    /** Behaviour badges the site awards ("Sehr zuverlässig", ...). */
    badges: string[];
    /** Commercial sellers only: their kleinanzeigen shop page. */
    shopUrl: string | null;
  };
  /** German date the ad was posted, e.g. "18.08.2026". */
  createdAt: string | null;
  /** Only present when `includeViewCount` was set; costs one extra request. */
  views?: number | null;
}
