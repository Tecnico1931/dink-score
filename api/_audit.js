// Append-only history of what happened to a club's games: who, what, when, and the game before and after.
// Rows are only ever inserted here; nothing in the API updates or deletes them (they go with the club).
import { tokenMatches } from './_db.js';

// Who is acting, as the server can tell. Organizers share one PIN, so "organizer-pin" says which kind of credential, not which person.
//   creator       the phone that created the club (its private token)
//   organizer-pin someone with the organizer PIN
//   member        a club with no PIN, where anyone with the code may edit
//   player:<key>  a phone linked to that club player
//   anonymous     only the club code
export function organizerActor(club, ownerToken) {
  if (club.owner_hash && tokenMatches(club.owner_hash, ownerToken)) return 'creator';
  return club.pin_hash ? 'organizer-pin' : 'member';
}
export const senderActor = sender => (sender === 'organizer' ? 'creator' : sender ? 'player:' + sender : 'anonymous');

// The parts of a game worth keeping in the history (the replay log is only noted, never copied).
export const snapshot = g => g && ({ teams: g.teams, score: g.score, mode: g.mode, scoring: g.scoring, target: g.target, winBy: g.winBy, endedAt: g.endedAt, logged: !!g.logged, ...(g.event ? { event: g.event.name || true } : {}) });

export async function audit(sql, club, game, action, actor, before, after, note) {
  await sql`INSERT INTO game_audit (club, game, action, actor, before, after, note)
    VALUES (${club}, ${game || ''}, ${action}, ${actor}, ${before ? JSON.stringify(before) : null}::jsonb, ${after ? JSON.stringify(after) : null}::jsonb, ${note || null})`;
}
