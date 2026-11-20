import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../api/_watchrules.js';
import { rally } from '../api/_pb.js';

const DAY = 86400e3;

test('a watch token is w_ plus 64 hex, never an owner token or a game secret, and only its hash is kept', () => {
  const t = W.newWatchToken();
  assert.match(t, /^w_[0-9a-f]{64}$/);
  assert.notEqual(t, W.newWatchToken());
  assert.ok(W.isWatchToken(t));
  for (const bad of ['', null, 'a'.repeat(48), 'w_' + 'a'.repeat(63), 'W_' + 'a'.repeat(64), 'w_' + 'g'.repeat(64), 'ABC123']) assert.ok(!W.isWatchToken(bad), String(bad));
  const h = W.hashWatchToken(t);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes(t.slice(2)));
  assert.notEqual(h, W.hashRevokeKey(t), 'each kind of secret hashes in its own domain');
  assert.notEqual(W.pairHash('a'.repeat(32)), W.pollHash('a'.repeat(32)));
});

test('the Bearer header is read strictly', () => {
  const t = W.newWatchToken();
  assert.equal(W.tokenFrom({ headers: { authorization: 'Bearer ' + t } }), t);
  for (const h of [undefined, '', t, 'Bearer', 'Bearer ' + t + ' x', 'Basic ' + t, 'Bearer ' + t.slice(0, -1), 'bearer ' + t]) assert.equal(W.tokenFrom({ headers: { authorization: h } }), null, String(h));
  assert.equal(W.tokenFrom({}), null);
});

test('hashEq compares 32-byte hex hashes and nothing else', () => {
  const a = W.hashWatchToken('w_x');
  assert.ok(W.hashEq(a, a));
  assert.ok(!W.hashEq(a, W.hashWatchToken('w_y')));
  for (const bad of [null, undefined, '', 'ab', a.slice(0, 62)]) assert.ok(!W.hashEq(bad, bad), String(bad));
});

test('what the watch sends is cleaned: ids, hashes, the 4 digits, tap ids, labels', () => {
  assert.equal(W.cleanPairId('A'.repeat(32)), 'a'.repeat(32));
  assert.equal(W.cleanPairId('a'.repeat(31)), null);
  assert.equal(W.cleanPollSecret('0123456789abcdef'.repeat(2)), '0123456789abcdef'.repeat(2));
  assert.equal(W.cleanHash('a'.repeat(64)), 'a'.repeat(64));
  assert.equal(W.cleanHash('A'.repeat(64)), null);
  assert.equal(W.cleanConfirm('0420'), '0420');
  for (const bad of ['123', '12345', '12a4', 1234.5, null, '']) assert.equal(W.cleanConfirm(bad), null, String(bad));
  assert.equal(W.cleanOpId('tap-0001_AB'), 'tap-0001_AB');
  for (const bad of ['short', 'has space1', 'x'.repeat(65), '', null, '../../etc']) assert.equal(W.cleanOpId(bad), null, String(bad));
  assert.equal(W.cleanLabel('  Ana\'s   Apple\nWatch <b> '), 'Ana\'s Apple Watch b');
  assert.equal(W.cleanLabel('x'.repeat(80)).length, 40);
  assert.equal(W.cleanLabel('   '), null);
  assert.equal(W.cleanLabel(undefined), null);
});

test('the typed fallback is 6 base32 characters of the pairing id, and typing it forgives case, spaces and dashes', () => {
  assert.equal(W.shortCode('00000000' + '0'.repeat(24)), 'AAAAAA');
  assert.equal(W.shortCode('ffffffff' + '0'.repeat(24)), '777777');
  assert.equal(W.shortCode('80000000' + '0'.repeat(24)), 'QAAAAA'); // top bit set = value 16 = Q
  assert.match(W.shortCode('0123456789abcdef0123456789abcdef'), /^[A-Z2-7]{6}$/);
  assert.equal(W.cleanShort(' ab-cd 23 '), 'ABCD23');
  for (const bad of ['ABCDE', 'ABCDEFG', 'ABCD18', 'AB CD1!']) assert.equal(W.cleanShort(bad), null, bad);
});

test('the 4-digit check: three tries, the third wrong one ends the pairing, a right number on the third still works', () => {
  assert.equal(W.confirmVerdict(1, '1234', '1234'), 'ok');
  assert.equal(W.confirmVerdict(1, '1234', '9999'), 'wrong');
  assert.equal(W.confirmVerdict(2, '1234', '9999'), 'wrong');
  assert.equal(W.confirmVerdict(3, '1234', '9999'), 'locked');
  assert.equal(W.confirmVerdict(3, '1234', '1234'), 'ok');
  assert.equal(W.confirmVerdict(4, '1234', '1234'), 'locked', 'a late right answer cannot rescue a spent pairing');
  assert.equal(W.confirmVerdict(1, '1234', null), 'wrong');
});

test('links last 90 days from the last call, never past a year from when they were made', () => {
  const made = Date.UTC(2026, 0, 1);
  assert.equal(W.nextExpiry(made, made), made + 90 * DAY);
  assert.equal(W.nextExpiry(made, made + 100 * DAY), made + 190 * DAY);
  assert.equal(W.nextExpiry(made, made + 300 * DAY), made + 365 * DAY, 'the hard cap');
  assert.equal(W.nextExpiry(made, made + 364 * DAY), made + 365 * DAY);
});

test('last-seen moves at most once an hour, so a tap is not a database write', () => {
  const now = Date.now();
  assert.ok(W.touchDue(null, now));
  assert.ok(W.touchDue(NaN, now));
  assert.ok(!W.touchDue(now - 59 * 60e3, now));
  assert.ok(W.touchDue(now - 60 * 60e3, now));
});

test('tap ids: a repeat is seen, and only the last 32 are remembered', () => {
  assert.ok(!W.seenOp([], 'tap-00000001'));
  assert.ok(!W.seenOp(undefined, 'tap-00000001'));
  assert.ok(!W.seenOp(['tap-00000001'], undefined), 'a call with no id is never a duplicate');
  let ops = [];
  for (let i = 0; i < 40; i++) ops = W.pushOp(ops, 'tap-' + String(i).padStart(8, '0'));
  assert.equal(ops.length, W.OPS_KEEP);
  assert.ok(W.seenOp(ops, 'tap-00000039'));
  assert.ok(W.seenOp(ops, 'tap-00000008'));
  assert.ok(!W.seenOp(ops, 'tap-00000007'), 'older ids fall out of the window');
  assert.deepEqual(W.pushOp(null, 'tap-00000001'), ['tap-00000001']);
});

test('what a watch sees of a game: players and score, with the serving call', () => {
  const state = { cfg: { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, teams: [['Ana', 'Ben'], ['Cy', 'Di']] }, score: [3, 2], serving: 0, server: 0, serverNum: 2, right: [0, 0], rallies: 5, winner: null, switched: false };
  const g = W.watchGame({ id: 'live-1', state, version: 7, secret_hash: 'x'.repeat(64), stack: [{}], ops: ['tap-00000001'] });
  assert.deepEqual(Object.keys(g).sort(), ['call', 'cfg', 'id', 'rallies', 'say', 'score', 'server', 'serverNum', 'serving', 'teams', 'version', 'winner']);
  assert.deepEqual(g.call, [3, 2, 2]);
  assert.equal(g.say, 'Score: 3, 2, 2');
  assert.equal(g.version, 7);
  const over = rally({ ...state, score: [10, 4], winner: null }, 0);
  assert.equal(W.watchGame({ id: 'live-1', state: over, version: 8 }).say, 'Game over');
  assert.ok(!JSON.stringify(g).includes('secret') && !JSON.stringify(g).includes('tap-'), 'no secrets or tap ids');
});

test('a game code: its own hash domains, 30 bits typed from 128 bits in the link, 4 numbers, and a single-game link is short lived', () => {
  const id = W.newOfferId();
  assert.match(id, /^[0-9a-f]{32}$/); assert.notEqual(id, W.newOfferId());
  assert.match(W.shortCode(id), /^[A-Z2-7]{6}$/);
  assert.match(W.newConfirm(), /^[0-9]{4}$/);
  assert.notEqual(W.offerHash(id), W.pairHash(id), 'a game code is never a watch pairing');
  assert.notEqual(W.offerShortHash(W.shortCode(id)), W.shortHash(W.shortCode(id)));
  assert.ok(W.hashEq(W.offerHash(id), W.offerHash(id)) && !W.hashEq(W.offerHash(id), W.offerHash(W.newOfferId())));
  assert.ok(W.GAME_LINK_HOURS * 3600e3 < 2 * DAY && W.GAME_LINK_END_MIN <= 30 && W.OFFER_TTL_MIN <= 15);
  assert.ok(W.MAX_GAME_LINKS >= 4, 'a pair of doubles and a couple of spectators');
  // The numbers keep the pairing rules: 3 wrong tries end the code.
  assert.equal(W.confirmVerdict(1, '1234', '1234'), 'ok');
  assert.equal(W.confirmVerdict(2, '1234', '4321'), 'wrong');
  assert.equal(W.confirmVerdict(3, '1234', '4321'), 'locked');
});
