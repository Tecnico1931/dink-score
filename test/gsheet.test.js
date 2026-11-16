import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetCsvUrl, allowedHop, fetchSheetCsv, MAX_BYTES } from '../api/_gsheet.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBcD';
const CSV = 'Player,Team\r\nAna,Ninjas\r\n';
const resp = (status, { type = 'text/csv; charset=utf-8', body = CSV, headers = {} } = {}) => ({ status, headers: { get: k => ({ 'content-type': type, ...headers })[k.toLowerCase()] ?? null }, body: body === null ? null : new Response(body).body, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
const status = async p => { try { await p; return 200; } catch (e) { return e.status; } };

test('a sheet link becomes the CSV export address, rebuilt from the id and tab only', () => {
  const want = `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`;
  assert.equal(sheetCsvUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit`), want);
  assert.equal(sheetCsvUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`), want);
  assert.equal(sheetCsvUrl(`  https://docs.google.com/spreadsheets/d/${ID}  `), want);
  assert.equal(sheetCsvUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=12345`), want + '&gid=12345');
  assert.equal(sheetCsvUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=7#gid=12345`), want + '&gid=7');
  assert.equal(sheetCsvUrl(`https://docs.google.com/spreadsheets/d/e/2PACX-${ID}/pubhtml?gid=9`), `https://docs.google.com/spreadsheets/d/e/2PACX-${ID}/pub?output=csv&gid=9&single=true`);
  // nothing else from the link survives
  assert.ok(!sheetCsvUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?foo=bar&redirect=https://evil.com`).includes('evil'));
});

test('only https docs.google.com spreadsheet links are accepted', () => {
  const bad = [
    undefined, null, '', 'not a url', `docs.google.com/spreadsheets/d/${ID}/edit`,
    `http://docs.google.com/spreadsheets/d/${ID}/edit`,                   // wrong scheme
    `ftp://docs.google.com/spreadsheets/d/${ID}/edit`, `file:///spreadsheets/d/${ID}`, `javascript:alert(1)//docs.google.com/spreadsheets/d/${ID}`,
    `https://evil.com/spreadsheets/d/${ID}/edit`,                         // other host
    `https://docs.google.com.evil.com/spreadsheets/d/${ID}/edit`,         // lookalike host
    `https://evildocs.google.com/spreadsheets/d/${ID}/edit`, `https://sub.docs.google.com/spreadsheets/d/${ID}/edit`, `https://docs-google.com/spreadsheets/d/${ID}/edit`,
    `https://docs.google.com@evil.com/spreadsheets/d/${ID}/edit`,         // user-info trick
    `https://evil.com@docs.google.com/spreadsheets/d/${ID}/edit`, `https://user:pw@docs.google.com/spreadsheets/d/${ID}/edit`,
    `https://docs.google.com:8443/spreadsheets/d/${ID}/edit`, `https://docs.google.com./spreadsheets/d/${ID}/edit`,
    `https://docs.google.com/document/d/${ID}/edit`, `https://docs.google.com/forms/d/${ID}/edit`, // not a sheet
    `https://docs.google.com/spreadsheets/`, `https://docs.google.com/spreadsheets/d/`, `https://docs.google.com/spreadsheets/d/short/edit`,
    `https://docs.google.com/spreadsheets/d/${ID}%2F..%2F..%2Fx/edit`, `https://docs.google.com/spreadsheets/d/${ID}.evil/edit`, `https://docs.google.com/spreadsheets/d/../${ID}`,
    `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=abc`, `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=1%0d%0aHost:evil`, `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1/../../`,
    `https://drive.google.com/spreadsheets/d/${ID}/edit`, `https://docs.googleusercontent.com/spreadsheets/d/${ID}/edit`, 'https://docs.google.com/spreadsheets/d/' + 'a'.repeat(3000),
    ['https://docs.google.com/spreadsheets/d/' + ID], { toString: () => 'https://evil.com' }
  ];
  for (const b of bad) {
    let threw = null;
    try { sheetCsvUrl(b); } catch (e) { threw = e; }
    assert.ok(threw && threw.status === 400, `accepted ${String(b).slice(0, 80)}`);
  }
});

test('redirects may only go to Google over https', () => {
  for (const ok of ['https://docs.google.com/x', 'https://doc-0k-9c-sheets.googleusercontent.com/export/abc', 'https://googleusercontent.com/x']) assert.ok(allowedHop(ok), ok);
  for (const no of ['http://docs.google.com/x', 'https://accounts.google.com/ServiceLogin', 'https://evil.com/', 'https://googleusercontent.com.evil.com/', 'https://evilgoogleusercontent.com/', 'https://x.googleusercontent.com@evil.com/',
    'https://user@docs.google.com/x', 'https://docs.google.com:444/x', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'gopher://docs.google.com/', '', 'not a url']) assert.equal(allowedHop(no), false, no);
});

test('fetch: follows Google redirects by hand, sends no cookies, and returns the CSV', async () => {
  const seen = [];
  const f = async (url, opts) => {
    seen.push([url, opts]);
    if (seen.length === 1) return resp(307, { headers: { location: 'https://doc-0k-9c-sheets.googleusercontent.com/export/abc?x=1' } });
    return resp(200);
  };
  const text = await fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=5`, f);
  assert.equal(text, CSV);
  assert.equal(seen[0][0], `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=5`);
  assert.equal(seen[1][0], 'https://doc-0k-9c-sheets.googleusercontent.com/export/abc?x=1');
  for (const [, o] of seen) { assert.equal(o.redirect, 'manual'); assert.equal(o.credentials, 'omit'); assert.ok(o.signal); assert.deepEqual(Object.keys(o.headers), ['Accept']); }
});

test('fetch: a redirect off Google (or to http, or to a sign-in page) is refused and never followed', async () => {
  for (const loc of ['https://evil.com/steal', 'http://docs.google.com/x', 'https://accounts.google.com/ServiceLogin?continue=x', 'https://169.254.169.254/', 'https://docs.google.com.evil.com/', '//evil.com/x']) {
    let calls = 0;
    const f = async () => { calls++; return resp(302, { headers: { location: loc } }); };
    const err = await fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, f).catch(e => e);
    assert.ok(err.status === 422 || err.status === 400, loc + ' ' + err.message);
    assert.equal(calls, 1, loc); // the second address is never requested
  }
  let n = 0; // too many hops
  const loop = async () => { n++; return resp(302, { headers: { location: 'https://docs.google.com/spreadsheets/d/loop' } }); };
  assert.equal(await status(fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, loop)), 422);
  assert.ok(n <= 5);
  const noLoc = async () => resp(302);
  assert.equal(await status(fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, noLoc)), 422);
});

test('fetch: clear errors for not shared, not found, not a sheet, empty and too large', async () => {
  const url = `https://docs.google.com/spreadsheets/d/${ID}/edit`;
  const run = r => fetchSheetCsv(url, async () => r).catch(e => e);
  assert.match((await run(resp(403))).message, /Anyone with the link/);
  assert.match((await run(resp(401))).message, /Anyone with the link/);
  assert.match((await run(resp(200, { type: 'text/html; charset=utf-8', body: '<html>Sign in</html>' }))).message, /Anyone with the link/);
  assert.equal((await run(resp(404))).status, 404);
  assert.equal((await run(resp(500))).status, 502);
  assert.match((await run(resp(200, { type: 'application/json', body: '{}' }))).message, /not a Google Sheets link/);
  assert.match((await run(resp(200, { body: '   \r\n ' }))).message, /empty/);
  assert.match((await run(resp(200, { body: 'a'.repeat(MAX_BYTES + 1) }))).message, /too large/);
  assert.match((await run(resp(200, { headers: { 'content-length': String(MAX_BYTES + 1) }, body: 'x' }))).message, /too large/);
  assert.equal((await run(resp(200, { body: 'a'.repeat(MAX_BYTES) }))).length, MAX_BYTES); // exactly the cap is fine
  assert.equal(await fetchSheetCsv(url, async () => resp(200, { body: '﻿Player\nAna' })), 'Player\nAna'); // byte-order mark removed
});

test('fetch: gives up after 8 seconds and when the network fails', async () => {
  const t0 = Date.now();
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const mod = await import('../api/_gsheet.js');
  assert.equal(mod.TIMEOUT_MS, 8000);
  const real = setTimeout;
  // run the timer fast: swap the global for this call only
  globalThis.setTimeout = (fn, ms, ...a) => real(fn, ms === 8000 ? 20 : ms, ...a);
  try {
    const err = await fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, hang).catch(e => e);
    assert.equal(err.status, 502); assert.match(err.message, /too long/);
  } finally { globalThis.setTimeout = real; }
  assert.ok(Date.now() - t0 < 2000);
  const down = await fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, async () => { throw new Error('ECONNRESET'); }).catch(e => e);
  assert.equal(down.status, 502);
  assert.ok(!/ECONNRESET/.test(down.message)); // network details do not leak
});
