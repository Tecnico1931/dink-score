// Dev-only accessibility audit, never shipped and not run in CI (needs a local Chrome).
//   npm i --no-save puppeteer-core axe-core && node tools/a11y-check.mjs
// Starts tools/serve.cjs, then in each app state runs axe-core (WCAG 2.x A/AA + best practice) and two checks axe
// does not make: interactive controls under 44 px, and visible text under 12 px.
// Env: CHROME=/path/to/chrome, A11Y_PORT=4199. Exit 1 if anything is reported.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const axeSrc = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome found; set CHROME=/path/to/chrome'); process.exit(2); }
const port = process.env.A11Y_PORT || 4199, base = `http://127.0.0.1:${port}/`;
const srv = spawn('node', ['tools/serve.cjs', port], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXTRA = scope => {
  const root = (scope && document.querySelector(scope)) || document, out = [], vis = el => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0; };
  const name = el => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  for (const el of root.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], summary')) {
    if (!vis(el) || el.closest('[inert],[hidden]')) continue;
    if (el.matches('a') && el.closest('p, li') && getComputedStyle(el).display === 'inline') continue; // WCAG 2.5.8 inline exception
    const r = el.getBoundingClientRect();
    if (r.width < 44 - .5 || r.height < 44 - .5) out.push({ kind: 'target', name: name(el), w: Math.round(r.width), h: Math.round(r.height) });
  }
  const seen = new Set();
  for (const el of root.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (own && px < 12 && !el.closest('svg')) { const k = el.className + '|' + px; if (!seen.has(k)) { seen.add(k); out.push({ kind: 'text', name: name(el), px }); } }
  }
  return out;
};
async function audit(page, label, report, scope) {
  await page.evaluate(axeSrc);
  const ax = await page.evaluate(async scope => { const r = await axe.run((scope && document.querySelector(scope)) || document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }); return r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 3).map(n => n.target.join(' ') + ' :: ' + (n.any[0] || n.all[0] || n.none[0] || {}).message) })); }, scope);
  const extra = await page.evaluate(EXTRA, scope);
  report.push({ label, axe: ax, extra });
}
const states = [['light', { colorScheme: 'light' }], ['dark', { colorScheme: 'dark' }], ['outdoor', { colorScheme: 'light', outdoor: true }]];
const report = [];
for (const [mode, opt] of states) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opt.colorScheme }]);
  await page.evaluateOnNewDocument(o => { try { if (o) localStorage.setItem('pb.display', JSON.stringify({ outdoor: 1, large: 1 })); } catch {} }, opt.outdoor);
  await page.goto(base, { waitUntil: 'networkidle0' }); await sleep(400);
  await audit(page, `${mode}: first-run tour`, report, '.tour');
  await page.evaluate(() => localStorage.setItem('pb.tutorialSeen', 'true')); await page.reload({ waitUntil: 'networkidle0' }); await sleep(300);
  await audit(page, `${mode}: home`, report);
  for (const tab of ['leaders', 'history', 'rules']) { await page.click(`[data-tab="${tab}"]`); await sleep(250); await audit(page, `${mode}: ${tab}`, report); }
  await page.click('[data-tab="play"]'); await sleep(200);
  if (await page.$('[data-act="me-open"]')) { await page.click('[data-act="me-open"]'); await sleep(300); await audit(page, `${mode}: profile sheet`, report); await page.keyboard.press('Escape'); await sleep(200); if (await page.$('.sheet-bg')) await page.evaluate(() => document.querySelector('.sheet-bg')?.click()); await sleep(200); }
  if (await page.$('[data-act="start"]')) { for (const [i, n] of ['Ana', 'Ben', 'Cy', 'Di'].entries()) await page.type(`#name-${i >> 1}-${i & 1}`, n);
    await page.click('[data-act="start"]'); await sleep(500); await audit(page, `${mode}: court`, report, '.court');
    if (await page.$('.half')) { for (let i = 0; i < 3; i++) { await page.click('.half[data-k="a"]'); await sleep(150); } await audit(page, `${mode}: court after rallies`, report, '.court'); } }
  // Sheets over the court: leave-game, then the winner sheet once team 1 wins.
  if (await page.$('.half')) {
    await page.click('[data-act="end"]'); await sleep(250); await audit(page, `${mode}: leave-game sheet`, report, '.sheet');
    await page.click('[data-act="keep"]'); await sleep(200);
    for (let i = 0; i < 30 && !(await page.$('.sheet h2')); i++) { await page.click('.half[data-k="a"]'); await sleep(60); }
    await sleep(300);
    const f = await page.evaluate(() => document.activeElement && (document.activeElement.closest('.sheet') ? 'sheet' : document.activeElement.tagName));
    if (f !== 'sheet') report.push({ label: `${mode}: winner sheet focus`, axe: [], extra: [{ kind: 'text', name: 'focus not inside the winner sheet: ' + f, px: 0 }] });
    await audit(page, `${mode}: winner sheet`, report, '.sheet');
    await page.click('[data-act="finish"]'); await sleep(300);
  }
  // Sheets from home: join a club, log a result.
  for (const [act, label] of [['club-open', 'club sheet'], ['log-open', 'log sheet']]) {
    if (await page.$(`[data-act="${act}"]`)) { await page.click(`[data-act="${act}"]`); await sleep(300); await audit(page, `${mode}: ${label}`, report, '.sheet'); await page.keyboard.press('Escape'); await sleep(200); }
  }
  // Reflow (WCAG 1.4.10): at 320 px and at 195 px (a 390 px phone zoomed to 200%) nothing may scroll sideways.
  for (const w of [320, 195]) {
    await page.setViewport({ width: w, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(250);
    const over = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !e.closest('[style*="overflow"],.tabs,svg') && getComputedStyle(e).position !== 'fixed'; }).slice(0, 3).map(e => e.outerHTML.slice(0, 90) + ' right=' + Math.round(e.getBoundingClientRect().right)));
    if (over.length) report.push({ label: `${mode}: reflow at ${w}px`, axe: [], extra: over.map(n => ({ kind: 'text', name: 'overflows sideways: ' + n, px: 0 })) });
  }
  await ctx.close();
}
{ // The public bracket page's shell (its data needs a live share token, so only the page chrome is checked here).
  const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(base + 'b.html', { waitUntil: 'networkidle0' }); await sleep(300); await audit(page, 'public bracket page (shell)', report); await ctx.close();
}
{ // A watch's QR or a game link opened with no club on this phone (Safari): the one-game link sheet, both ways in, at phone width and zoomed.
  const id = '0123456789abcdef0123456789abcdef';
  for (const [label, hash] of [['watch link, no club', `#watch=${id}.0420`], ['game link, no club', `#game=${id}`]]) {
    const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
    await page.goto(base + hash, { waitUntil: 'networkidle0' }); await sleep(500);
    if (!(await page.$('[data-form="watch-game"]'))) report.push({ label, axe: [], extra: [{ kind: 'text', name: 'the one-game link sheet did not open', px: 0 }] });
    else {
      await audit(page, label, report, '.sheet');
      for (const w of [320, 195]) {
        await page.setViewport({ width: w, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(250);
        const over = await page.evaluate(() => [...document.querySelectorAll('.sheet *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(e => e.tagName + '.' + e.className).slice(0, 3));
        if (over.length) report.push({ label: `${label}: reflow at ${w}px`, axe: [], extra: over.map(n => ({ kind: 'text', name: 'overflows sideways: ' + n, px: 0 })) });
      }
    }
    await ctx.close();
  }
}
{ // The scoring screen of a game shared from a club phone: the "Link a watch to this game" button (stubbed club, nothing is sent).
  for (const colorScheme of ['light', 'dark']) {
    const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: colorScheme }]);
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pb.tutorialSeen', 'true'); } catch {} });
    await page.goto(base, { waitUntil: 'networkidle0' }); await sleep(400);
    for (const [i, n] of ['Ana', 'Ben', 'Cy', 'Di'].entries()) await page.type(`#name-${i >> 1}-${i & 1}`, n);
    await page.click('[data-act="start"]'); await sleep(400);
    await page.evaluate(() => { club = { code: 'ABC123', name: 'Check club' }; live.shared = true; live.id = 'live-1'; renderCourt(); });
    if (!(await page.$('[data-act="watch-court"]'))) report.push({ label: `court with watch button (${colorScheme})`, axe: [], extra: [{ kind: 'text', name: 'the Link a watch button is missing', px: 0 }] });
    else {
      await audit(page, `court with watch button (${colorScheme})`, report, '.court');
      for (const w of [320]) { // the call row itself is wider than a 195 px screen (it was before the button), so only 320 px is held to this
        await page.setViewport({ width: w, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(250);
        const over = await page.evaluate(() => [...document.querySelectorAll('.watch-chip')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(e => e.tagName + '.' + e.className).slice(0, 3));
        if (over.length) report.push({ label: `court with watch button: reflow at ${w}px`, axe: [], extra: over.map(n => ({ kind: 'text', name: 'overflows sideways: ' + n, px: 0 })) });
      }
    }
    await ctx.close();
  }
}
await browser.close(); srv.kill();
let bad = 0;
for (const r of report) {
  console.log(`\n== ${r.label}`);
  for (const v of r.axe) { bad++; console.log(`  axe ${v.impact} ${v.id} x${v.n}`); v.ex.forEach(e => console.log('     ' + e)); }
  const t = r.extra.filter(e => e.kind === 'target'), x = r.extra.filter(e => e.kind === 'text');
  bad += t.length + x.length;
  t.forEach(e => console.log(`  target ${e.w}x${e.h} ${e.name}`)); x.forEach(e => console.log(e.px ? `  text ${e.px}px ${e.name}` : `  ${e.name}`));
  if (!r.axe.length && !r.extra.length) console.log('  clean');
}
process.exit(bad ? 1 : 0);
