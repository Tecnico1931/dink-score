import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// Dinks are back only as the free daily-streak currency of src/app/economy.js (L16 slice 1, rules in DESIGN.md "Rewards"); that module is the one place the page may name them.
test('the shop is gone and Dinks live only in the rewards module: no shop or Dinks API files, routes or other app copy', () => {
  for (const f of ['api/shop.js', 'api/_dinks.js']) assert.ok(!fs.existsSync(path.join(root, f)), f);
  assert.ok(!/api\/shop|dinks/i.test(read('vercel.json').replace(/dinkscore/gi, '')));
  for (const f of ['dink-score.html', 'index.html']) {
    const t = read(f).replace(read('src/app/economy.js'), '').replace(/dinkscore/gi, '');
    assert.ok(!/\bDinks?\b(?! Rating| Score)/.test(t.replace(/Dink Rating|Dink Score/g, '')), f + ' mentions Dinks');
    assert.ok(!/data-tab="shop"|api\('shop'|spin-wheel|equippedFor/.test(t), f + ' still has shop code');
  }
});

test('the progress rules no longer pay or count Dinks', async () => {
  const m = await import('../api/_progress.js');
  const games = [{ id: 'g1', mode: 'doubles', teams: [['A', 'B'], ['C', 'D']], score: [11, 5], winner: 0, endedAt: 1e12, receivedAt: 1e12, scoredBy: 'a' }];
  for (const p of m.computeProgress(games, 2e12).values()) for (const k of ['earned', 'base', 'bonus']) assert.ok(!(k in p), k);
  assert.ok(m.ACHIEVEMENTS.every(a => !('dinks' in a)) && m.CHALLENGES.every(c => !('dinks' in c)));
});
