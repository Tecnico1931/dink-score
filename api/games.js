// POST   /api/games {code, games:[...]}      -> saves one or more games (uploads use up to 500 at once)
// POST   /api/games {code, restore: id}      -> brings back a deleted game (kept for 30 days)
// DELETE /api/games?code=ABC123&id=g123      -> moves a game to recently deleted
// Deleting and restoring need the organizer PIN (X-Club-PIN header, or "pin" in the body) when the club has one.
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanGame, cleanName, reserveGames, releaseGames, requirePin, pinFrom } from './_db.js';

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://x');
    const code = cleanCode(url.searchParams.get('code'));
    const club = await requireClub(code, req);
    await requirePin(club, pinFrom(req), req);
    const id = String(url.searchParams.get('id') || '');
    const rows = await sql`UPDATE games SET deleted_at = now() WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That game was already deleted.');
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const code = cleanCode(body.code);
  const club = await requireClub(code, req);

  if (body.restore) {
    await requirePin(club, body.pin ?? pinFrom(req), req);
    const rows = await sql`UPDATE games SET deleted_at = NULL WHERE club = ${code} AND id = ${String(body.restore)} RETURNING id`;
    if (!rows.length) throw fail(404, 'That game can no longer be restored.');
    return send(res, 200, { ok: true });
  }

  const list = Array.isArray(body.games) ? body.games : [];
  if (!list.length) throw fail(400, 'No games to save.');
  if (list.length > 500) throw fail(400, 'Upload at most 500 games at a time.');

  const games = list.map(cleanGame); // validate everything before using up any of the club's allowance
  // Flood protection on every request, bulk uploads included (see reserveGames in _db.js).
  const windowStart = await reserveGames(code, games.length);
  const names = new Map();
  let inserted = 0;
  try {
    for (const g of games) {
      const rows = await sql`INSERT INTO games (club, id, data, ended_at) VALUES (${code}, ${g.id}, ${JSON.stringify(g)}::jsonb, ${g.endedAt})
                ON CONFLICT (club, id) DO NOTHING RETURNING id`;
      inserted += rows.length;
      for (const p of g.teams.flat()) if (!/^Player \d+$/.test(p)) names.set(p.toLowerCase(), p);
    }
  } finally {
    // Give back the allowance for games that were already stored (re-sent after a dropped connection) or not saved.
    await releaseGames(code, games.length - inserted, windowStart);
  }
  // Saved players share the 300-per-club cap with /api/roster. Games still save once the list is full.
  let [{ players }] = await sql`SELECT count(*)::int AS players FROM roster WHERE club = ${code}`;
  for (const [key, name] of names) {
    if (players >= 300) break;
    const added = await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${key}, ${cleanName(name)}) ON CONFLICT DO NOTHING RETURNING name_key`;
    players += added.length;
  }
  send(res, 200, { ok: true, saved: inserted, alreadySaved: games.length - inserted });
});
