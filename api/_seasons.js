// Ending a club season early (L21), reached through POST /api/club (no new function): not a route (files starting with "_").
//   season-end {seasonId, name?, pin|ownerToken} -> organizer: closes the current season now (the usual top-3 trophies go to everyone with
//                                                   enough verified games in it) and starts the next one, called `name` or a default
// The pure rules (what counts as a season, trophies) are in _progress.js; this file only stores the cuts and checks who may make one.
import { fail, requireOrganizer } from './_db.js';
import { cleanName } from './_names.js';
import { audit } from './_members.js';
import { seasonAt, nextSeasonName, SEASON_NAME_MAX } from './_progress.js';

export const SEASON_ACTIONS = ['season-end'];
export const MIN_SEASON_MS = 60 * 1000; // a season has to have run for a minute before it can be ended: no empty or double-tap seasons

// The club's early closes, oldest first: [{at, name}] where `name` is the season that began at `at`.
export async function loadCuts(sql, code) {
  const rows = await sql`SELECT starts_at, name FROM club_seasons WHERE club = ${code} ORDER BY starts_at`;
  return rows.map(r => ({ at: Number(r.starts_at), name: r.name }));
}

export const seasonView = s => ({ id: s.id, name: s.name, start: s.start, end: s.end });

export async function seasonAction(sql, club, body, req, now = Date.now()) {
  const code = club.code; // the permanent key
  const who = await requireOrganizer(club, body.pin, req, body.ownerToken);
  const cuts = await loadCuts(sql, code);
  const cur = seasonAt(now, cuts);
  if (typeof body.seasonId !== 'string' || !body.seasonId) throw fail(400, 'Say which season to end.');
  if (body.seasonId !== cur.id) throw fail(409, 'The season has changed since you opened this. Reload and check the current season.');
  if (now - cur.start < MIN_SEASON_MS) throw fail(409, 'This season only just started. Give it a minute before ending it.');
  const name = cleanName(body.name).slice(0, SEASON_NAME_MAX) || nextSeasonName(cur.name);
  // One insert that refuses to run when another close landed in the last minute, so two organizers tapping together make one season.
  const rows = await sql`INSERT INTO club_seasons (club, starts_at, name)
    SELECT ${code}, ${now}::bigint, ${name} WHERE NOT EXISTS (SELECT 1 FROM club_seasons WHERE club = ${code} AND starts_at > ${now - MIN_SEASON_MS}::bigint)
    RETURNING starts_at`;
  if (!rows.length) throw fail(409, 'The season was just ended by someone else. Reload to see it.');
  await audit(sql, code, who, 'season-end', cur.name, { ended: seasonView(Object.assign({}, cur, { end: now })), next: { name, start: now } });
  const next = [...cuts, { at: now, name }];
  return { status: 200, body: { ok: true, closed: seasonView(Object.assign({}, cur, { end: now })), season: seasonView(seasonAt(now, next)) } };
}
