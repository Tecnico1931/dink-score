import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBoard, setConfig, checkIn, checkOut, rest, suggest, call, finish, cancel, repair, liveFor, view, courtOf, LIMITS } from '../api/_court.js';

const names = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
const room = (n, cfg = {}) => names(n).reduce(checkIn, emptyBoard(cfg));
const playing = b => b.courts.flatMap(c => (c && c.teams ? c.teams.flat() : c && c.hold ? c.hold : []));
// the board's own rules: queue is a subset of present, nobody waits and plays, nobody twice
const sound = b => {
  const all = [...b.queue, ...playing(b)];
  assert.equal(new Set(all).size, all.length, 'a name appears twice');
  for (const p of all) assert.ok(b.present.includes(p), p + ' is not checked in');
};

test('check in and out keep the queue in arrival order, once each', () => {
  let b = room(5);
  assert.deepEqual(b.queue, names(5));
  assert.equal(checkIn(b, 'p2'), b, 'checking in twice (any case) changes nothing');
  b = checkOut(b, 'P3');
  assert.deepEqual(b.queue, ['P1', 'P2', 'P4', 'P5']);
  assert.deepEqual(b.present, ['P1', 'P2', 'P4', 'P5']);
  assert.equal(checkOut(b, 'Nobody'), b);
});

test('the board holds a bounded crowd', () => {
  let b = emptyBoard();
  for (let i = 0; i < LIMITS.present; i++) b = checkIn(b, 'N' + i);
  assert.throws(() => checkIn(b, 'One more'), e => e.status === 409);
});

test('the first four in line are called, the longest waiting first', () => {
  const b = room(6);
  const [s] = suggest(b);
  assert.equal(s.court, 1);
  const four = s.teams.flat();
  assert.equal(four.length, 4);
  assert.ok(four.includes('P1'), 'the longest wait always plays');
  assert.ok(!four.includes('P6'), 'the back of a six-player queue sits this one out');
});

test('fewer than four waiting: no suggestion, and calling says why', () => {
  const b = room(3);
  assert.deepEqual(suggest(b), []);
  assert.throws(() => call(b, 1), e => e.status === 409);
});

test('singles call two players', () => {
  const b = room(5, { format: 'singles' });
  assert.deepEqual(suggest(b).map(s => s.teams.flat().length), [2, 2, 2].slice(0, 2));
  const c = call(b, 1);
  assert.equal(c.courts[0].teams.length, 2);
  assert.deepEqual(c.queue.length, 3);
});

test('several free courts take consecutive groups from the queue', () => {
  const b = room(10, { courts: 2 });
  const s = suggest(b);
  assert.equal(s.length, 2);
  const flat = s.flatMap(x => x.teams.flat());
  assert.equal(new Set(flat).size, 8);
  assert.ok(!flat.includes('P10') && !flat.includes('P9'));
});

test('calling puts the group on the court and takes it out of the queue', () => {
  let b = room(6);
  b = call(b, 2);
  sound(b);
  assert.equal(b.queue.length, 2);
  assert.equal(b.courts[1].teams.flat().length, 4);
  assert.equal(courtOf(b, b.courts[1].teams[0][0]), 2);
  assert.throws(() => call(b, 2), e => e.status === 409, 'court in use');
  assert.throws(() => call(b, 9), e => e.status === 400, 'no such court');
});

test('a hand-picked group must be waiting, once each, and the right size', () => {
  const b = room(6);
  assert.ok(call(b, 1, [['P6', 'P5'], ['P4', 'P3']]).courts[0].teams);
  assert.throws(() => call(b, 1, [['P1', 'P1'], ['P2', 'P3']]), e => e.status === 400);
  assert.throws(() => call(b, 1, [['P1', 'Stranger'], ['P2', 'P3']]), e => e.status === 409);
  assert.throws(() => call(b, 1, [['P1'], ['P2']]), e => e.status === 400);
  assert.throws(() => call(b, 1, 'x'), e => e.status === 400);
});

test('a player on a court can neither check out nor sit out', () => {
  const b = call(room(6), 1);
  const on = b.courts[0].teams[0][0];
  assert.throws(() => checkOut(b, on), e => e.status === 409);
  assert.throws(() => rest(b, on), e => e.status === 409);
});

test('rotate: a finished game frees the court and all four go to the back, winners first', () => {
  let b = call(room(8), 1);
  const [A, B] = b.courts[0].teams;
  b = finish(b, 1, 1);
  sound(b);
  assert.equal(b.courts[0], null);
  assert.deepEqual(b.queue.slice(-4), [...B, ...A]);
  assert.equal(b.history.length, 1);
  assert.throws(() => finish(b, 1, 0), e => e.status === 409, 'nothing to finish');
});

test('finish needs a winner of 0 or 1', () => {
  const b = call(room(4), 1);
  assert.throws(() => finish(b, 1), e => e.status === 400);
  assert.throws(() => finish(b, 1, 2), e => e.status === 400);
});

test('winners stay: the winners hold the court, losers join the queue, challengers are the next two', () => {
  let b = call(room(8, { mode: 'winners-stay' }), 1);
  const [A, B] = b.courts[0].teams;
  b = finish(b, 1, 0);
  sound(b);
  assert.deepEqual(b.courts[0].hold, A);
  assert.deepEqual(b.queue.slice(-2), B);
  const [s] = suggest(b);
  assert.deepEqual(s.teams[0], A);
  assert.equal(s.teams[1].length, 2);
  assert.ok(!s.teams[1].some(p => A.includes(p)));
  b = call(b, 1);
  sound(b);
  assert.equal(b.courts[0].streak, 1);
  assert.equal(b.courts[0].stay, 0);
  assert.deepEqual(b.courts[0].teams[0], A);
});

test('winners stay only up to the limit, then everyone rotates off', () => {
  let b = room(12, { mode: 'winners-stay', stayLimit: 2 });
  b = call(b, 1);
  const A = b.courts[0].teams[0];
  b = finish(b, 1, 0);           // streak 1: stays
  assert.ok(b.courts[0].hold);
  b = call(b, 1);
  assert.deepEqual(b.courts[0].teams[0], A);
  b = finish(b, 1, 0);           // streak 2 = limit: off
  assert.equal(b.courts[0], null);
  assert.deepEqual(b.queue.slice(-4, -2), A, 'winners, then losers, at the back');
  sound(b);
});

test('challengers who win take over, with a streak of one', () => {
  let b = call(room(8, { mode: 'winners-stay' }), 1);
  b = finish(b, 1, 0);
  b = call(b, 1);
  const challengers = b.courts[0].teams[1];
  b = finish(b, 1, 1);
  assert.deepEqual(b.courts[0].hold, challengers);
  assert.equal(b.courts[0].streak, 1);
});

test('holding winners must be the first team when a group is picked by hand', () => {
  let b = call(room(8, { mode: 'winners-stay' }), 1);
  const A = b.courts[0].teams[0];
  b = finish(b, 1, 0);
  const [x, y] = b.queue.slice(0, 2);
  assert.throws(() => call(b, 1, [[x, y], A]), e => e.status === 409);
  assert.ok(call(b, 1, [A, [x, y]]).courts[0].teams);
});

test('cancel sends everyone back to the front of the queue', () => {
  let b = call(room(8), 1);
  const four = b.courts[0].teams.flat();
  b = cancel(b, 1);
  sound(b);
  assert.deepEqual(b.queue.slice(0, 4), four);
  assert.throws(() => cancel(b, 1), e => e.status === 409);
});

test('rest moves a waiting player to the back', () => {
  const b = rest(room(6), 'P1');
  assert.deepEqual(b.queue, ['P2', 'P3', 'P4', 'P5', 'P6', 'P1']);
  assert.throws(() => rest(b, 'Nobody'), e => e.status === 409);
});

test('fair rotation: over many games nobody partners the same person again before they have to', () => {
  // Six players, one court, rotate. With the rotation counts, partner repeats stay as even as the numbers allow.
  let b = room(6, { courts: 1 });
  const partners = new Map();
  for (let g = 0; g < 15; g++) {
    b = call(b, 1);
    for (const t of b.courts[0].teams) { const k = [...t].sort().join('+'); partners.set(k, (partners.get(k) || 0) + 1); }
    b = finish(b, 1, g % 2);
    sound(b);
  }
  const counts = [...partners.values()];
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 2, 'partner counts too uneven: ' + JSON.stringify([...partners]));
  assert.ok(partners.size >= 12, 'only ' + partners.size + ' different partnerships in 15 games');
  // and everyone plays about the same: the queue gives the longest wait first
  const played = new Map(b.history.flatMap(m => m.teams.flat()).map(p => [p, 0]));
  for (const m of b.history) for (const p of m.teams.flat()) played.set(p, played.get(p) + 1);
  assert.ok(Math.max(...played.values()) - Math.min(...played.values()) <= 1, JSON.stringify([...played]));
});

test('a repeat partner is avoided when the window offers a fresh one', () => {
  let b = room(8, { courts: 1 });
  b = call(b, 1, [['P1', 'P2'], ['P3', 'P4']]);
  b = finish(b, 1, 0);
  // queue is now P5..P8, then P1, P2, P3, P4: the next game is P5..P8 and nobody has partnered before
  b = call(b, 1);
  b = finish(b, 1, 0);
  // queue: P1 P2 P3 P4 P5 P6 P7 P8 order (winners first): the head P1 must not be put with P2 again if avoidable
  const [s] = suggest(b);
  const team = s.teams.find(t => t.includes('P1'));
  assert.ok(!team.includes('P2'), 'P1 and P2 partnered in the first game: ' + JSON.stringify(s.teams));
});

test('settings are validated, and changes that would strand a game are refused', () => {
  const b = emptyBoard();
  assert.throws(() => setConfig(b, { courts: 0 }), e => e.status === 400);
  assert.throws(() => setConfig(b, { courts: LIMITS.courts + 1 }), e => e.status === 400);
  assert.throws(() => setConfig(b, { format: 'triples' }), e => e.status === 400);
  assert.throws(() => setConfig(b, { mode: 'x' }), e => e.status === 400);
  assert.throws(() => setConfig(b, { control: 'anyone' }), e => e.status === 400);
  assert.throws(() => setConfig(b, { stayLimit: 0 }), e => e.status === 400);
  const busy = call(room(8, { courts: 2 }), 2);
  assert.throws(() => setConfig(busy, { courts: 1 }), e => e.status === 409);
  assert.throws(() => setConfig(busy, { format: 'singles' }), e => e.status === 409);
  assert.equal(setConfig(busy, { courts: 3 }).courts.length, 3);
  assert.equal(setConfig(room(4, { courts: 4 }), { courts: 2 }).courts.length, 2);
});

test('repair after a merge: no name twice, nobody waiting while on a court', () => {
  const b = { ...room(6), queue: ['P1', 'p1', 'P2', 'Gone'] };
  const r = repair(b);
  assert.deepEqual(r.queue, ['P1', 'P2']);
});

test('the live game for a court is found by its players, in any side order, and its score follows the court', () => {
  const b = call(room(4, { courts: 1 }), 1, [['P1', 'P2'], ['P3', 'P4']]);
  const court = b.courts[0];
  const games = [
    { id: 'other', teams: [['P1', 'P9'], ['P3', 'P4']], score: [1, 1], winner: null },
    { id: 'live-1', teams: [['p4', 'P3'], ['P2', 'p1']], score: [7, 4], winner: 0 }
  ];
  assert.deepEqual(liveFor(court, games), { id: 'live-1', score: [4, 7], winner: 1 });
  assert.equal(liveFor(court, [games[0]]), null);
  assert.equal(liveFor(null, games), null);
  assert.deepEqual(view(b, games).courts[0].live.score, [4, 7]);
});
