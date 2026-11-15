// POST   /api/games {code, games:[...]}      -> saves one or more games (uploads use up to 500 at once)
// POST   /api/games {code, restore: id}      -> brings back a deleted game (kept for 30 days)
// POST   /api/games {code, edit: game}       -> replaces a saved game with corrected details (same id)
// DELETE /api/games?code=ABC123&id=g123      -> moves a game to recently deleted
// Deleting, restoring and editing need the organizer PIN (X-Club-PIN header, or "pin" in the body) when the club has one,
// or the creating phone's token (X-Club-Owner header, or "ownerToken" in the body).
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanGame, cleanName, reserveGames, releaseGames, requirePin, pinFrom, ownerFrom, tokenMatches } from './_db.js';

// Who is sending these games: a player's name key (their phone's player token checks out), 'organizer' (the club
// creator's phone), or null. Never trusted from the game data itself.
async function verifiedSender(sql, club, code, body) {
  if (club.owner_hash && tokenMatches(club.owner_hash, body.ownerToken)) return 'organizer';
  if (!body.playerName || !body.playerToken) return null;
  const k = cleanName(body.playerName).toLowerCase();
  const [row] = await sql`SELECT claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
  return row && row.claim_hash && tokenMatches(row.claim_hash, body.playerToken) ? k : null;
}

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://x');
    const code = cleanCode(url.searchParams.get('code'));
    const club = await requireClub(code, req);
    await requirePin(club, pinFrom(req), req, ownerFrom(req));
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
    await requirePin(club, body.pin ?? pinFrom(req), req, body.ownerToken ?? ownerFrom(req));
    const rows = await sql`UPDATE games SET deleted_at = NULL WHERE club = ${code} AND id = ${String(body.restore)} RETURNING id`;
    if (!rows.length) throw fail(404, 'That game can no longer be restored.');
    return send(res, 200, { ok: true });
  }

  if (body.edit) {
    // Fix a saved result: same rules as deleting (organizer PIN or the creating phone), same checks as a new game.
    await requirePin(club, body.pin ?? pinFrom(req), req, body.ownerToken ?? ownerFrom(req));
    const g = Object.assign(cleanGame(body.edit), { editedAt: Date.now() });
    const [old] = await sql`SELECT data FROM games WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL`;
    if (!old) throw fail(404, 'That game no longer exists, so it could not be changed.');
    // Keep the server's own record of when the game arrived. Whether it still counts as verified (full Dinks):
    // - An edit that changes who played, the score, or whether it was scored live keeps verification only when an
    //   organizer has proved it: the club creator's phone, or the PIN in a club that has one. (In a club without a
    //   PIN anyone can edit, so their changes can't keep a game's full-Dinks status.)
    // - Any other edit (just the date or format) keeps it.
    // An edit never adds verification to a game that didn't have it.
    g.receivedAt = old.data.receivedAt || old.data.endedAt;
    const o = old.data;
    const sameResult = JSON.stringify(o.teams) === JSON.stringify(g.teams) && JSON.stringify(o.score) === JSON.stringify(g.score) && !!o.logged === !!g.logged;
    const organizerProved = (club.owner_hash && tokenMatches(club.owner_hash, body.ownerToken ?? ownerFrom(req))) || !!club.pin_hash;
    const sender = o.scoredBy;
    if (sender && (sameResult || organizerProved)) g.scoredBy = sender;
    const rows = await sql`UPDATE games SET data = ${JSON.stringify(g)}::jsonb, ended_at = ${g.endedAt}
      WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That game no longer exists, so it could not be changed.');
    let [{ players }] = await sql`SELECT count(*)::int AS players FROM roster WHERE club = ${code}`;
    for (const p of g.teams.flat()) {
      if (players >= 300 || /^Player \d+$/.test(p)) continue;
      const added = await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${p.toLowerCase()}, ${cleanName(p)}) ON CONFLICT DO NOTHING RETURNING name_key`;
      players += added.length;
    }
    return send(res, 200, { ok: true, game: g });
  }

  const list = Array.isArray(body.games) ? body.games : [];
  if (!list.length) throw fail(400, 'No games to save.');
  if (list.length > 500) throw fail(400, 'Upload at most 500 games at a time.');

  const games = list.map(cleanGame); // validate everything before using up any of the club's allowance
  // Server-side facts for Dinks (the app can't set these; cleanGame drops them):
  // - receivedAt: when the server got the game. The daily earning cap counts by this, so backdating doesn't help.
  // - scoredBy: who sent it. Win, forecast and streak Dinks need a game sent from the phone linked to one of
  //   any club player (the game can be for other people), or from the club creator's phone. Anything else earns the play bonus only.
  const sender = await verifiedSender(sql, club, code, body);
  const now = Date.now();
  for (const g of games) {
    g.receivedAt = now;
    if (sender) g.scoredBy = sender;
  }
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
