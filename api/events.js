// Events: tournaments and rotating-partner sessions with several games at once. Body for POST: {code, action, ...}
// GET  /api/events?code=ABC123                 -> the club's events, newest first (a short summary of each)
// GET  /api/events?code=ABC123&id=e123         -> one event in full: rounds or bracket, courts, scores, standings
//   create        {event, pin|ownerToken}                  -> organizer: starts an event (see createEvent in _events.js)
//   result        {id, matchId, score:[a,b], startedAt?, endedAt?, rallies?, live?}  -> anyone in the club: a finished match.
//                 It is also saved to the club's games, once (the game id comes from the event and match).
//   next-round    {id}                                      -> organizer: plans the next round of a rotating-partner event
//   set-round     {id, round, matches:[{teams}]}            -> organizer: picks the pairings of a round nobody has scored
//   publish-round {id, round}                               -> organizer: opens a manual round for scoring
//   start-knockout {id, advance?}                           -> organizer: pool play is over, start the bracket
//   correct       {id, matchId, score}                      -> organizer: fix a played match's score
//   end           {id}                                      -> organizer: finish the event now
//   delete        {id}                                      -> organizer: hide the event (its games stay in the record)
// Organizer actions need the creating phone's token or the organizer PIN, like the shop settings.
import { db, handler, send, readBody, fail, cleanCode, requireClub, requireOrganizer, cleanGame, cleanName, reserveGames, releaseGames, verifiedSender } from './_db.js';
import { createEvent, startNextRound, setRound, publishRound, recordResult, correctResult, startKnockout, endEvent, view } from './_events.js';

const MAX_EVENTS = 100; // per club, not counting deleted ones

function summary(row) {
  const e = row.data;
  const current = e.rounds.find(r => r.status !== 'done') || e.rounds[e.rounds.length - 1]; // for fixed teams every round exists from the start
  return { id: e.id, name: e.name, format: e.format, partners: e.partners, status: e.status, players: e.players.length, courts: e.courts,
    round: current ? current.n : 0, roundsPlanned: e.roundsPlanned, stage: e.stage, champion: e.champion || null, createdAt: e.createdAt, updatedAt: e.updatedAt };
}

// Reads an event, lets fn change it, and saves it only if nobody else saved first (the version number); otherwise
// it starts again from the newer copy. Two phones finishing different matches at the same moment both go through.
// fn(event) may return { changed: false } to say nothing needs saving.
async function mutate(sql, code, id, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const [row] = await sql`SELECT data, version FROM events WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL`;
    if (!row) throw fail(404, 'That event no longer exists.');
    const event = row.data;
    const out = fn(event) || {};
    if (out.changed === false) return { event, out };
    const saved = await sql`UPDATE events SET data = ${JSON.stringify(event)}::jsonb, version = version + 1, status = ${event.status}, updated_at = now()
      WHERE club = ${code} AND id = ${id} AND version = ${row.version} RETURNING version`;
    if (saved.length) return { event, out };
  }
  throw fail(409, 'Several people changed this event at once. Try again.');
}

// Puts a finished match into the club's games. Safe to repeat: the game id is the same every time, so it is stored once.
async function recordGame(sql, club, code, event, game, body, now) {
  const g = Object.assign(cleanGame(game), { event: { id: event.id, name: event.name } });
  g.receivedAt = now;
  const sender = await verifiedSender(sql, club, code, body);
  if (sender) g.scoredBy = sender;
  const windowStart = await reserveGames(code, 1);
  let inserted = 0;
  try {
    const rows = await sql`INSERT INTO games (club, id, data, ended_at) VALUES (${code}, ${g.id}, ${JSON.stringify(g)}::jsonb, ${g.endedAt})
      ON CONFLICT (club, id) DO NOTHING RETURNING id`;
    inserted = rows.length;
  } finally {
    await releaseGames(code, 1 - inserted, windowStart);
  }
  return inserted;
}

async function addToRoster(sql, code, names) {
  let [{ n }] = await sql`SELECT count(*)::int AS n FROM roster WHERE club = ${code}`;
  for (const name of names) {
    if (n >= 300) break;
    const added = await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${name.toLowerCase()}, ${cleanName(name)}) ON CONFLICT DO NOTHING RETURNING name_key`;
    n += added.length;
  }
}

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const code = cleanCode(url.searchParams.get('code'));
    await requireClub(code, req);
    const id = url.searchParams.get('id');
    if (id) {
      const [row] = await sql`SELECT data FROM events WHERE club = ${code} AND id = ${String(id)} AND deleted_at IS NULL`;
      if (!row) throw fail(404, 'That event no longer exists.');
      return send(res, 200, { event: view(row.data) });
    }
    const rows = await sql`SELECT data FROM events WHERE club = ${code} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`;
    return send(res, 200, { events: rows.map(summary) });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const code = cleanCode(body.code);
  const club = await requireClub(code, req);
  const now = Date.now();
  const action = String(body.action || '');

  if (action === 'create') {
    await requireOrganizer(club, body.pin, req, body.ownerToken);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM events WHERE club = ${code} AND deleted_at IS NULL`;
    if (n >= MAX_EVENTS) throw fail(400, `A club can keep up to ${MAX_EVENTS} events. Delete an old one first.`);
    const event = createEvent(body.event, now);
    await sql`INSERT INTO events (club, id, data, status) VALUES (${code}, ${event.id}, ${JSON.stringify(event)}::jsonb, ${event.status})`;
    await addToRoster(sql, code, event.players);
    return send(res, 201, { event: view(event) });
  }

  const id = String(body.id || '');
  if (action === 'result') {
    // Anyone in the club can enter a result, like adding a game. Fixing one later is an organizer action.
    const { event, out } = await mutate(sql, code, id, ev => recordResult(ev, String(body.matchId || ''), body, now));
    await recordGame(sql, club, code, event, out.game, body, now);
    return send(res, 200, { event: view(event) });
  }

  await requireOrganizer(club, body.pin, req, body.ownerToken);
  if (action === 'correct') {
    const { event, out } = await mutate(sql, code, id, ev => correctResult(ev, String(body.matchId || ''), body.score, now));
    // Same game id, new score. Keeps who sent it and when it arrived; does nothing if the game was deleted from the record.
    const g = cleanGame(out.game);
    await sql`UPDATE games SET data = data || ${JSON.stringify(g)}::jsonb, ended_at = ${g.endedAt} WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL`;
    return send(res, 200, { event: view(event) });
  }
  const actions = {
    'next-round': ev => startNextRound(ev, now),
    'set-round': ev => setRound(ev, body.round, body.matches, now),
    'publish-round': ev => publishRound(ev, body.round, now),
    'start-knockout': ev => startKnockout(ev, body.advance, now),
    end: ev => endEvent(ev, now)
  };
  if (actions[action]) {
    const { event } = await mutate(sql, code, id, actions[action]);
    return send(res, 200, { event: view(event) });
  }
  if (action === 'delete') {
    const rows = await sql`UPDATE events SET deleted_at = now() WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That event was already deleted.');
    return send(res, 200, { ok: true });
  }
  throw fail(400, 'Unknown action.');
});
