// Roles and membership, reached through POST /api/players (one route fewer for the function limit).
//   members     {pin|ownerToken}                          -> organizer: every saved name with its role, plus the audit log
//   set-role    {name, role: organizer|player, ...}       -> the creating phone or the PIN: promote or demote a co-organizer
//   remove      {name, block?, ...}                       -> organizer: take a member off (their claim and any role stop working)
//   unblock     {name, ...}                               -> organizer: let a blocked name be claimed again
//   leave       {name, playerToken}                       -> a member leaves the club
// Roles: the creating phone and the PIN are the owner-level credentials; a co-organizer (roster.role = 'organizer') can do
// everything else organizers can, but can't change roles or remove another organizer. Removing a member clears the phone's
// claim, so its tokens stop working, and any account link to the name; the member's past games and ratings stay under their
// name. Every change is written to club_audit with who did it: 'owner', 'pin' (the PIN is shared, so no name), the
// co-organizer's name, or the member themselves.
import { fail, requireOrganizer, cleanName, nameKey, tokenMatches } from './_db.js';
import { pendingRequests } from './_approvals.js';
import { undoKind } from './_undo.js';

export const MAX_ORGANIZERS = 10;
export const AUDIT_LIMIT = 100;

export async function audit(sql, club, actor, action, target, detail) {
  await sql`INSERT INTO club_audit (club, actor, actor_name, action, target, detail)
    VALUES (${club}, ${actor.by}, ${actor.name || null}, ${action}, ${target || null}, ${detail ? JSON.stringify(detail) : null}::jsonb)`;
}

// Set a member's role (null = ordinary member) and log it; a no-op when it already is that role. Shared with undo (players.js).
export async function changeRole(sql, code, actor, row, role) {
  if ((row.role || null) === role) return;
  if (role) {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM roster WHERE club = ${code} AND role = 'organizer'`;
    if (n >= MAX_ORGANIZERS) throw fail(400, `A club can have up to ${MAX_ORGANIZERS} co-organizers.`);
  }
  await sql`UPDATE roster SET role = ${role} WHERE club = ${code} AND name_key = ${nameKey(row.name)}`;
  await audit(sql, code, actor, role ? 'promote' : 'demote', row.name, { from: row.role || 'player', to: role || 'player' });
}

const targetKey = raw => {
  const name = cleanName(raw);
  if (!name) throw fail(400, 'Pick a member.');
  return nameKey(name);
};

export const MEMBER_ACTIONS = ['members', 'set-role', 'remove', 'unblock', 'leave'];

export async function memberAction(sql, club, body, req) {
  const code = club.code; // the permanent key
  const action = body.action;

  if (action === 'leave') {
    const k = targetKey(body.name);
    const [row] = await sql`SELECT name, role, claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
    if (!row || !row.claim_hash || !tokenMatches(row.claim_hash, body.playerToken)) throw fail(403, "This phone isn't linked to that player.");
    await sql`UPDATE roster SET claim_hash = NULL, role = NULL, dupr_rating = NULL, dupr_set_at = NULL WHERE club = ${code} AND name_key = ${k}`;
    await sql`DELETE FROM account_identities WHERE club = ${code} AND kind = 'player' AND name_key = ${k}`;
    await audit(sql, code, { by: 'member', name: row.name }, 'leave', row.name, row.role ? { hadRole: row.role } : null);
    return { ok: true };
  }

  const actor = await requireOrganizer(club, body.pin, req, body.ownerToken);

  if (action === 'members') {
    const [members, log, requests] = await Promise.all([
      sql`SELECT name, claim_hash IS NOT NULL AS claimed, role, blocked_at FROM roster WHERE club = ${code} ORDER BY lower(name) LIMIT 300`,
      sql`SELECT id, at, actor, actor_name, action, target, detail, undone_at FROM club_audit WHERE club = ${code} ORDER BY id DESC LIMIT ${AUDIT_LIMIT}`,
      pendingRequests(sql, code),
    ]);
    return {
      members: members.map(r => ({ name: r.name, claimed: r.claimed, role: r.role || 'player', blocked: !!r.blocked_at })),
      audit: log.map(r => ({ id: Number(r.id), undoable: !!undoKind(r, Date.now()), undone: !!r.undone_at, at: new Date(r.at).getTime(), actor: r.actor, actorName: r.actor_name, action: r.action, target: r.target, detail: r.detail })),
      requests,
      you: actor.by,
    };
  }

  if (action === 'unblock') {
    const rows = await sql`UPDATE roster SET blocked_at = NULL WHERE club = ${code} AND name_key = ${targetKey(body.name)} AND blocked_at IS NOT NULL RETURNING name`;
    if (!rows.length) throw fail(404, "That name isn't blocked.");
    await audit(sql, code, actor, 'unblock', rows[0].name);
    return { ok: true };
  }

  const k = targetKey(body.name);
  const [row] = await sql`SELECT name, role, claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
  if (!row) throw fail(404, 'No saved player has that name.');

  if (action === 'set-role') {
    if (actor.by === 'organizer') throw fail(403, 'Only the phone that created the club, or the organizer PIN, can change roles.');
    const role = body.role === 'organizer' ? 'organizer' : body.role === 'player' ? null : undefined;
    if (role === undefined) throw fail(400, 'Role must be organizer or player.');
    if (role && !row.claim_hash) throw fail(400, `${row.name} needs to pick their name on their own phone before they can be an organizer.`);
    await changeRole(sql, code, actor, row, role);
    return { ok: true, role: role || 'player' };
  }

  if (action === 'remove') {
    if (row.role === 'organizer' && actor.by === 'organizer') throw fail(403, 'Only the phone that created the club, or the organizer PIN, can remove an organizer.');
    const block = !!body.block;
    if (!row.claim_hash && !block) throw fail(404, "That name isn't linked to a phone.");
    await sql`UPDATE roster SET claim_hash = NULL, role = NULL, dupr_rating = NULL, dupr_set_at = NULL, blocked_at = ${block ? new Date().toISOString() : null} WHERE club = ${code} AND name_key = ${k}`;
    await sql`DELETE FROM account_identities WHERE club = ${code} AND kind = 'player' AND name_key = ${k}`;
    await audit(sql, code, actor, 'remove', row.name, { block, hadRole: row.role || 'player' });
    return { ok: true };
  }

  throw fail(400, 'Unknown action.');
}
