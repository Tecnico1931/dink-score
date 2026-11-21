// Per-phone organizer keys. A phone that proves the organizer PIN is handed its own random key, so one phone can be removed
// without changing the PIN for everyone. The key is 80 hex characters: a 16-character public id (shown in lists, used to
// remove a phone) followed by a 256-bit random secret. Only SHA-256 of the secret is stored (the secret is random, so it needs
// no slow hash), compared in constant time. The key travels where the PIN does, as "<digits>:<key>" or ":<key>" in the
// existing `pin` field and X-Club-PIN header, and never appears in a URL, a log line or an audit row (only its id does).
// Rows are in organizer_devices and go with the club. The older club-wide key (`deviceKey` in _db.js) keeps working for
// phones that have not upgraded; a PIN change ends every key of both kinds.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const MAX_DEVICES = 25; // phones unlocked at once, per club
export const STALE_DAYS = 180; // a phone not seen for this long is forgotten
const TOUCH_MINUTES = 10; // last-used is written at most this often per phone

const sha = s => createHash('sha256').update(s).digest();

export function newDeviceKey() {
  const id = randomBytes(8).toString('hex'), secret = randomBytes(32).toString('hex');
  return { id, key: id + secret, hash: sha(secret).toString('hex') };
}
// {id, secret} for a well-formed key, else null.
export function parseDeviceKey(key) {
  const m = /^([0-9a-f]{16})([0-9a-f]{64})$/.exec(String(key ?? ''));
  return m ? { id: m[1], secret: m[2] } : null;
}
export function secretMatches(storedHash, secret) {
  const want = Buffer.from(String(storedHash || ''), 'hex'), got = sha(String(secret));
  return want.length === got.length && timingSafeEqual(want, got);
}
// The key part of an organizer credential ("<digits>:<key>"), or ''.
export const keyPart = cred => String(cred ?? '').split(':')[1] || '';

// The row for a presented key when it is a live key of this club, else null. Refreshes its last-used time.
export async function findDevice(sql, clubCode, key) {
  const p = parseDeviceKey(key);
  if (!p) return null;
  const [row] = await sql`SELECT id, key_hash, name_key FROM organizer_devices WHERE club = ${clubCode} AND id = ${p.id}`;
  if (!row || !secretMatches(row.key_hash, p.secret)) return null;
  await sql`UPDATE organizer_devices SET last_used_at = now() WHERE club = ${clubCode} AND id = ${p.id} AND last_used_at < now() - ${TOUCH_MINUTES + ' minutes'}::interval`;
  return { id: row.id, nameKey: row.name_key };
}

// Registers a phone: returns its key (shown once, never stored). Forgets long-unused phones first.
export async function issueDevice(sql, clubCode, nameKey) {
  await sql`DELETE FROM organizer_devices WHERE club = ${clubCode} AND last_used_at < now() - ${STALE_DAYS + ' days'}::interval`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM organizer_devices WHERE club = ${clubCode}`;
  if (n >= MAX_DEVICES) return null;
  const d = newDeviceKey();
  await sql`INSERT INTO organizer_devices (club, id, key_hash, name_key) VALUES (${clubCode}, ${d.id}, ${d.hash}, ${nameKey || null})`;
  return { id: d.id, key: d.key };
}
