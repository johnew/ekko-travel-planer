import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  createEmptyState,
  eachDay,
  formatDate,
  getDayPlan,
  getPlanWarnings,
  groupItemsByLocation,
  monthGrid,
  nearestLocation,
  normalizeState,
  parseMapsInput,
  pickNewer,
  removeLocation,
  safeUrl,
} from '../src/model.js';

const kyoto = { id: 'kyoto', name: 'Kyoto', lat: 35.0116, lng: 135.7681, color: '#e6194b' };
const tokyo = { id: 'tokyo', name: 'Tokyo', lat: 35.6762, lng: 139.6503, color: '#4363d8' };

function tripState(extra = {}) {
  return {
    ...createEmptyState(),
    locations: [kyoto, tokyo],
    stays: [
      { id: 's1', locationId: 'kyoto', start: '2025-09-23', end: '2025-09-25' },
      { id: 's2', locationId: 'tokyo', start: '2025-09-25', end: '2025-09-28' },
    ],
    ...extra,
  };
}

test('parseMapsInput reads the place pin from a full Google Maps place link', () => {
  const r = parseMapsInput('https://www.google.com/maps/place/Fushimi+Inari+Taisha/@34.9676945,135.7791876,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d34.9676945!4d135.7791876');
  assert.equal(r.name, 'Fushimi Inari Taisha');
  assert.equal(r.lat, 34.9676945);
  assert.equal(r.lng, 135.7791876);
  assert.equal(r.needsManualPlacement, false);
  assert.match(r.url, /^https:\/\/www\.google\.com\/maps\/place\//);
});

test('parseMapsInput prefers the pin over the viewport centre', () => {
  const r = parseMapsInput('https://www.google.com/maps/place/X/@10,20,15z/data=!3d1.5!4d2.5');
  assert.deepEqual([r.lat, r.lng], [1.5, 2.5]);
});

test('parseMapsInput handles ?q= / ?query= coordinates and names', () => {
  assert.deepEqual(
    [parseMapsInput('https://maps.google.com/?q=35.0116,135.7681').lat, parseMapsInput('https://maps.google.com/?q=35.0116,135.7681').lng],
    [35.0116, 135.7681],
  );
  const named = parseMapsInput('https://www.google.com/maps/search/?api=1&query=Kinkaku-ji');
  assert.equal(named.lat, null);
  assert.equal(named.query, 'Kinkaku-ji');
  assert.equal(named.name, 'Kinkaku-ji');
});

test('parseMapsInput handles /search/ paths with coordinates', () => {
  const r = parseMapsInput('https://www.google.com/maps/search/35.0,135.5');
  assert.deepEqual([r.lat, r.lng], [35, 135.5]);
});

test('parseMapsInput flags short links for manual placement', () => {
  const r = parseMapsInput('https://maps.app.goo.gl/abc123');
  assert.equal(r.needsManualPlacement, true);
  assert.equal(r.url, 'https://maps.app.goo.gl/abc123');
});

test('parseMapsInput accepts plain coordinates and free text', () => {
  assert.deepEqual([parseMapsInput('35.1, 135.2').lat, parseMapsInput('35.1, 135.2').lng], [35.1, 135.2]);
  const text = parseMapsInput('Nishiki Market, Kyoto');
  assert.equal(text.query, 'Nishiki Market, Kyoto');
  assert.equal(text.url, '');
  assert.equal(parseMapsInput('').query, '');
});

test('parseMapsInput rejects out of range coordinates and non-http URLs', () => {
  assert.equal(parseMapsInput('95,10').lat, null);
  assert.equal(parseMapsInput('javascript:alert(1)').url, '');
});

test('safeUrl only allows http(s)', () => {
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('not a url'), '');
});

test('nearestLocation picks the closest location within range', () => {
  assert.equal(nearestLocation([kyoto, tokyo], { lat: 34.96, lng: 135.77 }).id, 'kyoto');
  assert.equal(nearestLocation([kyoto, tokyo], { lat: 35.68, lng: 139.7 }).id, 'tokyo');
  assert.equal(nearestLocation([kyoto, tokyo], { lat: 43.06, lng: 141.35 }), null);
});

test('groupItemsByLocation groups by location ordered by first stay, unassigned last', () => {
  const state = tripState({
    locations: [tokyo, kyoto, { id: 'osaka', name: 'Osaka', lat: 34.69, lng: 135.5, color: '#3cb44b' }],
    items: [
      { id: 'a', title: 'Shibuya', lat: 35.66, lng: 139.7, locationId: 'tokyo' },
      { id: 'b', title: 'Fushimi Inari', lat: 34.97, lng: 135.78, locationId: 'kyoto' },
      { id: 'c', title: 'Somewhere', lat: 0, lng: 0, locationId: null },
    ],
  });
  const groups = groupItemsByLocation(state);
  assert.deepEqual(groups.map((g) => g.location?.id ?? null), ['kyoto', 'tokyo', 'osaka', null]);
  assert.deepEqual(groups[0].items.map((i) => i.id), ['b']);
  assert.deepEqual(groups[3].items.map((i) => i.id), ['c']);
});

test('getDayPlan returns stays and departures for a day', () => {
  const state = tripState({
    departures: [{ id: 'd1', fromLocationId: 'kyoto', toLocationId: 'tokyo', date: '2025-09-25', time: '18:00', note: '' }],
  });
  const plan = getDayPlan(state, '2025-09-25');
  assert.deepEqual(plan.stays.map((s) => s.location.id), ['kyoto', 'tokyo']);
  assert.equal(plan.departures.length, 1);
  assert.equal(plan.departures[0].from.name, 'Kyoto');
  assert.equal(plan.departures[0].to.name, 'Tokyo');
  assert.equal(getDayPlan(state, '2025-09-24').departures.length, 0);
});

test('getPlanWarnings asks for a travel-on marker when two places share a day', () => {
  const warnings = getPlanWarnings(tripState());
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'overlap-without-departure');
  assert.equal(warnings[0].date, '2025-09-25');
  assert.match(warnings[0].message, /Kyoto and Tokyo/);
});

test('getPlanWarnings is satisfied by a matching departure', () => {
  const state = tripState({
    departures: [{ id: 'd1', fromLocationId: 'kyoto', toLocationId: 'tokyo', date: '2025-09-25', time: '18:00', note: '' }],
  });
  assert.deepEqual(getPlanWarnings(state), []);
});

test('getPlanWarnings flags departures that do not match the stays', () => {
  const state = tripState({
    departures: [{ id: 'd1', fromLocationId: 'tokyo', toLocationId: 'kyoto', date: '2025-09-30', time: '', note: '' }],
  });
  const types = getPlanWarnings(state).map((w) => w.type);
  assert.ok(types.includes('departure-without-stay'));
  assert.ok(types.includes('departure-without-arrival'));
});

test('getPlanWarnings accepts overnight arrival the next day', () => {
  const state = {
    ...createEmptyState(),
    locations: [kyoto, tokyo],
    stays: [
      { id: 's1', locationId: 'kyoto', start: '2025-09-23', end: '2025-09-25' },
      { id: 's2', locationId: 'tokyo', start: '2025-09-26', end: '2025-09-28' },
    ],
    departures: [{ id: 'd1', fromLocationId: 'kyoto', toLocationId: 'tokyo', date: '2025-09-25', time: '23:00', note: '' }],
  };
  assert.deepEqual(getPlanWarnings(state), []);
});

test('date helpers', () => {
  assert.equal(addDays('2025-09-30', 1), '2025-10-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.deepEqual(eachDay('2025-09-23', '2025-09-25'), ['2025-09-23', '2025-09-24', '2025-09-25']);
  assert.equal(formatDate('2025-09-23'), '23.09');
  assert.equal(formatDate('nope'), '');
});

test('monthGrid starts on Monday and covers the whole month', () => {
  const weeks = monthGrid(2025, 8); // September 2025 starts on a Monday
  assert.equal(weeks[0][0].iso, '2025-09-01');
  assert.ok(weeks.every((w) => w.length === 7));
  const inMonth = weeks.flat().filter((d) => d.inMonth);
  assert.equal(inMonth.length, 30);
  assert.equal(inMonth.at(-1).iso, '2025-09-30');
  assert.equal(monthGrid(2025, 9)[0][0].iso, '2025-09-29'); // October 2025 starts on Wednesday
});

test('normalizeState drops invalid and dangling entries', () => {
  const state = normalizeState({
    updatedAt: 5,
    locations: [kyoto, { id: 'bad', name: 'Bad', lat: 'x', lng: 1 }],
    items: [
      { id: 'i1', title: 'Ok', lat: 35, lng: 135, locationId: 'kyoto', url: 'javascript:alert(1)' },
      { id: 'i2', title: 'Orphan', lat: 35, lng: 135, locationId: 'gone' },
      { id: 'i3', title: 'No coords' },
    ],
    stays: [
      { id: 's1', locationId: 'kyoto', start: '2025-09-23', end: '2025-09-25' },
      { id: 's2', locationId: 'kyoto', start: '2025-09-25', end: '2025-09-23' },
    ],
    departures: [{ id: 'd1', fromLocationId: 'kyoto', toLocationId: 'gone', date: '2025-09-25' }],
  });
  assert.equal(state.updatedAt, 5);
  assert.deepEqual(state.locations.map((l) => l.id), ['kyoto']);
  assert.deepEqual(state.items.map((i) => [i.id, i.locationId, i.url]), [['i1', 'kyoto', ''], ['i2', null, '']]);
  assert.deepEqual(state.stays.map((s) => s.id), ['s1']);
  assert.equal(state.departures.length, 0);
  assert.deepEqual(normalizeState(null), createEmptyState());
});

test('pickNewer keeps the most recently updated state', () => {
  const a = { updatedAt: 1 };
  const b = { updatedAt: 2 };
  assert.equal(pickNewer(a, b), b);
  assert.equal(pickNewer(b, a), b);
  assert.equal(pickNewer(a, null), a);
});

test('removeLocation removes stays/departures and unassigns items', () => {
  const state = tripState({
    items: [{ id: 'a', title: 'Shibuya', lat: 35.66, lng: 139.7, locationId: 'tokyo' }],
    departures: [{ id: 'd1', fromLocationId: 'kyoto', toLocationId: 'tokyo', date: '2025-09-25', time: '', note: '' }],
  });
  const next = removeLocation(state, 'tokyo');
  assert.deepEqual(next.locations.map((l) => l.id), ['kyoto']);
  assert.equal(next.items[0].locationId, null);
  assert.deepEqual(next.stays.map((s) => s.id), ['s1']);
  assert.equal(next.departures.length, 0);
});
