// Who is an organizer: the phones unlocked with the organizer PIN, each with its own key (see _orgkeys.js). Reached through POST /api/club.
//   device-list   {pin|ownerToken}          -> organizer: every unlocked phone {id, name (its linked player, or null), createdAt, lastUsedAt, you}, newest use first
//   device-remove {id, pin|ownerToken}      -> organizer: that phone's key stops working at once
//   device-lock   {pin: ":<key>"}            -> a phone revokes its own key (needs only that key, so it works even while PIN guesses are paused)
// Unlocking (verify-pin with `device: true`) registers a phone; see issueFor. Every unlock, remove and lock is written to club_audit
// with the phone's id and the linked player's name, never a key or a PIN. Removing a phone leaves the PIN and every other phone alone.
import { fail, requireOrganizer, cleanName, nameKey, tokenMatches } from './_db.js';
import { audit } from './_members.js';
import { issueDevice, parseDeviceKey, secretMatches, keyPart, MAX_DEVICES } from './_orgkeys.js';

export const DEVICE_ACTIONS = ['device-list', 'device-remove', 'device-lock'];

// The player this phone is linked to, only when its player token checks out; otherwise null (the phone is listed unnamed).
async function linkedKey(sql, code, body) {
  if (!body.playerName || !body.playerToken) return null;
  const k = nameKey(cleanName(body.playerName));
  const [row] = await sql`SELECT claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
  return row && row.claim_hash && tokenMatches(row.claim_hash, body.playerToken) ? k : null;
}
const nameOf = async (sql, code, k) => k ? ((await sql`SELECT name FROM roster WHERE club = ${code} AND name_key = ${k}`)[0] || {}).name || null : null;

// After a PIN was proven for this club: a new phone key, or {} when the club is at its limit (the caller falls back to the club-wide key).
export async function issueFor(sql, club, body, actor) {
  const k = await linkedKey(sql, club.code, body);
  const d = await issueDevice(sql, club.code, k);
  if (!d) return {};
  await audit(sql, club.code, actor, 'device-unlock', await nameOf(sql, club.code, k), { device: d.id });
  return { organizerKey: d.key };
}

export async function deviceAction(sql, club, body, req) {
  const code = club.code;
  if (body.action === 'device-lock') {
    const p = parseDeviceKey(keyPart(body.pin));
    const [row] = p ? await sql`SELECT d.key_hash, r.name FROM organizer_devices d LEFT JOIN roster r ON r.club = d.club AND r.name_key = d.name_key WHERE d.club = ${code} AND d.id = ${p.id}` : [];
    if (row && secretMatches(row.key_hash, p.secret)) {
      await sql`DELETE FROM organizer_devices WHERE club = ${code} AND id = ${p.id}`;
      await audit(sql, code, { by: 'pin' }, 'device-lock', row.name || null, { device: p.id });
    }
    return { body: { ok: true } }; // locking is idempotent: an unknown or already removed key is simply locked
  }
  const actor = await requireOrganizer(club, body.pin, req, body.ownerToken);
  const mine = (parseDeviceKey(keyPart(body.pin)) || {}).id || null;
  if (body.action === 'device-list') {
    const rows = await sql`SELECT d.id, d.created_at, d.last_used_at, r.name FROM organizer_devices d LEFT JOIN roster r ON r.club = d.club AND r.name_key = d.name_key WHERE d.club = ${code} ORDER BY d.last_used_at DESC, d.created_at DESC`;
    return { body: { devices: rows.map(r => ({ id: r.id, name: r.name || null, createdAt: new Date(r.created_at).getTime(), lastUsedAt: new Date(r.last_used_at).getTime(), you: r.id === mine })), limit: MAX_DEVICES } };
  }
  const id = String(body.id ?? '');
  if (!/^[0-9a-f]{16}$/.test(id)) throw fail(400, 'Pick a phone to remove.');
  const rows = await sql`DELETE FROM organizer_devices d WHERE d.club = ${code} AND d.id = ${id} RETURNING d.name_key`;
  if (!rows.length) throw fail(404, 'That phone is already removed.');
  await audit(sql, code, actor, 'device-remove', await nameOf(sql, code, rows[0].name_key), { device: id, ...(id === mine ? { self: true } : {}) });
  return { body: { ok: true } };
}
