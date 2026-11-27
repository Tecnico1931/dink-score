import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LADDER, MILESTONES } from '../api/_economy.js';
import { EARN, CHALLENGE_PAY } from '../api/_economygame.js';
import { BOX_PRICE, BOX_DUPLICATE_REFUND, BOX_DAILY_LIMIT } from '../api/_economybox.js';
import { PASS_TIERS, PASS_XP_TIER } from '../api/_economypass.js';
import { SPIN_CHANCES } from '../api/_economyspin.js';
import { XP_GAME, XP_WIN, XP_DAY_CAP } from '../api/_economyxp.js';
import { PET_STAGES } from '../api/_economypets.js';
import { SCHEDULE } from '../api/_economyseason.js';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src/app/economy.js'), 'utf8');

// The Earning Dinks rules card quotes client copies of the server constants: they must not drift.
test('rules card numbers equal the server constants', () => {
  const lad = src.match(/const RW_LADDER = (\[[^\]]*\]), RW_MILES = (\[\[.*?\]\]);/);
  assert.equal(lad[1].replace(/\s/g, ''), JSON.stringify(LADDER));
  assert.equal(lad[2].replace(/\s/g, ''), JSON.stringify(MILESTONES));
  const earn = src.match(/const RW_EARN = \{ play: (\d+), win: (\d+), beat: (\d+), hot: (\d+), hotFrom: (\d+), cap: (\d+) \}, RW_CHAL = (\[[^\]]*\]);/);
  assert.ok(earn, 'client earning constants line exists');
  assert.deepEqual(earn.slice(1, 7).map(Number), [EARN.play, EARN.win, EARN.beat, EARN.hot, EARN.hotFrom, EARN.cap]);
  assert.equal(earn[7].replace(/\s/g, ''), JSON.stringify(CHALLENGE_PAY));
  const day = src.match(/const RW_BOX = \{ cost: (\d+), refund: (\d+), limit: (\d+) \}, RW_SPIN = \{ min: (\d+), max: (\d+) \}, RW_PASS_TIERS = (\d+), RW_XP = \{ game: (\d+), win: (\d+), cap: (\d+), tier: (\d+) \};/);
  assert.ok(day, 'client constants line exists');
  assert.deepEqual(day.slice(1).map(Number), [BOX_PRICE, BOX_DUPLICATE_REFUND, BOX_DAILY_LIMIT, Math.min(...SPIN_CHANCES.map(c => c.value)), Math.max(...SPIN_CHANCES.map(c => c.value)), PASS_TIERS.length, XP_GAME, XP_WIN, XP_DAY_CAP, PASS_XP_TIER]);
});

test('rules card is built from those constants and only draws where rewards are shown', () => {
  const body = src.match(/rulesHTML\(\) \{([\s\S]*?)\n  \},/)[1];
  assert.match(body, /if \(!rwShown\(\)\) return ''/);
  for (const k of ['RW_LADDER', 'RW_MILES', 'RW_CHAL', 'E.play', 'E.win', 'E.beat', 'E.hot', 'E.hotFrom', 'E.cap', 'RW_BOX.cost', 'RW_BOX.limit', 'RW_BOX.refund', 'RW_PASS_TIERS', 'RW_XP.game', 'RW_XP.win', 'RW_XP.cap', 'RW_XP.tier']) assert.ok(body.includes(k), k);
  assert.match(body, /rwBoxOn\(\)/, 'the box line shows only where the box is on');
  assert.match(body, /RW_SPIN\.min/, 'the daily spin line quotes the prize range');
  assert.match(body, /beat the forecast/, 'the forecast bonus is on the card');
  assert.match(body, /edited or deleted/, 'the card says edits and deletes adjust earnings');
  assert.ok(!/\+\d{2,} for a win/.test(body), 'no hard-coded earning number: all from the constants');
  assert.ok(/const E = RW_EARN/.test(src) || /E = RW_EARN/.test(body), 'the card reads RW_EARN');
});

test('pet days on the rules card and news equal the server stages', () => {
  const m = src.match(/const RW_PET_DAYS = \[(\d+), (\d+)\];/);
  assert.ok(m, 'client pet days line exists');
  assert.deepEqual([+m[1], +m[2]], PET_STAGES.slice(1).map(s => s.minDays));
  const rules = src.match(/rulesHTML\(\) \{([\s\S]*?)\n  \},/)[1], news = src.match(/newsItems\(\) \{([\s\S]*?)\n  \},/)[1];
  for (const b of [rules, news]) assert.ok(b.includes('RW_PET_DAYS[0]') && b.includes('RW_PET_DAYS[1]'));
});

test("what's new rewards items are built from the constants and only draw where rewards show", () => {
  const body = src.match(/newsItems\(\) \{([\s\S]*?)\n  \},/)[1];
  assert.match(body, /if \(!rwShown\(\)\) return \[\]/);
  for (const k of ['E.play', 'E.win', 'E.beat', 'E.cap', 'RW_SPIN.min', 'RW_SPIN.max', 'RW_BOX.cost', 'RW_BOX.limit', 'RW_PASS_TIERS']) assert.ok(body.includes(k), k);
  assert.match(body, /rwBoxOn\(\)/, 'spin and box item only where the box is on');
  assert.match(body, /25 December/);
  assert.equal(SCHEDULE.filter(r => r.event === 'christmas').map(r => r.to).sort().pop(), '2026-12-25', 'Christmas copy matches the schedule');
  assert.ok(!/\+\d{2,}/.test(body.replace(/\$\{[^}]*\}/g, '')), 'no hard-coded earning number');
});
