import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const block = src.match(/\/\*SHARELINK-START\*\/([\s\S]*?)\/\*SHARELINK-END\*\//);
assert.ok(block, 'the SHARELINK block is missing from dink-score.html');
const ShareLink = new Function(block[1] + '\nreturn ShareLink;')();
// The vendored qrcode-generator script, loaded the way the page loads it.
const lib = src.match(/<script>\s*\/\* qrcode-generator[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g, '');
const qrcode = new Function(lib + '\nreturn qrcode;')();

test('join link carries the cleaned code on the given origin', () => {
  assert.equal(ShareLink.join('https://dinkscore.vercel.app', 'abc 123'), 'https://dinkscore.vercel.app/?club=ABC123');
  assert.equal(ShareLink.join('https://dinkscore.vercel.app/', 'K7Q2ZM'), 'https://dinkscore.vercel.app/?club=K7Q2ZM');
  assert.equal(ShareLink.join('https://x.test', ''), '');
  assert.equal(ShareLink.join('https://x.test', undefined), '');
});

test('fromSearch reads the code back out of a join link', () => {
  const link = new URL(ShareLink.join('https://dinkscore.vercel.app', 'K7Q2ZM'));
  assert.equal(ShareLink.fromSearch(link.search), 'K7Q2ZM');
  assert.equal(ShareLink.fromSearch('?club=k7q-2zm&x=1'), 'K7Q2ZM');
  assert.equal(ShareLink.fromSearch('?display=ABC123'), '');
  assert.equal(ShareLink.fromSearch(''), '');
});

test('QR is an inline svg of dark squares; different links give different codes; no network references', () => {
  const a = ShareLink.qrSvg(qrcode, ShareLink.join('https://dinkscore.vercel.app', 'K7Q2ZM'));
  const b = ShareLink.qrSvg(qrcode, ShareLink.join('https://dinkscore.vercel.app', 'K7Q2ZN'));
  assert.match(a, /^<svg[^>]*viewBox/);
  assert.ok((a.match(/<rect/g) || []).length > 100 || /<path/.test(a), 'has modules');
  assert.notEqual(a, b);
  assert.doesNotMatch(a, /https?:\/\/(?!www\.w3\.org)/);
});
