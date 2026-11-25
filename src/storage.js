import { createEmptyState, normalizeState } from './model.js';

const STORAGE_KEY = 'ekko.trip.v1';
const CLIENT_ID_KEY = 'ekko.googleClientId';

export function loadLocal() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return createEmptyState();
  }
}

export function saveLocal(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function getClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || window.EKKO_CONFIG?.googleClientId || '';
}

export function setClientId(id) {
  if (id) localStorage.setItem(CLIENT_ID_KEY, id);
  else localStorage.removeItem(CLIENT_ID_KEY);
}

export function downloadJson(state, filename = 'ekko-trip.json') {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function readJsonFile(file) {
  return normalizeState(JSON.parse(await file.text()));
}
