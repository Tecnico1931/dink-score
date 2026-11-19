import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeague, createLadder, recordLeagueResult, recordChallenge } from '../api/_league.js';
import { leaguePublicView } from '../api/_share.js';

const players = ['Ann', 'Bo', 'Cat', 'Dev'];
const ORG = { organizer: true, name: null };

test('a public league shows names, standings and fixtures, and nothing else', () => {
  const L = createLeague({ kind: 'league', name: 'Tue', mode: 'singles', players, target: 11 }, {}, 1000, () => 0.5);
  recordLeagueResult(L, L.weeks[0].matches[0].id, { score: [11, 4] }, 2000, ORG);
  const v = leaguePublicView(L), text = JSON.stringify(v);
  assert.equal(v.kind, 'league');
  assert.equal(v.divisions[0].rows.length, 4);
  assert.equal(v.weeks[0].matches[0].score[0], 11);
  for (const hidden of [L.id, L.weeks[0].matches[0].id, 'resultsBy', 'seeds', 'canChallenge', 'previous']) assert.ok(!text.includes(hidden), hidden);
});

test('a public ladder shows the order and recent results, not the result keys', () => {
  const L = createLadder({ kind: 'ladder', name: 'Club ladder', mode: 'singles', players, jump: 3 }, {}, 1000, () => 0.5);
  const [top, second] = [L.entries[0], L.entries[1]];
  recordChallenge(L, { key: 'secretkey', challenger: second, defender: top, score: [11, 3] }, 2000, ORG);
  const v = leaguePublicView(L), text = JSON.stringify(v);
  assert.equal(v.kind, 'ladder');
  assert.equal(v.rows.length, 4);
  assert.equal(v.results.length, 1);
  assert.deepEqual(Object.keys(v.rows[0]).sort(), ['losses', 'name', 'played', 'rank', 'wins']);
  assert.ok(!text.includes('secretkey') && !text.includes('canChallenge'));
});
