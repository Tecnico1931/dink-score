// Ending a club season early (L21): the pure rules in api/_progress.js. A club that never ends one keeps the calendar quarters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { seasonOf, seasonAt, nextSeasonName, computeProgress, SEASON_MIN_GAMES } from '../api/_progress.js';

const U = (m, d, h = 12, mi = 0) => Date.UTC(2026, m, d, h, mi);
const MIN = 60 * 1000;
let n = 0;
// A verified doubles game received at `at`: Ana & Ben beat Cy & Di (or the other way round).
const game = (at, aWins = true) => ({ id: 'g' + ++n, mode: 'doubles', teams: [['Ana', 'Ben'], ['Cy', 'Di']], score: aWins ? [11, 4] : [4, 11], winner: aWins ? 0 : 1, endedAt: at, receivedAt: at, scoredBy: 'a' });
const run = (from, count, aWins = true) => Array.from({ length: count }, (_, i) => game(from + i * MIN, aWins));

test('a club with no early close has exactly the calendar quarters', () => {
  for (const ts of [U(0, 1, 0), U(2, 31, 23), U(6, 15), U(11, 31, 23, 59)]) {
    assert.deepEqual(seasonAt(ts, []), seasonOf(ts));
    assert.deepEqual(seasonAt(ts), seasonOf(ts));
  }
  const games = run(U(6, 2), SEASON_MIN_GAMES);
  const withNone = computeProgress(games, U(9, 2), []), legacy = computeProgress(games, U(9, 2));
  assert.deepEqual([...withNone.entries()], [...legacy.entries()]);
  assert.equal(legacy.get('ana').trophies[0].season, '2026-Q3');
});

test('closing early ends the season at the cut and starts the named one there', () => {
  const cut = U(7, 20, 9);
  const cuts = [{ at: cut, name: 'Autumn ladder' }];
  const before = seasonAt(cut - 1, cuts), after = seasonAt(cut, cuts);
  assert.equal(before.id, '2026-Q3');
  assert.equal(before.start, Date.UTC(2026, 6, 1), "the quarter's own start");
  assert.equal(before.end, cut, 'the old season ends at the cut, not at quarter end');
  assert.equal(after.name, 'Autumn ladder');
  assert.equal(after.start, cut);
  assert.equal(after.end, Date.UTC(2026, 9, 1), 'the new season runs to the end of the quarter it began in');
  assert.notEqual(before.id, after.id);
  // The calendar quarters carry on afterwards, with their usual ids.
  assert.deepEqual(seasonAt(Date.UTC(2026, 9, 1), cuts), seasonOf(Date.UTC(2026, 9, 1)));
  // Earlier quarters are untouched.
  assert.deepEqual(seasonAt(U(3, 10), cuts), seasonOf(U(3, 10)));
});

test('closing early awards the usual top three trophies to players with enough games, in both formats', () => {
  const cut = U(7, 20, 9);
  const cuts = [{ at: cut, name: 'Part two' }];
  const dubs = [...run(U(7, 1), SEASON_MIN_GAMES), ...run(U(7, 2), 1, false)];
  const solo = Array.from({ length: SEASON_MIN_GAMES }, (_, i) => ({ id: 's' + i, mode: 'singles', teams: [['Ana'], ['Cy']], score: [11, 3], winner: 0, endedAt: U(7, 3) + i * MIN, receivedAt: U(7, 3) + i * MIN, scoredBy: 'a' }));
  const unverified = { ...game(U(7, 4)), scoredBy: undefined };
  const after = run(cut + MIN, SEASON_MIN_GAMES);
  const p = computeProgress([...dubs, ...solo, unverified, ...after], cut + 5 * 60 * MIN, cuts);
  const ana = p.get('ana').trophies;
  assert.deepEqual(ana.map(t => [t.season, t.mode, t.place]).sort(), [['2026-Q3', 'doubles', 1], ['2026-Q3', 'singles', 1]].sort());
  assert.equal(ana[0].name, 'Summer 2026');
  assert.equal(ana[0].start, Date.UTC(2026, 6, 1));
  assert.equal(p.get('ben').trophies.length, 1);
  assert.equal(p.get('ben').trophies[0].mode, 'doubles');
  // The new season is still running: its games earn nothing yet.
  assert.ok(![...p.values()].some(x => x.trophies.some(t => t.season === `x${cut}`)));
  // Players with too few games in the closed season get no trophy.
  const few = computeProgress(run(U(7, 1), SEASON_MIN_GAMES - 1), cut + MIN, cuts);
  assert.ok([...few.values()].every(x => x.trophies.length === 0));
  // Nobody qualifying is fine: closing a season no one played is just an empty season.
  assert.deepEqual([...computeProgress([], cut + MIN, cuts)], []);
});

test('games count by when the server got them, so they fall on the right side of the cut', () => {
  const cut = U(7, 20, 9);
  const g = [game(cut - 1), game(cut)];
  const old = seasonAt(cut - 1, [{ at: cut, name: 'X' }]), neu = seasonAt(cut, [{ at: cut, name: 'X' }]);
  assert.ok(g[0].receivedAt >= old.start && g[0].receivedAt < old.end);
  assert.ok(g[1].receivedAt >= neu.start && g[1].receivedAt < neu.end);
  assert.ok(!(g[1].receivedAt < old.end));
});

test('the next season is named from the organizer, or from the old name', () => {
  assert.equal(nextSeasonName('Summer 2026'), 'Summer 2026, part 2');
  assert.equal(nextSeasonName('Summer 2026, part 2'), 'Summer 2026, part 3');
  assert.equal(nextSeasonName('Summer 2026, part 9'), 'Summer 2026, part 10');
  const long = nextSeasonName('x'.repeat(40));
  assert.ok(long.length <= 40 && long.endsWith(', part 2'), long);
  assert.ok(nextSeasonName(nextSeasonName('y'.repeat(40))).length <= 40);
});

test('consecutive early closes never overlap or repeat a season id, and keep every trophy', () => {
  const c1 = U(7, 10, 9), c2 = U(7, 25, 9), c3 = U(8, 5, 9);
  const cuts = [{ at: c1, name: 'Two' }, { at: c2, name: 'Three' }, { at: c3, name: 'Four' }];
  const seasons = [];
  for (const ts of [U(6, 5), c1 - 1, c1, c2 - 1, c2, c3 - 1, c3, U(8, 29), U(9, 1), U(9, 20)]) seasons.push(seasonAt(ts, cuts));
  // Every moment is inside its own season, and seasons sharing an id are the same season.
  for (const [i, ts] of [U(6, 5), c1 - 1, c1, c2 - 1, c2, c3 - 1, c3, U(8, 29), U(9, 1), U(9, 20)].entries()) assert.ok(seasons[i].start <= ts && ts < seasons[i].end, i);
  const byId = new Map();
  for (const s of seasons) { const o = byId.get(s.id); if (o) assert.deepEqual(o, s); byId.set(s.id, s); }
  const list = [...byId.values()].sort((a, b) => a.start - b.start);
  for (let i = 1; i < list.length; i++) { assert.ok(list[i].start >= list[i - 1].end, 'no overlap'); assert.ok(list[i].end > list[i].start, 'no empty season'); }
  assert.deepEqual(list.map(s => s.name), ['Summer 2026', 'Two', 'Three', 'Four', 'Fall 2026']);
  assert.equal(list[3].end, Date.UTC(2026, 9, 1));
  // Games in each stretch earn that stretch's trophies; nothing is lost or counted twice.
  const games = [...run(U(6, 5), SEASON_MIN_GAMES), ...run(c1 + MIN, SEASON_MIN_GAMES, false), ...run(c2 + MIN, SEASON_MIN_GAMES)];
  const p = computeProgress(games, c3 + MIN, cuts);
  const ana = p.get('ana').trophies, cy = p.get('cy').trophies;
  assert.deepEqual(ana.filter(t => t.mode === 'doubles').map(t => [t.name, t.place]).sort(), [['Summer 2026', 1], ['Three', 1], ['Two', 3]]);
  assert.deepEqual(cy.filter(t => t.mode === 'doubles').map(t => [t.name, t.place]).sort(), [['Summer 2026', 3], ['Three', 3], ['Two', 1]]);
  assert.equal(new Set(ana.map(t => t.season + t.mode)).size, ana.length);
});

test('a season ended early after a custom one runs out at quarter end still works', () => {
  const c1 = U(7, 10, 9), c2 = U(9, 8, 9); // the second close happens in the next quarter, in the calendar Fall season
  const cuts = [{ at: c1, name: 'Two' }, { at: c2, name: 'Three' }];
  const cal = seasonAt(U(9, 7), cuts);
  assert.equal(cal.id, '2026-Q4'); assert.equal(cal.start, Date.UTC(2026, 9, 1)); assert.equal(cal.end, c2);
  assert.equal(seasonAt(c2, cuts).name, 'Three');
  assert.equal(seasonAt(c2, cuts).end, Date.UTC(2027, 0, 1));
});

test('the season before a cut that lies in a later quarter keeps its own bounds', () => {
  const cut = U(10, 3, 9);
  const cuts = [{ at: cut, name: 'Late' }];
  assert.deepEqual(seasonAt(U(7, 15), cuts), seasonOf(U(7, 15)));
  assert.equal(seasonAt(cut - MIN, cuts).end, cut);
});
