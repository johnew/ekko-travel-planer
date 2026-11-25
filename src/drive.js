// Google Drive sync without a backend: the browser obtains an OAuth access token through
// Google Identity Services and talks to the Drive REST API directly. The trip is stored as a
// single JSON file in the user's own Drive. The `drive.file` scope only gives the app access
// to files it created itself.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'ekko-trip.json';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

let gisPromise = null;

/** Thrown when the access token is missing or expired; the user must reconnect with a click. */
export class DriveAuthError extends Error {}

/** Loads the Google Identity Services script once. */
export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisPromise = null;
        reject(new Error('Could not load Google sign-in. Are you offline?'));
      };
      document.head.append(script);
    });
  }
  return gisPromise;
}

export class DriveSync {
  constructor(clientId) {
    this.clientId = clientId;
    this.token = null;
    this.expiresAt = 0;
    this.fileId = null;
    this.tokenClient = null;
  }

  get connected() {
    return Boolean(this.token) && Date.now() < this.expiresAt;
  }

  /** Must be called from a user action (click), since it may open the Google sign-in popup. */
  async connect() {
    await loadGis();
    const firstTime = !this.tokenClient;
    this.tokenClient = this.tokenClient || window.google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: SCOPE,
      callback: () => {},
    });
    await this.requestToken(firstTime ? 'consent' : '');
  }

  requestToken(prompt) {
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        this.token = response.access_token;
        // Refresh a minute early to avoid using a token that expires mid-request.
        this.expiresAt = Date.now() + ((Number(response.expires_in) || 3600) - 60) * 1000;
        resolve();
      };
      this.tokenClient.error_callback = (err) => reject(new Error(err?.message || err?.type || 'Sign-in cancelled'));
      this.tokenClient.requestAccessToken({ prompt });
    });
  }

  disconnect() {
    if (this.token) window.google?.accounts?.oauth2?.revoke(this.token, () => {});
    this.token = null;
    this.expiresAt = 0;
    this.fileId = null;
  }

  async request(url, options = {}) {
    if (!this.connected) throw new DriveAuthError('Google Drive session expired');
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${this.token}` },
    });
    if (response.status === 401) {
      this.token = null;
      throw new DriveAuthError('Google Drive session expired');
    }
    if (!response.ok) throw new Error(`Google Drive request failed (${response.status})`);
    return response;
  }

  async findFile() {
    const params = new URLSearchParams({
      q: `name='${FILE_NAME}' and trashed=false`,
      spaces: 'drive',
      orderBy: 'modifiedTime desc',
      fields: 'files(id,modifiedTime)',
      pageSize: '1',
    });
    const data = await (await this.request(`${API}?${params}`)).json();
    return data.files?.[0]?.id || null;
  }

  /** Returns the parsed trip JSON stored in Drive, or null if none exists yet. */
  async load() {
    this.fileId = this.fileId || await this.findFile();
    if (!this.fileId) return null;
    const response = await this.request(`${API}/${encodeURIComponent(this.fileId)}?alt=media`);
    return response.json();
  }

  async save(state) {
    const body = JSON.stringify(state);
    this.fileId = this.fileId || await this.findFile();
    if (this.fileId) {
      await this.request(`${UPLOAD_API}/${encodeURIComponent(this.fileId)}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return;
    }
    const boundary = `ekko${Math.random().toString(36).slice(2)}`;
    const metadata = { name: FILE_NAME, mimeType: 'application/json' };
    const multipart = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      body,
      `--${boundary}--`,
    ].join('\r\n');
    const response = await this.request(`${UPLOAD_API}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    this.fileId = (await response.json()).id;
  }
}
