import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeague, recordLeagueResult, divisionTable, nextSeason, view, tiebreakOf, moveOf, maxMoveFor, DEFAULT_TIEBREAK } from '../api/_league.js';
import { leaguePublicView } from '../api/_share.js';
import { rewriteNames } from '../api/_rename.js';

const ORG = { organizer: true, name: null };
const rand = () => 0.5;
const rate = players => Object.fromEntries(players.map((p, i) => [p, 3 - i * 0.1]));

// Play the next pending match between singles players `a` and `b`, recording `scoreAB` from a's point of view.
function play(L, a, b, scoreAB) {
  const m = L.weeks.flatMap(w => w.matches).find(x => x.status === 'pending' && ((x.teams[0][0] === a && x.teams[1][0] === b) || (x.teams[0][0] === b && x.teams[1][0] === a)));
  assert.ok(m, `pending match ${a} vs ${b}`);
  const score = m.teams[0][0] === a ? scoreAB : [scoreAB[1], scoreAB[0]];
  recordLeagueResult(L, m.id, { score, endedAt: 5000 }, 5000, ORG);
}

test('legacy leagues without tiebreak or move keep today’s exact order (diff, pf, name) and move=1', () => {
  const players = ['Ann', 'Bo', 'Cat', 'Dev'];
  // Cat & Dev: 2W 1L, diff +1, pf 31 (Cat beat Dev 11-9). Ann & Bo: 1W 2L, diff -1, pf 30 (Bo beat Ann 11-9).
  const results = [['Bo', 'Ann', [11, 9]], ['Ann', 'Cat', [11, 9]], ['Dev', 'Ann', [11, 10]], ['Cat', 'Bo', [11, 10]], ['Dev', 'Bo', [11, 9]], ['Cat', 'Dev', [11, 9]]];
  const old = createLeague({ name: 'Old', mode: 'singles', players }, rate(players), 1000, rand);
  delete old.tiebreak; delete old.move;
  for (const [a, b, sc] of results) play(old, a, b, sc);
  assert.deepEqual(tiebreakOf(old), ['diff', 'pf']);
  assert.deepEqual(divisionTable(old, 0).map(r => r.name), ['Cat', 'Dev', 'Ann', 'Bo']); // alphabetical beats h2h on legacy

  const fresh = createLeague({ name: 'Fresh', mode: 'singles', players }, rate(players), 1000, rand);
  for (const [a, b, sc] of results) play(fresh, a, b, sc);
  assert.deepEqual(tiebreakOf(fresh), DEFAULT_TIEBREAK);
  assert.deepEqual(divisionTable(fresh, 0).map(r => r.name), ['Cat', 'Dev', 'Bo', 'Ann']); // default has h2h 3rd before name
});

test('head-to-head first beats a bigger point difference; default puts point difference first', () => {
  const players = ['Ann', 'Bo', 'Cat', 'Dev'];
  // Ann: 2W 1L, diff -3, pf 26 (beat Bo 11-9). Bo: 2W 1L, diff +16, pf 31.
  // Cat: 1W 2L, diff -10, pf 21 (beat Dev 11-9). Dev: 1W 2L, diff -3, pf 23.
  const results = [['Ann', 'Bo', [11, 9]], ['Ann', 'Cat', [11, 9]], ['Dev', 'Ann', [11, 4]], ['Bo', 'Cat', [11, 1]], ['Bo', 'Dev', [11, 3]], ['Cat', 'Dev', [11, 9]]];
  const make = tiebreak => {
    const L = createLeague({ name: 'L', mode: 'singles', players, tiebreak }, rate(players), 1000, rand);
    for (const [a, b, sc] of results) play(L, a, b, sc);
    return divisionTable(L, 0).map(r => r.name);
  };
  assert.deepEqual(make(['diff', 'pf', 'h2h']), ['Bo', 'Ann', 'Dev', 'Cat']);
  assert.deepEqual(make(['h2h', 'diff', 'pf']), ['Ann', 'Bo', 'Cat', 'Dev']);
});

test('points for first vs point difference first, and circular 3-way h2h falling through to the next rule', () => {
  const players = ['Ann', 'Bo', 'Cat', 'Dev'];
  // Bo: 3W 0L. Ann/Cat/Dev all 1W 2L in a 3-way circle (Ann>Cat, Cat>Dev, Dev>Ann).
  // Cat: diff +2, pf 25. Ann: diff -2, pf 33. Dev: diff -15, pf 17.
  const results = [['Bo', 'Ann', [14, 12]], ['Bo', 'Cat', [11, 5]], ['Bo', 'Dev', [11, 4]], ['Ann', 'Cat', [11, 9]], ['Cat', 'Dev', [11, 1]], ['Dev', 'Ann', [12, 10]]];
  const make = tiebreak => {
    const L = createLeague({ name: 'L', mode: 'singles', players, tiebreak }, rate(players), 1000, rand);
    for (const [a, b, sc] of results) play(L, a, b, sc);
    return divisionTable(L, 0).map(r => r.name);
  };
  assert.deepEqual(make(['diff', 'pf', 'h2h']), ['Bo', 'Cat', 'Ann', 'Dev']);
  assert.deepEqual(make(['pf', 'diff', 'h2h']), ['Bo', 'Ann', 'Cat', 'Dev']);
  assert.deepEqual(make(['h2h', 'diff', 'pf']), ['Bo', 'Cat', 'Ann', 'Dev']); // circular h2h -> diff
  assert.deepEqual(make(['h2h', 'pf', 'diff']), ['Bo', 'Ann', 'Cat', 'Dev']); // circular h2h -> pf
});

test('diff then h2h then pf: diff narrows a 3-way tie to 2, then h2h beats pf', () => {
  const players = ['Ann', 'Bo', 'Cat', 'Dev'];
  // Dev: 3W 0L. Ann: 1W 2L, diff -1, pf 32. Bo: 1W 2L, diff -3, pf 34. Cat: 1W 2L, diff -3, pf 27 (Cat beat Bo 11-8).
  const results = [['Dev', 'Ann', [11, 9]], ['Dev', 'Bo', [14, 12]], ['Dev', 'Cat', [11, 8]], ['Ann', 'Cat', [11, 8]], ['Cat', 'Bo', [11, 8]], ['Bo', 'Ann', [14, 12]]];
  const make = tiebreak => {
    const L = createLeague({ name: 'L', mode: 'singles', players, tiebreak }, rate(players), 1000, rand);
    for (const [a, b, sc] of results) play(L, a, b, sc);
    return divisionTable(L, 0).map(r => r.name);
  };
  assert.deepEqual(make(['diff', 'pf', 'h2h']), ['Dev', 'Ann', 'Bo', 'Cat']);
  assert.deepEqual(make(['diff', 'h2h', 'pf']), ['Dev', 'Ann', 'Cat', 'Bo']);
});

test('2-leg split 1-1 falls through from h2h; mid-season unplayed pairs skip h2h', () => {
  const players = ['Ann', 'Bo', 'Cat', 'Dev'];
  const two = createLeague({ name: '2-leg', mode: 'singles', players, legs: 2, tiebreak: ['h2h', 'diff', 'pf'] }, rate(players), 1000, rand);
  play(two, 'Ann', 'Bo', [11, 2]);
  play(two, 'Bo', 'Ann', [11, 9]); // 1-1 split: Ann +7, Bo -7 -> falls through to diff
  assert.deepEqual(divisionTable(two, 0).slice(0, 2).map(r => r.name), ['Ann', 'Bo']);

  // Mid-season 3-way tie at 1W: Ann beat Bo (+2), Bo beat Dev (+10 -> +8), Cat beat Dev (+9). Cat has not played Ann or Bo, so h2h skips to diff.
  const mid = createLeague({ name: 'Mid', mode: 'singles', players, tiebreak: ['h2h', 'diff', 'pf'] }, rate(players), 1000, rand);
  play(mid, 'Ann', 'Bo', [11, 9]);
  play(mid, 'Bo', 'Dev', [11, 1]);
  play(mid, 'Cat', 'Dev', [11, 2]);
  assert.deepEqual(divisionTable(mid, 0).map(r => r.name), ['Cat', 'Bo', 'Ann', 'Dev']);
});

test('4-way tie with 2-2-1-1 mini-table splits and resolves both 2-way sub-ties by h2h', () => {
  const players = ['Ann', 'Bo', 'Cat', 'Dev', 'Eli', 'Fay'];
  const L = createLeague({ name: 'Six', mode: 'singles', players, tiebreak: ['h2h', 'diff', 'pf'] }, rate(players), 1000, rand);
  // Eli 4W 1L, Fay 3W 2L. Ann, Bo, Cat, Dev all 2W 3L.
  // Within {Ann, Bo, Cat, Dev}: Ann & Dev are 2-1 (Dev beat Ann); Bo & Cat are 1-2 (Cat beat Bo).
  // Give Bo and Cat huge diff over Eli/Fay so diff would put them above Ann & Dev, proving h2h drives the order.
  const results = [
    ['Ann', 'Bo', [11, 9]], ['Ann', 'Cat', [11, 9]], ['Dev', 'Ann', [11, 9]],
    ['Dev', 'Cat', [11, 9]], ['Bo', 'Dev', [11, 9]], ['Cat', 'Bo', [11, 9]],
    ['Eli', 'Ann', [11, 1]], ['Eli', 'Dev', [11, 1]], ['Eli', 'Cat', [11, 9]], ['Bo', 'Eli', [11, 0]], ['Eli', 'Fay', [11, 5]],
    ['Fay', 'Ann', [11, 1]], ['Fay', 'Dev', [11, 1]], ['Fay', 'Bo', [11, 9]], ['Cat', 'Fay', [11, 0]]
  ];
  for (const [a, b, sc] of results) play(L, a, b, sc);
  assert.deepEqual(divisionTable(L, 0).map(r => r.name), ['Eli', 'Fay', 'Dev', 'Ann', 'Cat', 'Bo']);
});

test('doubles head-to-head works on 2-player teams, and rename never corrupts tiebreak keys', () => {
  const players = ['Diff', 'Pf', 'H2h', 'Ann', 'Bo', 'Cat'];
  const teams = [['Diff', 'Pf'], ['H2h', 'Ann'], ['Bo', 'Cat']];
  const L = createLeague({ name: 'D', mode: 'doubles', players, teams, tiebreak: ['h2h', 'diff', 'pf'] }, {}, 1000, rand);
  assert.equal(typeof L.tiebreak, 'string', 'stored as string so rewriteNames ignores it');
  const renamed = rewriteNames(L, new Map([['diff', 'Pat'], ['pf', 'Sam']]));
  assert.equal(renamed.value.tiebreak, 'h2h,diff,pf');

  // Play doubles: Team0 beats Team1 (11-9), Team1 beats Team2 (11-0), Team0 loses to Team2 (0-11)? Wait: make 2-way tie at 1W!
  // With 3 teams, 2-way tie happens if only 2 matches played: T0 beats T1 (11-9), T1 beats T2 (11-1). Now T0 (1W, +2) and T1 (1W, +8) tie; T0 beat T1 -> T0 #1!
  const ms = L.weeks.flatMap(w => w.matches);
  const find = (a, b) => ms.find(m => m.teams.some(t => t.includes(a)) && m.teams.some(t => t.includes(b)));
  const m01 = find('Diff', 'H2h'), m12 = find('H2h', 'Bo');
  recordLeagueResult(L, m01.id, { score: m01.teams[0].includes('Diff') ? [11, 9] : [9, 11], endedAt: 5000 }, 5000, ORG);
  recordLeagueResult(L, m12.id, { score: m12.teams[0].includes('H2h') ? [11, 1] : [1, 11], endedAt: 5000 }, 5000, ORG);
  assert.deepEqual(divisionTable(L, 0).map(r => r.members), [['Diff', 'Pf'], ['H2h', 'Ann'], ['Bo', 'Cat']]);
});

test('tiebreak validation rejects unknown, duplicate or missing keys and accepts string or array', () => {
  const players = ['Ann', 'Bo', 'Cat', 'Dev'];
  for (const bad of [[], ['diff', 'pf'], ['diff', 'diff', 'pf'], ['wins', 'diff', 'pf'], 42, 'bad']) {
    assert.throws(() => createLeague({ name: 'L', mode: 'singles', players, tiebreak: bad }, {}, 1000, rand), /Tie-breakers/);
  }
  const fromStr = createLeague({ name: 'L', mode: 'singles', players, tiebreak: 'pf,h2h,diff' }, {}, 1000, rand);
  assert.deepEqual(tiebreakOf(fromStr), ['pf', 'h2h', 'diff']);
});

test('promotion and relegation counts: 0 keeps divisions, 2 swaps top/bottom 2 across 2 or 3 divisions, carries over and overrides', () => {
  const P = n => Array.from({ length: n }, (_, i) => 'P' + String(i + 1).padStart(2, '0'));
  const playOrdered = L => {
    for (const m of L.weeks.flatMap(w => w.matches)) {
      const w0 = m.teams[0][0] < m.teams[1][0]; // P01 beats P02 beats ...
      recordLeagueResult(L, m.id, { score: w0 ? [11, 5] : [5, 11], endedAt: 5000 }, 5000, ORG);
    }
  };
  const divs = L => L.divisions.map(dv => dv.entries.map(i => L.entries[i][0]).sort());

  // 2 divisions of 4: maxMove is 2
  const two = createLeague({ name: 'Two', mode: 'singles', players: P(8), divisions: 2, move: 2, tiebreak: ['h2h', 'diff', 'pf'] }, rate(P(8)), 1000, rand);
  assert.equal(two.move, 2);
  assert.equal(maxMoveFor(two.divisions), 2);
  playOrdered(two);
  const twoNext = nextSeason(two, {}, 2000, rand);
  assert.equal(twoNext.move, 2);
  assert.deepEqual(tiebreakOf(twoNext), ['h2h', 'diff', 'pf']); // tiebreak carries over
  assert.deepEqual(divs(twoNext), [['P01', 'P02', 'P05', 'P06'], ['P03', 'P04', 'P07', 'P08']]);

  // Override to 0 at nextSeason: everyone stays in the same division
  const stay = nextSeason(two, { move: 0 }, 2000, rand);
  assert.equal(stay.move, 0);
  assert.deepEqual(divs(stay), [['P01', 'P02', 'P03', 'P04'], ['P05', 'P06', 'P07', 'P08']]);

  // 3 divisions of 5: maxMove is 2 (top 2 up, middle 1 stays, bottom 2 down — sizes stay 5)
  const three = createLeague({ name: 'Three', mode: 'singles', players: P(15), divisions: 3, move: 99 }, rate(P(15)), 1000, rand);
  assert.equal(three.move, 2, 'clamped to maxMove');
  playOrdered(three);
  const threeNext = nextSeason(three, {}, 2000, rand);
  assert.deepEqual(divs(threeNext), [
    ['P01', 'P02', 'P03', 'P06', 'P07'],
    ['P04', 'P05', 'P08', 'P11', 'P12'],
    ['P09', 'P10', 'P13', 'P14', 'P15']
  ]);

  // null/empty move uses default 1, negative clamps to 0, 1 division is always 0
  assert.equal(createLeague({ name: 'A', mode: 'singles', players: P(8), divisions: 2, move: null }, {}, 1000, rand).move, 1);
  assert.equal(createLeague({ name: 'B', mode: 'singles', players: P(8), divisions: 2, move: '' }, {}, 1000, rand).move, 1);
  assert.equal(createLeague({ name: 'C', mode: 'singles', players: P(8), divisions: 2, move: -3 }, {}, 1000, rand).move, 0);
  assert.equal(createLeague({ name: 'D', mode: 'singles', players: P(4), divisions: 1, move: 2 }, {}, 1000, rand).move, 0);
  const leg = createLeague({ name: 'E', mode: 'singles', players: P(8), divisions: 2 }, {}, 1000, rand);
  delete leg.move;
  assert.equal(moveOf(leg), 1);
});

test('view and leaguePublicView expose tiebreak, move and pf without leaking private fields', () => {
  const players = ['Ann', 'Bo', 'Cat', 'Dev', 'Eli', 'Fay', 'Gus', 'Hal'];
  const L = createLeague({ name: 'Pub', mode: 'singles', players, divisions: 2, move: 2, tiebreak: ['pf', 'h2h', 'diff'] }, rate(players), 1000, rand);
  play(L, 'Ann', 'Bo', [11, 4]);
  const v = view(L);
  assert.deepEqual(v.tiebreak, ['pf', 'h2h', 'diff']);
  assert.equal(v.move, 2);
  assert.equal(v.maxMove, 2);

  const pub = leaguePublicView(L), text = JSON.stringify(pub);
  assert.deepEqual(pub.tiebreak, ['pf', 'h2h', 'diff']);
  assert.equal(pub.move, 2);
  assert.equal(pub.divisions[0].rows[0].pf, 11);
  for (const hidden of [L.id, L.weeks[0].matches[0].id, 'resultsBy', 'seeds', 'previous', 'maxMove']) assert.ok(!text.includes(hidden), hidden);
});
