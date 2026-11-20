// Browser smoke test for the built site (public/, run by CI; needs Chrome through Playwright, so not part of `npm test`).
//   npm i --no-save playwright-core && npx playwright-core install chromium && node build.cjs && node tools/smoke-check.mjs
// Starts tools/serve.cjs (same CSP headers as Vercel), then plays one whole game on a phone-sized screen: the page loads with
// no script error or CSP violation, a rally game is scored to 11, saved, and shows up in Leaders and Record, also after a reload.
// Env: PW_CHROME=/path/to/chrome (default: Playwright's own Chromium), SMOKE_PORT=4188.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const port = process.env.SMOKE_PORT || 4188, base = `http://127.0.0.1:${port}/`;
const srv = spawn('node', ['tools/serve.cjs', port], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
let failed = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  const problems = [];
  // The static preview has no /api and no Vercel analytics script, so those two requests fail by design.
  const expected = t => /_vercel\/insights|\/api\/|status of 404/.test(t);
  page.on('pageerror', e => problems.push('page error: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !expected(m.text())) problems.push('console: ' + m.text()); });

  await page.goto(base);
  await page.getByRole('button', { name: 'Skip' }).click();
  console.log('ok  loads, no script error or CSP violation');

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

  assert.deepEqual(problems, [], problems.join('\n'));
  console.log('ok  no script errors or CSP violations in the whole run');
} catch (e) {
  failed = true; console.error('FAIL', e.message);
} finally {
  await browser.close(); srv.kill();
}
process.exit(failed ? 1 : 0);
