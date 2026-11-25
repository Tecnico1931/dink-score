import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SPIN_SEGMENTS, SPIN_CHANCES, SPIN_MAX, drawSpin, spinId, spinOdds } from '../api/_economyspin.js';
import { describe } from '../api/_economyactivity.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('spin odds: chances sum to 100 and every prize is on the wheel, up to 50', () => {
  assert.equal(SPIN_CHANCES.reduce((n, c) => n + c.chance, 0), 100);
  for (const c of SPIN_CHANCES) assert.ok(SPIN_SEGMENTS.includes(c.value), `${c.value} is on the wheel`);
  assert.deepEqual([...new Set(SPIN_SEGMENTS)].sort((a, b) => a - b), SPIN_CHANCES.map(c => c.value).sort((a, b) => a - b));
  assert.equal(SPIN_MAX, 50);
  assert.equal(spinOdds().max, 50);
});

test('draw follows the stated chances exactly over every roll', () => {
  const tally = new Map();
  for (let roll = 0; roll < 100; roll++) {
    const r = drawSpin(() => roll);
    assert.ok(SPIN_SEGMENTS.includes(r.value));
    tally.set(r.value, (tally.get(r.value) || 0) + 1);
  }
  for (const c of SPIN_CHANCES) assert.equal(tally.get(c.value), c.chance, `value ${c.value}`);
});

test('draw refuses a random source out of range', () => {
  assert.throws(() => drawSpin(() => 100), /out of range/);
});

test('one spin a day: the ledger id is per UTC day, and the activity line is plain words', () => {
  assert.equal(spinId('2026-03-05'), 'spin:2026-03-05');
  assert.equal(describe({ kind: 'earn', reason: 'spin', amount: 10 }), 'Daily spin');
  const src = read('api/_economyspin.js');
  assert.match(src, /NOT EXISTS \(SELECT 1 FROM reward_ledger/, 'the insert is guarded so a replay cannot pay twice');
  assert.match(src, /randomInt/, 'CSPRNG draw');
  assert.ok(!/CREATE TABLE|ALTER TABLE/.test(src), 'no schema change');
});

test('route is gated like the box, and the shop shows the wheel only where the box is on', () => {
  const api = read('api/players.js');
  assert.match(api, /rewards-spin[\s\S]*?!club\.rewards \|\| !club\.mystery_box/);
  const ui = read('src/app/economyshop.js');
  assert.match(ui.slice(ui.indexOf('function rwSpinHTML')), /rwBoxOn\(\)/);
  assert.ok(!/animation|transition|setInterval|requestAnimationFrame/.test(ui.slice(ui.indexOf('function rwWheelSVG'), ui.indexOf('function rwBoxHTML'))), 'the wheel is still');
  assert.ok(!/days? left|countdown|in \d+ ?h/i.test(ui.slice(ui.indexOf('function rwSpinHTML'), ui.indexOf('function rwBoxHTML'))), 'no countdown copy');
});
