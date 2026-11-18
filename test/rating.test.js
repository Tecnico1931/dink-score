import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { START, replay } from '../api/_progress.js';

// The client's copy of the rating engine (the DR block, generated from rating-engine.js), pulled out of dink-score.html so the app's copy is held to the same numbers as the server's import.
const html = readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
const DR = new Function(html.match(/const DR = \(\(\) => \{[\s\S]*?\n\}\)\(\);/)[0].replace('const DR =', 'return') );
const client = DR();

const game = (id, score, endedAt, mode = 'doubles') => ({ id, mode, score, endedAt, teams: mode === 'singles' ? [['A'], ['B']] : [['A', 'B'], ['C', 'D']] });

test('new players start at 2.00 on the server and the client', () => {
  assert.equal(START, 2);
  assert.equal(client.START, 2);
  assert.equal(client.forecast({ doubles: new Map(), singles: new Map() }, 'doubles', [['X', 'Y'], ['Z', 'W']], 11).ratings[0], 2);
});

test('the first game moves everyone from 2.00: winners rise, losers stay at the 2.00 floor', () => {
  const games = [game('g1', [11, 3], 1e12)];
  const s = replay(games).tables.doubles, c = client.compute(games).tables.doubles;
  for (const t of [s, c]) {
    assert.ok(t.get('a').rating > 2 && t.get('b').rating > 2);
    assert.equal(t.get('c').rating, 2);
    assert.equal(t.get('d').rating, 2);
  }
  assert.equal(s.get('a').rating, c.get('a').rating);
});

test('server and client replay a long history to identical ratings, never below 2.00', () => {
  const games = Array.from({ length: 60 }, (_, i) => game('g' + i, i % 3 ? [11, i % 9] : [i % 7, 11], 1e12 + i * 36e5, i % 4 ? 'doubles' : 'singles'));
  const s = replay(games).tables, c = client.compute(games).tables;
  for (const mode of ['doubles', 'singles']) for (const [k, p] of s[mode]) {
    assert.ok(Math.abs(p.rating - c[mode].get(k).rating) < 1e-12);
    assert.ok(p.rating >= 2 && p.rating <= 8);
  }
});

import { compute, CAP, PROVISIONAL, VERSION, isProvisional } from '../api/_rating.js';

test('v2: a blowout counts no more than 11-3, on both copies; cap 1 is exactly v1', () => {
  assert.equal(VERSION, 2);
  assert.ok(Math.abs(CAP - 11 / 14) < 1e-12);
  const r = (games, opt) => compute(games, opt).tables.doubles.get('a').rating;
  const rc = games => client.compute(games).tables.doubles.get('a').rating;
  const [g11_3, g11_0, g11_9] = [[11, 3], [11, 0], [11, 9]].map(s => [game('g', s, 1e12)]);
  assert.equal(r(g11_0), r(g11_3));
  assert.equal(rc(g11_0), rc(g11_3));
  assert.ok(r(g11_0, { cap: 1 }) > r(g11_3), 'without the cap a shutout moves more');
  assert.ok(r(g11_9) < r(g11_3), 'a close win still moves less than 11-3');
  assert.equal(client.compute(g11_0, { cap: 1 }).tables.doubles.get('a').rating, r(g11_0, { cap: 1 }));
  // the cap is symmetric: losing 0-11 hurts team 0 no more than losing 3-11
  assert.equal(compute([game('g', [0, 11], 1e12)]).changes.g.list[0].after, compute([game('g', [3, 11], 1e12)]).changes.g.list[0].after);
});

test('v2: provisional until 10 games', () => {
  assert.equal(PROVISIONAL, 10);
  assert.equal(client.PROVISIONAL, 10);
  const games = Array.from({ length: 11 }, (_, i) => game('g' + i, [11, 5], 1e12 + i * 36e5));
  const at = n => compute(games.slice(0, n)).tables.doubles.get('a');
  assert.equal(isProvisional(at(9)), true);
  assert.equal(isProvisional(at(10)), false);
  assert.equal(client.isProvisional(client.compute(games.slice(0, 9)).tables.doubles.get('a')), true);
  assert.equal(client.isProvisional(client.compute(games.slice(0, 10)).tables.doubles.get('a')), false);
  assert.equal(isProvisional(undefined), true);
});

test('names are keyed the same way on both copies (accents compose, case and spaces ignored)', () => {
  const g = [{ id: 'x', mode: 'singles', score: [11, 5], endedAt: 1e12, teams: [['Zoé '], ['B']] }, { id: 'y', mode: 'singles', score: [11, 5], endedAt: 1e12 + 1, teams: [['  zoé'], ['B']] }];
  assert.equal(compute(g).tables.singles.size, 2);
  assert.equal(client.compute(g).tables.singles.size, 2);
});
