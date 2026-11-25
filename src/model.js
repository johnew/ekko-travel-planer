// Pure, DOM-free logic for the travel planner. Everything in here is unit tested
// with `node --test` and shared by the browser UI.

export const STATE_VERSION = 1;

export const LOCATION_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#9a6324', '#469990', '#808000',
];

export function createEmptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: 0,
    locations: [],
    items: [],
    stays: [],
    departures: [],
  };
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

export function isValidLatLng(lat, lng) {
  return isFiniteNumber(lat) && isFiniteNumber(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Validates and cleans up state loaded from localStorage, a JSON file or Google Drive.
 * Unknown fields are dropped and invalid entries are skipped.
 */
export function normalizeState(raw) {
  const state = createEmptyState();
  if (!raw || typeof raw !== 'object') return state;
  state.updatedAt = isFiniteNumber(raw.updatedAt) ? raw.updatedAt : 0;

  for (const l of Array.isArray(raw.locations) ? raw.locations : []) {
    if (!l || typeof l.id !== 'string' || !isValidLatLng(l.lat, l.lng)) continue;
    state.locations.push({
      id: l.id,
      name: str(l.name, 'Unnamed location'),
      lat: l.lat,
      lng: l.lng,
      color: typeof l.color === 'string' && /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : LOCATION_COLORS[0],
    });
  }
  const locationIds = new Set(state.locations.map((l) => l.id));

  for (const i of Array.isArray(raw.items) ? raw.items : []) {
    if (!i || typeof i.id !== 'string' || !isValidLatLng(i.lat, i.lng)) continue;
    state.items.push({
      id: i.id,
      title: str(i.title, 'Untitled'),
      url: safeUrl(i.url),
      notes: str(i.notes),
      lat: i.lat,
      lng: i.lng,
      locationId: locationIds.has(i.locationId) ? i.locationId : null,
      done: i.done === true,
    });
  }

  for (const s of Array.isArray(raw.stays) ? raw.stays : []) {
    if (!s || typeof s.id !== 'string' || !locationIds.has(s.locationId)) continue;
    if (!isIsoDate(s.start) || !isIsoDate(s.end) || s.end < s.start) continue;
    state.stays.push({ id: s.id, locationId: s.locationId, start: s.start, end: s.end });
  }

  for (const d of Array.isArray(raw.departures) ? raw.departures : []) {
    if (!d || typeof d.id !== 'string' || !isIsoDate(d.date)) continue;
    if (!locationIds.has(d.fromLocationId) || !locationIds.has(d.toLocationId)) continue;
    state.departures.push({
      id: d.id,
      fromLocationId: d.fromLocationId,
      toLocationId: d.toLocationId,
      date: d.date,
      time: typeof d.time === 'string' && TIME.test(d.time) ? d.time : '',
      note: str(d.note),
    });
  }
  return state;
}

/** Returns the URL if it is an http(s) URL, otherwise an empty string. */
export function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function toCoords(latStr, lngStr) {
  const lat = Number(latStr);
  const lng = Number(lngStr);
  return isValidLatLng(lat, lng) ? { lat, lng } : null;
}

const COORD_PAIR = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

function decodePlus(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' ')).trim();
  } catch {
    return s.replace(/\+/g, ' ').trim();
  }
}

function coordsFrom(text) {
  const m = typeof text === 'string' ? text.match(COORD_PAIR) : null;
  return m ? toCoords(m[1], m[2]) : null;
}

/**
 * Extracts as much as possible from a Google Maps link (or a plain "lat,lng" / free text).
 *
 * Returns { url, name, query, lat, lng, needsManualPlacement }
 *  - lat/lng are set when coordinates could be read directly from the input.
 *  - query is a search string that can be geocoded when no coordinates were found.
 *  - needsManualPlacement is true when nothing usable was found, e.g. for short links
 *    (maps.app.goo.gl) which cannot be resolved in the browser without a backend.
 *    The user then clicks the map to place the item instead.
 */
export function parseMapsInput(input) {
  const result = { url: '', name: '', query: '', lat: null, lng: null, needsManualPlacement: false };
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return result;

  const pair = coordsFrom(text);
  if (pair) return Object.assign(result, pair);

  let url;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return Object.assign(result, { name: text, query: text });
  }
  result.url = url.href;

  const host = url.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'g.co') {
    result.needsManualPlacement = true;
    return result;
  }

  const placeMatch = url.pathname.match(/\/place\/([^/]+)/);
  const searchMatch = url.pathname.match(/\/search\/([^/]+)/);
  const search = searchMatch ? decodePlus(searchMatch[1]) : '';
  const q = url.searchParams.get('q') || url.searchParams.get('query')
    || url.searchParams.get('destination') || url.searchParams.get('ll') || '';

  if (placeMatch) result.name = decodePlus(placeMatch[1]);
  if (!result.name && q && !coordsFrom(q)) result.name = q.trim();
  if (!result.name && search && !coordsFrom(search)) result.name = search;

  // Most precise first: the place pin "!3d<lat>!4d<lng>", then explicit queries, then the
  // viewport centre "@lat,lng".
  const pin = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const at = decodePlus(url.pathname).match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const coords = (pin && toCoords(pin[1], pin[2]))
    || coordsFrom(q)
    || coordsFrom(search)
    || (at && toCoords(at[1], at[2]))
    || null;

  if (coords) {
    Object.assign(result, coords);
  } else if (result.name) {
    result.query = result.name;
  } else {
    result.needsManualPlacement = true;
  }
  return result;
}

export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Finds the closest location within maxKm of the point, or null. */
export function nearestLocation(locations, point, maxKm = 75) {
  let best = null;
  let bestDist = Infinity;
  for (const loc of locations) {
    const d = distanceKm(loc, point);
    if (d < bestDist && d <= maxKm) {
      best = loc;
      bestDist = d;
    }
  }
  return best;
}

export function nextLocationColor(locations) {
  return LOCATION_COLORS[locations.length % LOCATION_COLORS.length];
}

// ---------- Dates ----------

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function eachDay(start, end) {
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** "2025-09-23" -> "23.09" */
export function formatDate(iso) {
  if (!isIsoDate(iso)) return '';
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

export function formatRange(start, end) {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}

function byDateTime(a, b) {
  return (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99'));
}

// ---------- Grouping & schedule ----------

/**
 * Items are organised by location (not by date). Locations with a planned stay are ordered by
 * the first day you are there; unplanned locations follow alphabetically; items that do not
 * belong to any location end up in a final group with location === null.
 */
export function groupItemsByLocation(state) {
  const itemsByLocation = new Map(state.locations.map((location) => [location.id, []]));
  const firstDatesByLocation = new Map();
  const unassigned = [];

  for (const item of state.items) {
    const items = itemsByLocation.get(item.locationId);
    if (items) items.push(item);
    if (!item.locationId) unassigned.push(item);
  }
  for (const stay of state.stays) {
    const firstDate = firstDatesByLocation.get(stay.locationId);
    if (!firstDate || stay.start < firstDate) firstDatesByLocation.set(stay.locationId, stay.start);
  }

  const groups = state.locations.map((location) => ({
    location,
    firstDate: firstDatesByLocation.get(location.id) || null,
    items: itemsByLocation.get(location.id),
  }));
  groups.sort((a, b) => {
    if (a.firstDate && b.firstDate) return a.firstDate.localeCompare(b.firstDate);
    if (a.firstDate) return -1;
    if (b.firstDate) return 1;
    return a.location.name.localeCompare(b.location.name);
  });
  if (unassigned.length) groups.push({ location: null, firstDate: null, items: unassigned });
  return groups;
}

export function getLocationSchedule(state, locationId) {
  return {
    stays: state.stays.filter((s) => s.locationId === locationId)
      .sort((a, b) => a.start.localeCompare(b.start)),
    departures: state.departures.filter((d) => d.fromLocationId === locationId).sort(byDateTime),
    arrivals: state.departures.filter((d) => d.toLocationId === locationId).sort(byDateTime),
  };
}

/** Everything planned for a single day. */
export function getDayPlan(state, iso) {
  const locById = new Map(state.locations.map((l) => [l.id, l]));
  return {
    stays: state.stays
      .filter((s) => s.start <= iso && iso <= s.end)
      .map((stay) => ({ stay, location: locById.get(stay.locationId) }))
      .filter((s) => s.location),
    departures: state.departures
      .filter((d) => d.date === iso)
      .sort(byDateTime)
      .map((departure) => ({
        departure,
        from: locById.get(departure.fromLocationId),
        to: locById.get(departure.toLocationId),
      }))
      .filter((d) => d.from && d.to),
  };
}

/**
 * Checks the plan for things that need attention, e.g. two places on the same day without a
 * "travel on" marker saying when you leave, or departures that do not match a stay.
 */
export function getPlanWarnings(state) {
  const warnings = [];
  const locById = new Map(state.locations.map((l) => [l.id, l]));
  const name = (id) => locById.get(id)?.name || 'unknown location';
  const staysAt = (id, day) => state.stays.some((s) => s.locationId === id && s.start <= day && day <= s.end);

  for (const d of state.departures) {
    if (!staysAt(d.fromLocationId, d.date)) {
      warnings.push({
        type: 'departure-without-stay',
        date: d.date,
        message: `Leaving ${name(d.fromLocationId)} on ${formatDate(d.date)}, but no stay in ${name(d.fromLocationId)} is planned that day.`,
      });
    }
    // Arrival may be the same day or the next morning (night train / overnight flight).
    if (!staysAt(d.toLocationId, d.date) && !staysAt(d.toLocationId, addDays(d.date, 1))) {
      warnings.push({
        type: 'departure-without-arrival',
        date: d.date,
        message: `Travelling to ${name(d.toLocationId)} on ${formatDate(d.date)}, but no stay in ${name(d.toLocationId)} is planned.`,
      });
    }
  }

  const days = new Set();
  for (const s of state.stays) for (const day of eachDay(s.start, s.end)) days.add(day);
  for (const day of [...days].sort()) {
    const ids = [...new Set(state.stays.filter((s) => s.start <= day && day <= s.end).map((s) => s.locationId))];
    if (ids.length < 2) continue;
    const covered = ids.every((id) => state.departures.some((d) => d.date === day
      && (d.fromLocationId === id || d.toLocationId === id)));
    if (!covered) {
      warnings.push({
        type: 'overlap-without-departure',
        date: day,
        message: `On ${formatDate(day)} you are planned in ${ids.map(name).join(' and ')} – add a "travel on" marker to say when you leave.`,
      });
    }
  }
  return warnings.sort((a, b) => a.date.localeCompare(b.date));
}

/** Calendar grid (weeks start on Monday) for a month. Returns an array of weeks of 7 days. */
export function monthGrid(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  let day = addDays(first.toISOString().slice(0, 10), -offset);
  const weeks = [];
  do {
    const week = [];
    for (let i = 0; i < 7; i += 1) {
      week.push({ iso: day, inMonth: Number(day.slice(5, 7)) - 1 === monthIndex });
      day = addDays(day, 1);
    }
    weeks.push(week);
  } while (Number(day.slice(5, 7)) - 1 === monthIndex);
  return weeks;
}

/** Choose which of two saved states to keep when syncing (newest wins). */
export function pickNewer(local, remote) {
  if (!remote) return local;
  if (!local) return remote;
  return (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
}

/** Removes a location and everything that depends on it; its items become unassigned. */
export function removeLocation(state, locationId) {
  return {
    ...state,
    locations: state.locations.filter((l) => l.id !== locationId),
    items: state.items.map((i) => (i.locationId === locationId ? { ...i, locationId: null } : i)),
    stays: state.stays.filter((s) => s.locationId !== locationId),
    departures: state.departures.filter((d) => d.fromLocationId !== locationId && d.toLocationId !== locationId),
  };
}
