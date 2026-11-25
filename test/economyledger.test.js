// Rewards slice 2: the server-side ledger and balance as pure functions (api/_economy.js), with made-up players and days only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as E from '../api/_economy.js';

const T = k => Date.parse(k + 'T12:00:00Z'); // noon UTC on a made-up day
const sync = (ledger, days, now, tz = 0) => E.deriveEarnings({ ledger, receivedAt: days.map(T), tz, now: T(now) + 36e5 });
const apply = (ledger, rows) => ledger.concat(rows);
// Plays on each day (YYYY-MM-DD) with a sync at the end of each day, like a phone that opens the app daily.
const daily = days => days.reduce((l, d) => apply(l, sync(l, [d], d)), []);
const jan = n => `2026-01-${String(n).padStart(2, '0')}`;

test('the first game pays the day-1 rung (5) and starts day 1; more games the same day add nothing', () => {
  const a = sync([], [jan(5), jan(5)], jan(5));
  assert.deepEqual(a, [{ id: 'day:2026-01-05', kind: 'earn', amount: 5, reason: 'day', day: jan(5), streak: 1 }]);
  assert.deepEqual(sync(a, [jan(5)], jan(5)), [], 'a second sync the same day adds nothing');
});

test('consecutive days pay the ladder 5, 8, 10, 12, 15, 20, 25 then 25, plus 100 on day 30; the streak restarts after a gap', () => {
  const l = daily(Array.from({ length: 30 }, (_, i) => jan(1 + i > 31 ? 31 : 1 + i)));
  assert.deepEqual(l.slice(0, 9).map(e => e.amount), [5, 8, 10, 12, 15, 20, 25, 25, 25]);
  assert.equal(l[29].amount, 125, 'day 30 pays the 25 and the 100');
  assert.equal(l[29].reason, 'day+streak');
  assert.equal(E.ledgerBalance(l), 95 + 22 * 25 + 125);
  assert.equal(E.summary(l, 0, T(jan(30))).streak, 30);
  const gap = daily([jan(1), jan(2), jan(3), jan(5)]);
  assert.deepEqual(gap.map(e => e.streak), [1, 2, 3, 1]);
  assert.deepEqual(E.summary(gap, 0, T(jan(5))), { dinks: 5 + 8 + 10 + 5, streak: 1, best: 3, last: jan(5) });
  assert.equal(E.summary(gap, 0, T(jan(7))).streak, 0, 'two missed days: the shown streak is 0');
  assert.deepEqual([1, 7, 8, 29, 30, 31, 60, 99, 100, 101].map(E.dayPay), [5, 25, 25, 25, 125, 25, 25, 25, 275, 25]);
  assert.equal(E.dayPay(0), 0);
});

test('a phone that syncs late still gets every day it saved a game, in order, with the right streak', () => {
  const l = sync([], [jan(3), jan(1), jan(2)], jan(3));
  assert.deepEqual(l.map(e => [e.day, e.streak, e.amount]), [[jan(1), 1, 5], [jan(2), 2, 8], [jan(3), 3, 10]]);
});

test('a clock set back or a backdated log adds nothing: only days after the last paid one count, and never a future day', () => {
  const l = daily([jan(10), jan(11)]);
  assert.deepEqual(sync(l, [jan(8), jan(9), jan(10)], jan(11)), [], 'older days are never paid after a later one');
  assert.deepEqual(sync(l, [jan(20)], jan(11)), [], 'a day that has not happened yet is not paid');
  assert.deepEqual(sync(l, [jan(11)], jan(11)), []);
  assert.equal(sync(l, [jan(12)], jan(12))[0].streak, 3);
});

test('the first sync pays at most the last 14 days: an old history is not back-paid and a phone balance is never an input', () => {
  const old = Array.from({ length: 60 }, (_, i) => jan(1) && new Date(Date.UTC(2025, 10, 1 + i)).toISOString().slice(0, 10));
  const rows = E.deriveEarnings({ ledger: [], receivedAt: old.map(T), tz: 0, now: T(old[59]) + 36e5 });
  assert.equal(rows.length, E.LOOKBACK_DAYS + 1, 'today and the 14 days before it');
  assert.equal(rows[0].streak, 1, 'the paid run starts at 1, not at the real run length');
  assert.ok(E.ledgerBalance(rows) <= 295, 'the most a first sync can pay: day 1 to 15 of a streak');
  assert.ok(!E.deriveEarnings.toString().includes('pb.rewards') && E.deriveEarnings.length === 1, 'the input is saved-game times and a ledger, nothing from the phone but its time zone');
});

test('the time zone only moves a game between neighbouring days and is clamped', () => {
  const late = Date.parse('2026-01-05T23:30:00Z');
  assert.equal(E.dayKey(late, 0), jan(5)); assert.equal(E.dayKey(late, 120), jan(6)); assert.equal(E.dayKey(late, -300), jan(5));
  assert.equal(E.cleanTz(99999), 840); assert.equal(E.cleanTz(-99999), -720); assert.equal(E.cleanTz('x'), 0);
  const a = E.deriveEarnings({ ledger: [], receivedAt: [late], tz: 120, now: late + 3e6 });
  assert.equal(a[0].id, 'day:' + jan(6));
});

test('ids are the idempotency key: replaying the same rows or a second device derives the same ids and amounts', () => {
  const a = sync([], [jan(1), jan(2)], jan(2)), b = sync([], [jan(2), jan(1), jan(1)], jan(2));
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map(e => e.id)).size, a.length);
  assert.ok(a.every(E.validEntry));
});

test('the balance is the sum of the ledger, and a spend never takes it below zero (spending is not built yet, the rule is)', () => {
  const l = daily([jan(1), jan(2), jan(3)]); // 5 + 8 + 10
  assert.equal(E.ledgerBalance(l), 23);
  const s = E.spendEntry(l, { id: 'spend:test-1', amount: 4, reason: 'test' });
  assert.deepEqual(s, { id: 'spend:test-1', kind: 'spend', amount: -4, reason: 'test', day: null, streak: null });
  assert.ok(E.validEntry(s));
  const after = apply(l, [s]);
  assert.equal(E.ledgerBalance(after), 19);
  assert.equal(E.spendEntry(after, { id: 'spend:test-1', amount: 4 }), null, 'the same id twice is recorded once');
  assert.throws(() => E.spendEntry(after, { id: 'spend:test-2', amount: 20 }), /Not enough/);
  assert.throws(() => E.spendEntry(after, { id: 'spend:test-3', amount: -5 }), /positive/);
  assert.throws(() => E.spendEntry(after, { id: '', amount: 1 }), /id/);
  assert.equal(E.summary(after, 0, T(jan(3))).dinks, 19, 'spending leaves the streak alone');
});

test('a row that is not an earn above zero or a spend below zero is refused', () => {
  const ok = { id: 'day:2026-01-01', kind: 'earn', amount: 1, reason: 'day', day: jan(1), streak: 1 };
  assert.ok(E.validEntry(ok));
  for (const bad of [{ ...ok, amount: 0 }, { ...ok, amount: -1 }, { ...ok, kind: 'spend' }, { ...ok, id: 'x' }, { ...ok, amount: 1.5 }, { ...ok, day: 'today' }, null])
    assert.ok(!E.validEntry(bad), JSON.stringify(bad));
});

test('the ledger code never reads a score, rating, rank or pairing, and has no purchase path', () => {
  for (const f of ['api/_economy.js', 'api/_economysync.js']) {
    const code = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
    assert.ok(!/\bscore\b|\brating|\brank|pairing|winner|Math\.random|stripe|payment|price/i.test(code.replace(/data->'teams'/g, '')), f);
  }
  const sql = fs.readFileSync(new URL('../api/_economysync.js', import.meta.url), 'utf8');
  assert.match(sql, /data->'teams' AS teams, data->>'receivedAt' AS r/, 'only the players, the sender and the arrival time of a game are read');
  assert.match(sql, /data->>'scoredBy' = \$\{key\} OR data->>'scoredByPlayer' = \$\{key\}/, "only games this name's own verified phone saved");
  assert.ok(!/\bUPDATE reward_ledger|DELETE FROM reward_ledger/.test(sql), 'the sync only ever appends');
});
