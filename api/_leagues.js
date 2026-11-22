// Leagues and ladders, reached through /api/events (one route fewer for the function limit). Not a route (files starting with "_").
//   GET  /api/events?code=ABC123&leagues=1          -> {leagues: [summary]}, newest first
//   GET  /api/events?code=ABC123&league=l123        -> {league}: standings per division, or the ladder in order
//   POST /api/events {code, action, ...}:
//     league-create       {league: {kind: 'league'|'ladder', name, season?, mode, players, teams?, divisions?, legs?, move?, tiebreak?, jump?, decayDays?, target, scoring, winBy, resultsBy}, pin|ownerToken}
//                         -> organizer. Entries are seeded by the club's own Dink Rating, read here, never sent by the phone.
//     league-result       {id, matchId, score, startedAt?, endedAt?, rallies?, live?}          -> a league match: its players, an organizer, or any club member if allowed
//                         {id, key, challenger, defender, score, ...}                          -> a ladder challenge ([challenger score, defender score]); key makes a retry safe
//                         Either way the result also becomes one game in the club's record (id <leagueId>-<matchId or key>), once.
//     league-challenge    {id, key, challenger, defender}      -> open a ladder challenge (the challenger or an organizer); it lapses after 7 days unanswered
//     league-answer       {id, challengeId, answer}            -> 'accept' | 'decline' (the defender or an organizer), 'withdraw' (the challenger or an organizer)
//     league-correct      {id, matchId, score}      -> organizer: fix a played match or challenge
//     league-results-by   {id, who}                 -> organizer: who may enter results
//     league-end          {id, season?}             -> organizer: finish a league season now, or close a ladder's season (the order carries over)
//     league-next-season  {id, season?, move?}      -> organizer: the finished league's next season, the top of each division moving up and the bottom down
//     league-share / league-share-new / league-share-off  {id}  -> organizer: make, replace or remove the public read-only link (/l/<token>); answers {shareToken}
//     league-schedule     {id, week, date?, time?, courts?}  -> organizer: a day ('YYYY-MM-DD'), time ('HH:MM') and number of courts for one week (see _leagueweeks.js)
//     league-reschedule   {id, matchId, date?, time?, court?} -> organizer: one match on another day, time or court; its players are told
//     league-forfeit      {id, matchId, winner: 0|1|null}     -> organizer: settle a match by forfeit (target to 0, no game in the record), or undo it with null
//     league-notify       {id, week}                          -> organizer: tell the week's players their match, day and court (or bye); answers {sent, on}
//                         A new week also tells its players by itself the moment the week before is played. Opt-in push only, see _push.js.
//     league-delete       {id}                      -> organizer: hide it (its games stay in the record)
import { fail, requireOrganizer, requirePin, cleanName, nameKey, verifiedSender } from './_db.js';
import { refreshRatings, ratingsFor } from './_rating_store.js';
import { ratingMap } from './_seeding.js';
import { recordGame, correctGame, addToRoster } from './_gamesave.js';
import { replyTagged } from './_sync.js';
import { newShareToken } from './_share.js';
import { notify, vapidFromEnv, leagueWeekMessages, leagueMovedMessages, leagueResultMessages } from './_push.js';
import * as L from './_league.js';
import * as W from './_leagueweeks.js';

export const LEAGUE_ACTIONS = ['league-create', 'league-result', 'league-correct', 'league-results-by', 'league-end', 'league-next-season', 'league-share', 'league-share-new', 'league-share-off', 'league-delete',
  'league-challenge', 'league-answer', 'league-schedule', 'league-reschedule', 'league-forfeit', 'league-notify'];
export const MAX_LEAGUES = 50; // per club, not counting deleted ones

async function readOne(sql, code, id) {
  const [row] = await sql`SELECT data FROM leagues WHERE club = ${code} AND id = ${String(id)} AND deleted_at IS NULL`;
  if (!row) throw fail(404, 'That league no longer exists.');
  return row.data;
}

// Same pattern as events: read, change, save only if nobody saved first, else start again from the newer copy.
async function mutate(sql, code, id, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const [row] = await sql`SELECT data, version FROM leagues WHERE club = ${code} AND id = ${String(id)} AND deleted_at IS NULL`;
    if (!row) throw fail(404, 'That league no longer exists.');
    const league = row.data;
    const out = fn(league) || {};
    if (out.changed === false) return { league, out };
    const saved = await sql`UPDATE leagues SET data = ${JSON.stringify(league)}::jsonb, version = version + 1, status = ${league.status}, updated_at = now()
      WHERE club = ${code} AND id = ${String(id)} AND version = ${row.version} RETURNING version`;
    if (saved.length) return { league, out };
  }
  throw fail(409, 'Several people changed this at once. Try again.');
}

export async function leagueGet(sql, club, req, res, params) {
  const code = club.code;
  const id = params.get('league');
  if (id) return replyTagged(req, res, code + ':league:' + id, { league: L.view(await readOne(sql, code, id)) });
  const rows = await sql`SELECT data FROM leagues WHERE club = ${code} AND deleted_at IS NULL ORDER BY updated_at DESC, id LIMIT ${MAX_LEAGUES}`;
  return replyTagged(req, res, code + ':leagues', { leagues: rows.map(r => L.summary(r.data)) });
}

const fix = fn => { try { return fn(); } catch (e) { if (e.status) throw fail(e.status, e.message); throw e; } };

// Returns { body, status? } (the caller sends it), or throws.
export async function leagueAction(sql, club, body, req, { now = Date.now(), rand = Math.random } = {}) {
  const code = club.code, action = body.action, id = String(body.id || '');

  if (action === 'league-result' || action === 'league-challenge' || action === 'league-answer') {
    // Players in the match and organizers by default; any club member when the organizer allowed it.
    const sender = await verifiedSender(sql, club, code, body);
    let organizer = sender === 'organizer';
    if (!organizer && club.pin_hash && body.pin) { // a wrong PIN is just not an organizer here (still counted against the PIN limits)
      try { await requirePin(club, body.pin, req, body.ownerToken); organizer = true; } catch (e) { if (e.status === 429) throw e; }
    }
    const actor = { organizer, name: sender && sender !== 'organizer' ? sender : null };
    if (action !== 'league-result') { // an open challenge (send, accept, decline, withdraw): the same who-may-act rules, no game
      const { league } = await mutate(sql, code, id, lg => fix(() => (action === 'league-challenge' ? L.openChallenge(lg, body, now, actor) : L.answerChallenge(lg, body.challengeId, body.answer, now, actor))));
      return { body: { league: L.view(league) } };
    }
    const { league, out } = await mutate(sql, code, id, lg => fix(() => {
      if (lg.kind === 'ladder') return L.recordChallenge(lg, body, now, actor);
      const before = W.currentWeek(lg), r = L.recordLeagueResult(lg, String(body.matchId || ''), body, now, actor);
      if (r.changed) r.opened = W.openedWeek(lg, before, now); // the week before was just played: this one opens, and its players hear it once
      return r;
    }));
    await recordGame(sql, club, code, league, out.game, body, now, body.rallyLog);
    if (out.changed && out.match && out.match.teams) await notify(sql, code, leagueResultMessages(league, out.match, actor.name)); // the match's players: result is in, no score
    if (out.opened) await notify(sql, code, leagueWeekMessages(league, out.opened));
    return { body: { league: L.view(league) } };
  }

  await requireOrganizer(club, body.pin, req, body.ownerToken);

  if (action === 'league-create') {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM leagues WHERE club = ${code} AND deleted_at IS NULL`;
    if (n >= MAX_LEAGUES) throw fail(400, `A club can keep up to ${MAX_LEAGUES} leagues and ladders. Delete an old one first.`);
    const input = body.league && typeof body.league === 'object' ? body.league : null;
    if (!input) throw fail(400, 'League details are missing.');
    const players = (Array.isArray(input.players) ? input.players : []).map(cleanName).filter(Boolean);
    const stored = await refreshRatings(sql, club).then(() => ratingsFor(sql, club));
    const ratings = ratingMap(stored, players);
    const made = fix(() => (input.kind === 'ladder' ? L.createLadder(input, ratings, now, rand) : L.createLeague(input, ratings, now, rand)));
    await sql`INSERT INTO leagues (club, id, data, status) VALUES (${code}, ${made.id}, ${JSON.stringify(made)}::jsonb, ${made.status})`;
    await addToRoster(sql, code, made.entries.flat());
    return { status: 201, body: { league: L.view(made) } };
  }

  if (action === 'league-next-season') {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM leagues WHERE club = ${code} AND deleted_at IS NULL`;
    if (n >= MAX_LEAGUES) throw fail(400, `A club can keep up to ${MAX_LEAGUES} leagues and ladders. Delete an old one first.`);
    const prev = await readOne(sql, code, id);
    const [taken] = await sql`SELECT id FROM leagues WHERE club = ${code} AND deleted_at IS NULL AND data->>'previous' = ${id} LIMIT 1`;
    if (taken) throw fail(409, 'The next season has already been made.');
    const next = fix(() => L.nextSeason(prev, body, now, rand));
    await sql`INSERT INTO leagues (club, id, data, status) VALUES (${code}, ${next.id}, ${JSON.stringify(next)}::jsonb, ${next.status})`;
    return { status: 201, body: { league: L.view(next) } };
  }

  if (action === 'league-correct') {
    const { league, out } = await mutate(sql, code, id, lg => fix(() => L.correctLeagueResult(lg, String(body.matchId || ''), body.score, now)));
    await correctGame(sql, club, code, out.game, body, 'league score corrected');
    return { body: { league: L.view(league) } };
  }
  if (action === 'league-schedule') {
    const { league } = await mutate(sql, code, id, lg => fix(() => W.setWeekPlan(lg, body.week, body, now)));
    return { body: { league: L.view(league) } };
  }
  if (action === 'league-reschedule') {
    const { league, out } = await mutate(sql, code, id, lg => fix(() => W.rescheduleMatch(lg, body.matchId, body, now)));
    if (out.changed) await notify(sql, code, leagueMovedMessages(league, league.weeks.find(w => w.matches.includes(out.match)) || league.weeks[0], out.match));
    return { body: { league: L.view(league) } };
  }
  if (action === 'league-forfeit') {
    const { league, out } = await mutate(sql, code, id, lg => fix(() => {
      const before = W.currentWeek(lg), r = W.forfeitMatch(lg, body.matchId, body.winner === undefined ? null : body.winner, now);
      if (r.changed) r.opened = W.openedWeek(lg, before, now);
      return r;
    }));
    if (out.opened) await notify(sql, code, leagueWeekMessages(league, out.opened));
    return { body: { league: L.view(league) } };
  }
  if (action === 'league-notify') {
    const { league, out } = await mutate(sql, code, id, lg => fix(() => ({ week: W.noteWeekSent(lg, body.week, now) })));
    const sent = await notify(sql, code, leagueWeekMessages(league, out.week));
    return { body: { league: L.view(league), sent, on: !!vapidFromEnv() } };
  }
  if (action === 'league-results-by') {
    const { league } = await mutate(sql, code, id, lg => fix(() => L.setResultsBy(lg, body.who, now)));
    return { body: { league: L.view(league) } };
  }
  if (action === 'league-end') {
    const { league } = await mutate(sql, code, id, lg => fix(() => (lg.kind === 'ladder' ? L.closeLadderSeason(lg, cleanName(body.season) || undefined, now) : L.endSeason(lg, now))));
    return { body: { league: L.view(league) } };
  }
  if (action === 'league-share' || action === 'league-share-new' || action === 'league-share-off') {
    // Same as an event's link: 'share' makes it (or returns the one that exists), 'share-new' replaces it, 'share-off' removes it. Only organizers see the token.
    const [cur] = await sql`SELECT share_token FROM leagues WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL`;
    if (!cur) throw fail(404, 'That league no longer exists.');
    if (action === 'league-share-off') {
      await sql`UPDATE leagues SET share_token = NULL WHERE club = ${code} AND id = ${id}`;
      return { body: { shareToken: null } };
    }
    if (cur.share_token && action === 'league-share') return { body: { shareToken: cur.share_token } };
    const token = newShareToken();
    await sql`UPDATE leagues SET share_token = ${token} WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL`;
    return { body: { shareToken: token } };
  }
  if (action === 'league-delete') {
    const rows = await sql`UPDATE leagues SET deleted_at = now(), share_token = NULL WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That one was already deleted.');
    return { body: { ok: true } };
  }
  throw fail(400, 'Unknown action.');
}
