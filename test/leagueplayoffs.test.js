import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeague, recordLeagueResult, endSeason, allMatches, nextSeason } from '../api/_league.js';
import { startPlayoffs, recordPlayoff, correctPlayoff, playoffGame, playoffView, playoffField } from '../api/_leagueplayoffs.js';

const P = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
const rate = players => Object.fromEntries(players.map((p, i) => [p, 3 - i * 0.1]));
const ORG = { organizer: true, name: null };
// Everyone beats anyone listed after them in the player list, so the table order is P1, P2, ...
const finished = (n, extra = {}) => {
  const L = createLeague({ name: 'Spring', mode: 'singles', players: P(n), ...extra }, rate(P(n)), 1000, () => 0.5);
  for (const m of allMatches(L)) {
    const first = Number(m.teams[0][0].slice(1)) < Number(m.teams[1][0].slice(1));
    recordLeagueResult(L, m.id, { score: first ? [11, 3] : [3, 11], endedAt: 2000 }, 2000, ORG);
  }
  return L;
};

test('qualifiers are seeded by place, then division', () => {
  const L = finished(8, { divisions: 2 }); // A: P1-P4, B: P5-P8
  assert.deepEqual(playoffField(L, 2).map(f => [f.members[0], f.division, f.rank]), [['P1', 0, 1], ['P5', 1, 1], ['P2', 0, 2], ['P6', 1, 2]]);
});

test('playoffs need a finished league and start only once', () => {
  const live = createLeague({ name: 'x', mode: 'singles', players: P(4) }, rate(P(4)), 1000, () => 0.5);
  assert.throws(() => startPlayoffs(live, {}, 1), /Finish the season/);
  const L = finished(4);
  assert.throws(() => startPlayoffs(L, { top: 9 }), /1 to 8/);
  startPlayoffs(L, { top: 4 }, 3000);
  assert.equal(L.playoffs.field.length, 4);
  assert.throws(() => startPlayoffs(L, {}, 3001), /already started/);
});

test('a single division of four plays semi-finals and a final, and the champion is named', () => {
  const L = finished(4);
  startPlayoffs(L, { top: 4 }, 3000);
  const v = playoffView(L);
  assert.deepEqual(v.bracket.matches.find(m => m.id === 'W1-0').teams, [['P1'], ['P4']]);
  assert.throws(() => recordPlayoff(L, 'W2-0', [11, 2], 3100), /waiting/);
  const r = recordPlayoff(L, 'W1-0', [11, 5], 3100);
  assert.equal(r.changed, true);
  assert.deepEqual(r.game.teams, [['P1'], ['P4']]);
  assert.equal(r.game.id, `${L.id}-po-W1-0`);
  assert.equal(recordPlayoff(L, 'W1-0', [11, 5], 3200).changed, false); // retry
  assert.throws(() => recordPlayoff(L, 'W1-0', [5, 11], 3200), /already been played/);
  recordPlayoff(L, 'W1-1', [11, 9], 3300);
  assert.equal(L.playoffs.champion, null);
  recordPlayoff(L, 'W2-0', [9, 11], 3400); // P2 beats P1 in the final
  assert.deepEqual(L.playoffs.champion, ['P2']);
});

test('playoff games never change the season table, and a correction is guarded once the final is played', () => {
  const L = finished(4);
  const before = JSON.stringify(allMatches(L));
  startPlayoffs(L, { top: 2 }, 3000);
  assert.equal(L.playoffs.field.length, 2);
  recordPlayoff(L, 'W1-0', [11, 7], 3100);
  assert.equal(JSON.stringify(allMatches(L)), before);
  assert.equal(playoffGame(L, 'nope'), null);
  correctPlayoff(L, 'W1-0', [7, 11], 3200);
  assert.deepEqual(L.playoffs.champion, ['P2']);
  const four = finished(4);
  startPlayoffs(four, { top: 4 }, 3000);
  recordPlayoff(four, 'W1-0', [11, 5], 3100); recordPlayoff(four, 'W1-1', [11, 9], 3200); recordPlayoff(four, 'W2-0', [11, 2], 3300);
  assert.throws(() => correctPlayoff(four, 'W1-0', [5, 11], 3400), /Later matches/);
});

test('the next season is unaffected by playoffs', () => {
  const L = finished(6);
  startPlayoffs(L, { top: 2 }, 3000);
  const next = nextSeason(L, {}, 4000, () => 0.5);
  assert.equal(next.playoffs, undefined);
});
