// Google sign-in + Google Photos Picker API.
// Docs: https://developers.google.com/photos/picker
import { CONFIG } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const API = 'https://photospicker.googleapis.com/v1';
let token = null;
let tokenExpires = 0;
let tokenClient = null;

export const isConfigured = () => !!CONFIG.googleClientId;
export const isSignedIn = () => !!token && Date.now() < tokenExpires;

function loadScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in. Check your connection.'));
    document.head.appendChild(s);
  });
}

// Call on page load so signIn() can open its popup directly from a click.
export async function prepare() {
  await loadScript();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.googleClientId,
    scope: SCOPE,
    callback: () => {},
  });
}

export function signIn() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error('Google sign-in is still loading. Try again in a moment.'));
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error_description || r.error));
      token = r.access_token;
      tokenExpires = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
      resolve();
    };
    tokenClient.error_callback = (e) => reject(new Error(e?.message || e?.type || 'Sign-in was cancelled.'));
    // Always show the account chooser so each partner can sign in with their own account.
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  });
}

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Google Photos error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

const seconds = (s, dflt) => (s ? parseFloat(String(s)) * 1000 : dflt);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a Google Photos picking session, opens Google's picker (in `win`, a
 * window opened synchronously from the click so popup blockers allow it, or via
 * the link handed to `onLink` when no window could be opened), waits for the
 * user to tap Done, and returns the picked items.
 * The picker may open in the Google Photos app on phones and the browser window
 * may close right away, so a closed window is NOT treated as "cancelled" — only
 * the `signal` (Cancel button) or Google's own timeout ends the wait.
 */
export async function pick(win, onStatus, { signal, onLink } = {}) {
  const session = await api('POST', '/sessions', { pickingConfig: { maxItemCount: '2000' } });
  try {
    const uri = session.pickerUri + '/autoclose';
    if (win && !win.closed) {
      win.location.href = uri;
      onStatus('Waiting for you to tap Done in Google Photos… (this page keeps waiting, even if Google Photos opens in its app)');
    } else {
      onLink?.(uri); // popup blocked: show a link instead
    }
    const interval = seconds(session.pollingConfig?.pollInterval, 4000);
    const deadline = Date.now() + seconds(session.pollingConfig?.timeoutIn, 30 * 60 * 1000);
    let s = session;
    while (!s.mediaItemsSet) {
      if (signal?.aborted) throw new Error('Picking cancelled.');
      if (Date.now() > deadline) throw new Error('The Google Photos picker timed out. Please try again.');
      await wait(Math.max(1500, interval));
      if (signal?.aborted) throw new Error('Picking cancelled.');
      s = await api('GET', `/sessions/${session.id}`);
    }
    onStatus('Getting the list of photos you picked…');
    const items = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ sessionId: session.id, pageSize: '100' });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await api('GET', `/mediaItems?${q}`);
      items.push(...(page.mediaItems || []));
      pageToken = page.nextPageToken || '';
      onStatus(`Found ${items.length} items…`);
    } while (pageToken);
    const photos = items.filter((i) => i.type !== 'VIDEO');
    return { sessionId: session.id, items: photos, videos: items.length - photos.length };
  } catch (e) {
    endSession(session.id);
    throw e;
  }
}

// Download a resized copy (the picker's links expire after about an hour).
export async function download(item, maxSide = 1600) {
  const r = await fetch(`${item.mediaFile.baseUrl}=w${maxSide}-h${maxSide}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return r.blob();
}

export async function endSession(id) {
  try { await api('DELETE', `/sessions/${id}`); } catch { /* best effort */ }
}
