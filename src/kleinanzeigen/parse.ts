/**
 * Shared text/price/date parsing for the scraped pages.
 *
 * Dates are the subtle part. Kleinanzeigen renders three formats and none of
 * them carry a timezone:
 *   "Heute, 22:06"   "Gestern, 19:30"   "26.04.2026"
 * The Python original resolved them against the scraping host's local clock and
 * emitted a naive ISO string; this does the same, so a host running outside
 * Europe/Berlin will be off by its UTC offset. Set TZ=Europe/Berlin to be exact.
 * Every timestamp this module produces is naive local ISO ("2026-08-20T12:37:00")
 * and is compared with `toEpoch`, which reads such strings as local time too —
 * so the comparison stays consistent regardless of the host's zone.
 */

const RELATIVE = /^(Heute|Gestern),\s*(\d{1,2}):(\d{2})$/;
const GERMAN_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

/** "Heute, 22:06" / "Gestern, 19:30" / "26.04.2026" → naive local ISO, or null. */
export function parseListingDate(text: string | null | undefined, now: Date = new Date()): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  const relative = RELATIVE.exec(trimmed);
  if (relative) {
    const hour = Number(relative[2]);
    const minute = Number(relative[3]);
    if (hour > 23 || minute > 59) return null;
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (relative[1] === "Gestern") day.setDate(day.getDate() - 1);
    return naiveIso(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute));
  }

  const absolute = GERMAN_DATE.exec(trimmed);
  if (absolute) {
    const day = Number(absolute[1]);
    const month = Number(absolute[2]);
    const year = Number(absolute[3]);
    const date = new Date(year, month - 1, day);
    // Reject 31.02. and friends, which Date silently rolls over.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return naiveIso(date);
  }

  return null;
}

/** Read a naive ISO string as local time. Returns NaN for unparseable input. */
export function toEpoch(naive: string): number {
  return new Date(naive).getTime();
}

function naiveIso(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * "444 € VB" → 444 negotiable, "Zu verschenken" → 0, "" → null.
 *
 * German thousands separators are dots and the decimal separator is a comma,
 * so "1.250,50 €" has to lose the dots before the comma becomes a point.
 */
export function parsePrice(text: string | null | undefined): {
  amount: number | null;
  label: string | null;
  negotiable: boolean;
} {
  const label = collapse(text ?? "");
  if (!label) return { amount: null, label: null, negotiable: false };

  const negotiable = /\bVB\b/i.test(label);
  if (/zu verschenken/i.test(label)) return { amount: 0, label, negotiable };

  const digits = /(\d[\d.]*(?:,\d+)?)/.exec(label);
  if (!digits?.[1]) return { amount: null, label, negotiable };

  const amount = Number(digits[1].replace(/\./g, "").replace(",", "."));
  return { amount: Number.isFinite(amount) ? amount : null, label, negotiable };
}

/** "1 - 25 von 564 Ergebnissen …" → total hits, or null if unparseable. */
export function parseTotalResults(summary: string | null | undefined): number | null {
  const match = /\bvon\s+([\d.]+)/.exec(summary ?? "");
  if (!match?.[1]) return null;
  const total = Number(match[1].replace(/\./g, ""));
  return Number.isFinite(total) ? total : null;
}

/**
 * "1 - 25 von 564 …" → how many pages exist.
 *
 * Only page 1 lets us infer the page size unambiguously (its range always
 * starts at 1), so anything else returns null rather than a guess.
 */
export function parsePageCount(summary: string | null | undefined): number | null {
  const match = /(\d[\d.]*)\s*-\s*(\d[\d.]*)\s+von\s+([\d.]+)/.exec(summary ?? "");
  if (!match) return null;
  const from = Number(match[1]!.replace(/\./g, ""));
  const to = Number(match[2]!.replace(/\./g, ""));
  const total = Number(match[3]!.replace(/\./g, ""));
  if (from !== 1 || to <= 0 || !Number.isFinite(total)) return null;
  return Math.ceil(total / to);
}

/**
 * "13088 Pankow - Weissensee" → its parts. Postcodes are always 5 digits.
 *
 * Results pages append the distance from the search centre when a radius was
 * given ("13357 Wedding (4 km)"); that is a property of the search, not of the
 * ad, so it is split off rather than left glued to the city name.
 */
export function parseLocality(text: string | null | undefined): {
  postcode: string | null;
  city: string | null;
  district: string | null;
  distanceKm: number | null;
} {
  let value = collapse(text ?? "");
  if (!value) return { postcode: null, city: null, district: null, distanceKm: null };

  let distanceKm: number | null = null;
  const distance = /\s*\((\d+(?:[.,]\d+)?)\s*km\)\s*$/i.exec(value);
  if (distance?.[1]) {
    const parsed = Number(distance[1].replace(",", "."));
    if (Number.isFinite(parsed)) distanceKm = parsed;
    value = value.slice(0, distance.index).trim();
  }

  const [head, ...rest] = value.split(" - ");
  const district = rest.join(" - ").trim() || null;

  const withPostcode = /^(\d{5})\s*(.*)$/.exec(head!.trim());
  if (withPostcode) {
    return { postcode: withPostcode[1]!, city: withPostcode[2]!.trim() || null, district, distanceKm };
  }
  return { postcode: null, city: head!.trim() || null, district, distanceKm };
}

/** Squash the whitespace that the site's templating leaves everywhere. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Like `collapse`, but keeps paragraph breaks — used for ad descriptions. */
export function collapseKeepingLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
