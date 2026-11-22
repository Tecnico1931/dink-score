// The club creator's own games earn Dinks for the creator's own claimed name (and nobody else's), with made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stampSender, hashToken, newOwnerToken } from '../api/_db.js';
import { rewriteGame } from '../api/_rename.js';
import { renameDeep } from '../api/_privacy.js';

const ownerToken = newOwnerToken(), annToken = newOwnerToken();
const club = { code: 'T', owner_hash: hashToken(ownerToken) };
// A fake roster: only Ann has a phone link.
const sql = async (_s, ..._v) => [{ claim_hash: hashToken(annToken) }];
const stamp = async body => { const g = {}; const sender = await stampSender(sql, club, 'T', body, [g]); return { sender, g }; };

test('the creating phone with its own verified claim is organizer and also carries its own name key', async () => {
  const { sender, g } = await stamp({ ownerToken, playerName: 'Ann', playerToken: annToken });
  assert.equal(sender, 'organizer');
  assert.deepEqual(g, { scoredBy: 'organizer', scoredByPlayer: 'ann' });
});

test('the creating phone without a claim, or with a forged one, carries no player name', async () => {
  for (const extra of [{}, { playerName: 'Ann' }, { playerName: 'Ann', playerToken: 'f'.repeat(48) }, { playerName: 'Ann', playerToken: newOwnerToken() }]) {
    const { sender, g } = await stamp({ ownerToken, ...extra });
    assert.equal(sender, 'organizer'); assert.deepEqual(g, { scoredBy: 'organizer' }, JSON.stringify(extra));
  }
});

test('a plain player phone is stamped as before, and a forged claim without the creator token is nobody', async () => {
  assert.deepEqual((await stamp({ playerName: 'Ann', playerToken: annToken })).g, { scoredBy: 'ann' });
  assert.deepEqual((await stamp({ ownerToken: 'f'.repeat(48), playerName: 'Ann', playerToken: 'f'.repeat(48) })).g, {});
});

test('a rename or an anonymise follows scoredByPlayer like scoredBy', () => {
  const g = { teams: [['Ann', 'Bo'], ['Cy', 'Di']], scoredBy: 'organizer', scoredByPlayer: 'ann' };
  assert.equal(rewriteGame(g, new Map([['ann', 'Anna']])).scoredByPlayer, 'anna');
  assert.equal(renameDeep(g, 'ann', 'Former player ABCDE').scoredByPlayer, 'former player abcde');
});
