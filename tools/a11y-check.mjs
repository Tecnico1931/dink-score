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
  await page.evaluate(() => localStorage.setItem('pb.tutorialSeen', 'true')); await page.evaluate(() => localStorage.setItem('pb.newsSeen', '"2026-11-22"')); await page.reload({ waitUntil: 'networkidle0' }); await sleep(300);
  await audit(page, `${mode}: home`, report);
  for (const tab of ['leaders', 'history', 'rules']) { await page.click(`[data-tab="${tab}"]`); await sleep(250); await audit(page, `${mode}: ${tab}`, report); }
  await page.click('[data-tab="play"]'); await sleep(200);
  if (await page.$('[data-act="me-open"]')) { await page.click('[data-act="me-open"]'); await sleep(300); await audit(page, `${mode}: profile sheet`, report); await page.keyboard.press('Escape'); await sleep(200); if (await page.$('.sheet-bg')) await page.evaluate(() => document.querySelector('.sheet-bg')?.click()); await sleep(200); }
  if (await page.$('[data-act="new-open"]')) { await page.click('[data-act="new-open"]'); await sleep(400); await audit(page, `${mode}: new game sheet`, report, '.sheet');
    for (const [i, n] of ['Ana', 'Ben', 'Cy', 'Di'].entries()) await page.type(`#name-${i >> 1}-${i & 1}`, n);
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
{ // The Events tab as an organizer: game nights, standings now, the event and league cards with Standings and TV (stubbed club and data, nothing is sent).
  for (const colorScheme of ['light', 'dark']) {
    const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: colorScheme }]);
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pb.tutorialSeen', 'true'); localStorage.setItem('pb.newsSeen', '"2026-11-22"'); } catch {} });
    await page.goto(base, { waitUntil: 'networkidle0' }); await sleep(400);
    await page.evaluate(() => {
      const now = Date.now(), H = 36e5, rows = [['Ana', 3, 0, 12], ['Ben', 2, 1, 4], ['Cy', 1, 2, -6]].map(([name, wins, losses, diff], i) => ({ rank: i + 1, name, played: wins + losses, wins, losses, diff, members: [name] }));
      club = { code: 'ABC123', name: 'Check club', hasPin: true }; owners[club.code] = 'a'.repeat(48);
      clubData = Object.assign({}, clubData, { code: club.code, nights: [{ id: 'n1', title: 'Friday open play', startsAt: now + 26 * H, location: 'West Park', cap: 12, status: 'open', counts: { in: 2, maybe: 1, out: 0 }, rsvps: { in: ['Ana', 'Ben'], maybe: ['Cy'], out: [] } }] });
      evSummary = [{ id: 'e1', name: 'Saturday round robin', format: 'roundrobin', partners: 'rotating', players: 8, courts: 2, status: 'live', stage: 'rounds', round: 2, rounds: 7 }, { id: 'e2', name: 'Club cup', format: 'single_elim', partners: 'fixed', players: 8, courts: 1, status: 'live', stage: 'knockout' }];
      Object.assign(evTab, { code: club.code, at: Date.now(), tokens: {}, arm: '', err: '', leagues: [{ id: 'l1', name: 'Tuesday league', season: 'Autumn', kind: 'league', divisions: 1, mode: 'doubles', entries: 4, status: 'live', week: 2, weeks: 3, results: 2 }],
        evd: { id: 'e1', name: 'Saturday round robin', format: 'roundrobin', partners: 'rotating', status: 'live', standings: rows }, lgd: { id: 'l1', name: 'Tuesday league', status: 'live', mode: 'doubles', divisions: [{ label: 'Division A' }], tables: [{ label: 'Division A', rows }] } });
      tab = 'events'; render();
    });
    await sleep(300);
    if (!(await page.$('[data-ev="tab-tv"]')) || !(await page.$('[data-lg="tab-tv"]')) || !(await page.$('[data-gn="new"]'))) report.push({ label: `events tab (${colorScheme})`, axe: [], extra: [{ kind: 'text', name: 'the Schedule a game night or TV button is missing', px: 0 }] });
    await audit(page, `events tab (${colorScheme})`, report);
    await page.evaluate(() => { evTab.arm = 'evente1'; render(); }); await sleep(200);
    await audit(page, `events tab, TV armed (${colorScheme})`, report);
    for (const w of colorScheme === 'light' ? [320, 195] : []) {
      await page.setViewport({ width: w, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(250);
      const over = await page.evaluate(() => [...document.querySelectorAll('#app *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !e.closest('.tabs,svg'); }).map(e => e.tagName.toLowerCase() + '.' + e.className).slice(0, 5));
      if (over.length) report.push({ label: `events tab: reflow at ${w}px`, axe: [], extra: over.map(n => ({ kind: 'text', name: 'overflows sideways: ' + n, px: 0 })) });
    }
    await ctx.close();
  }
}
{ // Rewards: the Your Dink card with a worn ring, and the Shop sheet (owned and unowned items), stubbed club and answers, nothing is sent.
  for (const colorScheme of ['light', 'dark']) {
    const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: colorScheme }]);
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pb.tutorialSeen', 'true'); localStorage.setItem('pb.newsSeen', '"2026-11-22"'); } catch {} });
    await page.goto(base, { waitUntil: 'networkidle0' }); await sleep(400);
    await page.evaluate(() => {
      club = { code: 'ABC123', name: 'Check club', hasPin: true, rewards: true, mysteryBox: true }; me[club.code] = { name: 'Ana', token: 't'.repeat(48) };
      const cat = [['frame-court', 'Court green ring', 6], ['frame-blue', 'Team blue ring', 8], ['frame-ink', 'Ink ring', 8], ['frame-double', 'Double ring', 15], ['paddle-court', 'Court green paddle', 6], ['paddle-blue', 'Team blue paddle', 8], ['paddle-ink', 'Ink paddle', 8], ['paddle-stripe', 'Striped paddle', 15]];
      const byId = Object.fromEntries(cat.map(([id, name, price]) => [id, { id, slot: id.split('-')[0], name, price }]));
      const box = { price: 7, duplicateRefund: 4, dailyLimit: 3, openedToday: 1, tiers: [
        { id: 'common', label: 'Common', chance: 55, items: ['frame-court', 'paddle-court'].map(k => byId[k]) },
        { id: 'uncommon', label: 'Uncommon', chance: 30, items: ['frame-blue', 'frame-ink', 'paddle-blue', 'paddle-ink'].map(k => byId[k]) },
        { id: 'rare', label: 'Rare', chance: 15, items: ['frame-double', 'paddle-stripe'].map(k => byId[k]) }
      ] };
      const shop = { dinks: 12, worn: { frame: 'frame-double', paddle: 'paddle-stripe' }, share: true, box, items: cat.map(([id, name, price]) => ({ id, slot: id.split('-')[0], name, price, owned: ['frame-double', 'paddle-stripe', 'frame-ink'].includes(id) })) };
      const looks = { ana: { frame: 'frame-double', paddle: 'paddle-stripe' }, ben: { frame: 'frame-court', paddle: 'paddle-blue' } };
      const pass = {
        season: { id: '2026-Q4', name: 'Fall 2026', start: 0, end: 1 }, games: 6, dinks: 12, worn: shop.worn, share: true, claimable: 2,
        tiers: [
          { tier: 1, games: 1, dinks: 2, payoutDinks: 2, item: null, unlocked: true, claimed: true },
          { tier: 2, games: 3, dinks: 3, payoutDinks: 3, item: null, unlocked: true, claimed: false },
          { tier: 3, games: 5, dinks: 2, payoutDinks: 2, item: { id: 'frame-court', slot: 'frame', name: 'Court green ring', price: 6, owned: false }, unlocked: true, claimed: false },
          { tier: 4, games: 8, dinks: 4, payoutDinks: 4, item: null, unlocked: false, claimed: false },
          { tier: 6, games: 15, dinks: 2, payoutDinks: 2, item: { id: 'paddle-court', slot: 'paddle', name: 'Court green paddle', price: 6, owned: false }, unlocked: false, claimed: false }
        ]
      };
      playerCall = async b => (b && b.action === 'rewards-looks' ? { looks } : b && b.action === 'rewards-pass' ? pass : shop);
      render();
    });
    await sleep(300);
    await audit(page, `Your Dink card, ring worn (${colorScheme})`, report);
    await page.evaluate(() => Rewards.openPass()); await sleep(400);
    await audit(page, `Season pass sheet (${colorScheme})`, report, '.sheet');
    if (colorScheme === 'light') {
      for (const w of [320, 195]) {
        await page.setViewport({ width: w, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(200);
        const over = await page.evaluate(() => [...document.querySelectorAll('.sheet *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(e => e.tagName + '.' + e.className).slice(0, 3));
        if (over.length) report.push({ label: `Season pass sheet: reflow at ${w}px`, axe: [], extra: over.map(n => ({ kind: 'text', name: 'overflows sideways: ' + n, px: 0 })) });
      }
      await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(150);
    }
    await page.evaluate(() => Rewards.openStore()); await sleep(400);
    await page.evaluate(() => {
      if (clubSheet && clubSheet.store) {
        clubSheet.boxResult = { openId: 'a11y0001', item: clubSheet.store.items[1], tier: { id: 'uncommon', label: 'Uncommon', chance: 30 }, duplicate: false, refund: 0, cost: 7, replayed: false };
        renderClub();
      }
    }); await sleep(200);
    await audit(page, `Shop sheet with mystery box (${colorScheme})`, report, '.sheet');
    if (colorScheme === 'light') {
      for (const w of [320, 195]) {
        await page.setViewport({ width: w, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(200);
        const over = await page.evaluate(() => [...document.querySelectorAll('.sheet .rw-box, .sheet .rw-box *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(e => e.tagName + '.' + e.className).slice(0, 3));
        if (over.length) report.push({ label: `Shop mystery box: reflow at ${w}px`, axe: [], extra: over.map(n => ({ kind: 'text', name: 'overflows sideways: ' + n, px: 0 })) });
      }
      await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(150);
    }
    // Shared club looks on leaderboard rows, game cards and profile header (scoped to the rendered components, plus reflow).
    await page.evaluate(() => {
      clubSheet = null; renderClub();
      const now = Date.now();
      clubData = Object.assign({}, clubData, { code: club.code, roster: ['Ana', 'Ben', 'Cy', 'Di'], players: ['Ana', 'Ben', 'Cy', 'Di'].map(n => ({ name: n, claimed: true })), games: [{ id: 'rwg1', mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, teams: [['Ana', 'Ben'], ['Cy', 'Di']], score: [11, 7], winner: 0, startedAt: now - 9e5, endedAt: now - 3e5, rallies: 24, scoredBy: 'ana' }] });
      Rewards.syncLooks(true);
      tab = 'leaders'; render();
    });
    await sleep(300);
    if (!(await page.$('.rows .avatar-mini[data-rw-frame="double"]')) || !(await page.$('.rows .rw-pad[data-rw-skin="stripe"]'))) report.push({ label: `Leaderboard shared looks (${colorScheme})`, axe: [], extra: [{ kind: 'text', name: 'shared ring or paddle badge missing on leaderboard', px: 0 }] });
    else await audit(page, `Leaderboard shared looks (${colorScheme})`, report, '.rows .prow-main');
    await page.evaluate(() => { clubSheet = { view: 'members', membersData: { members: [], audit: [], requests: [] } }; renderClub(); }); await sleep(250);
    if (!(await page.$('#sheet3 .mem-who .avatar-mini[data-rw-frame="double"]')) || !(await page.$('#sheet3 .mem-who .rw-pad[data-rw-skin="stripe"]'))) report.push({ label: `Roster shared looks (${colorScheme})`, axe: [], extra: [{ kind: 'text', name: 'shared ring or paddle badge missing on roster', px: 0 }] });
    else await audit(page, `Roster shared looks (${colorScheme})`, report, '#sheet3 .mem-who .avatar-mini');
    await page.evaluate(() => { clubSheet = null; renderClub(); tab = 'history'; render(); }); await sleep(250);
    if (!(await page.$('.game .rw-g-av[data-rw-frame="double"]')) || !(await page.$('.game .rw-pad[data-rw-skin="stripe"]'))) report.push({ label: `Game card shared looks (${colorScheme})`, axe: [], extra: [{ kind: 'text', name: 'shared ring or paddle badge missing on game card', px: 0 }] });
    else await audit(page, `Game card shared looks (${colorScheme})`, report, '.game .lines');
    await page.evaluate(() => { profile = { name: 'Ana', mode: 'doubles' }; renderProfile(); }); await sleep(250);
    if (!(await page.$('#sheet4 .pf-head .av[data-rw-frame="double"]')) || !(await page.$('#sheet4 .pf-head .rw-pad[data-rw-skin="stripe"]'))) report.push({ label: `Profile shared looks (${colorScheme})`, axe: [], extra: [{ kind: 'text', name: 'shared ring or paddle badge missing on profile', px: 0 }] });
    else await audit(page, `Profile shared looks (${colorScheme})`, report, '#sheet4 .pf-head');
    if (colorScheme === 'light') {
      await page.evaluate(() => { profile = null; renderProfile(); tab = 'history'; render(); });
      for (const w of [320, 195]) {
        await page.setViewport({ width: w, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(200);
        const over = await page.evaluate(() => [...document.querySelectorAll('.game .lines *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(e => e.tagName + '.' + e.className).slice(0, 3));
        if (over.length) report.push({ label: `Game card shared looks: reflow at ${w}px`, axe: [], extra: over.map(n => ({ kind: 'text', name: 'overflows sideways: ' + n, px: 0 })) });
      }
    }
    await ctx.close();
  }
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
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pb.tutorialSeen', 'true'); localStorage.setItem('pb.newsSeen', '"2026-11-22"'); } catch {} });
    await page.goto(base, { waitUntil: 'networkidle0' }); await sleep(400);
    await page.click('[data-act="new-open"]'); await sleep(300);
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
{ // Link a watch from the court of a game with no club: the sheet that asks first, the choice once it is shared, and an event match (nothing is sent).
  for (const colorScheme of ['light', 'dark']) {
    const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: colorScheme }]);
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pb.tutorialSeen', 'true'); localStorage.setItem('pb.newsSeen', '"2026-11-22"'); } catch {} });
    await page.goto(base, { waitUntil: 'networkidle0' }); await sleep(400);
    await page.click('[data-act="new-open"]'); await sleep(300);
    for (const [i, n] of ['Ana', 'Ben', 'Cy', 'Di'].entries()) await page.type(`#name-${i >> 1}-${i & 1}`, n);
    await page.click('[data-act="start"]'); await sleep(400);
    const states = [['no club, not shared', () => {}, '[data-act="watch-share"]'], ['shared: scan or code', () => { live.room = 'ABCDEF'; live.shared = true; live.id = 'live-1'; }, '[data-act="watch-court-scan"]'], ['event match', () => { live.room = null; live.shared = false; live.event = { id: 'e1', name: 'Spring ladder' }; }, '[data-act="club-close"]']];
    for (const [name, set, want] of states) {
      await page.evaluate(set); await page.evaluate(() => { clubSheet = null; renderClub(); renderCourt(); }); await sleep(150);
      await page.click('[data-act="watch-court"]'); await sleep(250);
      const label = `court watch sheet, ${name} (${colorScheme})`;
      if (!(await page.$('#sheet3 ' + want))) report.push({ label, axe: [], extra: [{ kind: 'text', name: 'the sheet did not show ' + want, px: 0 }] });
      else await audit(page, label, report, '#sheet3');
    }
    await ctx.close();
  }
}
{ // Joined club sheet (plain member and organizer): three groups, headings, targets, contrast and reflow (stubbed club, nothing is sent).
  for (const [mode, opt] of states) {
    const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opt.colorScheme }]);
    await page.evaluateOnNewDocument(o => { try { localStorage.setItem('pb.tutorialSeen', 'true'); localStorage.setItem('pb.newsSeen', '"2026-11-22"'); if (o) localStorage.setItem('pb.display', JSON.stringify({ outdoor: 1, large: 1 })); } catch {} }, opt.outdoor);
    await page.goto(base, { waitUntil: 'networkidle0' }); await sleep(400);
    await page.evaluate(() => {
      club = { code: 'K7P2QX', name: 'Preview Club', hasPin: true };
      clubs = [{ code: 'K7P2QX', name: 'Preview Club' }];
      me[club.code] = { name: 'Ana', token: 't'.repeat(48) };
      delete owners[club.code]; delete pins[club.code];
      clubData = { code: 'K7P2QX', games: [], deleted: [], roster: ['Ana', 'Ben', 'Cy', 'Di'], nights: [{ id: 'n1', title: 'Friday open play', startsAt: Date.now() + 864e5, status: 'open', counts: { in: 4, maybe: 1, out: 0 } }] };
      clubSheet = { view: 'club' }; renderClub();
    });
    await sleep(300);
    await audit(page, `${mode}: club sheet (member)`, report, '#sheet3 .sheet');
    await page.evaluate(() => { owners[club.code] = 'a'.repeat(48); clubSheet = { view: 'club' }; renderClub(); });
    await sleep(300);
    await audit(page, `${mode}: club sheet (organizer)`, report, '#sheet3 .sheet');
    if (mode === 'light') {
      for (const w of [320, 195]) {
        await page.setViewport({ width: w, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(200);
        const over = await page.evaluate(() => [...document.querySelectorAll('#sheet3 .sheet *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(e => e.tagName.toLowerCase() + '.' + e.className).slice(0, 3));
        if (over.length) report.push({ label: `club sheet: reflow at ${w}px`, axe: [], extra: over.map(n => ({ kind: 'text', name: 'overflows sideways: ' + n, px: 0 })) });
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
