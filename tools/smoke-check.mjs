// Browser smoke test for the built site (public/, run by CI; needs Chrome through Playwright, so not part of `npm test`).
//   npm i --no-save playwright-core && npx playwright-core install chromium && node build.cjs && node tools/smoke-check.mjs
// Starts tools/serve.cjs (same CSP headers as Vercel), then plays one whole game on a phone-sized screen: the page loads with
// no script error or CSP violation, a rally game is scored to 11, undone and won again, saved, and shows up in Leaders and Record, also after a reload.
// It then reloads with the network off (the service worker serves the app), joins the preview's stand-in club, and opens a bracket
// in the app and on the public /b/<token> page. Nothing leaves the machine: the preview server keeps its club and events in memory.
// Env: PW_CHROME=/path/to/chrome (default: Playwright's own Chromium), SMOKE_PORT=4188.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const port = process.env.SMOKE_PORT || 4188, base = `http://127.0.0.1:${port}/`;
const srv = spawn('node', ['tools/serve.cjs', port], { stdio: 'ignore' });
for (let i = 0; ; i++) { // wait until the server answers, not a fixed time
  if (await fetch(base).then(r => r.ok, () => false)) break;
  if (i > 100) throw new Error('preview server did not start');
  await new Promise(r => setTimeout(r, 100));
}
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  let offline = false;
  // The static preview has no /api and no Vercel analytics script, so those two requests fail by design (and every request fails offline).
  const expected = t => /_vercel\/insights|\/api\/|status of 404/.test(t) || (offline && /ERR_INTERNET_DISCONNECTED/.test(t));
  page.on('pageerror', e => problems.push('page error: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !expected(m.text())) problems.push('console: ' + m.text()); });

  await page.goto(base);
  await page.getByRole('button', { name: 'Skip' }).click();
  console.log('ok  loads, no script error or CSP violation');

  const hero = page.locator('.hero');
  assert.match(await hero.innerText(), /Good (morning|afternoon|evening)/, 'the hero card greets by time of day');
  assert.match(await hero.innerText(), /game(s)? this week/);
  assert.equal(await hero.locator('.week i').count(), 7, 'the hero card draws seven days');
  assert.equal(await page.locator('#name-0-0').count(), 0, 'the setup card is not inline on Play');
  await page.locator('[data-act=new-open]').click();
  await page.getByRole('dialog', { name: 'New game' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.locator('[data-act=new-open]').click();
  assert.equal(await page.locator('#new-player').count(), 0, 'the new-player input stays hidden until + Add is tapped');
  await page.locator('[data-act=add-open]').click();
  await page.fill('#new-player', 'Eli');
  await page.keyboard.press('Enter');
  await page.locator('.chip-btn', { hasText: 'Eli' }).waitFor();
  assert.equal(await page.locator('#new-player').count(), 0, 'the input hides again after saving');
  console.log('ok  hero card, New game sheet and + Add chip');

  for (const [i, n] of ['Ana', 'Ben', 'Cy', 'Di'].entries()) await page.fill(`#name-${i < 2 ? 0 : 1}-${i % 2}`, n);
  const optsBtn = page.locator('[data-act="setup-opts"]');
  assert.equal(await optsBtn.getAttribute('aria-expanded'), 'false', 'game settings start collapsed');
  assert.match(await optsBtn.innerText(), /Doubles · Side-out · to 11 · win by 2/);
  await optsBtn.click();
  assert.equal(await optsBtn.getAttribute('aria-expanded'), 'true', 'game settings expand on click');
  await page.getByRole('button', { name: 'Rally', exact: true }).click();
  assert.match(await optsBtn.innerText(), /Doubles · Rally · to 11 · win by 2/);
  await page.locator('[data-act=start]').click();
  for (let i = 0; i < 11; i++) await page.locator('[data-rally="0"]').click();
  await page.getByRole('dialog').getByText(/Ana & Ben win|Ana and Ben win|win/).first().waitFor();
  console.log('ok  a rally game scores to 11 and shows the winner');

  await page.getByRole('dialog').locator('[data-act=undo]').click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.locator('[data-rally="0"]').click();
  await page.getByRole('dialog').getByText(/win/).first().waitFor();
  console.log('ok  undo takes back the winning rally, and the game can be won again');

  await page.locator('[data-act=finish]').click();
  await page.getByRole('button', { name: 'Leaders', exact: true }).click();
  const leaders = await page.locator('main, body').first().innerText();
  assert.ok(/Ana/.test(leaders) && /Cy/.test(leaders), 'Leaders lists the four players');
  assert.ok(/2\.\d\d/.test(leaders), 'Leaders shows Dink Ratings');
  console.log('ok  the saved game builds the Leaders table');

  await page.reload();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  assert.ok(/Ana/.test(await page.locator('body').innerText()), 'the game is still there after a reload');
  console.log('ok  the game is in Record after a reload');

  // Offline: once the worker controls the page its shell is cached, so a reload with no network still opens the app and the saved game.
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await ctx.setOffline(true); offline = true;
  await page.reload();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  assert.ok(/Ana/.test(await page.locator('body').innerText()), 'the app and the saved game open with no network');
  await ctx.setOffline(false); offline = false;
  console.log('ok  offline reload: the service worker serves the app and the saved game is still there');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.waitFor();
  await settings.getByRole('button', { name: 'Dark', exact: true }).click();
  await settings.getByRole('button', { name: 'Done' }).click();
  await settings.waitFor({ state: 'detached' });
  console.log('ok  settings open, change the appearance and close');

  // What's new shows once, for a phone that has seen the tour and not this update.
  const old = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  old.on('pageerror', e => problems.push('page error: ' + e.message));
  old.on('console', m => { if (m.type() === 'error' && !expected(m.text())) problems.push('console: ' + m.text()); });
  await old.addInitScript(() => { try { localStorage.setItem('pb.tutorialSeen', 'true'); } catch {} });
  await old.goto(base);
  const news = old.getByRole('dialog', { name: "What's new" });
  await news.waitFor();
  await news.getByRole('button', { name: 'Got it' }).click();
  await news.waitFor({ state: 'detached' });
  await old.reload();
  assert.equal(await old.getByRole('dialog').count(), 0, "What's new does not come back after Got it");
  console.log("ok  What's new shows once and stays closed");

  // A club and a bracket. The preview answers any club code and holds events in memory (tools/serve.cjs); the event is made through
  // the same /api/events the app uses, so its players appear as the club's saved players.
  const post = async body => (await fetch(base + 'api/events', { method: 'POST', body: JSON.stringify(body) })).json();
  const made = await post({ action: 'create', event: { name: 'Smoke Cup', format: 'single_elim', players: ['Ana', 'Ben', 'Cy', 'Di', 'Eli', 'Fay', 'Gus', 'Hal'] } });
  const { shareToken } = await post({ action: 'share', id: made.event.id });

  const fresh = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  fresh.on('pageerror', e => problems.push('page error: ' + e.message));
  fresh.on('console', m => { if (m.type() === 'error' && !expected(m.text())) problems.push('console: ' + m.text()); });
  await fresh.goto(base);
  await fresh.getByRole('button', { name: 'Skip' }).click();
  await fresh.locator('[data-act="club-open"]').click();
  await fresh.fill('#club-code', 'k7p2qx');
  await fresh.locator('[data-form="club-join"] button[type=submit]').click();
  await fresh.locator('#club-h', { hasText: 'Who are you?' }).waitFor();
  await fresh.locator('[data-claim="Ana"]').waitFor(); // the event's players are the club's saved players
  await fresh.locator('[data-act="whoami-skip"]').click();
  await fresh.locator('#club-h').waitFor({ state: 'detached' });
  await fresh.getByText('Preview Club').first().waitFor();
  console.log('ok  joining a club with its code lands in the club, with the saved players to pick from');

  await fresh.locator('#tabs [data-tab="events"]').click();
  await fresh.locator(`#events [data-ev="open"][data-id="${made.event.id}"]`).click();
  await fresh.locator('#events').getByText('Semifinals').first().waitFor();
  console.log('ok  the event opens in the app with its bracket');

  const pub = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  pub.on('pageerror', e => problems.push('page error: ' + e.message));
  pub.on('console', m => { if (m.type() === 'error' && !expected(m.text())) problems.push('console: ' + m.text()); });
  await pub.goto(`${base}b/${shareToken}`);
  await pub.getByRole('heading', { name: 'Smoke Cup' }).waitFor();
  await pub.getByText('Semifinals').first().waitFor();
  await pub.getByText('Waiting for earlier matches').waitFor(); // the final waits for both semifinals
  console.log('ok  the public bracket page draws the bracket');

  assert.deepEqual(problems, [], problems.join('\n'));
  console.log('ok  no script errors or CSP violations in the whole run');
} catch (e) {
  failed = true; console.error('FAIL', e.message);
} finally {
  await browser.close(); srv.kill();
}
process.exit(failed ? 1 : 0);
