// Move to a new phone without accounts: pure helpers for transfer and recovery codes.
// The transfer code never reaches the server. The old phone derives a lookup id and an encryption key from it
// (see the MOVE block in dink-score.html), so the server only holds an id it can't reverse and a blob it can't read.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export const TRANSFER_TTL_MIN = 10;         // a transfer code works for 10 minutes, once
export const RECOVERY_TTL_DAYS = 90;        // a printed creator recovery code works for 90 days, once
export const MAX_BLOB = 32 * 1024;          // base64 characters; a phone's tokens are a few hundred bytes per club

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // same alphabet as club codes: no 0/O, 1/I/L

// A recovery code is 16 characters (about 79 bits), shown as XXXX-XXXX-XXXX-XXXX.
export function newRecoveryCode() {
  let out = '';
  while (out.length < 16) for (const b of randomBytes(32)) if (b < 248 && out.length < 16) out += ALPHA[b % 31];
  return out.replace(/(.{4})(?=.)/g, '$1-');
}
export const cleanRecoveryCode = raw => {
  const c = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 16 && [...c].every(ch => ALPHA.includes(ch)) ? c : null;
};
export const hashRecovery = code => scryptSync(code, 'dink-score-recovery', 32).toString('hex');
export function recoveryMatches(stored, code) {
  if (!stored || !code) return false;
  const a = Buffer.from(stored, 'hex'), b = Buffer.from(hashRecovery(code), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Transfer ids come from the phone: 64 hex characters. The server stores one more hash of it, never the id itself.
export const cleanTransferId = raw => (/^[0-9a-f]{64}$/.test(String(raw || '')) ? String(raw) : null);
export const idHash = id => createHash('sha256').update('dink-move-store:' + id).digest('hex');
export const cleanBlob = raw => (typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_BLOB && /^[A-Za-z0-9+/_=-]+$/.test(raw) ? raw : null);
