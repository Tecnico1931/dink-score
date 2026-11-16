import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counts, confirmBlocker, findDuplicates, DUP_WINDOW_MS } from '../api/_confirm.js';

const g = (id, teams, score, endedAt, extra = {}) => ({ id, mode: teams[0].length === 1 ? 'singles' : 'doubles', teams, score, endedAt, ...extra });
const T = 1.7e12, MIN = 60000;

test('with the setting off every game counts; with it on only confirmed games and event matches do', () => {
  assert.equal(counts(g('a', [['A', 'B'], ['C', 'D']], [11, 5], T), false), true);
  assert.equal(counts(g('a', [['A', 'B'], ['C', 'D']], [11, 5], T), true), false);
  assert.equal(counts(g('a', [['A', 'B'], ['C', 'D']], [11, 5], T, { confirmed: { by: 'c' } }), true), true);
  assert.equal(counts(g('a', [['A', 'B'], ['C', 'D']], [11, 5], T, { event: { id: 'e' } }), true), true);
});

test('only the other team (or an organizer, handled elsewhere) can confirm', () => {
  const game = g('a', [['Ana', 'Ben'], ['Cy', 'Di']], [11, 5], T, { scoredBy: 'ana' });
  assert.match(confirmBlocker(game, 'ana'), /recorded/);
  assert.match(confirmBlocker(game, 'Ben'), /other team/);
  assert.equal(confirmBlocker(game, 'cy'), null);
  assert.equal(confirmBlocker(game, ' DI '), null);
  assert.match(confirmBlocker(game, 'zed'), /player in this game/);
  assert.match(confirmBlocker(game, ''), /player in this game/);
});

test('a game nobody verified (or an organizer sent) can be confirmed by any of its players', () => {
  for (const scoredBy of [undefined, 'organizer', 'zed']) {
    const game = g('a', [['Ana', 'Ben'], ['Cy', 'Di']], [11, 5], T, { scoredBy });
    assert.equal(confirmBlocker(game, 'ana'), null);
    assert.equal(confirmBlocker(game, 'di'), null);
  }
});

test('duplicates: same players and score close in time, whichever side was typed first', () => {
  const a = g('live', [['Ana', 'Ben'], ['Cy', 'Di']], [11, 7], T);
  const b = g('logged', [['di', 'cy'], ['ben', 'ana']], [7, 11], T + 20 * MIN, { logged: true });
  assert.deepEqual(findDuplicates([a, b]), [['live', 'logged']]);
});

test('duplicates: a different score, partner, format or a long gap is not a duplicate', () => {
  const a = g('a', [['Ana', 'Ben'], ['Cy', 'Di']], [11, 7], T);
  assert.deepEqual(findDuplicates([a, g('b', [['Ana', 'Ben'], ['Cy', 'Di']], [11, 8], T + MIN)]), []);
  assert.deepEqual(findDuplicates([a, g('b', [['Ana', 'Cy'], ['Ben', 'Di']], [11, 7], T + MIN)]), [], 'same four, different pairings');
  assert.deepEqual(findDuplicates([a, g('b', [['Ana', 'Ben'], ['Cy', 'Di']], [7, 11], T + MIN)]), [], 'same score but the other side won');
  assert.deepEqual(findDuplicates([a, g('b', [['Ana', 'Ben'], ['Cy', 'Di']], [11, 7], T + DUP_WINDOW_MS + MIN)]), []);
  assert.deepEqual(findDuplicates([g('s1', [['Ana'], ['Ben']], [11, 7], T), g('s2', [['Ana'], ['Ben']], [11, 7], T + MIN)]), [['s1', 's2']]);
  assert.deepEqual(findDuplicates([g('s1', [['Ana'], ['Ben']], [11, 7], T), a]), []);
});

test('duplicates: games an organizer marked "keep both" are left out; three records give every close pair', () => {
  const mk = (id, at, extra) => g(id, [['Ana', 'Ben'], ['Cy', 'Di']], [11, 7], T + at * MIN, extra);
  assert.deepEqual(findDuplicates([mk('a', 0, { dupOk: true }), mk('b', 5)]), []);
  assert.deepEqual(findDuplicates([mk('a', 0), mk('b', 5), mk('c', 10)]), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
  assert.deepEqual(findDuplicates([mk('a', 0), mk('b', 5), mk('c', 400)]), [['a', 'b']]);
});
