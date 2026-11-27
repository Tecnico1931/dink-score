// M12: season prizes (100/60/40) and achievement bonus Dinks. Pure planners, made-up players, ledger simulated with ON CONFLICT DO NOTHING.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, ACHIEVEMENT_PAY, SEASON_PRIZE, computeProgress, planAchievementRows, planPrizeRows } from '../api/_progress.js';
import { validEntry, ledgerBalance } from '../api/_economy.js';
import { describe } from '../api/_economyactivity.js';

const DAYMS = 864e5, T0 = Date.UTC(2026, 6, 6, 12); // inside 2026-Q3
// n games, Ana and Ben against Cy and Di, sent from Ana's phone, Ana's side winning `wins` of them.
const games = (n, wins) => Array.from({ length: n }, (_, i) => ({ id: 'g' + i, teams: [['Ana', 'Ben'], ['Cy', 'Di']], mode: 'doubles', winner: i < wins ? 0 : 1,
  score: i < wins ? [11, 5] : [5, 11], endedAt: T0 + i * 3600e3, receivedAt: T0 + i * 3600e3, scoredBy: 'ana' }));
const append = (ledger, rows) => { for (const r of rows) { assert.ok(validEntry(r), JSON.stringify(r)); if (!ledger.some(e => e.id === r.id)) ledger.push(r); } return rows; };

test('every achievement pays 5 to 50 Dinks, harder ones more', () => {
  assert.deepEqual(Object.keys(ACHIEVEMENT_PAY).sort(), ACHIEVEMENTS.map(a => a.id).sort(), 'every achievement has a bonus');
  for (const [id, n] of Object.entries(ACHIEVEMENT_PAY)) assert.ok(Number.isInteger(n) && n >= 5 && n <= 50, id);
  const pay = id => ACHIEVEMENT_PAY[id];
  assert.ok(pay('first-win') < pay('games-50') && pay('games-50') < pay('games-100') && pay('games-100') < pay('rating-45'));
});

test('achievements pay once, however often the sync runs, and a merge-moved row counts as paid', () => {
  const me = computeProgress(games(6, 6), T0 + 10 * DAYMS).get('ana');
  const ledger = [];
  const first = append(ledger, planAchievementRows({ ledger, me }));
  const got = me.achievements.map(a => a.id);
  assert.ok(got.includes('first-win') && got.includes('games-10') === false);
  assert.deepEqual(first.map(r => r.id).sort(), got.map(id => 'ach:' + id).sort());
  assert.equal(ledgerBalance(ledger), got.reduce((n, id) => n + ACHIEVEMENT_PAY[id], 0));
  assert.deepEqual(planAchievementRows({ ledger, me }), [], 'second sync pays nothing');
  assert.deepEqual(planAchievementRows({ ledger: ledger.map(r => ({ ...r, id: 'm:remy:' + r.id })), me }), [], 'merged rows are not paid again');
  assert.deepEqual(planAchievementRows({ ledger: [], me: null }), []);
});

test('a finished season pays its top 3 with 5 or more games 100 / 60 / 40, once per season and format', () => {
  assert.deepEqual([...SEASON_PRIZE], [100, 60, 40]);
  const g = games(5, 5), after = Date.UTC(2026, 9, 2), during = T0 + DAYMS;
  const done = computeProgress(g, after), live = computeProgress(g, during);
  assert.deepEqual([...live.values()].flatMap(p => planPrizeRows({ ledger: [], me: p })), [], 'nothing is paid while the season runs');
  const ana = done.get('ana'), ledger = [];
  const rows = append(ledger, planPrizeRows({ ledger, me: ana }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'sprz:2026-Q3:doubles');
  assert.ok([100, 60, 40].includes(rows[0].amount) && rows[0].amount === SEASON_PRIZE[ana.trophies[0].place - 1]);
  assert.deepEqual(planPrizeRows({ ledger, me: ana }), [], 'paid once');
  const few = computeProgress(games(4, 4), after).get('ana');
  assert.deepEqual(planPrizeRows({ ledger: [], me: few }), [], 'under 5 games: no trophy, no prize');
  const places = [1, 2, 3, 4].map(place => planPrizeRows({ ledger: [], me: { trophies: [{ season: 'x1', mode: 'singles', place }] } }).map(r => r.amount));
  assert.deepEqual(places, [[100], [60], [40], []]);
});

test('the rules card quotes exactly the server amounts', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/app/economy.js', import.meta.url), 'utf8');
  const m = src.match(/const RW_ACH_PAY = (\[\[[\s\S]*?\]\]), RW_PRIZE = (\[[^\]]*\]);/);
  const card = eval(m[1]), by = new Map();
  for (const [n, names] of card) for (const nm of names.split(/, | and /)) by.set(nm, n);
  for (const a of ACHIEVEMENTS) assert.equal(by.get(a.name), ACHIEVEMENT_PAY[a.id], a.name);
  assert.equal(by.size, ACHIEVEMENTS.length);
  assert.equal(m[2].replace(/\s/g, ''), JSON.stringify(SEASON_PRIZE));
});

test('the activity list names both in plain words', () => {
  assert.equal(describe({ kind: 'earn', reason: 'ach:shutout' }), 'Achievement: Shutout');
  assert.equal(describe({ kind: 'earn', reason: 'sprz:2' }), 'Season prize: 2nd place');
  assert.equal(describe({ kind: 'earn', reason: 'ach:nope' }), 'Achievement: unlocked');
});
