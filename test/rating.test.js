import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { START, replay } from '../api/_progress.js';

// The client's copy of the rating engine, pulled out of dink-score.html so both copies are held to the same numbers.
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
