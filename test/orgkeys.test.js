// Per-phone organizer keys (api/_orgkeys.js) and the "Who's an organizer" screen (src/app/organizer-devices.js). The server flow
// (unlock, list, remove, lock, upgrade, PIN change, audit) runs in tools/api-check.mjs against a throwaway database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newDeviceKey, parseDeviceKey, secretMatches, keyPart, MAX_DEVICES } from '../api/_orgkeys.js';

const page = fs.readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
const mod = fs.readFileSync(new URL('../src/app/organizer-devices.js', import.meta.url), 'utf8');

test('a phone key is 80 random hex characters: a 16-character id and a 256-bit secret, and only a hash of the secret is kept', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const d = newDeviceKey();
    assert.match(d.key, /^[0-9a-f]{80}$/);
    assert.equal(d.key.slice(0, 16), d.id);
    assert.match(d.hash, /^[0-9a-f]{64}$/);
    assert.ok(!d.hash.includes(d.key.slice(16)) && d.hash !== d.key.slice(16), 'the stored value is not the secret');
    seen.add(d.key);
  }
  assert.equal(seen.size, 200);
  assert.ok(MAX_DEVICES >= 2);
});

test('only the right secret matches, and malformed keys never parse', () => {
  const d = newDeviceKey(), p = parseDeviceKey(d.key);
  assert.equal(p.id, d.id);
  assert.ok(secretMatches(d.hash, p.secret));
  assert.ok(!secretMatches(d.hash, '0'.repeat(64)));
  assert.ok(!secretMatches(d.hash, p.secret.slice(0, 63) + (p.secret.endsWith('0') ? '1' : '0')), 'one changed character is enough');
  assert.ok(!secretMatches('', p.secret) && !secretMatches(null, p.secret) && !secretMatches('zz', p.secret));
  for (const bad of ['', null, undefined, 'a'.repeat(79), 'a'.repeat(81), 'A'.repeat(80), 'g'.repeat(80), d.key + '0', ' ' + d.key, '123456']) assert.equal(parseDeviceKey(bad), null, String(bad));
});

test('the key rides after the colon of the existing PIN field', () => {
  const d = newDeviceKey();
  assert.equal(keyPart(':' + d.key), d.key);
  assert.equal(keyPart('246810:' + 'a'.repeat(64)), 'a'.repeat(64));
  assert.equal(keyPart('246810'), '');
  assert.equal(keyPart(undefined), '');
});

// The screen, run with stand-ins for the app's globals.
function screen(over = {}) {
  const g = Object.assign({
    club: { code: 'ABC234', name: 'Tue' }, pins: { ABC234: ':' + 'a'.repeat(80) }, clubSheet: null, isCreator: () => false,
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    skel: () => '<skeleton>', myName: () => null, myToken: () => null, hasOrganizer: () => true, announce() {}, api: async () => ({}), adminCreds: () => ({}), $: () => null, renderClub() {}, render() {}, forgetPin() {}, rememberPin() {}
  }, over);
  const keys = Object.keys(g);
  return new Function(...keys, mod + '\nreturn { odHTML, odAgo, odAct, odUpgrade, odOwnKey };')(...keys.map(k => g[k]));
}

test('the list names each phone, marks this one, escapes names, and a removal needs a second tap', () => {
  const s = screen();
  const now = Date.now();
  const html = s.odHTML({ data: { devices: [
    { id: 'a'.repeat(16), name: 'Ana <b>', createdAt: now - 864e5 * 3, lastUsedAt: now - 5 * 60000, you: true },
    { id: 'b'.repeat(16), name: null, createdAt: now - 864e5 * 40, lastUsedAt: now - 864e5 * 2, you: false }
  ] }, armed: 'b'.repeat(16) });
  assert.ok(html.includes('Ana &lt;b&gt;') && !html.includes('Ana <b>'));
  assert.ok(html.includes('Unnamed phone') && html.includes('This phone'));
  assert.ok(html.includes('Tap again to Remove') && html.includes('data-od-id="' + 'b'.repeat(16) + '"'));
  assert.ok(html.includes('last used 5 minutes ago') && html.includes('last used 2 days ago'));
  assert.ok(!/[0-9a-f]{80}/.test(html), 'no key is drawn');
  assert.ok(s.odHTML({ data: null }).includes('<skeleton>'));
  assert.ok(s.odHTML({ data: { devices: [] } }).includes('No phones are listed yet'));
  assert.ok(s.odHTML({ data: { devices: [] }, error: 'No <i>' }).includes('role="alert"'));
  assert.equal(s.odAgo(Date.now()), 'just now');
});

test('upgrade: only a raw PIN or an old club-wide key is traded, once per launch, and the PIN is replaced by the phone key', async () => {
  const calls = [], pins = { ABC234: '246810:' + 'c'.repeat(64) }, key = 'd'.repeat(80);
  const s = screen({ club: { code: 'ABC234', hasPin: true }, pins, api: async (p, o) => { calls.push(JSON.parse(o.body)); return { ok: true, organizerKey: key }; }, rememberPin: (c, v) => { pins[c] = v; } });
  await s.odUpgrade();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'verify-pin'); assert.equal(calls[0].device, true);
  assert.equal(pins.ABC234, ':' + key);
  await s.odUpgrade(); assert.equal(calls.length, 1, 'already upgraded, and tried once');
  const none = screen({ club: { code: 'ZZZ999', hasPin: true }, pins: { ZZZ999: ':' + key }, api: async () => { throw new Error('should not call'); } });
  await none.odUpgrade();
  const failing = screen({ club: { code: 'YYY888', hasPin: true }, pins: { YYY888: '246810' }, api: async () => { throw new Error('403'); } });
  await failing.odUpgrade(); // a changed PIN or no network leaves it as it was
});

test('the page wires the screen: a button for organizers, unlock and PIN change ask for a phone key, lock revokes it, a phone key never moves with the transfer', () => {
  assert.match(page, /data-od="open"/);
  assert.match(page, /ds\.od\) \{ if \(ds\.od === 'open'\) odOpen\(\)/);
  assert.match(page, /c\.view === 'devices' && club && odCanOrg\(\)/);
  assert.match(page, /action: 'verify-pin', pin, device: true/);
  assert.match(page, /action: 'set-pin'[^\n]*device: true/);
  assert.match(page, /if \(a === 'pin-lock'\) \{ odLockThis\(\); return; \}/);
  assert.match(page, /pin: \/\^\\d\{4,8\}\$\/\.test\(pins\[c\.code\] \|\| ''\)/, 'only a raw PIN is packed for another phone');
  assert.match(page, /body\.removed && club/);
  assert.match(mod, /action: 'device-lock'/);
  assert.doesNotMatch(mod, /console\./, 'a key is never logged');
});
