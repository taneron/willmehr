/** Shapes returned by willhaben's ad-search API, narrowed to what we consume. */

export interface RawAttribute {
  name: string;
  values: string[];
}

export interface RawAdvertSummary {
  id: string;
  verticalId?: number;
  adTypeId?: number;
  productId?: number;
  description?: string;
  advertStatus?: { id?: string; description?: string; statusId?: number };
  attributes?: { attribute?: RawAttribute[] };
  contextLinkList?: { contextLink?: Array<{ id?: string; uri?: string }> };
}

export interface RawSearchResponse {
  rowsFound?: number;
  rowsReturned?: number;
  rowsRequested?: number;
  pageRequested?: number;
  searchDate?: string;
  advertSummaryList?: { advertSummary?: RawAdvertSummary[] };
  navigatorGroups?: RawNavigatorGroup[];
  pagingLinksList?: { contextLink?: Array<{ id?: string; description?: string; uri?: string }> };
}

export interface RawNavigatorGroup {
  navigatorList?: RawNavigator[];
}

export interface RawNavigator {
  id?: string;
  label?: string;
  navigatorType?: string;
  navigatorSelectionType?: string;
  possibleValues?: RawNavigatorValue[];
  groupedPossibleValues?: Array<{ possibleValues?: RawNavigatorValue[] }>;
  urlConstructionInformation?: {
    urlParams?: Array<{ urlParameterName?: string; navigatorUrlParameterType?: string }>;
  };
}

export interface RawNavigatorValue {
  label?: string;
  hits?: number;
  urlParamRepresentationForValue?: Array<{ urlParameterName?: string; value?: string }>;
}

/** A listing, flattened into something an agent can reason about directly. */
export interface Listing {
  id: string;
  title: string;
  /** Numeric price in EUR. `null` when the ad has no price (e.g. "Preis auf Anfrage"). */
  price: number | null;
  priceLabel: string | null;
  url: string;
  description: string | null;
  location: string | null;
  postcode: string | null;
  district: string | null;
  state: string | null;
  coordinates: { lat: number; lng: number } | null;
  /** ISO 8601. First publication of the ad. */
  publishedAt: string | null;
  /** ISO 8601. Last edit — a re-listed or price-dropped ad changes here but not above. */
  changedAt: string | null;
  seller: {
    name: string | null;
    isPrivate: boolean | null;
    /** Present for commercial sellers only. */
    organisationId: string | null;
  };
  /** Buyer protection + shipping ("PayLivery") is offered. */
  payliveryEnabled: boolean;
  /** Ad was bumped to the top of results by the seller. */
  bumped: boolean;
  categoryIds: number[];
  imageUrls: string[];
  status: string | null;
}

export interface SearchResult {
  totalFound: number;
  returned: number;
  page: number;
  listings: Listing[];
  /** Query URL actually issued, for debugging and reproducibility. */
  requestUrl: string;
}

/** A filter dimension the API exposes for the current query. */
export interface FilterDimension {
  id: string;
  label: string | null;
  type: string | null;
  selection: string | null;
  /** Query parameter names this dimension is expressed through. */
  parameters: string[];
  values: Array<{ label: string; parameter: string; value: string; hits: number | null }>;
}
