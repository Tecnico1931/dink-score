// Minimal WebAuthn (passkey) relying-party logic: no database, no framework, only node:crypto.
// Why not a library: the app has one runtime dependency and `npm test` runs with no install. This file covers only what a
// passkey sign-in needs: registration and assertion with attestation "none" (we never rely on who made the authenticator),
// ES256 / RS256 / EdDSA keys, user verification required, origin and RP ID pinned, sign-counter rollback refused.
import { createHash, createPublicKey, verify, randomBytes, timingSafeEqual } from 'node:crypto';

export const b64u = buf => Buffer.from(buf).toString('base64url');
export const unb64u = s => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  return Buffer.from(s, 'base64url');
};
const sha256 = b => createHash('sha256').update(b).digest();
export const newChallenge = () => b64u(randomBytes(32));
export const ALGS = [-7, -257, -8]; // ES256, RS256, EdDSA

// CBOR: the subset authenticators emit (definite lengths, ints, byte/text strings, arrays, maps, booleans, null).
export function cborDecode(buf, at = 0, depth = 0) {
  if (depth > 8) throw new Error('cbor too deep');
  if (at >= buf.length) throw new Error('cbor truncated');
  const ib = buf[at++], major = ib >> 5, info = ib & 31;
  let n;
  if (info < 24) n = info;
  else if (info === 24) { n = buf[at]; at += 1; }
  else if (info === 25) { n = buf.readUInt16BE(at); at += 2; }
  else if (info === 26) { n = buf.readUInt32BE(at); at += 4; }
  else if (major === 7) throw new Error('cbor float unsupported');
  else throw new Error('cbor length unsupported');
  if (n === undefined || Number.isNaN(n)) throw new Error('cbor truncated');
  const take = () => { if (at + n > buf.length) throw new Error('cbor truncated'); const s = buf.subarray(at, at + n); at += n; return s; };
  switch (major) {
    case 0: return [n, at];
    case 1: return [-1 - n, at];
    case 2: return [Buffer.from(take()), at];
    case 3: return [take().toString('utf8'), at];
    case 4: { if (n > 64) throw new Error('cbor array too long'); const a = []; for (let i = 0; i < n; i++) { const [v, e] = cborDecode(buf, at, depth + 1); a.push(v); at = e; } return [a, at]; }
    case 5: { if (n > 64) throw new Error('cbor map too long'); const m = new Map(); for (let i = 0; i < n; i++) { const [k, e1] = cborDecode(buf, at, depth + 1); const [v, e2] = cborDecode(buf, e1, depth + 1); m.set(k, v); at = e2; } return [m, at]; }
    case 7: if (info === 20) return [false, at]; if (info === 21) return [true, at]; if (info === 22) return [null, at]; throw new Error('cbor simple unsupported');
    default: throw new Error('cbor tag unsupported');
  }
}

export function parseAuthData(ad) {
  if (!Buffer.isBuffer(ad) || ad.length < 37) throw new Error('authData too short');
  const flags = ad[32];
  const out = { rpIdHash: ad.subarray(0, 32), up: !!(flags & 1), uv: !!(flags & 4), backedUp: !!(flags & 16), at: !!(flags & 64), signCount: ad.readUInt32BE(33) };
  if (out.at) {
    if (ad.length < 55) throw new Error('authData too short');
    const len = ad.readUInt16BE(53);
    if (len < 1 || len > 1023 || ad.length < 55 + len) throw new Error('bad credential id length');
    out.credId = ad.subarray(55, 55 + len);
    out.cose = cborDecode(ad, 55 + len)[0];
  }
  return out;
}

// COSE key -> { alg, spki } (SPKI DER, base64url) so it can be stored as text and re-imported with createPublicKey.
export function coseToSpki(cose) {
  if (!(cose instanceof Map)) throw new Error('bad COSE key');
  const kty = cose.get(1), alg = cose.get(3);
  let jwk;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
  else if (kty === 3 && alg === -257) jwk = { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) };
  else if (kty === 1 && alg === -8 && cose.get(-1) === 6) jwk = { kty: 'OKP', crv: 'Ed25519', x: b64u(cose.get(-2)) };
  else throw new Error('unsupported key type');
  const key = createPublicKey({ key: jwk, format: 'jwk' }); // throws on a point that is not on the curve
  if (jwk.kty === 'RSA' && (key.asymmetricKeyDetails.modulusLength || 0) < 2048) throw new Error('RSA key too small');
  return { alg, spki: b64u(key.export({ type: 'spki', format: 'der' })) };
}

function clientData(raw, type, challenge, origin) {
  let cd;
  try { cd = JSON.parse(unb64u(raw).toString('utf8')); } catch { throw new Error('bad clientDataJSON'); }
  if (cd.type !== type) throw new Error('wrong ceremony type');
  if (typeof cd.challenge !== 'string' || cd.challenge.length !== challenge.length || !timingSafeEqual(Buffer.from(cd.challenge), Buffer.from(challenge))) throw new Error('challenge mismatch');
  if (cd.origin !== origin) throw new Error('origin mismatch');
  if (cd.crossOrigin === true) throw new Error('cross-origin ceremony');
  return unb64u(raw);
}
const checkRp = (ad, rpId) => { if (!timingSafeEqual(ad.rpIdHash, sha256(rpId))) throw new Error('rpId mismatch'); if (!ad.up) throw new Error('user presence missing'); if (!ad.uv) throw new Error('user verification missing'); };

export function verifyRegistration({ credential, challenge, origin, rpId }) {
  const r = credential && credential.response;
  if (!r || credential.type !== 'public-key') throw new Error('bad credential');
  clientData(r.clientDataJSON, 'webauthn.create', challenge, origin);
  const [att] = cborDecode(unb64u(r.attestationObject));
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('bad attestation');
  const ad = parseAuthData(att.get('authData'));
  checkRp(ad, rpId);
  if (!ad.at || !ad.cose) throw new Error('no credential data');
  if (b64u(ad.credId) !== credential.id) throw new Error('credential id mismatch');
  const { alg, spki } = coseToSpki(ad.cose);
  const transports = Array.isArray(r.transports) ? r.transports.filter(t => ['usb', 'nfc', 'ble', 'internal', 'hybrid'].includes(t)) : [];
  return { credId: credential.id, spki, alg, signCount: ad.signCount, transports, backedUp: ad.backedUp };
}

export function verifyAssertion({ credential, challenge, origin, rpId, spki, alg, signCount }) {
  const r = credential && credential.response;
  if (!r || credential.type !== 'public-key') throw new Error('bad credential');
  const cdBytes = clientData(r.clientDataJSON, 'webauthn.get', challenge, origin);
  const adBytes = unb64u(r.authenticatorData);
  const ad = parseAuthData(adBytes);
  checkRp(ad, rpId);
  const key = createPublicKey({ key: unb64u(spki), format: 'der', type: 'spki' });
  const data = Buffer.concat([adBytes, sha256(cdBytes)]);
  const sig = unb64u(r.signature);
  const good = alg === -8 ? verify(null, data, key, sig) : verify('sha256', data, key, sig);
  if (!good) throw new Error('bad signature');
  // Counter: authenticators that keep one only ever raise it. A drop means a cloned credential. Many passkeys report 0 always.
  if ((ad.signCount !== 0 || Number(signCount) !== 0) && ad.signCount <= Number(signCount)) throw new Error('sign counter went backwards');
  return { signCount: ad.signCount, userHandle: r.userHandle ? unb64u(r.userHandle).toString('utf8') : null };
}

export function creationOptions({ rpId, rpName, userId, userName, challenge, excludeIds = [] }) {
  return {
    rp: { id: rpId, name: rpName },
    user: { id: b64u(Buffer.from(userId)), name: userName, displayName: userName },
    challenge,
    pubKeyCredParams: ALGS.map(alg => ({ type: 'public-key', alg })),
    timeout: 120000,
    attestation: 'none',
    excludeCredentials: excludeIds.map(id => ({ type: 'public-key', id })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' }
  };
}
export const requestOptions = ({ rpId, challenge }) => ({ rpId, challenge, timeout: 120000, userVerification: 'required', allowCredentials: [] });

// Which RP ID and origin a request may use. WEBAUTHN_ORIGINS (comma-separated origins) is an allow-list: the request's Origin header must
// be in it and the RP ID is that origin's hostname. Unset, the single legacy pair applies exactly as before (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN).
// `legacyRpId` is what a passkey with no recorded RP ID was created under. Returns null when the origin is not allowed.
export function resolveRp(env, origin) {
  const legacyRpId = env.WEBAUTHN_RP_ID || 'dinkscore.vercel.app';
  const list = String(env.WEBAUTHN_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!list.length) {
    const only = env.WEBAUTHN_ORIGIN || 'https://' + legacyRpId;
    return origin === only ? { rpId: legacyRpId, origin: only, legacyRpId } : null;
  }
  if (typeof origin !== 'string' || !list.includes(origin)) return null;
  try { return { rpId: new URL(origin).hostname, origin, legacyRpId }; } catch { return null; }
}
