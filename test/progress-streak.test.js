import test from 'node:test';
import assert from 'node:assert/strict';
import { computeProgress } from '../api/_progress.js';

const at = Date.UTC(2026, 0, 5, 10);
const game = (id, winner, extra = {}) => ({
  id: `g${id}`, mode: 'doubles', teams: [['Ana', 'Ben'], ['Cy', 'Di']],
  score: winner === 0 ? [11, 5] : [5, 11], winner, endedAt: at + id, receivedAt: at + id, scoredBy: 'ana', ...extra
});
const streak = games => computeProgress(games, Date.UTC(2026, 6, 1)).get('ana').streak;

test('progress exposes an active win streak from chronological verified games', () => {
  assert.equal(streak([game(1, 1)]), 0);
  assert.equal(streak([game(1, 0)]), 1);
  assert.equal(streak([game(1, 0), game(2, 0)]), 2);
  assert.equal(streak([game(1, 0), game(2, 0), game(3, 0)]), 3);
  assert.equal(streak([game(1, 0), game(2, 0), game(3, 0), game(4, 0), game(5, 0)]), 5);
});

test('a loss clears the active win streak immediately', () => {
  assert.equal(streak([game(1, 0), game(2, 0), game(3, 0), game(4, 1)]), 0);
});

test('held games do not affect the streak', () => {
  assert.equal(streak([game(1, 0), game(2, 0), game(3, 0), game(4, 1, { hold: true })]), 3);
});
