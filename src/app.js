/* global L */
import {
  formatDate,
  formatRange,
  getDayPlan,
  getLocationSchedule,
  getPlanWarnings,
  groupItemsByLocation,
  monthGrid,
  nearestLocation,
  nextLocationColor,
  normalizeState,
  parseMapsInput,
  pickNewer,
  removeLocation,
  uid,
} from './model.js';
import {
  downloadJson, getClientId, loadLocal, readJsonFile, saveLocal, setClientId,
} from './storage.js';
import { DriveSync, loadGis } from './drive.js';

const UNASSIGNED_COLOR = '#777777';
const DEPARTURE_COLOR = '#d10000';

let state = loadLocal();
let drive = null;
let driveSaveTimer = null;
let pickCallback = null;
let calendarMonth = initialMonth();

const $ = (sel) => document.querySelector(sel);

/** Tiny DOM builder; children are appended as text nodes so user input is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function locationById(id) {
  return state.locations.find((l) => l.id === id) || null;
}

function update(mutator) {
  const next = structuredClone(state);
  mutator(next);
  next.updatedAt = Date.now();
  state = normalizeState(next);
  saveLocal(state);
  render();
  scheduleDriveSave();
}

function replaceState(next) {
  state = normalizeState(next);
  saveLocal(state);
  calendarMonth = initialMonth();
  render();
  fitMap();
}

// ---------------------------------------------------------------- Map

const map = L.map('map', { zoomControl: true }).setView([35.0, 137.0], 5);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const layers = {
  departures: L.layerGroup().addTo(map),
  locations: L.layerGroup().addTo(map),
  items: L.layerGroup().addTo(map),
};
const itemMarkers = new Map();

map.on('click', (e) => {
  if (!pickCallback) return;
  const cb = pickCallback;
  stopPick();
  cb({ lat: e.latlng.lat, lng: e.latlng.lng });
});

function startPick(message, callback) {
  pickCallback = callback;
  $('#pick-hint-text').textContent = message;
  $('#pick-hint').hidden = false;
  map.getContainer().classList.add('picking');
}

function stopPick() {
  pickCallback = null;
  $('#pick-hint').hidden = true;
  map.getContainer().classList.remove('picking');
}

function itemPopup(item) {
  const loc = locationById(item.locationId);
  return h('div', { class: 'popup' },
    h('strong', {}, item.title),
    h('div', { class: 'muted' }, loc ? loc.name : 'No location'),
    item.notes ? h('p', {}, item.notes) : null,
    item.url ? h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open link ↗') : null);
}

function renderMap() {
  Object.values(layers).forEach((layer) => layer.clearLayers());
  itemMarkers.clear();

  for (const loc of state.locations) {
    const schedule = getLocationSchedule(state, loc.id);
    const dates = schedule.stays.map((s) => formatRange(s.start, s.end)).join(', ');
    L.circleMarker([loc.lat, loc.lng], {
      radius: 14, color: '#fff', weight: 3, fillColor: loc.color, fillOpacity: 0.85,
    })
      .bindTooltip(h('div', {}, h('strong', {}, loc.name), dates ? h('div', {}, dates) : null), {
        permanent: true, direction: 'top', offset: [0, -12], className: 'location-label',
      })
      .addTo(layers.locations);
  }

  for (const item of state.items) {
    const color = locationById(item.locationId)?.color || UNASSIGNED_COLOR;
    const marker = L.circleMarker([item.lat, item.lng], {
      radius: 7, color: '#222', weight: 1, fillColor: color, fillOpacity: item.done ? 0.35 : 0.95,
    }).bindPopup(() => itemPopup(item)).bindTooltip(escapeHtml(item.title));
    marker.addTo(layers.items);
    itemMarkers.set(item.id, marker);
  }

  // High priority "travel on" markers: red dashed route plus a label at the departure point.
  for (const dep of state.departures) {
    const from = locationById(dep.fromLocationId);
    const to = locationById(dep.toLocationId);
    if (!from || !to) continue;
    L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
      color: DEPARTURE_COLOR, weight: 4, dashArray: '10 8', opacity: 0.9,
    }).addTo(layers.departures);
    const label = `✈ ${formatDate(dep.date)}${dep.time ? ` ${dep.time}` : ''} → ${to.name}`;
    L.marker([from.lat, from.lng], {
      icon: L.divIcon({
        className: 'departure-icon',
        html: `<span>${escapeHtml(label)}</span>`,
        iconSize: null,
        iconAnchor: [-16, -8],
      }),
      zIndexOffset: 1000,
      keyboard: false,
    }).addTo(layers.departures);
  }
}

function fitMap() {
  const points = [...state.locations, ...state.items].map((p) => [p.lat, p.lng]);
  if (points.length === 1) map.setView(points[0], 13);
  else if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 14 });
}

function focusItem(item) {
  map.setView([item.lat, item.lng], Math.max(map.getZoom(), 15));
  itemMarkers.get(item.id)?.openPopup();
}

// ---------------------------------------------------------------- Geocoding

async function geocode(query) {
  const params = new URLSearchParams({ q: query, format: 'json', limit: '1' });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Search failed');
  const [hit] = await response.json();
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), displayName: hit.display_name } : null;
}

/**
 * Turns user input (Google Maps link, "lat,lng" or a name) into a point. Calls `done` with
 * { lat, lng, name, url }. Falls back to letting the user click on the map.
 */
async function resolvePoint(input, label, done) {
  const parsed = parseMapsInput(input);
  if (parsed.lat !== null) {
    done({ lat: parsed.lat, lng: parsed.lng, name: parsed.name, url: parsed.url });
    return;
  }
  if (parsed.query) {
    setStatus(`Searching for “${parsed.query}”…`);
    try {
      const hit = await geocode(parsed.query);
      if (hit) {
        setStatus('');
        done({ lat: hit.lat, lng: hit.lng, name: parsed.name, url: parsed.url });
        return;
      }
    } catch {
      // fall through to manual placement
    }
    setStatus('');
  }
  const why = parsed.needsManualPlacement && parsed.url
    ? 'Short links cannot be read without a server.'
    : 'Could not find that place.';
  startPick(`${why} Click on the map to place ${label}.`, (point) => done({ ...point, name: parsed.name, url: parsed.url }));
}

// ---------------------------------------------------------------- Sidebar: places

function locationOptions(select, { includeAuto = false, includeNone = false } = {}) {
  const current = select.value;
  select.replaceChildren(
    ...(includeAuto ? [h('option', { value: '' }, 'Auto (nearest location)')] : []),
    ...(includeNone ? [h('option', { value: '' }, 'No location')] : []),
    ...state.locations.map((l) => h('option', { value: l.id }, l.name)),
  );
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function departureBadge(dep, { arrival = false } = {}) {
  const other = locationById(arrival ? dep.fromLocationId : dep.toLocationId);
  const when = `${formatDate(dep.date)}${dep.time ? ` ${dep.time}` : ''}`;
  return arrival
    ? h('span', { class: 'badge arrival' }, `Arrive from ${other?.name ?? '?'} ${formatDate(dep.date)}`)
    : h('span', { class: 'badge departure', title: dep.note || '' }, `✈ Leave for ${other?.name ?? '?'} ${when}`);
}

function renderGroups() {
  const container = $('#groups');
  const groups = groupItemsByLocation(state);
  if (!groups.length) {
    container.replaceChildren(h('p', { class: 'muted empty' },
      'Start by adding a location (e.g. “Kyoto”), then paste Google Maps links for things you want to do there.'));
    return;
  }
  container.replaceChildren(...groups.map(({ location, items }) => {
    const schedule = location ? getLocationSchedule(state, location.id) : null;
    const header = h('div', { class: 'group-header' },
      h('span', { class: 'dot', style: { background: location?.color || UNASSIGNED_COLOR } }),
      h('h3', {}, location ? location.name : 'Not linked to a location'),
      h('span', { class: 'count' }, String(items.length)),
      location ? h('button', {
        class: 'icon', title: `Remove ${location.name}`,
        onclick: () => {
          if (confirm(`Remove ${location.name}? Its stays and travel markers are removed and its items become unlinked.`)) {
            update((s) => Object.assign(s, removeLocation(s, location.id)));
          }
        },
      }, '✕') : null);
    const scheduleEl = location ? h('div', { class: 'group-schedule' },
      schedule.stays.length
        ? schedule.stays.map((s) => h('span', { class: 'badge stay' }, `📅 ${formatRange(s.start, s.end)}`))
        : h('span', { class: 'muted' }, 'Not in the calendar yet'),
      schedule.arrivals.map((d) => departureBadge(d, { arrival: true })),
      schedule.departures.map((d) => departureBadge(d))) : null;

    const list = h('ul', { class: 'items' }, items.map((item) => {
      const move = h('select', {
        class: 'move', title: 'Move to location',
        onchange: (e) => update((s) => {
          s.items.find((i) => i.id === item.id).locationId = e.target.value || null;
        }),
      });
      locationOptions(move, { includeNone: true });
      move.value = item.locationId || '';
      return h('li', { class: item.done ? 'done' : '' },
        h('input', {
          type: 'checkbox', checked: item.done, title: 'Done',
          onchange: (e) => update((s) => { s.items.find((i) => i.id === item.id).done = e.target.checked; }),
        }),
        h('button', { class: 'link', onclick: () => focusItem(item) }, item.title),
        item.url ? h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open link' }, '↗') : null,
        move,
        h('button', {
          class: 'icon', title: 'Remove',
          onclick: () => update((s) => { s.items = s.items.filter((i) => i.id !== item.id); }),
        }, '✕'));
    }));
    return h('section', { class: 'group', style: { borderLeftColor: location?.color || UNASSIGNED_COLOR } },
      header, scheduleEl, items.length ? list : h('p', { class: 'muted' }, 'No items yet.'));
  }));
}

$('#item-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#item-input').value.trim();
  if (!input) return;
  const title = $('#item-title').value.trim();
  const chosenLocation = $('#item-location').value;
  const notes = $('#item-notes').value.trim();
  resolvePoint(input, 'the item', (point) => {
    const locationId = chosenLocation || nearestLocation(state.locations, point)?.id || null;
    update((s) => {
      s.items.push({
        id: uid('item'),
        title: title || point.name || (point.url ? 'Linked place' : input),
        url: point.url,
        notes,
        lat: point.lat,
        lng: point.lng,
        locationId,
        done: false,
      });
    });
    $('#item-form').reset();
    map.setView([point.lat, point.lng], Math.max(map.getZoom(), 13));
  });
});

$('#location-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#location-input').value.trim();
  if (!input) return;
  resolvePoint(input, 'the location', (point) => {
    const name = point.name || (parseMapsInput(input).url ? 'New location' : input);
    update((s) => {
      const id = uid('loc');
      s.locations.push({ id, name, lat: point.lat, lng: point.lng, color: nextLocationColor(s.locations) });
      // Link existing unlinked items that are close to the new location.
      for (const item of s.items) {
        if (!item.locationId && nearestLocation([{ id, lat: point.lat, lng: point.lng }], item)) item.locationId = id;
      }
    });
    $('#location-form').reset();
    map.setView([point.lat, point.lng], 11);
  });
});

$('#pick-cancel').addEventListener('click', stopPick);

// ---------------------------------------------------------------- Sidebar: calendar

function initialMonth() {
  const first = state.stays.map((s) => s.start).sort()[0];
  if (first) return { year: Number(first.slice(0, 4)), month: Number(first.slice(5, 7)) - 1 };
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderCalendar() {
  const { year, month } = calendarMonth;
  $('#cal-title').textContent = new Date(year, month, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const warnings = getPlanWarnings(state);
  const warningDays = new Set(warnings.map((w) => w.date));
  const today = todayIso();

  const head = h('div', { class: 'cal-row cal-head' },
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('div', {}, d)));
  const weeks = monthGrid(year, month).map((week) => h('div', { class: 'cal-row' }, week.map(({ iso, inMonth }) => {
    const plan = getDayPlan(state, iso);
    const classes = ['cal-day'];
    if (!inMonth) classes.push('outside');
    if (iso === today) classes.push('today');
    if (plan.departures.length) classes.push('travel-day');
    if (warningDays.has(iso)) classes.push('has-warning');
    return h('div', {
      class: classes.join(' '),
      title: 'Click to use this date in the forms below',
      onclick: () => {
        // First click picks the stay start, the next click (on a later day) the stay end.
        const start = $('#stay-start');
        const end = $('#stay-end');
        if (!start.value || end.value || iso < start.value) {
          start.value = iso;
          end.value = '';
        } else {
          end.value = iso;
        }
        $('#dep-date').value = iso;
      },
    },
    h('div', { class: 'num' }, String(Number(iso.slice(8, 10)))),
    plan.stays.map(({ location }) => h('div', {
      class: 'cal-stay', style: { background: location.color }, title: location.name,
    }, location.name)),
    plan.departures.map(({ departure, to }) => h('div', {
      class: 'cal-departure', title: departure.note || `Travel on to ${to.name}`,
    }, `✈ ${departure.time ? `${departure.time} ` : ''}→ ${to.name}`)));
  })));
  $('#calendar').replaceChildren(head, ...weeks);

  $('#warnings').replaceChildren(...warnings.map((w) => h('div', { class: 'warning' }, `⚠ ${w.message}`)));

  // Chronological overview of stays and travel days.
  const entries = [
    ...state.stays.map((s) => ({ date: s.start, sort: `${s.start}1`, kind: 'stay', s })),
    ...state.departures.map((d) => ({ date: d.date, sort: `${d.date}2${d.time || '99:99'}`, kind: 'dep', d })),
  ].sort((a, b) => a.sort.localeCompare(b.sort));
  $('#schedule').replaceChildren(...entries.map((entry) => {
    if (entry.kind === 'stay') {
      const loc = locationById(entry.s.locationId);
      return h('li', { class: 'schedule-stay' },
        h('span', { class: 'dot', style: { background: loc?.color } }),
        h('span', {}, `${formatRange(entry.s.start, entry.s.end)} · ${loc?.name ?? '?'}`),
        h('button', {
          class: 'icon', title: 'Remove stay',
          onclick: () => update((st) => { st.stays = st.stays.filter((x) => x.id !== entry.s.id); }),
        }, '✕'));
    }
    const from = locationById(entry.d.fromLocationId);
    const to = locationById(entry.d.toLocationId);
    return h('li', { class: 'schedule-departure' },
      h('span', {}, `✈ ${formatDate(entry.d.date)}${entry.d.time ? ` ${entry.d.time}` : ''} · Leave ${from?.name ?? '?'} → ${to?.name ?? '?'}${entry.d.note ? ` (${entry.d.note})` : ''}`),
      h('button', {
        class: 'icon', title: 'Remove travel marker',
        onclick: () => update((st) => { st.departures = st.departures.filter((x) => x.id !== entry.d.id); }),
      }, '✕'));
  }));
  if (!entries.length) $('#schedule').append(h('li', { class: 'muted' }, 'Nothing planned yet.'));
}

$('#cal-prev').addEventListener('click', () => {
  const { year, month } = calendarMonth;
  calendarMonth = month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
  renderCalendar();
});
$('#cal-next').addEventListener('click', () => {
  const { year, month } = calendarMonth;
  calendarMonth = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
  renderCalendar();
});

$('#stay-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const locationId = $('#stay-location').value;
  const start = $('#stay-start').value;
  const end = $('#stay-end').value || start;
  if (!locationId || !start) return;
  if (end < start) {
    alert('The end date must be on or after the start date.');
    return;
  }
  update((s) => { s.stays.push({ id: uid('stay'), locationId, start, end }); });
  calendarMonth = { year: Number(start.slice(0, 4)), month: Number(start.slice(5, 7)) - 1 };
  renderCalendar();
  $('#stay-form').reset();
});

$('#departure-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const fromLocationId = $('#dep-from').value;
  const toLocationId = $('#dep-to').value;
  const date = $('#dep-date').value;
  if (!fromLocationId || !toLocationId || !date) return;
  if (fromLocationId === toLocationId) {
    alert('Choose two different locations.');
    return;
  }
  update((s) => {
    s.departures.push({
      id: uid('dep'), fromLocationId, toLocationId, date, time: $('#dep-time').value, note: $('#dep-note').value.trim(),
    });
  });
  $('#departure-form').reset();
});

// ---------------------------------------------------------------- Tabs

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[data-tab]')) t.classList.toggle('active', t === tab);
    for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== `tab-${tab.dataset.tab}`;
  });
}

// ---------------------------------------------------------------- Import / export / Drive

function setStatus(text) {
  $('#status').textContent = text;
}

$('#export-btn').addEventListener('click', () => downloadJson(state));
$('#import-input').addEventListener('change', async (e) => {
  const [file] = e.target.files;
  e.target.value = '';
  if (!file) return;
  try {
    const imported = await readJsonFile(file);
    if (confirm('Replace the current trip with the imported file?')) {
      imported.updatedAt = Date.now();
      replaceState(imported);
      scheduleDriveSave();
    }
  } catch {
    alert('That file is not a valid trip file.');
  }
});

function renderDriveButton() {
  $('#drive-btn').textContent = drive?.connected ? 'Disconnect Google Drive' : 'Sync with Google Drive';
}

function scheduleDriveSave() {
  if (!drive?.connected) return;
  clearTimeout(driveSaveTimer);
  setStatus('Unsaved changes…');
  driveSaveTimer = setTimeout(async () => {
    try {
      setStatus('Saving to Google Drive…');
      await drive.save(state);
      setStatus(`Saved to Google Drive ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      setStatus(`Drive sync failed: ${err.message}`);
    }
  }, 1500);
}

$('#drive-btn').addEventListener('click', async () => {
  if (drive?.connected) {
    drive.disconnect();
    drive = null;
    setStatus('Disconnected from Google Drive. Changes are only saved in this browser.');
    renderDriveButton();
    return;
  }
  let clientId = getClientId();
  if (!clientId) {
    clientId = (prompt('Enter your Google OAuth client ID (see README → Google Drive sync):') || '').trim();
    if (!clientId) return;
    setClientId(clientId);
  }
  try {
    setStatus('Connecting to Google Drive…');
    drive = new DriveSync(clientId);
    await drive.connect();
    const remote = await drive.load();
    const remoteState = remote ? normalizeState(remote) : null;
    const newest = pickNewer(state, remoteState);
    if (newest === remoteState) {
      replaceState(remoteState);
      setStatus('Loaded trip from Google Drive.');
    } else {
      await drive.save(state);
      setStatus('Connected – trip saved to Google Drive.');
    }
  } catch (err) {
    drive = null;
    setStatus(`Google Drive: ${err.message}`);
  }
  renderDriveButton();
});

// Preload Google sign-in so the popup opens directly from the click (avoids popup blockers).
if (getClientId()) loadGis().catch(() => {});

// ---------------------------------------------------------------- Render

function render() {
  for (const sel of ['#stay-location', '#dep-from', '#dep-to']) locationOptions($(sel));
  locationOptions($('#item-location'), { includeAuto: true });
  renderGroups();
  renderCalendar();
  renderMap();
}

render();
fitMap();
