// POST   /api/games {code, games:[...]}      -> saves one or more games (uploads use up to 500 at once)
// POST   /api/games {code, restore: id}      -> brings back a deleted game (kept for 30 days)
// POST   /api/games {code, edit: game}       -> replaces a saved game with corrected details (same id)
// GET    /api/games?code=ABC123&id=g123      -> {rallyLog} for replaying a game scored live (null when it has none)
// A game may carry "rallyLog" (see _rallylog.js). A log that doesn't replay to the game's own score is dropped and the game
// is saved without it; the response lists those ids in "rejectedLogs".
// DELETE /api/games?code=ABC123&id=g123      -> moves a game to recently deleted
// Deleting, restoring and editing need the organizer PIN (X-Club-PIN header, or "pin" in the body) when the club has one,
// or the creating phone's token (X-Club-Owner header, or "ownerToken" in the body).
// POST   /api/games {code, confirm: id, playerName+playerToken | pin | ownerToken} -> confirms a game: a player on the other team from whoever recorded it, or an organizer
// POST   /api/games {code, keepBoth: [idA, idB], pin|ownerToken}  -> organizer: these two similar games are really two games, stop flagging them
// GET    /api/games?code=ABC123&rating=Name[&mode=singles] -> {points: [[ended at, rating after]]}: that player's stored Dink Rating line, oldest first
// GET    /api/games?code=ABC123&reactions=g123 -> {gameId, reactions: { [key]: [name, ...] }} for one finished game
// POST   /api/games {code, react: id, reaction, playerName, playerToken} -> toggles a member's reaction on a finished game
// GET    /api/games?code=ABC123&audit=1[&id=g123]  -> organizer only: the history of changes to games (who, what, when, before and after), newest first
import { checkLog } from './_rallylog.js';
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanGame, requireOrganizer, cleanName, nameKey, reserveGames, releaseGames, requirePin, pinFrom, ownerFrom, tokenMatches, coOrganizer, verifiedSender, stampSender, clientIp } from './_db.js';
import { audit, organizerActor, senderActor, snapshot } from './_audit.js';
import { confirmBlocker } from './_confirm.js';
import { refreshRatings, historyOf } from './_rating_store.js';
import { getGameReactions, toggleReaction } from './_reactions.js';

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://x');
    const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
    const code = club.code; // the club's permanent key, even when an old club code was used
    await requirePin(club, pinFrom(req), req, ownerFrom(req));
    const id = String(url.searchParams.get('id') || '');
    const rows = await sql`UPDATE games SET deleted_at = now() WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL RETURNING id, data, rally_log IS NOT NULL AS replay`;
    if (!rows.length) throw fail(404, 'That game was already deleted.');
    await audit(sql, code, id, 'delete', await organizerActor(club, ownerFrom(req)), snapshot(rows[0].data), null, rows[0].replay ? 'had a replay' : null);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
    if (url.searchParams.get('audit')) {
      // The history is for organizers only: the creating phone or the PIN (a club without a PIN is read by its creating phone alone).
      await requireOrganizer(club, pinFrom(req), req, ownerFrom(req));
      const only = url.searchParams.get('id');
      const rows = only
        ? await sql`SELECT id, game, action, actor, at, before, after, note FROM game_audit WHERE club = ${club.code} AND game = ${String(only)} ORDER BY id DESC LIMIT 100`
        : await sql`SELECT id, game, action, actor, at, before, after, note FROM game_audit WHERE club = ${club.code} ORDER BY id DESC LIMIT 200`;
      return send(res, 200, { audit: rows.map(r => ({ id: Number(r.id), game: r.game, action: r.action, actor: r.actor, at: new Date(r.at).getTime(), before: r.before, after: r.after, note: r.note })) });
    }
    if (url.searchParams.get('rating')) {
      // One player's stored rating line: [[ended at, rating after]], oldest first (the newest 200 games).
      await refreshRatings(sql, club);
      return send(res, 200, { points: await historyOf(sql, club, url.searchParams.get('mode'), nameKey(String(url.searchParams.get('rating')))) });
    }
    if (url.searchParams.get('reactions')) {
      return send(res, 200, await getGameReactions(sql, club.code, url.searchParams.get('reactions')));
    }
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
    const rows = await sql`UPDATE games SET deleted_at = NULL WHERE club = ${code} AND id = ${String(body.restore)} AND deleted_at IS NOT NULL RETURNING id, data`;
    if (!rows.length) throw fail(404, 'That game can no longer be restored.');
    await audit(sql, code, rows[0].id, 'restore', await organizerActor(club, body.ownerToken ?? ownerFrom(req)), null, snapshot(rows[0].data));
    return send(res, 200, { ok: true });
  }

  if (body.react) {
    const out = await toggleReaction(sql, {
      code,
      gameId: body.react,
      rawReaction: body.reaction,
      playerName: body.playerName,
      playerToken: body.playerToken,
      tokenMatches,
      ip: clientIp(req)
    });
    return send(res, 200, out);
  }

  if (body.confirm) {
    // An organizer (creating phone, or the PIN in the body), or a player in the game whose phone is linked to their name.
    // A wrong PIN is just not an organizer here (still counted against the PIN limits).
    const sender = await verifiedSender(sql, club, code, body);
    let by = sender === 'organizer' ? 'organizer' : null;
    if (!by && await coOrganizer(club, body.ownerToken ?? ownerFrom(req))) by = 'organizer';
    if (!by && club.pin_hash && body.pin) {
      try { await requirePin(club, body.pin, req, body.ownerToken); by = 'organizer'; } catch (e) { if (e.status === 429) throw e; }
    }
    const id = String(body.confirm);
    const [row] = await sql`SELECT data, confirmed_by FROM games WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL`;
    if (!row) throw fail(404, 'That game no longer exists.');
    if (!by) {
      if (!sender) throw fail(403, 'Only a player in this game (on a phone linked to their name) or an organizer can confirm it.');
      const why = confirmBlocker(row.data, sender);
      if (why) throw fail(403, why);
      by = sender;
    }
    if (row.confirmed_by) return send(res, 200, { ok: true, alreadyConfirmed: true, confirmed: { by: row.confirmed_by } });
    const rows = await sql`UPDATE games SET confirmed_by = ${by}, confirmed_at = now() WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL AND confirmed_by IS NULL RETURNING confirmed_at`;
    if (rows.length) await audit(sql, code, id, 'confirm', by === 'organizer' ? await organizerActor(club, body.ownerToken ?? ownerFrom(req)) : 'player:' + by, null, snapshot(row.data));
    return send(res, 200, { ok: true, confirmed: { by, at: rows.length ? new Date(rows[0].confirmed_at).getTime() : undefined } });
  }

  if (body.keepBoth) {
    // "These look alike but are two games": both stop being flagged. An organizer decision, like deleting the extra one.
    await requirePin(club, body.pin ?? pinFrom(req), req, body.ownerToken ?? ownerFrom(req));
    const ids = Array.isArray(body.keepBoth) ? body.keepBoth.map(String).slice(0, 2) : [];
    if (ids.length !== 2 || ids[0] === ids[1]) throw fail(400, 'Name the two games to keep.');
    const rows = await sql`UPDATE games SET dup_ok = true WHERE club = ${code} AND id = ANY(${ids}) AND deleted_at IS NULL RETURNING id`;
    if (rows.length !== 2) throw fail(404, 'One of those games no longer exists.');
    await audit(sql, code, ids[0], 'keep-both', await organizerActor(club, body.ownerToken ?? ownerFrom(req)), null, null, 'kept alongside ' + ids[1]);
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
    if (sender && (sameResult || organizerProved)) { g.scoredBy = sender; if (o.scoredByPlayer) g.scoredByPlayer = o.scoredByPlayer; }
    // The rally log only stays while it still replays to the corrected game; a changed score, format or target clears it.
    const log = old.rally_log ? checkLog(g, old.rally_log) : null;
    // A confirmation vouches for one result. A changed result needs a new one, unless an organizer made the change
    // (the edit is then on the record as theirs); an edit that keeps the result keeps the confirmation.
    const confirmBy = sameResult ? undefined : organizerProved ? 'organizer' : null;
    const rows = await sql`UPDATE games SET data = ${JSON.stringify(g)}::jsonb, ended_at = ${g.endedAt}, rally_log = ${log},
        confirmed_by = CASE WHEN ${confirmBy === undefined} THEN confirmed_by ELSE ${confirmBy ?? null}::text END,
        confirmed_at = CASE WHEN ${confirmBy === undefined} THEN confirmed_at WHEN ${confirmBy ?? null}::text IS NULL THEN NULL ELSE now() END
      WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That game no longer exists, so it could not be changed.');
    await audit(sql, code, g.id, 'edit', await organizerActor(club, body.ownerToken ?? ownerFrom(req)), snapshot(old.data), snapshot(g), old.rally_log && !log ? 'replay cleared' : null);
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
  // - scoredByPlayer: only on the creating phone's games, its own verified name key, see stampSender.
  const sender = await stampSender(sql, club, code, body, games);
  const now = Date.now();
  for (const g of games) g.receivedAt = now;
  // Flood protection on every request, bulk uploads included (see reserveGames in _db.js).
  const windowStart = await reserveGames(code, games.length);
  const names = new Map();
  let inserted = 0;
  // The creating phone is an organizer, so a game it sends is confirmed; everyone else's waits for the other team or an organizer.
  const confirmedBy = sender === 'organizer' ? 'organizer' : null;
  try {
    for (const [i, g] of games.entries()) {
      const rows = await sql`INSERT INTO games (club, id, data, ended_at, rally_log, confirmed_by, confirmed_at) VALUES (${code}, ${g.id}, ${JSON.stringify(g)}::jsonb, ${g.endedAt}, ${logs[i]}, ${confirmedBy}::text, CASE WHEN ${confirmedBy}::text IS NULL THEN NULL ELSE now() END)
                ON CONFLICT (club, id) DO NOTHING RETURNING id`;
      inserted += rows.length;
      if (rows.length) await audit(sql, code, g.id, 'create', senderActor(sender), null, snapshot(g), logs[i] ? 'scored live' : g.logged ? 'logged' : null);
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
