import test from 'node:test';
import assert from 'node:assert/strict';
import { newChallenge, verifyRegistration, verifyAssertion, cborDecode, creationOptions, requestOptions } from '../api/_webauthn.js';
import { makeAuthenticator } from '../tools/fake-authenticator.mjs';

const rpId = 'dinkscore.example', origin = 'https://dinkscore.example';
const setup = o => { const a = makeAuthenticator({ rpId, origin, ...o }); const ch = newChallenge(); return { a, ch, reg: verifyRegistration({ credential: a.create(ch), challenge: ch, origin, rpId }) }; };

test('registration returns the credential id, a re-importable key and the starting counter', () => {
  const { a, reg } = setup();
  assert.equal(reg.credId, a.id);
  assert.equal(reg.alg, -7);
  assert.equal(reg.signCount, 0);
  assert.deepEqual(reg.transports, ['internal']);
});

test('registration is refused for the wrong challenge, origin, RP ID, ceremony type or missing user verification', () => {
  const a = makeAuthenticator({ rpId, origin }), ch = newChallenge();
  const bad = (cred, args = {}) => assert.throws(() => verifyRegistration({ credential: cred, challenge: ch, origin, rpId, ...args }));
  bad(a.create(ch), { challenge: newChallenge() });
  bad(a.create(ch, { origin: 'https://evil.example' }));
  bad(a.create(ch, { rpId: 'evil.example' }));
  bad(makeAuthenticator({ rpId, origin, uv: false }).create(ch));
  bad(makeAuthenticator({ rpId, origin, up: false }).create(ch));
  bad({ ...a.create(ch), id: 'AAAA' }); // credential id must match the one in the attested data
  bad({ ...a.create(ch), type: 'password' });
  bad(null);
});

test('registration is refused for unsupported or invalid keys', () => {
  const ch = newChallenge(), a = makeAuthenticator({ rpId, origin }), cred = a.create(ch);
  const att = Buffer.from(cred.response.attestationObject, 'base64url');
  const flipped = Buffer.from(att); flipped[flipped.length - 3] ^= 0xff; // corrupt the public key's y coordinate
  assert.throws(() => verifyRegistration({ credential: { ...cred, response: { ...cred.response, attestationObject: flipped.toString('base64url') } }, challenge: ch, origin, rpId }));
});

test('a good assertion verifies and the counter must move forward', () => {
  const { a, reg } = setup();
  const ch = newChallenge();
  const out = verifyAssertion({ credential: a.get(ch, { userHandle: 'acct1' }), challenge: ch, origin, rpId, spki: reg.spki, alg: reg.alg, signCount: reg.signCount });
  assert.equal(out.signCount, 1);
  assert.equal(out.userHandle, 'acct1');
  const ch2 = newChallenge();
  a.setCounter(0); // a cloned credential replaying an old counter
  assert.throws(() => verifyAssertion({ credential: a.get(ch2), challenge: ch2, origin, rpId, spki: reg.spki, alg: reg.alg, signCount: 5 }), /counter/);
});

test('authenticators that always report counter 0 still sign in', () => {
  const { a, reg } = setup(), ch = newChallenge();
  a.setCounter(-1); // get() increments first, so it sends 0
  const out = verifyAssertion({ credential: a.get(ch), challenge: ch, origin, rpId, spki: reg.spki, alg: reg.alg, signCount: 0 });
  assert.equal(out.signCount, 0);
});

test('an assertion is refused for the wrong challenge, origin, RP ID, ceremony type, key or a tampered signature', () => {
  const { a, reg } = setup(), ch = newChallenge();
  const args = { challenge: ch, origin, rpId, spki: reg.spki, alg: reg.alg, signCount: 0 };
  assert.throws(() => verifyAssertion({ ...args, credential: a.get(ch), challenge: newChallenge() }), /challenge/);
  assert.throws(() => verifyAssertion({ ...args, credential: a.get(ch, { over: { origin: 'https://evil.example' } }) }), /origin/);
  assert.throws(() => verifyAssertion({ ...args, credential: a.get(ch, { over: { rpId: 'evil.example' } }) }), /rpId/);
  assert.throws(() => verifyAssertion({ ...args, credential: a.get(ch, { over: { type: 'webauthn.create' } }) }), /ceremony/);
  const other = setup();
  assert.throws(() => verifyAssertion({ ...args, credential: other.a.get(ch) }), /signature/);
  const c = a.get(ch), sig = Buffer.from(c.response.signature, 'base64url'); sig[sig.length - 1] ^= 1;
  assert.throws(() => verifyAssertion({ ...args, credential: { ...c, response: { ...c.response, signature: sig.toString('base64url') } } }));
  assert.throws(() => verifyAssertion({ ...args, credential: makeAuthenticator({ rpId, origin, uv: false }).get(ch) }));
});

test('the CBOR reader refuses malformed and oversized input instead of looping or reading past the end', () => {
  assert.throws(() => cborDecode(Buffer.from([0x58, 0x20, 1, 2]))); // byte string shorter than its length
  assert.throws(() => cborDecode(Buffer.alloc(0)));
  assert.throws(() => cborDecode(Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0]))); // float
  assert.throws(() => cborDecode(Buffer.from([0x99, 0xff, 0xff]))); // array of 65535
  assert.throws(() => cborDecode(Buffer.from(Array(20).fill(0x81)))); // nesting too deep
});

test('options ask for discoverable, user-verified passkeys with no attestation', () => {
  const c = creationOptions({ rpId, rpName: 'x', userId: 'acct1', userName: 'Ana', challenge: 'c', excludeIds: ['k1'] });
  assert.equal(c.attestation, 'none');
  assert.equal(c.authenticatorSelection.userVerification, 'required');
  assert.equal(c.authenticatorSelection.residentKey, 'required');
  assert.deepEqual(c.excludeCredentials, [{ type: 'public-key', id: 'k1' }]);
  assert.deepEqual(requestOptions({ rpId, challenge: 'c' }).allowCredentials, []);
});

test('resolveRp: legacy single pair when WEBAUTHN_ORIGINS is unset', async () => {
  const { resolveRp } = await import('../api/_webauthn.js');
  const r = resolveRp({}, 'https://dinkscore.vercel.app');
  assert.deepEqual(r, { rpId: 'dinkscore.vercel.app', origin: 'https://dinkscore.vercel.app', legacyRpId: 'dinkscore.vercel.app' });
  assert.equal(resolveRp({}, 'https://dink.raulesantos.com'), null);
  assert.equal(resolveRp({}, undefined), null);
  const custom = { WEBAUTHN_RP_ID: 'example.test', WEBAUTHN_ORIGIN: 'https://app.example.test' };
  assert.equal(resolveRp(custom, 'https://app.example.test').rpId, 'example.test'); // parent-domain RP ID kept as today
  assert.equal(resolveRp(custom, 'https://example.test'), null);
});

test('resolveRp: allow-list gives each origin its own hostname as RP ID and refuses others', async () => {
  const { resolveRp } = await import('../api/_webauthn.js');
  const env = { WEBAUTHN_ORIGINS: ' https://dinkscore.vercel.app , https://dink.raulesantos.com/ ' };
  assert.equal(resolveRp(env, 'https://dinkscore.vercel.app').rpId, 'dinkscore.vercel.app');
  assert.equal(resolveRp(env, 'https://dink.raulesantos.com').rpId, 'dink.raulesantos.com');
  assert.equal(resolveRp(env, 'https://dink.raulesantos.com').legacyRpId, 'dinkscore.vercel.app'); // old passkeys stay on the old address
  for (const bad of ['https://evil.example', 'http://dink.raulesantos.com', 'https://dink.raulesantos.com.evil.example', '', undefined, null]) assert.equal(resolveRp(env, bad), null);
});

test('a credential made under one RP ID does not verify under another', () => {
  const a = makeAuthenticator({ rpId: 'dinkscore.vercel.app', origin: 'https://dinkscore.vercel.app' }), ch = newChallenge();
  const reg = verifyRegistration({ credential: a.create(ch), challenge: ch, origin: 'https://dinkscore.vercel.app', rpId: 'dinkscore.vercel.app' });
  const ch2 = newChallenge();
  assert.throws(() => verifyAssertion({ credential: a.get(ch2), challenge: ch2, origin: 'https://dink.raulesantos.com', rpId: 'dink.raulesantos.com', spki: reg.spki, alg: reg.alg, signCount: 0 }));
});
