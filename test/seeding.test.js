import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ratingMap, seedTeams, splitDivisions, divisionInputs } from '../api/_seeding.js';
import { createEvent } from '../api/_events.js';
import { compute, START } from '../api/_rating.js';

const NOW = Date.UTC(2026, 5, 1, 12);
const names = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
// P1 strongest ... Pn weakest
const ladder = list => Object.fromEntries(list.map((p, i) => [p, 6 - i * 0.1]));

test('ratingMap reads the stored doubles ratings by name and gives START to anyone without games', () => {
  const stored = { players: { doubles: { 'ana lopez': { rating: 4.2 } }, singles: { 'ben': { rating: 7 } } } };
  assert.deepEqual(ratingMap(stored, ['Ana  Lopez', 'Ben']), { 'Ana  Lopez': 4.2, Ben: START });
  assert.deepEqual(ratingMap(null, ['X']), { X: START });
});

test('ratingMap agrees with the engine: a player who won is above one who lost', () => {
  const games = [{ id: 'g1', mode: 'doubles', teams: [['A', 'B'], ['C', 'D']], score: [11, 3], winner: 0, endedAt: 1 }];
  const t = compute(games).tables.doubles;
  const stored = { players: { doubles: Object.fromEntries([...t].map(([k, p]) => [k, { rating: p.rating }])) } };
  const r = ratingMap(stored, ['A', 'C']);
  assert.ok(r.A > r.C);
});

test('seedTeams puts the strongest team first and is stable on ties', () => {
  const r = { a: 3, b: 3, c: 5, d: 5, e: 4, f: 4, g: 2, h: 2 };
  const s = seedTeams([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']], r);
  assert.deepEqual(s.teams, [['c', 'd'], ['e', 'f'], ['a', 'b'], ['g', 'h']]);
  assert.deepEqual(s.seeds, [5, 4, 3, 2]);
  assert.deepEqual(seedTeams([['x', 'y'], ['z', 'w']], {}).teams, [['x', 'y'], ['z', 'w']]);
});

test('splitDivisions: strongest in Division A, sizes even, fixed teams get even divisions', () => {
  const p = names(10), r = ladder(p);
  const d = splitDivisions(p, r, 2, { fixed: true });
  assert.deepEqual(d.map(x => x.players.length), [6, 4]);
  assert.deepEqual(d[0].players, ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  assert.equal(d[0].label, 'Division A');
  const rot = splitDivisions(names(9), ladder(names(9)), 2);
  assert.deepEqual(rot.map(x => x.players.length), [5, 4]);
  assert.deepEqual(splitDivisions(names(12), ladder(names(12)), 3).map(x => x.players.length), [4, 4, 4]);
});

test('splitDivisions refuses too few players, a bad count and an odd fixed field', () => {
  assert.throws(() => splitDivisions(names(7), {}, 2), /too few/);
  assert.throws(() => splitDivisions(names(12), {}, 1), /2 to 4/);
  assert.throws(() => splitDivisions(names(12), {}, 5), /2 to 4/);
  assert.throws(() => splitDivisions(names(9), {}, 2, { fixed: true }), /even/);
});

test('createEvent seeds fixed teams by rating: seed 1 is the strongest team and the bracket follows that order', () => {
  const p = names(8), r = { P1: 2, P2: 2, P3: 6, P4: 6, P5: 4, P6: 4, P7: 3, P8: 3 };
  const ev = createEvent({ name: 'Cup', format: 'single_elim', rotation: 'manual', teams: [['P1', 'P2'], ['P3', 'P4'], ['P5', 'P6'], ['P7', 'P8']], players: p, courts: 2, seeding: 'rating', ratings: r }, NOW);
  assert.deepEqual(ev.teams.map(t => t.join('+')), ['P3+P4', 'P5+P6', 'P7+P8', 'P1+P2']);
  assert.deepEqual(ev.seeds, [6, 4, 3, 2]);
  assert.equal(ev.seeding, 'rating');
  assert.deepEqual(ev.bracket.teams[0], ['P3', 'P4']);
});

test('without seeding the team order is untouched', () => {
  const ev = createEvent({ name: 'Cup', format: 'single_elim', rotation: 'manual', teams: [['P1', 'P2'], ['P3', 'P4']], players: names(4), ratings: { P3: 9, P4: 9 } }, NOW);
  assert.deepEqual(ev.teams[0], ['P1', 'P2']);
  assert.equal(ev.seeds, undefined);
});

test('divisionInputs makes one seeded event per division and each is a valid event', () => {
  const p = names(16), r = ladder(p);
  const ins = divisionInputs({ name: 'Club cup', format: 'single_elim', rotation: 'auto', players: p, courts: 2, divisions: 2 }, r, NOW);
  assert.equal(ins.length, 2);
  const evs = ins.map(i => createEvent(i, NOW));
  assert.deepEqual(evs.map(e => e.name), ['Club cup · Division A', 'Club cup · Division B']);
  assert.deepEqual(evs.map(e => e.division), [{ n: 1, of: 2, label: 'Division A' }, { n: 2, of: 2, label: 'Division B' }]);
  assert.deepEqual(evs[0].players, p.slice(0, 8));
  assert.ok(evs[0].seeds.every((v, i, a) => !i || a[i - 1] >= v));
  assert.notEqual(ins[0].seed, ins[1].seed);
});

test('divisionInputs keeps a long name within 40 characters and refuses hand-picked teams and imports', () => {
  const long = 'x'.repeat(40);
  const ins = divisionInputs({ name: long, format: 'roundrobin', partners: 'rotating', players: names(8), divisions: 2 }, {}, NOW);
  assert.ok(ins.every(i => i.name.length <= 40 && i.name.endsWith('Division ' + 'AB'[ins.indexOf(i)])));
  assert.throws(() => divisionInputs({ name: 'n', format: 'single_elim', rotation: 'manual', players: names(8), divisions: 2 }, {}), /hand-picked/);
  assert.throws(() => divisionInputs({ name: 'n', format: 'roundrobin', partners: 'fixed', rotation: 'auto', players: names(8), teamMeta: [], divisions: 2 }, {}), /hand-picked/);
});
