// Dinks activity (plain-words ledger) and the pace behind the Shop saving goal: pure functions, made-up players and fixed days only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as A from '../api/_economyactivity.js';
import { paceFrom, PACE_MIN_DAYS } from '../api/_economy.js';

const row = (id, kind, amount, reason, day = null, at = '2026-01-10T12:00:00Z') => ({ id, kind, amount, reason, day, streak: null, at });
const T = k => Date.parse(k + 'T12:00:00Z');

test('each reason reads in plain words and the balance runs oldest to newest', () => {
  const led = [
    row('day:2026-01-05', 'earn', 1, 'day', '2026-01-05', '2026-01-05T12:00:00Z'),
    row('day:2026-01-06', 'earn', 3, 'day+streak', '2026-01-06', '2026-01-06T12:00:00Z'),
    row('buy:frame-court', 'spend', -4, 'shop:frame-court', null, '2026-01-07T12:00:00Z'),
    row('p:1', 'earn', 5, 'pass:tier-1', null, '2026-01-08T12:00:00Z'),
    row('b:1', 'spend', -2, 'box:paddle-ink', '2026-01-09', '2026-01-09T12:00:00Z'),
    row('b:1r', 'earn', 1, 'boxref:paddle-ink', null, '2026-01-09T12:00:01Z')
  ];
  const out = A.activityFrom(led);
  assert.deepEqual(out.entries.map(e => [e.text, e.amount, e.balance]), [
    ['Mystery box refund: you already had Ink paddle', 1, 4],
    ['Opened a mystery box: Ink paddle', -2, 3],
    ['Season pass tier 1', 5, 5],
    ['Bought Court green ring', -4, 0],
    ['Earned for a play day, with a streak bonus', 3, 4],
    ['Earned for a play day', 1, 1]
  ]);
  assert.equal(out.balance, 4); assert.equal(out.total, 6);
});

test('only text, amount, balance and date leave: never an id, a reason or a name key', () => {
  const [e] = A.activityFrom([row('buy:frame-court', 'spend', -6, 'shop:frame-court')]).entries;
  assert.deepEqual(Object.keys(e).sort(), ['amount', 'at', 'balance', 'text']);
  assert.equal(A.describe(row('x', 'earn', 5, 'something-new')), 'Earned Dinks', 'an unknown reason never leaks its raw text');
  assert.equal(A.describe(row('x', 'spend', -5, 'weird:thing')), 'Spent Dinks');
  assert.equal(A.describe(row('x', 'spend', -5, 'shop:not-an-item')), 'Bought an item');
});

test('capped at the last 100 rows, newest first, but the balance still counts every row', () => {
  const led = Array.from({ length: 130 }, (_, i) => row('d' + i, 'earn', 1, 'day', '2026-01-01', new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString()));
  const out = A.activityFrom(led);
  assert.equal(out.entries.length, A.ACTIVITY_CAP); assert.equal(out.total, 130); assert.equal(out.balance, 130);
  assert.equal(out.entries[0].balance, 130); assert.equal(out.entries[99].balance, 31);
  assert.ok(out.entries[0].at > out.entries[1].at);
  assert.equal(A.activityFrom(led, Infinity).entries.length, 130, 'the export asks for everything');
});

test('pace: Dinks per play day over the last 30 days, play-day rows only, null until a few days', () => {
  const play = (d, amt = 1) => row('day:' + d, 'earn', amt, amt > 1 ? 'day+streak' : 'day', d);
  const now = T('2026-02-20');
  assert.equal(paceFrom([], now), null);
  assert.equal(paceFrom([play('2026-02-18'), play('2026-02-19')], now), null, `needs ${PACE_MIN_DAYS} play days`);
  assert.equal(paceFrom([play('2026-02-17'), play('2026-02-18'), play('2026-02-19', 3)], now), 1.67);
  const withExtras = [play('2026-02-17'), play('2026-02-18'), play('2026-02-19'), row('p', 'earn', 50, 'pass:tier-3'), row('r', 'earn', 4, 'boxref:frame-ink')];
  assert.equal(paceFrom(withExtras, now), 1, 'a pass reward or a refund does not count as pace');
  assert.equal(paceFrom([play('2025-12-01'), play('2025-12-02'), play('2025-12-03')], now), null, 'days older than 30 do not count');
});

test('the activity code is read-only and never touches a game, a rating or a pairing', () => {
  const src = fs.readFileSync(new URL('../api/_economyactivity.js', import.meta.url), 'utf8');
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(src) && !/\bsql\b/.test(src.replace(/\/\/.*$/gm, '')));
  assert.ok(!/Date\.now|Math\.random/.test(src));
});
