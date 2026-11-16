// Fetching a Google Sheet as CSV for the event importer, without a Google login or key: the sheet has to be shared as
// "Anyone with the link can view" (or published to the web). This is the only place the server fetches a URL that an
// organizer influenced, so it is strict:
//   - only https://docs.google.com/spreadsheets/d/<id>/... links are accepted, and only the sheet id and tab (gid) are
//     taken from them. The address that is fetched is built here from those two values, never the link itself;
//   - redirects are followed by hand, a few hops at most, and each one must stay on docs.google.com or
//     *.googleusercontent.com over https (no credentials, no port, no other host);
//   - at most 512 KB and 8 seconds, no cookies or credentials, and the answer must be CSV.
// fetchImpl is injectable so tests never call Google.
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export const MAX_BYTES = 512 * 1024;
export const TIMEOUT_MS = 8000;
const MAX_HOPS = 4;
const ID = /^[A-Za-z0-9_-]{20,120}$/;
const NOT_SHARED = 'Google did not let us read that sheet. In Google Sheets choose Share, then General access: Anyone with the link, Viewer, and try again. A sheet published to the web works too.';
const NOT_SHEET = 'That is not a Google Sheets link. Paste the address of the sheet, like https://docs.google.com/spreadsheets/d/…/edit.';

// A link -> the CSV address to fetch, or an error. The only thing kept from the link is the id and the tab number.
export function sheetCsvUrl(link) {
  if (typeof link !== 'string') throw bad(NOT_SHEET);
  const text = link.trim();
  if (!text || text.length > 2000) throw bad(NOT_SHEET);
  let u;
  try { u = new URL(text); } catch { throw bad(NOT_SHEET); }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || u.username || u.password || u.port) throw bad(NOT_SHEET);
  // /spreadsheets/d/<id>/edit, or a published link: /spreadsheets/d/e/<publish id>/pub...
  const m = u.pathname.match(/^\/spreadsheets\/d\/(e\/)?([^/]+)(?:\/|$)/);
  if (!m || !ID.test(m[2])) throw bad(NOT_SHEET);
  const gid = (u.searchParams.get('gid') || new URLSearchParams(u.hash.replace(/^#/, '')).get('gid') || '').trim();
  if (gid && !/^[0-9]{1,12}$/.test(gid)) throw bad(NOT_SHEET);
  const tab = gid ? `&gid=${gid}` : '';
  return m[1] ? `https://docs.google.com/spreadsheets/d/e/${m[2]}/pub?output=csv${tab}&single=true` : `https://docs.google.com/spreadsheets/d/${m[2]}/export?format=csv${tab}`;
}

// Where a redirect may go: Google's own sheet hosts, over https, and nothing else.
export function allowedHop(href) {
  let u;
  try { u = new URL(href); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  return h === 'docs.google.com' || h === 'googleusercontent.com' || h.endsWith('.googleusercontent.com');
}

async function readCapped(res, controller) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) { controller.abort(); throw bad('That sheet is too large. Keep it under 512 KB.'); }
  const chunks = [];
  let total = 0;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { controller.abort(); try { await reader.cancel(); } catch {} throw bad('That sheet is too large. Keep it under 512 KB.'); }
      chunks.push(value);
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw bad('That sheet is too large. Keep it under 512 KB.');
    chunks.push(buf);
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder('utf-8').decode(all).replace(/^﻿/, '');
}

export async function fetchSheetCsv(link, fetchImpl = (...a) => globalThis.fetch(...a)) {
  let url = sheetCsvUrl(link);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { Accept: 'text/csv' } });
      } catch (err) {
        if (err && err.status) throw err;
        throw bad(controller.signal.aborted ? 'Google took too long to answer. Try again.' : 'Could not reach Google Sheets. Try again.', 502);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        let next = null;
        try { next = loc ? new URL(loc, url).href : null; } catch {}
        if (hop >= MAX_HOPS || !next || !allowedHop(next)) throw bad(NOT_SHARED, 422); // a sign-in page is the usual reason. 422, not 403: the app treats 403 as a wrong organizer PIN
        url = next;
        continue;
      }
      if (res.status === 404) throw bad('Google could not find that sheet. Check the link.', 404);
      if (res.status === 401 || res.status === 403) throw bad(NOT_SHARED, 422);
      if (res.status !== 200) throw bad(`Google answered with an error (${res.status}). Check the link and the sharing setting.`, 502);
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      if (!type.startsWith('text/csv')) throw bad(type.startsWith('text/html') ? NOT_SHARED : NOT_SHEET, type.startsWith('text/html') ? 422 : 400);
      let text;
      try { text = await readCapped(res, controller); }
      catch (err) { if (err && err.status) throw err; throw bad(controller.signal.aborted ? 'Google took too long to answer. Try again.' : 'Could not read that sheet. Try again.', 502); }
      if (!text.trim()) throw bad('That sheet is empty.');
      return text;
    }
  } finally { clearTimeout(timer); }
}
