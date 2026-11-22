import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLadder, recordChallenge, openChallenge, answerChallenge, closeLadderSeason, view, CHALLENGE_DAYS } from '../api/_league.js';

const DAY = 86400000, T0 = 1_700_000_000_000;
const P = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
const ratings = Object.fromEntries(P(5).map((p, i) => [p, 3 - i * 0.1]));
const ORG = { organizer: true };
const as = name => ({ organizer: false, name });
const make = (extra = {}) => Object.assign(createLadder({ name: 'Ladder', mode: 'singles', players: P(5), jump: 2 }, ratings, T0, () => 0.5), extra);
const send = (L, key, c, d, at = T0, actor = as(c.toLowerCase())) => openChallenge(L, { key, challenger: [c], defender: [d] }, at, actor);

test('a challenge waits for the defender, who accepts or declines; only the defender or an organizer may answer', () => {
  const L = make();
  const r = send(L, 'ch01', 'P3', 'P2');
  assert.equal(r.changed, true);
  assert.equal(view(L, T0).open.length, 1);
  assert.deepEqual(view(L, T0).open[0].defender, ['P2']);
  assert.throws(() => answerChallenge(L, 'ch01', 'accept', T0, as('p3')), /challenged player/);   // the challenger cannot accept for them
  assert.throws(() => answerChallenge(L, 'ch01', 'accept', T0, null), /challenged player/);       // an unproven phone cannot
  answerChallenge(L, 'ch01', 'accept', T0 + DAY, as('p2'));
  assert.equal(view(L, T0 + DAY).open[0].state, 'accepted');
  assert.equal(answerChallenge(L, 'ch01', 'accept', T0 + DAY, ORG).changed, false);               // answering twice is safe
  answerChallenge(L, 'ch01', 'decline', T0 + 2 * DAY, ORG);
  assert.equal(view(L, T0 + 2 * DAY).open.length, 0);
  assert.throws(() => answerChallenge(L, 'ch01', 'accept', T0 + 2 * DAY, ORG), /no longer open/);
});

test('the challenger may withdraw, nobody else but an organizer', () => {
  const L = make();
  send(L, 'ch01', 'P3', 'P2');
  assert.throws(() => answerChallenge(L, 'ch01', 'withdraw', T0, as('p2')), /challenger/);
  answerChallenge(L, 'ch01', 'withdraw', T0, as('p3'));
  assert.equal(view(L, T0).open.length, 0);
});

test('an unanswered challenge lapses after the waiting time, and an accepted one gets a fresh stretch to play', () => {
  const L = make();
  send(L, 'ch01', 'P3', 'P2'); send(L, 'ch02', 'P5', 'P4');
  answerChallenge(L, 'ch02', 'accept', T0 + 6 * DAY, ORG);
  assert.equal(view(L, T0 + CHALLENGE_DAYS * DAY - 1).open.length, 2);
  assert.deepEqual(view(L, T0 + CHALLENGE_DAYS * DAY).open.map(o => o.id), ['ch02']);   // ch01 ran out, ch02 now has until day 13
  assert.equal(view(L, T0 + 13 * DAY).open.length, 0);
  assert.throws(() => answerChallenge(L, 'ch01', 'accept', T0 + 8 * DAY, ORG), /no longer open/);
  assert.equal(view(L, T0).open.length, 2);                                              // nothing was stored: the same data read earlier still shows both
});

test('the same two cannot have two open challenges, a retry is safe, and the order and jump rules apply', () => {
  const L = make();
  assert.equal(send(L, 'ch01', 'P3', 'P2').changed, true);
  assert.equal(send(L, 'ch01', 'P3', 'P2').changed, false);      // a phone retrying
  assert.equal(send(L, 'ch09', 'P3', 'P2').changed, false);      // already open between them
  assert.throws(() => send(L, 'ch01', 'P4', 'P3'), /already used/);
  assert.throws(() => send(L, 'ch02', 'P2', 'P3'), /above you/);
  assert.throws(() => send(L, 'ch03', 'P5', 'P2'), /up to 2 places/);
  assert.throws(() => send(L, 'ch04', 'P3', 'P3'), /themselves/);
  assert.throws(() => send(L, 'ch05', 'P4', 'P3', T0, as('p3')), /challenger or an organizer/);   // not their own challenge
  assert.throws(() => send(L, 'x', 'P4', 'P3'), /key/);
  assert.throws(() => send(L, 'ch06', 'P4', 'Nobody'), /not on this ladder/);
  assert.equal(send(L, 'ch07', 'P4', 'P3', T0, ORG).changed, true);
  L.resultsBy = 'club';
  assert.equal(send(L, 'ch08', 'P5', 'P4', T0, as('someone-else')).changed, true);                  // any member when the organizer allowed it
});

test('playing the match settles the open challenge between the two, and leaves others alone', () => {
  const L = make();
  send(L, 'ch01', 'P3', 'P2'); send(L, 'ch02', 'P5', 'P4');
  const r = recordChallenge(L, { key: 'res1', challenger: ['P3'], defender: ['P2'], score: [11, 4] }, T0 + DAY, ORG);
  assert.equal(r.changed, true);
  assert.deepEqual(view(L, T0 + DAY).open.map(o => o.id), ['ch02']);
  recordChallenge(L, { key: 'res1', challenger: ['P3'], defender: ['P2'], score: [11, 4] }, T0 + DAY, ORG);   // a retry keeps ch02
  assert.deepEqual(view(L, T0 + DAY).open.map(o => o.id), ['ch02']);
});

test('old ladders have none, a closed ladder takes none, and closing a season clears them; counts are capped', () => {
  const old = make(); delete old.open;
  assert.deepEqual(view(old, T0).open, []);
  const L = make();
  send(L, 'ch01', 'P3', 'P2');
  closeLadderSeason(L, 'Season 2', T0 + DAY);
  assert.deepEqual(view(L, T0 + DAY).open, []);
  const done = make({ status: 'done' });
  assert.throws(() => send(done, 'ch01', 'P3', 'P2'), /closed/);
  const big = createLadder({ name: 'Big', mode: 'singles', players: Array.from({ length: 32 }, (_, i) => 'Q' + (i + 1)), jump: 10 }, {}, T0, () => 0.5);
  let n = 0;
  assert.throws(() => { for (let i = 1; i < 32; i++) for (let j = Math.max(0, i - 10); j < i; j++) { openChallenge(big, { key: 'k' + (n++ + 1000), challenger: ['Q' + (i + 1)], defender: ['Q' + (j + 1)] }, T0, ORG); } }, /too many open/);
  assert.equal(big.open.length, 30);
});
