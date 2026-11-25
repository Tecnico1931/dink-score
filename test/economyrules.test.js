import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BONUS, DAY_PAY } from '../api/_economy.js';
import { BOX_PRICE, BOX_DUPLICATE_REFUND, BOX_DAILY_LIMIT } from '../api/_economybox.js';
import { PASS_TIERS } from '../api/_economypass.js';
import { SPIN_CHANCES } from '../api/_economyspin.js';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src/app/economy.js'), 'utf8');

// The Earning Dinks rules card quotes client copies of the server constants: they must not drift.
test('rules card numbers equal the server constants', () => {
  assert.equal(src.match(/const RW_BONUS = (\[\[.*?\]\]);/)[1].replace(/\s/g, ''), JSON.stringify(BONUS));
  const day = src.match(/const RW_DAY_PAY = (\d+), RW_BOX = \{ cost: (\d+), refund: (\d+), limit: (\d+) \}, RW_SPIN = \{ min: (\d+), max: (\d+) \}, RW_PASS_TIERS = (\d+);/);
  assert.ok(day, 'client constants line exists');
  assert.deepEqual(day.slice(1).map(Number), [DAY_PAY, BOX_PRICE, BOX_DUPLICATE_REFUND, BOX_DAILY_LIMIT, Math.min(...SPIN_CHANCES.map(c => c.value)), Math.max(...SPIN_CHANCES.map(c => c.value)), PASS_TIERS.length]);
});

test('rules card is built from those constants and only draws where rewards are shown', () => {
  const body = src.match(/rulesHTML\(\) \{([\s\S]*?)\n  \},/)[1];
  assert.match(body, /if \(!rwShown\(\)\) return ''/);
  for (const k of ['RW_DAY_PAY', 'RW_BONUS', 'RW_BOX.cost', 'RW_BOX.limit', 'RW_BOX.refund', 'RW_PASS_TIERS']) assert.ok(body.includes(k), k);
  assert.match(body, /rwBoxOn\(\)/, 'the box line shows only where the box is on');
  assert.match(body, /RW_SPIN\.min/, 'the daily spin line quotes the prize range');
  assert.ok(!/\+\d+ for a win|forecast/i.test(body), 'no upstream earning rule that does not exist here');
});
