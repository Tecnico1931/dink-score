import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, cleanZone, WEEKS } from '../api/_analytics.js';

const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 18, 12); // Wed 18 Nov 2026
const game = (a, b, at, extra = {}) => ({ id: 'g' + Math.random(), mode: 'singles', teams: [[a], [b]], score: [11, 5], startedAt: at - 20 * 6e4, endedAt: at, ...extra });

test('a club with no games gets empty, well-formed numbers', () => {
  const r = analyze([], { now: NOW });
  assert.equal(r.games, 0);
  assert.equal(r.weeks.length, WEEKS);
  assert.equal(r.retention.rate, null);
  assert.equal(r.busiest.top.length, 0);
});

test('weeks count distinct players and split new from returning', () => {
  const games = [
    game('Ann', 'Bo', NOW - 14 * DAY), game('Ann', 'Bo', NOW - 13 * DAY),
    game('Ann', 'Cy', NOW - 1 * DAY)
  ];
  const r = analyze(games, { now: NOW });
  const last = r.weeks[r.weeks.length - 1];
  assert.deepEqual([last.games, last.players, last.newPlayers, last.returning], [1, 2, 1, 1]); // Cy is new, Ann returns
  assert.equal(r.games, 3);
});

test('retention: of players old enough to return, the share who played in a later week', () => {
  const games = [
    game('Ann', 'Bo', NOW - 60 * DAY), game('Ann', 'Cy', NOW - 30 * DAY), // Ann returns; Bo and Cy only once
    game('Dee', 'Ann', NOW - 2 * DAY)                                     // too recent to count in the cohort
  ];
  const r = analyze(games, { now: NOW });
  assert.deepEqual([r.retention.cohort, r.retention.cameBack, r.retention.rate], [3, 1, 33]);
  assert.equal(r.retention.active, 2); // Ann and Dee
  assert.equal(r.retention.lapsed, 1); // Cy played 30 days ago, not in the last 4 weeks (Bo is older still)
});

test('busiest hours use the club time zone', () => {
  const at = Date.UTC(2026, 10, 16, 23, 30); // Mon 23:30 UTC = Tue 10:30 in Sydney
  const utc = analyze([game('A', 'B', at, { startedAt: at })], { now: NOW, tz: 'UTC' });
  const syd = analyze([game('A', 'B', at, { startedAt: at })], { now: NOW, tz: 'Australia/Sydney' });
  assert.deepEqual([utc.busiest.top[0].day, utc.busiest.top[0].hour], [0, 23]);
  assert.deepEqual([syd.busiest.top[0].day, syd.busiest.top[0].hour], [1, 10]);
});

test('held games stay out when confirmation is required; deleted names key the same', () => {
  const games = [game('Ann', 'Bo', NOW - DAY), game('ann ', 'Cy', NOW - DAY, { confirmed: true })];
  assert.equal(analyze(games, { now: NOW, required: true }).games, 1);
  assert.equal(analyze(games, { now: NOW }).weeks.at(-1).players, 3); // "ann " is Ann
});

test('a bad zone falls back to UTC', () => {
  assert.equal(cleanZone('Not/AZone'), 'UTC');
  assert.equal(cleanZone('Europe/London'), 'Europe/London');
});

test('Monday 00:02 boundary puts an hour-old game in the previous week and a current-week game in weeks.at(-1)', () => {
  // Winter (GMT = UTC+0): Mon 2026-11-23 00:02 Europe/London
  const monGmt = Date.UTC(2026, 10, 23, 0, 2);
  const prevOnly = analyze([game('Ivy', 'Jon', monGmt - 36e5)], { now: monGmt, tz: 'Europe/London' });
  assert.equal(prevOnly.weeks.at(-1).start, '2026-11-23');
  assert.equal(prevOnly.weeks.at(-1).players, 0);
  assert.equal(prevOnly.weeks.at(-2).start, '2026-11-16');
  assert.equal(prevOnly.weeks.at(-2).players, 2);

  const curWeek = analyze([game('Ivy', 'Jon', monGmt - 6e4)], { now: monGmt, tz: 'Europe/London' });
  assert.equal(curWeek.weeks.at(-1).start, '2026-11-23');
  assert.equal(curWeek.weeks.at(-1).players, 2);

  // Summer (BST = UTC+1): Sun 2026-03-29 23:02 UTC = Mon 2026-03-30 00:02 Europe/London
  const monBst = Date.UTC(2026, 2, 29, 23, 2);
  const bstPrev = analyze([game('Ivy', 'Jon', monBst - 36e5)], { now: monBst, tz: 'Europe/London' });
  assert.equal(bstPrev.weeks.at(-1).start, '2026-03-30');
  assert.equal(bstPrev.weeks.at(-1).players, 0);
  assert.equal(bstPrev.weeks.at(-2).start, '2026-03-23');
  assert.equal(bstPrev.weeks.at(-2).players, 2);

  const bstCur = analyze([game('Ivy', 'Jon', monBst - 6e4)], { now: monBst, tz: 'Europe/London' });
  assert.equal(bstCur.weeks.at(-1).start, '2026-03-30');
  assert.equal(bstCur.weeks.at(-1).players, 2);
});
