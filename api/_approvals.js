// Ask an organizer to approve instead of sharing the PIN (L17).
// A member who can't (or shouldn't) enter the organizer PIN asks to link a saved name to their phone: for a name already linked to
// another phone (new phone, lost phone), or one that needs an organizer to confirm it. The request is short-lived (15 minutes),
// organizers hear about it through the existing push (see _push.js), and any organizer approves or denies it from their own phone.
// Reached through /api/players (approval-* actions; the function count is at its limit).
//   approval-request {name, playerToken}  -> the asking phone: makes up its own private key (playerToken, 48 hex) and sends it; only its hash
//                                           is stored. Answers {id, expiresAt}. Approving makes that key the name's link, so the key is the
//                                           proof of who asked, and no token is ever sent back.
//   approval-status  {id, playerToken}    -> the asking phone: pending | approved | denied | expired
//   approval-decide  {id, decision, pin|ownerToken} -> organizer: approve | deny (members lists the pending ones)
// Approving links the name to the asking phone the way release + claim would: the old link, role, self-reported rating, notification
// devices and passkey-account link of that name are dropped, so the name starts as an ordinary member on the new phone. A co-organizer
// can't hand over an organizer's name (same rule as release). Every decision is written to club_audit with who made it.
import { randomBytes } from 'node:crypto';
import { cleanName, nameKey } from './_names.js';
import { notify, vapidFromEnv } from './_push.js';

export const APPROVAL_ACTIONS = ['approval-request', 'approval-status', 'approval-decide'];
export const APPROVAL_TTL_SECONDS = 15 * 60;
export const MAX_PENDING_PER_CLUB = 10;
export const MAX_ASKS_PER_HOUR = 5; // per network

const fail = (status, message) => Object.assign(new Error(message), { status });
const short = (s, n) => String(s || '').slice(0, n);

// pending, approved, denied, or expired (a pending row past its time).
export function requestState(row, now = Date.now()) {
  if (row.status === 'approved' || row.status === 'denied') return row.status;
  return new Date(row.expires_at).getTime() > now ? 'pending' : 'expired';
}

export function cleanDecision(raw) {
  const d = String(raw == null ? '' : raw).trim().toLowerCase();
  if (d === 'approve' || d === 'deny') return d;
  throw fail(400, 'Choose approve or deny.');
}

// The key the asking phone made up: same shape as a player token (what tokenMatches accepts).
export function cleanAskToken(raw) {
  const t = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(t)) throw fail(400, 'This phone could not make a request. Reload the app and try again.');
  return t;
}

// Never carries the club name or code (privacy invariant, see push-check.mjs): only the name as typed in the club.
export const requestMessage = name => ({ title: 'Approval needed', body: `Someone asks to link ${short(name, 30)} to a new phone. Open Members to decide.`, tag: 'approval' });

// ---- database queries and routes ----

// What organizers see in the Members sheet.
export async function pendingRequests(sql, code) {
  const rows = await sql`SELECT a.id, r.name, r.claim_hash IS NOT NULL AS linked, a.created_at, a.expires_at
    FROM approval_requests a JOIN roster r ON r.club = a.club AND r.name_key = a.name_key
    WHERE a.club = ${code} AND a.status = 'pending' AND a.expires_at > now() ORDER BY a.created_at ASC, a.id ASC`;
  return rows.map(r => ({ id: r.id, name: r.name, linked: !!r.linked, at: new Date(r.created_at).getTime(), expiresAt: new Date(r.expires_at).getTime() }));
}

// Organizers a push can reach: co-organizers, and the phone that created the club (it subscribes with its owner token, which flags the device).
async function organizerMessages(sql, code, name) {
  const rows = await sql`SELECT r.name FROM roster r WHERE r.club = ${code} AND r.claim_hash IS NOT NULL AND r.blocked_at IS NULL
    AND (r.role = 'organizer' OR EXISTS (SELECT 1 FROM push_subs s WHERE s.club = r.club AND s.name_key = r.name_key AND s.organizer))`;
  const msg = requestMessage(name);
  return new Map(rows.map(r => [r.name, msg]));
}

export async function approvalAction(sql, club, body, req) {
  const { requireOrganizer, tokenMatches, hashToken, clientIp } = await import('./_db.js');
  const code = club.code; // the permanent key
  const action = body.action;

  if (action === 'approval-request') {
    const name = cleanName(body.name);
    if (!name) throw fail(400, 'Pick a name.');
    const token = cleanAskToken(body.playerToken);
    const key = nameKey(name);
    const [row] = await sql`SELECT name, claim_hash, blocked_at FROM roster WHERE club = ${code} AND name_key = ${key}`;
    if (!row) throw fail(404, 'No saved player has that name.');
    if (row.blocked_at) throw fail(403, `${row.name} was removed from this club by an organizer. Ask an organizer to unblock it.`);
    // A few asks per network per hour, so nobody can fill every organizer's phone with requests.
    const mark = 'ask:' + clientIp(req);
    const [{ id: markId }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${mark}) RETURNING id`;
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${mark} AND at > now() - interval '1 hour'`;
    if (Number(n) > MAX_ASKS_PER_HOUR) {
      await sql`DELETE FROM lookup_fails WHERE id = ${markId}`;
      throw fail(429, 'Too many requests from this network. Try again in an hour.');
    }
    await sql`DELETE FROM approval_requests WHERE club = ${code} AND expires_at < now() - interval '1 day'`;
    await sql`UPDATE approval_requests SET status = 'expired' WHERE club = ${code} AND name_key = ${key} AND status = 'pending' AND expires_at <= now()`;
    const [{ pending }] = await sql`SELECT count(*)::int AS pending FROM approval_requests WHERE club = ${code} AND status = 'pending'`;
    if (Number(pending) >= MAX_PENDING_PER_CLUB) throw fail(429, 'This club already has several requests waiting. Ask an organizer in person.');
    const id = 'ap-' + randomBytes(6).toString('hex');
    let made;
    try {
      [made] = await sql`INSERT INTO approval_requests (club, id, name_key, token_hash, expires_at)
        VALUES (${code}, ${id}, ${key}, ${hashToken(token)}, now() + ${APPROVAL_TTL_SECONDS} * interval '1 second') RETURNING expires_at`;
    } catch (e) {
      if (e && e.code === '23505') throw fail(409, `A request for ${row.name} is already waiting for an organizer.`);
      throw e;
    }
    const vapid = vapidFromEnv();
    const sent = vapid ? await notify(sql, code, await organizerMessages(sql, code, row.name), vapid) : 0;
    return { ok: true, id, expiresAt: new Date(made.expires_at).getTime(), notified: sent };
  }

  if (action === 'approval-status') {
    const id = String(body.id || '').slice(0, 40);
    const [row] = await sql`SELECT status, expires_at, token_hash FROM approval_requests WHERE club = ${code} AND id = ${id}`;
    if (!row || !tokenMatches(row.token_hash, body.playerToken)) throw fail(404, "That request wasn't found. It may have expired.");
    return { ok: true, status: requestState(row), expiresAt: new Date(row.expires_at).getTime() };
  }

  // approval-decide: organizers only.
  const actor = await requireOrganizer(club, body.pin, req, body.ownerToken);
  const { audit } = await import('./_members.js');
  const decision = cleanDecision(body.decision);
  const id = String(body.id || '').slice(0, 40);
  const [row] = await sql`SELECT a.name_key, a.token_hash, a.status, a.expires_at, r.name, r.role, r.blocked_at
    FROM approval_requests a LEFT JOIN roster r ON r.club = a.club AND r.name_key = a.name_key WHERE a.club = ${code} AND a.id = ${id}`;
  if (!row) throw fail(404, "That request wasn't found.");
  const state = requestState(row);
  if (state !== 'pending') throw fail(409, state === 'expired' ? 'That request expired. Ask them to send it again.' : `That request was already ${state}.`);
  if (!row.name) throw fail(409, 'That name is no longer in the club.');
  if (decision === 'approve') {
    if (row.blocked_at) throw fail(409, `${row.name} was removed from this club. Unblock it first.`);
    if (row.role === 'organizer' && actor.by === 'organizer') throw fail(403, 'Only the phone that created the club, or the organizer PIN, can hand over an organizer.');
  }
  // Atomic: only one decision wins, and never after the time is up.
  const won = await sql`UPDATE approval_requests SET status = ${decision === 'approve' ? 'approved' : 'denied'}, decided_at = now()
    WHERE club = ${code} AND id = ${id} AND status = 'pending' AND expires_at > now() RETURNING id`;
  if (!won.length) throw fail(409, 'That request was just decided or expired.');
  if (decision === 'approve') {
    await sql.transaction([
      sql`UPDATE roster SET claim_hash = ${row.token_hash}, role = NULL, dupr_rating = NULL, dupr_set_at = NULL WHERE club = ${code} AND name_key = ${row.name_key} AND blocked_at IS NULL`,
      sql`DELETE FROM push_subs WHERE club = ${code} AND name_key = ${row.name_key}`,
      sql`DELETE FROM account_identities WHERE club = ${code} AND kind = 'player' AND name_key = ${row.name_key}`,
    ]);
  }
  await audit(sql, code, actor, decision === 'approve' ? 'approve-claim' : 'deny-claim', row.name, { request: id });
  return { ok: true, status: decision === 'approve' ? 'approved' : 'denied' };
}
