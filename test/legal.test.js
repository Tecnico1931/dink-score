import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(root, f), 'utf8');

test('no page, script or header contacts Google Fonts', () => {
  for (const f of ['dink-score.html', 'bracket-public.html', 'build.cjs', 'sw.js', 'vercel.json', 'privacy.html', 'terms.html', 'legal.css'].concat(existsSync(path.join(root, 'index.html')) ? ['index.html', 'b.html'] : [])) {
    const t = read(f).replace(/Fonts are served from Dink Score itself; the page does not contact Google Fonts\./, '');
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(t), `${f} still references Google Fonts`);
  }
});

test('self-hosted font files exist for every @font-face url', () => {
  const css = read('fonts/fonts.css');
  const urls = [...css.matchAll(/url\(\/fonts\/([^)]+)\)/g)].map(m => m[1]);
  assert.ok(urls.length >= 4);
  for (const u of urls) assert.ok(readdirSync(path.join(root, 'fonts')).includes(u), `missing fonts/${u}`);
});

test('pages that load fonts link the self-hosted stylesheet', () => {
  for (const f of ['dink-score.html', 'bracket-public.html']) assert.match(read(f), /href="\/fonts\/fonts\.css"/);
});

test('privacy and terms are marked as drafts and cross-linked, and are routed', () => {
  for (const f of ['privacy.html', 'terms.html']) assert.match(read(f), /Draft for review[\s\S]*not legal advice/);
  assert.match(read('privacy.html'), /href="\/terms"/);
  assert.match(read('terms.html'), /href="\/privacy"/);
  const v = JSON.parse(read('vercel.json'));
  const dest = src => (v.rewrites.find(r => r.source === src) || {}).destination;
  assert.equal(dest('/privacy'), '/privacy.html');
  assert.equal(dest('/terms'), '/terms.html');
});

test('privacy note names every processor and the policy covers minors', () => {
  const p = read('privacy.html');
  for (const w of ['Vercel', 'Neon', 'DUPR', 'Google Sheet', 'Young players']) assert.ok(p.includes(w), `privacy.html lacks ${w}`);
  assert.match(read('terms.html'), /Young players/);
});

test('the app links to privacy and terms from the club sheet and the Rules tab', () => {
  const a = read('dink-score.html');
  assert.ok((a.match(/href="\/privacy"/g) || []).length >= 2);
  assert.ok((a.match(/href="\/terms"/g) || []).length >= 2);
});

test('service worker never serves the app shell for the legal pages', () => {
  assert.match(read('sw.js'), /privacy\|terms/);
});

test('security policy, security.txt and dependabot are present', () => {
  assert.match(read('SECURITY.md'), /security\/advisories\/new/);
  assert.match(read('.well-known/security.txt'), /^Contact: /m);
  assert.match(read('.github/dependabot.yml'), /package-ecosystem: npm/);
});
