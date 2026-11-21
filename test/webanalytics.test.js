import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = f => fs.readFileSync(fileURLToPath(new URL(f, root)), 'utf8');

// Run analytics.js the way a page does, in a sandbox with a fake window.
function load(nav = {}) {
  const win = { navigator: nav, location: { href: 'https://dink.example/' }, URL };
  win.window = win;
  vm.runInNewContext(read('analytics.js'), win);
  return win;
}
const BASE = 'https://dink.example/';

test('the URL scrubber removes query, hash and share tokens', () => {
  const { scrubUrl } = load().dinkAnalytics;
  assert.equal(scrubUrl('https://dink.example/?display=ABCD23#club=XYZ', BASE), 'https://dink.example/');
  assert.equal(scrubUrl('https://dink.example/b/SeCrEtToKeN123?x=1#y', BASE), 'https://dink.example/b/[token]');
  assert.equal(scrubUrl('https://dink.example/l/SeCrEtToKeN123', BASE), 'https://dink.example/l/[token]');
  assert.equal(scrubUrl('https://dink.example/r/SeCrEtToKeN123/card.png', BASE), 'https://dink.example/r/[token]');
  assert.equal(scrubUrl('https://dink.example/privacy?a=b', BASE), 'https://dink.example/privacy');
  assert.equal(scrubUrl('https://dink.example/anything/ELSE/CLUB42', BASE), 'https://dink.example/');
  assert.equal(scrubUrl('/b/tok', BASE), 'https://dink.example/b/[token]');
  assert.equal(scrubUrl('javascript:alert(1)', BASE), null);
  for (const u of ['https://dink.example/b/SeCrEtToKeN123?x=1#y', 'https://dink.example/?display=ABCD23#t=1']) {
    assert.ok(!/SeCrEtToKeN|ABCD23|[?#]/.test(scrubUrl(u, BASE)));
  }
});

test('only masked page views are sent; custom events are dropped', () => {
  const { beforeSend } = load().dinkAnalytics;
  assert.deepEqual({ ...beforeSend({ type: 'pageview', url: 'https://dink.example/l/tok?a=1#b' }, {}, {}, BASE) }, { type: 'pageview', url: 'https://dink.example/l/[token]' });
  assert.equal(beforeSend({ type: 'event', url: 'https://dink.example/', name: 'x', data: { club: 'ABCD' } }, {}, {}, BASE), null);
  assert.equal(beforeSend(null, {}, {}, BASE), null);
});

test('Do Not Track and Global Privacy Control send nothing', () => {
  const ev = { type: 'pageview', url: 'https://dink.example/' };
  const { beforeSend } = load().dinkAnalytics;
  assert.ok(beforeSend(ev, {}, {}, BASE));
  assert.equal(beforeSend(ev, { doNotTrack: '1' }, {}, BASE), null);
  assert.equal(beforeSend(ev, {}, { doNotTrack: '1' }, BASE), null);
  assert.equal(beforeSend(ev, { msDoNotTrack: '1' }, {}, BASE), null);
  assert.equal(beforeSend(ev, { globalPrivacyControl: true }, {}, BASE), null);
});

test('the page registers the filter on the queue before the script loads, and the real script gets the same function', () => {
  const w = load({ globalPrivacyControl: true });
  assert.equal(w.vaq.length, 1);
  assert.equal(w.vaq[0][0], 'beforeSend');
  assert.equal(w.vaq[0][1]({ type: 'pageview', url: 'https://dink.example/' }), null, 'opted out via the navigator');
  const ok = load();
  assert.equal(ok.vaq[0][1]({ type: 'pageview', url: 'https://dink.example/b/tok#h' }).url, 'https://dink.example/b/[token]');
});

test('every page that loads the insights script loads the filter first, and nothing else', () => {
  const pages = { 'build.cjs (app)': read('build.cjs'), 'bracket-public.html': read('bracket-public.html'), 'league-public.html': read('league-public.html'), 'api/_result.js': read('api/_result.js') };
  for (const [name, src] of Object.entries(pages)) {
    const a = src.indexOf('src="/analytics.js"'), b = src.indexOf('src="/_vercel/insights/script.js"');
    assert.ok(a > -1 && b > a, name + ': analytics.js must come before the insights script');
    assert.equal(src.split('_vercel/insights').length - 1, 1, name + ': one insights script only');
  }
  for (const f of ['index.html', 'b.html', 'l.html']) {
    const html = read(f);
    assert.ok(html.indexOf('src="/analytics.js"') > -1 && html.indexOf('src="/analytics.js"') < html.indexOf('/_vercel/insights/script.js'), f);
  }
});

test('the CSP names no third-party host for scripts or beacons, and the script route is same-origin', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const csp = vercel.headers.flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy').value;
  const dir = n => csp.split(';').map(s => s.trim()).find(s => s.startsWith(n + ' '));
  for (const n of ['script-src', 'connect-src', 'default-src']) assert.ok(!/https?:\/\/|\*/.test(dir(n)), n + ' has a host: ' + dir(n));
  assert.ok(dir('script-src').split(' ').includes("'self'"));
  assert.ok(!/vercel-scripts|vercel-insights|va\.vercel/.test(csp));
  assert.ok(!read('index.html').match(/https?:\/\/[^\s"']*vercel[^\s"']*script/));
});

test('the service worker keeps the analytics route out of its cache and ships the filter offline', () => {
  const sw = read('sw.js');
  assert.match(sw, /startsWith\("\/_vercel\/"\)\) return/);
  assert.match(sw, /SHELL = \[[^\]]*'analytics\.js'/);
  assert.ok(fs.existsSync(fileURLToPath(new URL('public/analytics.js', root))), 'build copies analytics.js to public/');
});

test('the privacy page describes the page-view counter honestly', () => {
  const p = read('privacy.html');
  assert.match(p, /Vercel Web Analytics/);
  assert.match(p, /no cookies/i);
  assert.match(p, /Do Not Track/);
  assert.match(p, /share link/);
  assert.match(p, /does not receive player names/);
});
