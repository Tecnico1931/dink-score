import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSessionCode, expiresAt, SESSION_MS, sessionView } from '../api/_sessions.js';
import { section } from './helpers/app.js';

const grab = (name, ret) => new Function(section(name) + `\nreturn ${ret};`)();
const Pickup = grab('PICKUP', 'Pickup');
const ShareLink = grab('SHARELINK', 'ShareLink');
const Heal = grab('RECOVERY', 'Heal');

test('session codes are 8 letters and numbers, cleaned like club codes', () => {
  assert.equal(cleanSessionCode('abcd-2345'), 'ABCD2345');
  for (const bad of ['', 'ABC123', 'ABCD23456', null]) assert.throws(() => cleanSessionCode(bad), { status: 400 });
});

test('a session lasts exactly 24 hours', () => {
  assert.equal(SESSION_MS, 864e5);
  assert.equal(expiresAt(1000), 1000 + 864e5);
});

test('sessionView copies only listed fields: no host key, no hashes', () => {
  const v = sessionView({ code: 'ABCD2345', name: 'Sat', host_hash: 'secret', expires_at: new Date(5000).toISOString(), club: 'X' }, [{ name: 'Ann', token_hash: 'x' }], [{ data: { id: 'g1' }, session: 'ABCD2345' }], 7);
  assert.deepEqual(v, { session: { code: 'ABCD2345', name: 'Sat', expiresAt: 5000, now: 7 }, players: ['Ann'], games: [{ id: 'g1' }] });
  assert.ok(!JSON.stringify(v).includes('secret'));
});

test('session link and QR source carry the 8 character code', () => {
  assert.equal(ShareLink.session('https://x.test/', 'abcd 2345'), 'https://x.test/?session=ABCD2345');
  assert.equal(ShareLink.sessionFromSearch('?session=abcd-2345'), 'ABCD2345');
  assert.equal(ShareLink.sessionFromSearch('?club=ABC123'), '');
  assert.equal(ShareLink.fromSearch('?session=ABCD2345'), '', 'a session link is not a club link');
});

test('time left follows the server clock and runs out', () => {
  const p = { expiresAt: 10 * 60000, skew: 0 };
  assert.equal(Pickup.left(p, 0), 600000);
  assert.equal(Pickup.left({ ...p, skew: 5 * 60000 }, 0), 300000);
  assert.equal(Pickup.leftText(600000), '10 min left');
  assert.equal(Pickup.leftText(86400000), '24 h 0 min left');
  assert.equal(Pickup.leftText(0), 'Ended');
});

test('standings count wins, losses and point difference, merging names that differ in case', () => {
  const g = (a, b, s) => ({ teams: [a, b], score: s });
  const t = Pickup.standings([g(['Ann', 'Bo'], ['Cy', 'Di'], [11, 5]), g(['ann', 'Cy'], ['Bo', 'Di'], [9, 11])]);
  assert.deepEqual(t.map(r => [r.name, r.w, r.l, r.diff]), [['Bo', 2, 0, 8], ['Ann', 1, 1, 4], ['Di', 1, 1, -4], ['Cy', 0, 2, -8]]);
});

test('Heal.pickup keeps a good session and drops a damaged one', () => {
  const ok = Heal.pickup({ code: 'ABCD2345', expiresAt: 5, name: 'x', host: 'a'.repeat(48), players: ['Ann', 3], games: [], pending: [{ nope: 1 }], saved: null });
  assert.equal(ok.code, 'ABCD2345'); assert.deepEqual(ok.players, ['Ann']); assert.deepEqual(ok.pending, []); assert.deepEqual(ok.saved, {});
  assert.equal(Heal.pickup({ code: 'short', expiresAt: 5 }), null);
  assert.equal(Heal.pickup({ code: 'ABCD2345' }), null);
  assert.equal(Heal.pickup('x'), null);
  assert.equal(Heal.pickup({ code: 'ABCD2345', expiresAt: 5, host: 'zz' }).host, '');
});
