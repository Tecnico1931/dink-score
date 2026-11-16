// POST   /api/games {code, games:[...]}      -> saves one or more games (uploads use up to 500 at once)
// POST   /api/games {code, restore: id}      -> brings back a deleted game (kept for 30 days)
// POST   /api/games {code, edit: game}       -> replaces a saved game with corrected details (same id)
// GET    /api/games?code=ABC123&id=g123      -> {rallyLog} for replaying a game scored live (null when it has none)
// A game may carry "rallyLog" (see _rallylog.js). A log that doesn't replay to the game's own score is dropped and the game
// is saved without it; the response lists those ids in "rejectedLogs".
// DELETE /api/games?code=ABC123&id=g123      -> moves a game to recently deleted
// Deleting, restoring and editing need the organizer PIN (X-Club-PIN header, or "pin" in the body) when the club has one,
// or the creating phone's token (X-Club-Owner header, or "ownerToken" in the body).
import { checkLog } from './_rallylog.js';
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanGame, cleanName, nameKey, reserveGames, releaseGames, requirePin, pinFrom, ownerFrom, tokenMatches, verifiedSender } from './_db.js';

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://x');
    const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
    const code = club.code; // the club's permanent key, even when an old club code was used
    await requirePin(club, pinFrom(req), req, ownerFrom(req));
    const id = String(url.searchParams.get('id') || '');
    const rows = await sql`UPDATE games SET deleted_at = now() WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That game was already deleted.');
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
    const [row] = await sql`SELECT rally_log FROM games WHERE club = ${club.code} AND id = ${String(url.searchParams.get('id') || '')} AND deleted_at IS NULL`;
    if (!row) throw fail(404, 'That game no longer exists.');
    return send(res, 200, { rallyLog: row.rally_log || null });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used

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
    const [old] = await sql`SELECT data, rally_log FROM games WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL`;
    if (!old) throw fail(404, 'That game no longer exists, so it could not be changed.');
    // Keep the server's own record of when the game arrived. Whether it still counts as verified (for achievements, challenges and seasons):
    // - An edit that changes who played, the score, or whether it was scored live keeps verification only when an
    //   organizer has proved it: the club creator's phone, or the PIN in a club that has one. (In a club without a
    //   PIN anyone can edit, so their changes can't keep a game's verified status.)
    // - Any other edit (just the date or format) keeps it.
    // An edit never adds verification to a game that didn't have it.
    g.receivedAt = old.data.receivedAt || old.data.endedAt;
    const o = old.data;
    const sameResult = JSON.stringify(o.teams) === JSON.stringify(g.teams) && JSON.stringify(o.score) === JSON.stringify(g.score) && !!o.logged === !!g.logged;
    const organizerProved = (club.owner_hash && tokenMatches(club.owner_hash, body.ownerToken ?? ownerFrom(req))) || !!club.pin_hash;
    const sender = o.scoredBy;
    if (sender && (sameResult || organizerProved)) g.scoredBy = sender;
    // The rally log only stays while it still replays to the corrected game; a changed score, format or target clears it.
    const log = old.rally_log ? checkLog(g, old.rally_log) : null;
    const rows = await sql`UPDATE games SET data = ${JSON.stringify(g)}::jsonb, ended_at = ${g.endedAt}, rally_log = ${log}
      WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That game no longer exists, so it could not be changed.');
    let [{ players }] = await sql`SELECT count(*)::int AS players FROM roster WHERE club = ${code}`;
    for (const p of g.teams.flat()) {
      if (players >= 300 || /^Player \d+$/.test(p)) continue;
      const added = await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${nameKey(p)}, ${cleanName(p)}) ON CONFLICT DO NOTHING RETURNING name_key`;
      players += added.length;
    }
    return send(res, 200, { ok: true, game: g });
  }

  const list = Array.isArray(body.games) ? body.games : [];
  if (!list.length) throw fail(400, 'No games to save.');
  if (list.length > 500) throw fail(400, 'Upload at most 500 games at a time.');

  const games = list.map(cleanGame); // validate everything before using up any of the club's allowance
  const logs = list.map((raw, i) => (raw && raw.rallyLog != null ? checkLog(games[i], raw.rallyLog) : null));
  const rejectedLogs = games.filter((g, i) => list[i].rallyLog != null && !logs[i]).map(g => g.id);
  // Server-side facts (the app can't set these; cleanGame drops them):
  // - receivedAt: when the server got the game. Weeks and seasons count by this, so backdating doesn't help.
  // - scoredBy: who sent it. Achievements, challenges and seasons count only games sent from the phone linked to one of
  //   any club player (the game can be for other people), or from the club creator's phone.
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
    for (const [i, g] of games.entries()) {
      const rows = await sql`INSERT INTO games (club, id, data, ended_at, rally_log) VALUES (${code}, ${g.id}, ${JSON.stringify(g)}::jsonb, ${g.endedAt}, ${logs[i]})
                ON CONFLICT (club, id) DO NOTHING RETURNING id`;
      inserted += rows.length;
      for (const p of g.teams.flat()) if (!/^Player \d+$/.test(p)) names.set(nameKey(p), p);
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
  send(res, 200, { ok: true, saved: inserted, alreadySaved: games.length - inserted, ...(rejectedLogs.length ? { rejectedLogs } : {}) });
});
