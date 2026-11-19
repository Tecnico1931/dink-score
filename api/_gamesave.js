// Saving finished matches of events, leagues and ladders into the club's games. Not a route (files starting with "_").
import { checkLog } from './_rallylog.js';
import { cleanGame, cleanName, fail, nameKey, reserveGames, releaseGames, verifiedSender } from './_db.js';
import { audit, organizerActor, senderActor, snapshot } from './_audit.js';

// Puts a finished match into the club's games. Safe to repeat: the game id is the same every time, so it is stored once.
export async function recordGame(sql, club, code, event, game, body, now, rallyLog) {
  const g = Object.assign(cleanGame(game), { event: { id: event.id, name: event.name } });
  g.receivedAt = now;
  const sender = await verifiedSender(sql, club, code, body);
  if (sender) g.scoredBy = sender;
  const windowStart = await reserveGames(code, 1);
  let inserted = 0;
  try {
    // Event matches count without a separate confirmation (the event's organizer controls who may enter results), and an
    // organizer's own entry is marked confirmed like any other game.
    const confirmedBy = sender === 'organizer' ? 'organizer' : null;
    const rows = await sql`INSERT INTO games (club, id, data, ended_at, rally_log, confirmed_by, confirmed_at) VALUES (${code}, ${g.id}, ${JSON.stringify(g)}::jsonb, ${g.endedAt}, ${checkLog(g, rallyLog)}, ${confirmedBy}::text, CASE WHEN ${confirmedBy}::text IS NULL THEN NULL ELSE now() END)
      ON CONFLICT (club, id) DO NOTHING RETURNING id`;
    inserted = rows.length;
    if (inserted) await audit(sql, code, g.id, 'create', senderActor(sender), null, snapshot(g), 'event match');
  } finally {
    await releaseGames(code, 1 - inserted, windowStart);
  }
  return inserted;
}

// A game the watch finished: the server saves the live game itself, so it is kept even when the scoring phone is closed or away.
// The id is the live game's own id, which the phone's own save uses too (record() in the app), so whichever arrives second does
// nothing and the ratings never count it twice. Nobody is verified (no scoredBy), so a club that asks for confirmation holds it.
export async function saveLiveGame(sql, code, live) {
  const s = live.state;
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(String(live.id))) throw fail(400, 'This game has a name the watch cannot save. Save it on the scoring phone.');
  const g = cleanGame({ id: live.id, mode: s.cfg.mode, scoring: s.cfg.scoring, target: s.cfg.target, winBy: s.cfg.winBy, teams: s.cfg.teams, score: s.score, rallies: s.rallies, startedAt: s.startedAt, endedAt: s.endedAt || Date.now() });
  g.receivedAt = Date.now();
  const windowStart = await reserveGames(code, 1);
  let inserted = 0;
  try {
    const rows = await sql`INSERT INTO games (club, id, data, ended_at) VALUES (${code}, ${g.id}, ${JSON.stringify(g)}::jsonb, ${g.endedAt}) ON CONFLICT (club, id) DO NOTHING RETURNING id`;
    inserted = rows.length;
    if (inserted) await audit(sql, code, g.id, 'create', senderActor(null), null, snapshot(g), 'watch');
  } finally {
    await releaseGames(code, 1 - inserted, windowStart);
  }
  if (inserted) await addToRoster(sql, code, g.teams.flat().filter(n => !/^Player \d+$/.test(n)));
  return { id: g.id, saved: inserted === 1 };
}

// Same game id, new score (an organizer fixing a result). Keeps who sent it and when it arrived; does nothing if the game was deleted from the record.
export async function correctGame(sql, club, code, game, body, note) {
  const g = cleanGame(game);
  const [old] = await sql`SELECT data FROM games WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL`;
  await sql`UPDATE games SET data = data || ${JSON.stringify(g)}::jsonb, ended_at = ${g.endedAt}, rally_log = NULL WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL`;
  if (old) await audit(sql, code, g.id, 'edit', await organizerActor(club, body.ownerToken), snapshot(old.data), snapshot(Object.assign({}, old.data, g)), note);
}

// Players typed into an event or league who are not on the club's roster yet join it (the roster holds at most 300).
export async function addToRoster(sql, code, names) {
  let [{ n }] = await sql`SELECT count(*)::int AS n FROM roster WHERE club = ${code}`;
  for (const name of names) {
    if (n >= 300) break;
    const added = await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${nameKey(name)}, ${cleanName(name)}) ON CONFLICT DO NOTHING RETURNING name_key`;
    n += added.length;
  }
}
