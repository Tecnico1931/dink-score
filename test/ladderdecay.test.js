import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLadder, recordChallenge, ladderOrder, ladderRows, closeLadderSeason, view, summary } from '../api/_league.js';

const DAY = 86400000, T0 = 1_700_000_000_000;
const P = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
const ratings = Object.fromEntries(P(5).map((p, i) => [p, 3 - i * 0.1]));
const ORG = { organizer: true };
const make = decayDays => createLadder({ name: 'Ladder', mode: 'singles', players: P(5), jump: 3, decayDays }, ratings, T0, () => 0.5);
const names = (L, now) => ladderOrder(L, now).map(i => L.entries[i][0]);
const play = (L, key, c, d, score, at) => recordChallenge(L, { key, challenger: [c], defender: [d], score }, at, ORG);

test('decay is off unless asked for: the order never depends on the clock', () => {
  for (const L of [make(0), make(undefined)]) assert.deepEqual(names(L, T0 + 900 * DAY), P(5));
  const old = make(0); delete old.decayDays; delete old.since;
  assert.deepEqual(names(old, T0 + 900 * DAY), P(5));
});

test('an idle entry drops one place per stretch of idle days, never below last', () => {
  const L = make(10);
  assert.deepEqual(names(L, T0 + 9 * DAY), P(5));
  // day 10: everyone above last is due; the top drops first and whoever moved up starts fresh, so P1<->P2 and P3<->P4 swap once
  assert.deepEqual(names(L, T0 + 10 * DAY), ['P2', 'P1', 'P4', 'P3', 'P5']);
  assert.deepEqual(names(L, T0 + 19 * DAY), ['P2', 'P1', 'P4', 'P3', 'P5']);
  for (const days of [20, 55, 400]) assert.deepEqual([...names(L, T0 + days * DAY)].sort(), P(5)); // still everyone, once
});

test('playing resets the clock for both sides', () => {
  const L = make(10);
  play(L, 'k001', 'P3', 'P2', [11, 5], T0 + 5 * DAY); // P3 takes P2's place; both reset at day 5
  assert.deepEqual(names(L, T0 + 9 * DAY), ['P1', 'P3', 'P2', 'P4', 'P5']);
  // day 12: P1 and P4 (idle since the start) dropped; P3 and P2 (reset at day 5) are not due until day 15
  assert.deepEqual(names(L, T0 + 12 * DAY), ['P3', 'P1', 'P2', 'P5', 'P4']);
});

test('the same results and the same clock always give the same order (replay is pure)', () => {
  const L = make(7);
  play(L, 'k001', 'P4', 'P2', [11, 9], T0 + 3 * DAY);
  play(L, 'k002', 'P5', 'P4', [11, 1], T0 + 20 * DAY);
  const a = names(L, T0 + 50 * DAY), b = names(JSON.parse(JSON.stringify(L)), T0 + 50 * DAY);
  assert.deepEqual(a, b);
});

test('challenges are checked against the decayed order, and results stay in time order', () => {
  const L = make(10), now = T0 + 10 * DAY;
  assert.throws(() => play(L, 'k009', 'P2', 'P1', [11, 3], now), /above you/); // P1 fell below P2 by day 10
  const r = play(L, 'k010', 'P5', 'P3', [11, 3], now);          // P3 is directly above P5 by then
  assert.equal(r.changed, true);
  assert.deepEqual(names(L, now), ['P2', 'P1', 'P4', 'P5', 'P3']);
  const later = play(L, 'k011', 'P5', 'P4', [11, 4], now - DAY); // a clock that went backwards never puts a result before an earlier one
  assert.equal(later.match.at, now);
});

test('rows say when the next drop is due; last place and decay-off ladders have none', () => {
  const L = make(10), now = T0 + 3 * DAY;
  const rows = ladderRows(L, now);
  assert.equal(rows[0].dropsAt, T0 + 10 * DAY);
  assert.equal(rows.at(-1).dropsAt, null);
  assert.ok(ladderRows(make(0), now).every(r => r.dropsAt === null));
  assert.equal(view(L, now).decayDays, 10);
  assert.equal(summary(L, T0 + 400 * DAY).results, 0);
});

test('closing a season carries the decayed order over and restarts the clock', () => {
  const L = make(10);
  const expected = names(L, T0 + 25 * DAY);
  closeLadderSeason(L, undefined, T0 + 25 * DAY);
  assert.deepEqual(L.entries.map(e => e[0]), expected);
  assert.equal(L.since, T0 + 25 * DAY);
  assert.deepEqual(names(L, T0 + 25 * DAY), expected);
  assert.deepEqual(names(L, T0 + 34 * DAY), expected); // a fresh stretch
});

test('decayDays is clamped', () => {
  assert.equal(make(9999).decayDays, 365);
  assert.equal(make(-5).decayDays, 0);
  assert.equal(make('abc').decayDays, 0);
});
