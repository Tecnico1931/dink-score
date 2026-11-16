import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { newRecoveryCode, cleanRecoveryCode, hashRecovery, recoveryMatches, cleanTransferId, idHash } from '../api/_transfer.js';

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const block = src.match(/\/\*MOVE-START\*\/([\s\S]*?)\/\*MOVE-END\*\//);
assert.ok(block, 'the MOVE block is missing from dink-score.html');
const Move = new Function('crypto', block[1] + '\nreturn Move;')(globalThis.crypto);
const tok = c => c.repeat(48);

test('transfer code: 12 characters, no look-alikes, cleaned from typing', () => {
  const c = Move.newCode();
  assert.match(c, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(Move.clean(c.toLowerCase().replace(/-/g, ' ')), c.replace(/-/g, ''));
  assert.equal(Move.clean('ABCD-EFGH'), '');
  assert.equal(Move.clean('OOOO-1111-IIII'), '');
});

test('the lookup id is a 64 hex id the server hashes again; the same code gives the same id', async () => {
  const c = Move.newCode(), id = await Move.id(c);
  assert.equal(cleanTransferId(id), id);
  assert.equal(await Move.id(c.toLowerCase()), id);
  assert.notEqual(idHash(id), id);
});

test('seal and open round trip; a wrong code or tampered blob does not open', async () => {
  const code = Move.newCode(), other = Move.newCode();
  const payload = Move.pack([{ code: 'ABC234', name: 'Tue' }], { ABC234: { name: 'Ana', token: tok('a') } }, { ABC234: tok('b') }, { ABC234: '1234' });
  const blob = await Move.seal(code, payload);
  assert.deepEqual(await Move.open(code, blob), payload);
  await assert.rejects(Move.open(other, blob));
  const bad = Buffer.from(blob, 'base64'); bad[bad.length - 1] ^= 1;
  await assert.rejects(Move.open(code, bad.toString('base64')));
  assert.doesNotMatch(blob, /Ana|1234/, 'the server only ever sees ciphertext');
});

test('merge brings claims and organizer access, keeps what the new phone already has, ignores junk', () => {
  const payload = { v: 1, clubs: [
    { code: 'ABC234', name: 'Tue', me: { name: 'Ana', token: tok('a') }, owner: tok('b'), pin: '1234' },
    { code: 'XYZ789', name: 'Wed', me: null, owner: null, pin: null },
    { code: 'bad', name: 'x', me: { name: 'Eve', token: 'short' }, owner: 'zz', pin: 'abc' }
  ] };
  const clubs = [{ code: 'XYZ789', name: 'Wed' }], me = {}, owners = { XYZ789: tok('c') }, pins = {};
  assert.equal(Move.merge(payload, clubs, me, owners, pins), 1);
  assert.deepEqual(clubs.map(c => c.code), ['XYZ789', 'ABC234']);
  assert.deepEqual(me, { ABC234: { name: 'Ana', token: tok('a') } });
  assert.deepEqual(owners, { XYZ789: tok('c'), ABC234: tok('b') });
  assert.deepEqual(pins, { ABC234: '1234' });
  assert.throws(() => Move.merge({ v: 2 }, [], {}, {}, {}));
});

test('recovery code: 16 characters shown in groups, cleaned, hash matches only the right code', () => {
  const r = newRecoveryCode();
  assert.match(r, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
  const clean = cleanRecoveryCode(r.toLowerCase());
  assert.equal(clean, r.replace(/-/g, ''));
  const h = hashRecovery(clean);
  assert.ok(recoveryMatches(h, clean));
  assert.ok(!recoveryMatches(h, cleanRecoveryCode(newRecoveryCode())));
  assert.equal(cleanRecoveryCode('short'), null);
  assert.ok(!recoveryMatches(null, clean));
});
