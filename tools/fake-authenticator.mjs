// A software passkey for tests: builds the same bytes a real authenticator sends, so api/_webauthn.js is checked end to end.
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';

const sha256 = b => createHash('sha256').update(b).digest();
const b64u = b => Buffer.from(b).toString('base64url');

// Just enough CBOR to write a COSE key and an attestation object.
function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}

export function makeAuthenticator({ rpId, origin, uv = true, up = true } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credIdBytes = randomBytes(32), id = b64u(credIdBytes);
  let counter = 0;
  const flags = (at) => (up ? 1 : 0) | (uv ? 4 : 0) | (at ? 64 : 0);
  const cose = () => cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const cd = (type, challenge, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
  const cn = () => { const b = Buffer.alloc(4); b.writeUInt32BE(counter); return b; };
  return {
    id,
    create(challenge, over = {}) {
      const len = Buffer.alloc(2); len.writeUInt16BE(credIdBytes.length);
      const ad = Buffer.concat([sha256(over.rpId || rpId), Buffer.from([flags(true)]), cn(), Buffer.alloc(16), len, credIdBytes, cose()]);
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64u(cd('webauthn.create', challenge, over.origin)), attestationObject: b64u(att), transports: ['internal'] } };
    },
    get(challenge, { userHandle, over = {} } = {}) {
      counter++;
      const ad = Buffer.concat([sha256(over.rpId || rpId), Buffer.from([flags(false)]), cn()]);
      const c = cd(over.type || 'webauthn.get', challenge, over.origin);
      const sig = sign('sha256', Buffer.concat([ad, sha256(c)]), privateKey);
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64u(c), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: userHandle ? b64u(Buffer.from(userHandle)) : undefined } };
    },
    setCounter(n) { counter = n; }
  };
}
