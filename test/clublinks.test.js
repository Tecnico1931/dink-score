// Linking friendly clubs into one leaderboard (L15): the pure parts of api/_clublinks.js. The consent flow itself runs in tools/api-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newInviteCode, cleanInvite, isInvite, linkStandingView, MAX_LINKS } from '../api/_clublinks.js';

test('invite codes are 8 characters from an alphabet without look-alikes, and typing them forgivingly works', () => {
  for (let i = 0; i < 200; i++) assert.ok(isInvite(newInviteCode()));
  assert.ok(!/[ILO01]/.test(Array.from({ length: 500 }, () => newInviteCode()).join('')));
  assert.equal(cleanInvite(' abcd-2345 '), 'ABCD2345');
  assert.ok(isInvite(cleanInvite('abcd 2345')));
  for (const bad of ['', null, undefined, 'ABCD234', 'ABCD23456', 'ABCDEFGI', 'ABCD-OOO1', '../etc/x']) assert.ok(!isInvite(cleanInvite(bad)), String(bad));
  assert.equal(newInviteCode(() => 0), 'AAAAAAAA');
  assert.ok(MAX_LINKS >= 1);
});

const row = (name, club, rating, games, provisional = false, extra = {}) => ({ name, club, rating, games, provisional, ...extra });

test('the standing ranks established players by rating, then lists provisional ones unranked', () => {
  const v = linkStandingView('doubles', ['Mine', 'Theirs'], [
    row('Low', 0, 2.1, 30), row('New', 1, 3.9, 2, true), row('Top', 1, 3.5, 12), row('Tie B', 0, 3.0, 8), row('Tie A', 1, 3.0, 8), row('Tie C', 0, 3.0, 20)
  ]);
  assert.deepEqual(v.rows.map(r => [r.name, r.rank]), [['Top', 1], ['Tie C', 2], ['Tie A', 3], ['Tie B', 4], ['Low', 5], ['New', null]]);
  assert.deepEqual(v.clubs, ['Mine', 'Theirs']);
  assert.equal(v.mode, 'doubles');
});

test('the standing is copied field by field: nothing added to a row, a club or the mode leaks', () => {
  const v = linkStandingView('anything', ['Mine', 'Theirs', 'Third'], [
    row('Ana', 0, 3.456, 9.7, false, { code: 'ABC123', pin: '246810', ownerToken: 'x', avatar: { type: 'photo', value: 'zzz' }, dupr: 4.5, claim_hash: 'h', key: 'ana', club2: 'secret' }),
    row('Ben', 7, NaN, 'many', 'yes')
  ]);
  assert.deepEqual(Object.keys(v).sort(), ['clubs', 'mode', 'rows', 'v']);
  assert.equal(v.mode, 'doubles');
  assert.deepEqual(v.clubs, ['Mine', 'Theirs'], 'only the two clubs');
  for (const r of v.rows) assert.deepEqual(Object.keys(r).sort(), ['club', 'games', 'name', 'provisional', 'rank', 'rating']);
  assert.equal(v.rows.find(r => r.name === 'Ana').rating, 3.46);
  assert.equal(v.rows.find(r => r.name === 'Ana').games, 9);
  const ben = v.rows.find(r => r.name === 'Ben');
  assert.deepEqual([ben.club, ben.rating, ben.games, ben.provisional, ben.rank], [0, 0, 0, true, null]);
  assert.ok(!/ABC123|246810|ownerToken|photo|zzz|secret|claim/.test(JSON.stringify(v)));
});

test('the standing caps its size and keeps singles distinct', () => {
  const many = Array.from({ length: 500 }, (_, i) => row('P' + i, i % 2, 2 + i / 1000, 10));
  assert.equal(linkStandingView('singles', ['A', 'B'], many).rows.length, 200);
  assert.equal(linkStandingView('singles', ['A', 'B'], []).mode, 'singles');
});
