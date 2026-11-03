import { invalidParameterValue } from './lambda-error';

/** The most entries a page of most of Lambda's lists holds, and how many without MaxItems, as Lambda's. */
const MAX_ITEMS = 10_000;
const DEFAULT_ITEMS = 50;

/**
 * Where an entry sorts in its list: the values the list is sorted by, in turn, such as a function's name and its
 * version's number; null, for $LATEST, sorts first.
 */
export type Place = ReadonlyArray<string | number | null>;

/** A page of a list, as Lambda's lists answer one, and the marker of the next page, when there is one. */
export interface Page<T> {
  page: T[];
  nextMarker?: string;
}

const markerOf = (place: Place): string => Buffer.from(JSON.stringify(place), 'utf8').toString('base64url');

/** The place that a page of `operation` gave as its NextMarker; refused when it isn't one. */
function placeOf(marker: string, operation: string): Place {
  try {
    const place: unknown = JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'));
    if (Array.isArray(place) && place.length > 0 && place.every((value) => value === null || typeof value === 'string' || Number.isInteger(value))) {
      return place as Place;
    }
  } catch {
    // Not one of FF's markers: refused below.
  }
  throw invalidParameterValue(`Marker is not one that ${operation} gave.`);
}

function compare(a: Place, b: Place): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? null, b[i] ?? null];
    if (x === y) continue;
    if (x === null) return -1;
    if (y === null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** A list's own limits, where they aren't most lists': the most MaxItems may ask, and the most a page gives however many it asks. */
export interface PageLimits {
  most?: number;
  perPage?: number;
}

/**
 * A page of `entries`, sorted by their places, as Lambda's lists give one: MaxItems of them, 50 by default, within the
 * list's own limits, from after the Marker that the page before gave as its NextMarker, which this page gives when more
 * come after it.
 */
export function pageOf<T>(query: URLSearchParams, entries: readonly T[], place: (entry: T) => Place, operation: string, limits: PageLimits = {}): Page<T> {
  const { most = MAX_ITEMS, perPage = most } = limits;
  const sent = query.get('MaxItems');
  const asked = sent === null ? DEFAULT_ITEMS : Number(sent);
  if (!Number.isInteger(asked) || asked < 1 || asked > most) throw invalidParameterValue(`MaxItems must be a whole number from 1 to ${most}, not ${sent}.`);
  const size = Math.min(asked, perPage);
  const marker = query.get('Marker');
  const sorted = [...entries].sort((a, b) => compare(place(a), place(b)));
  const from = marker === null ? undefined : placeOf(marker, operation);
  const rest = from ? sorted.filter((entry) => compare(place(entry), from) > 0) : sorted;
  const page = rest.slice(0, size);
  const last = page.at(-1);
  return { page, ...(rest.length > page.length && last !== undefined ? { nextMarker: markerOf(place(last)) } : {}) };
}
