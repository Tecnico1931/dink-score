// Events: tournaments and rotating-partner sessions with several games at once. Body for POST: {code, action, ...}
// GET  /api/events?code=ABC123                 -> the club's events, newest first, 50 a page (a short summary of each); add &offset=50 for the next page, `more` says if there is one
// GET  /api/events?code=ABC123&id=e123         -> one event in full: rounds or bracket, courts, scores, standings
//   create        {event, pin|ownerToken}                  -> organizer: starts an event (see createEvent in _events.js)
//   result        {id, matchId, score:[a,b], startedAt?, endedAt?, rallies?, live?}  -> players in the match or an organizer (any club member if the event allows it): a finished match.
//                 It is also saved to the club's games, once (the game id comes from the event and match).
//   results-by    {id, who:'players'|'club'}                -> organizer: who may enter results (players in the match + organizers, or any club member)
//   next-round    {id}                                      -> organizer: plans the next round of a rotating-partner event
//   set-round     {id, round, matches:[{teams}]}            -> organizer: picks the pairings of a round nobody has scored
//   publish-round {id, round}                               -> organizer: opens a manual round for scoring
//   start-knockout {id, advance?}                           -> organizer: pool play is over, start the bracket
//   correct       {id, matchId, score}                      -> organizer: fix a played match's score
//   end           {id}                                      -> organizer: finish the event now
//   share / share-new / share-off  {id}                     -> organizer: make, replace or remove the public read-only link; answers {shareToken}
//   delete        {id}                                      -> organizer: hide the event (its games stay in the record)
//   sheet-fetch   {url}                                     -> organizer: reads a shared Google Sheet as CSV text (see _gsheet.js); answers {csv}. Creates nothing.
//   refs          {id}                                      -> organizer: the private DUPR reference IDs typed in the imported sheet: {refs}
//   public-logos  {id, on}                                  -> organizer: show or hide team logos on the public bracket page
// create may carry teamMeta ([{name, logo}] for each of its manual teams), publicLogos and refs ({player: DUPR ID}, reference only).
// Organizer actions need the creating phone's token or the organizer PIN, like the club's other organizer settings.
import { checkLog } from './_rallylog.js';
import { db, handler, send, readBody, fail, cleanCode, requireClub, requireOrganizer, requirePin, cleanGame, cleanName, nameKey, reserveGames, releaseGames, verifiedSender } from './_db.js';
import { audit, organizerActor, senderActor, snapshot } from './_audit.js';
import { newShareToken } from './_share.js';
import { notify, roundMessages } from './_push.js';
import { replyTagged } from './_sync.js';
import { fetchSheetCsv, sheetCsvUrl } from './_gsheet.js';
import { cleanRefs, createEvent, startNextRound, setRound, publishRound, recordResult, checkResultActor, setResultsBy, correctResult, startKnockout, endEvent, view } from './_events.js';

const PAGE = 50; // events per page of the list
const MAX_EVENTS = 100; // per club, not counting deleted ones
const sheetCalls = new Map(); // club -> times of recent sheet reads; a small brake on top of the organizer check
const throttleSheet = code => {
  const now = Date.now(), recent = (sheetCalls.get(code) || []).filter(t => now - t < 60000);
  if (recent.length >= 20) throw fail(429, 'That is a lot of sheet reads. Wait a minute and try again.');
  recent.push(now); sheetCalls.set(code, recent);
};

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
async function recordGame(sql, club, code, event, game, body, now, rallyLog) {
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

async function addToRoster(sql, code, names) {
  let [{ n }] = await sql`SELECT count(*)::int AS n FROM roster WHERE club = ${code}`;
  for (const name of names) {
    if (n >= 300) break;
    const added = await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${nameKey(name)}, ${cleanName(name)}) ON CONFLICT DO NOTHING RETURNING name_key`;
    n += added.length;
  }
}

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
    const code = club.code; // the club's permanent key, even when an old club code was used
    const id = url.searchParams.get('id');
    if (id) {
      const [row] = await sql`SELECT data FROM events WHERE club = ${code} AND id = ${String(id)} AND deleted_at IS NULL`;
      if (!row) throw fail(404, 'That event no longer exists.');
      return replyTagged(req, res, code + ':event:' + id, { event: view(row.data) });
    }
    // A page at a time, newest first, so every event up to MAX_EVENTS can be reached: ?offset=50 is the second page.
    const offset = Math.min(Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0), MAX_EVENTS);
    const rows = await sql`SELECT data FROM events WHERE club = ${code} AND deleted_at IS NULL ORDER BY updated_at DESC, id LIMIT ${PAGE + 1} OFFSET ${offset}`;
    return replyTagged(req, res, code + ':events:' + offset, { events: rows.slice(0, PAGE).map(summary), more: rows.length > PAGE });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used
  const now = Date.now();
  const action = String(body.action || '');

  if (action === 'create') {
    await requireOrganizer(club, body.pin, req, body.ownerToken);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM events WHERE club = ${code} AND deleted_at IS NULL`;
    if (n >= MAX_EVENTS) throw fail(400, `A club can keep up to ${MAX_EVENTS} events. Delete an old one first.`);
    const event = createEvent(body.event, now);
    const refs = cleanRefs(body.event && body.event.refs, event.players);
    await sql`INSERT INTO events (club, id, data, status, refs) VALUES (${code}, ${event.id}, ${JSON.stringify(event)}::jsonb, ${event.status}, ${Object.keys(refs).length ? JSON.stringify(refs) : null}::jsonb)`;
    await addToRoster(sql, code, event.players);
    return send(res, 201, { event: view(event) });
  }

  const id = String(body.id || '');
  if (action === 'result') {
    // Players in the match and organizers by default; any club member when the organizer allowed it. Fixing one later is an organizer action.
    const sender = await verifiedSender(sql, club, code, body);
    let organizer = sender === 'organizer';
    if (!organizer && club.pin_hash && body.pin) { // a wrong PIN is just not an organizer here (still counted against the PIN limits)
      try { await requirePin(club, body.pin, req, body.ownerToken); organizer = true; } catch (e) { if (e.status === 429) throw e; }
    }
    const actor = { organizer, name: sender && sender !== 'organizer' ? sender : null };
    const { event, out } = await mutate(sql, code, id, ev => { checkResultActor(ev, String(body.matchId || ''), actor); return recordResult(ev, String(body.matchId || ''), body, now); });
    await recordGame(sql, club, code, event, out.game, body, now, body.rallyLog);
    return send(res, 200, { event: view(event) });
  }

  await requireOrganizer(club, body.pin, req, body.ownerToken);
  if (action === 'sheet-fetch') {
    sheetCsvUrl(body.url); // a bad link is refused before it counts against the limit
    throttleSheet(code);
    return send(res, 200, { csv: await fetchSheetCsv(body.url, (u, o) => globalThis.fetch(u, o)) });
  }
  if (action === 'refs') {
    const [row] = await sql`SELECT refs FROM events WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL`;
    if (!row) throw fail(404, 'That event no longer exists.');
    return send(res, 200, { refs: row.refs || {} });
  }
  if (action === 'results-by') {
    const { event } = await mutate(sql, code, id, ev => setResultsBy(ev, body.who, now));
    return send(res, 200, { event: view(event) });
  }
  if (action === 'public-logos') {
    const { event } = await mutate(sql, code, id, ev => { ev.publicLogos = body.on === true; ev.updatedAt = now; });
    return send(res, 200, { event: view(event) });
  }
  if (action === 'correct') {
    const { event, out } = await mutate(sql, code, id, ev => correctResult(ev, String(body.matchId || ''), body.score, now));
    // Same game id, new score. Keeps who sent it and when it arrived; does nothing if the game was deleted from the record.
    const g = cleanGame(out.game);
    const [old] = await sql`SELECT data FROM games WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL`;
    await sql`UPDATE games SET data = data || ${JSON.stringify(g)}::jsonb, ended_at = ${g.endedAt}, rally_log = NULL WHERE club = ${code} AND id = ${g.id} AND deleted_at IS NULL`;
    if (old) await audit(sql, code, g.id, 'edit', await organizerActor(club, body.ownerToken), snapshot(old.data), snapshot(Object.assign({}, old.data, g)), 'event score corrected');
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
    if (action === 'next-round' || action === 'publish-round') { // a round just opened: its players hear their court (opt-in, see _push.js)
      const round = event.rounds.find(r => r.n === (action === 'publish-round' ? Number(body.round) : event.rounds.length));
      if (round && round.status === 'live') await notify(sql, code, roundMessages(event, round));
    }
    return send(res, 200, { event: view(event) });
  }
  if (action === 'share' || action === 'share-new' || action === 'share-off') {
    // The public link: 'share' makes it (or returns the one that exists), 'share-new' replaces it (the old link stops
    // working), 'share-off' removes it. Only organizers ever get to see the token.
    const [cur] = await sql`SELECT share_token FROM events WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL`;
    if (!cur) throw fail(404, 'That event no longer exists.');
    if (action === 'share-off') {
      await sql`UPDATE events SET share_token = NULL WHERE club = ${code} AND id = ${id}`;
      return send(res, 200, { shareToken: null });
    }
    if (cur.share_token && action === 'share') return send(res, 200, { shareToken: cur.share_token });
    const token = newShareToken();
    await sql`UPDATE events SET share_token = ${token} WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL`;
    return send(res, 200, { shareToken: token });
  }
  if (action === 'delete') {
    const rows = await sql`UPDATE events SET deleted_at = now(), share_token = NULL WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That event was already deleted.');
    return send(res, 200, { ok: true });
  }
  throw fail(400, 'Unknown action.');
});
