import test from 'node:test';
import assert from 'node:assert/strict';
import { renameDeep, newAnonLabel, isAnonLabel, likeFor, gamesCsv } from '../api/_privacy.js';

test('renameDeep replaces whole names (any case) in values and keys, nothing else', () => {
  const v = { teams: [['Ana', 'ben'], [' ANA ', 'Cy']], byes: ['Anabel'], by: { ana: 1 }, n: 3 };
  assert.deepEqual(renameDeep(v, 'ana', 'X'), { teams: [['X', 'ben'], ['X', 'Cy']], byes: ['Anabel'], by: { X: 1 }, n: 3 });
  assert.deepEqual(v.teams[0], ['Ana', 'ben'], 'the input is not changed');
});
test('anonymous labels look the same and differ', () => {
  const a = newAnonLabel(), b = newAnonLabel();
  assert.ok(isAnonLabel(a) && isAnonLabel(b));
  assert.ok(!isAnonLabel('Former player'));
});
test('likeFor escapes LIKE characters and falls back to match-all for non-ASCII names', () => {
  assert.equal(likeFor('A_b%'), '%a\\_b\\%%');
  assert.equal(likeFor('Zoë'), '%');
});
test('gamesCsv quotes cells and defuses formulas', () => {
  const csv = gamesCsv([{ data: { id: 'g1', endedAt: 0, mode: 'doubles', teams: [['=1+1', 'B, C'], ['D', 'E']], score: [11, 3], winner: 0, scoring: 'sideout', target: 11, winBy: 2 }, deleted_at: null }]);
  assert.ok(csv.includes("'=1+1 & \"B, C\"") || csv.includes('"\'=1+1 & B, C"'));
  assert.equal(csv.split('\r\n').length, 3);
});

test('renameDeep uses the name key (spaces, accents) and relabels scoredBy with the label\'s key', () => {
  assert.deepEqual(renameDeep({ teams: [['Ana  Lee', 'Zoë']], scoredBy: 'ana lee' }, 'ana lee', 'Former player ABCDE'),
    { teams: [['Former player ABCDE', 'Zoë']], scoredBy: 'former player abcde' });
  assert.equal(likeFor('ana lee'), '%ana%lee%');
});
