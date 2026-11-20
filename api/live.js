// Watch scoring (prototype): the phone scoring a game publishes its live state here. A watch
// (through Apple Shortcuts) appends point and undo intents. The phone polls for intents, applies
// them with the real scoring rules (PB.rally) and republishes, so the rules live in one place and
// an intent changes nothing until the phone takes it.
//   GET  /api/live?code=ABC123&id=live-xyz&secret=K   -> { state, intents } for the scoring phone
//   POST /api/live {code, action:'state', id, secret, state, ack} -> the phone publishes; ack drops applied intents
//   POST /api/live {code, action:'point', game, secret, side}     -> an intent for that live game; answers the score call
//   POST /api/live {code, action:'undo', game, secret}            -> an undo intent; answers the score call
//   POST /api/live {code, action:'end', id, secret}   -> the phone removes the live game (saved or discarded)
//   GET  /api/live?code=ABC123                                 -> { games } the club's live games (players + scores; no secret needed)
//   POST /api/live {code, action:'rally', game, secret, side, base?}   -> the server applies the rally itself (shared scoring)
//   POST /api/live {code, action:'unrally', game, secret, base?}       -> the server takes back the last server-applied rally
//   POST /api/live {code, action:'ack', game, secret, ack}             -> the phone drops intents it has applied
//   Every GET answer here carries an ETag and honours If-None-Match with an empty 304 (Sync v2, see _sync.js).
//   GET/POST board-*: the open play court board built on these live games, documented in _courtboard.js
//   POST push-status | push-subscribe | push-unsubscribe: opt-in "you're up" notifications, documented in _push.js
//   GET ?session=CODE and POST session-*: pickup sessions (24 hours, no club), documented in _sessions.js
//   POST watch-* and GET ?watch=state: Apple Watch linking and scoring (a watch token, not a club code), documented in _watch.js
// Each live game has its own short-lived secret, made on the scoring phone and shown there (and on the watch setup page).
// Intents must name the game and carry its secret; the club code alone is not enough, so two games at once never mix.
// The server keeps only a hash of the secret, hands intents only to a caller who holds it, and signs each intent with it,
// so the phone also ignores any intent that was not made by someone holding the secret.
import { createHash } from 'node:crypto';
import { db, handler, send, readBody, fail, cleanCode, requireClub } from './_db.js';
import { secretOk, hashSecret, FRESH_MS, requireSecret, applyRally } from './_livecore.js';
import { callOf, sayOf, cleanOpId } from './_watchrules.js';
import { WATCH_ACTIONS, WATCH_CLUB_ACTIONS, watchAction, watchClubAction, watchState, attachLinks, endGameLinks } from './_watch.js';
import { boardGet, boardAction, BOARD_ACTIONS } from './_courtboard.js';
import { sessionGet, sessionAction } from './_sessions.js';
import { pushAction, PUSH_ACTIONS } from './_push.js';
import { replyTagged } from './_sync.js';

export { secretOk, hashSecret };
// What the phone recomputes to accept an intent: sha256 of "secret:n:kind:side:game", hex.
export const signIntent = (secret, game, n, kind, side) => createHash('sha256').update(`${secret}:${n}:${kind}:${side}:${game}`).digest('hex');

const MAX_PENDING = 50;
const MAX_LIVE_ROWS = 20; // live games one club can have at once; stale ones are purged first

function answer(row) {
  const s = row.state, call = callOf(s);
  return { ok: true, score: s.score, call, say: sayOf(s, call), pending: (row.intents || []).length };
}

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.has('session')) return replyTagged(req, res, 'session:' + url.searchParams.get('session'), await sessionGet(sql, url.searchParams.get('session'), req)); // pickup sessions: no club involved (see _sessions.js)
    if (url.searchParams.get('watch') === 'state') { const w = await watchState(db(), req); return replyTagged(req, res, w.scope, w.body); } // a linked watch: its token is the credential, no club code (see _watch.js)
    const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
    const code = club.code; // the club's permanent key, even when an old club code was used
    const id = String(url.searchParams.get('id') || '');
    if (url.searchParams.get('board')) return replyTagged(req, res, code + ':board', await boardGet(sql, club)); // the open play court board (see _courtboard.js)
    if (!id) {
      // The club's games going on right now: players and scores only. Anyone with the club code can
      // already see the club's finished games; a live score is no more private. Scoring one still
      // needs that game's secret.
      const since = new Date(Date.now() - FRESH_MS).toISOString();
      const rows = await sql`SELECT id, state, updated_at FROM live_games WHERE club = ${code} AND updated_at > ${since} ORDER BY updated_at DESC LIMIT ${MAX_LIVE_ROWS}`;
      const games = rows.map(r => ({ id: r.id, teams: r.state.cfg.teams, score: r.state.score, serving: r.state.serving, serverNum: r.state.serverNum, winner: r.state.winner, mode: r.state.cfg.mode, scoring: r.state.cfg.scoring, target: r.state.cfg.target, startedAt: r.state.startedAt, updatedAt: new Date(r.updated_at).getTime() }));
      return replyTagged(req, res, code + ':live', { games });
    }
    const [row] = await sql`SELECT state, intents, secret_hash, version FROM live_games WHERE club = ${code} AND id = ${id}`;
    if (!row) return send(res, 200, { state: null, intents: [], version: 0 });
    await requireSecret(sql, req, row, url.searchParams.get('secret'));
    return replyTagged(req, res, code + ':game:' + id, { state: row.state, intents: row.intents, version: row.version });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  if (typeof body.action === 'string' && body.action.startsWith('session-')) return send(res, 200, await sessionAction(sql, body, req));
  if (WATCH_ACTIONS.includes(body.action)) return send(res, 200, await watchAction(sql, body, req)); // a watch: pairing is open, everything else carries its token (see _watch.js)
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used

  if (WATCH_CLUB_ACTIONS.includes(body.action)) return send(res, 200, await watchClubAction(sql, club, body, req)); // the phone linking, listing and unlinking watches
  if (BOARD_ACTIONS.includes(body.action)) return send(res, 200, await boardAction(sql, club, body, req));
  if (PUSH_ACTIONS.includes(body.action)) return send(res, 200, await pushAction(sql, club, body, req)); // opt-in notifications (see _push.js)

  if (body.action === 'state') {
    const id = String(body.id || '').slice(0, 64), st = body.state;
    if (!id || !st || typeof st !== 'object' || !Array.isArray(st.score) || !st.cfg) throw fail(400, 'That live game looks wrong.');
    if (JSON.stringify(st).length > 30000) throw fail(400, 'That live game is too big.');
    if (!secretOk(body.secret)) throw fail(400, 'A live game needs a secret of 6 to 32 letters and numbers.');
    const ack = Math.max(0, Math.trunc(Number(body.ack) || 0)), hash = hashSecret(body.secret);
    // Expire rows nobody has published for a day (everywhere now and then), then cap what is left for this club.
    await sql`DELETE FROM live_games WHERE club = ${code} AND updated_at < now() - interval '1 day'`;
    if (Math.random() < 0.05) await sql`DELETE FROM live_games WHERE updated_at < now() - interval '1 day'`;
    const [{ n, has }] = await sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE id = ${id})::int AS has FROM live_games WHERE club = ${code}`;
    if (!Number(has) && Number(n) >= MAX_LIVE_ROWS) throw fail(429, 'This club has too many live games open. Finish or end one first.');
    // Only the phone holding the secret can publish to an existing game; a game from before secrets existed is claimed by its next publish.
    const rows = await sql`INSERT INTO live_games (club, id, state, secret_hash) VALUES (${code}, ${id}, ${JSON.stringify(st)}::jsonb, ${hash})
      ON CONFLICT (club, id) DO UPDATE SET state = EXCLUDED.state, updated_at = now(), secret_hash = EXCLUDED.secret_hash, stack = '[]'::jsonb, version = live_games.version + 1,
        intents = (SELECT COALESCE(jsonb_agg(i), '[]'::jsonb) FROM jsonb_array_elements(live_games.intents) i WHERE (i->>'n')::int > ${ack})
      WHERE live_games.secret_hash IS NULL OR live_games.secret_hash = EXCLUDED.secret_hash RETURNING id`;
    if (!rows.length) { await requireSecret(sql, req, { secret_hash: '-' }, body.secret); }
    if (body.watch) await attachLinks(sql, code, id, body.watch); // the watches this phone linked score this game too (the secret was checked above)
    return send(res, 200, { ok: true });
  }

  if (body.action === 'end') {
    const [row] = await sql`SELECT secret_hash FROM live_games WHERE club = ${code} AND id = ${String(body.id || '')}`;
    if (row) { await requireSecret(sql, req, row, body.secret); await sql`DELETE FROM live_games WHERE club = ${code} AND id = ${String(body.id || '')}`; await endGameLinks(sql, code, String(body.id || '')); }
    return send(res, 200, { ok: true });
  }

  if (body.action === 'point' || body.action === 'undo') {
    if (body.action === 'point' && body.side !== 0 && body.side !== 1) throw fail(400, 'Say which side scored: side 0 or 1.');
    const since = new Date(Date.now() - FRESH_MS).toISOString();
    if (!body.game) throw fail(400, 'Say which live game this is: copy the game and secret from the scoring phone.');
    const [row] = await sql`SELECT id, state, intents, secret_hash FROM live_games WHERE club = ${code} AND id = ${String(body.game)} AND updated_at > ${since}`;
    if (!row) throw fail(404, 'No live game with that name. Check the game and secret on the scoring phone.');
    await requireSecret(sql, req, row, body.secret);
    if (row.state.winner !== null && row.state.winner !== undefined) throw fail(409, 'That game is over.');
    if ((row.intents || []).length >= MAX_PENDING) throw fail(429, 'Too many taps are waiting. Open the game on the phone.');
    const kind = body.action, side = body.side === 1 ? 1 : 0;
    const [{ seq }] = await sql`UPDATE live_games SET seq = seq + 1 WHERE club = ${code} AND id = ${row.id} RETURNING seq`;
    const sig = signIntent(body.secret, row.id, seq, kind, side);
    const [updated] = await sql`UPDATE live_games SET intents = intents || jsonb_build_array(jsonb_build_object('n', ${seq}::int, 'kind', ${kind}::text, 'side', ${side}::int, 'g', ${row.id}::text, 'sig', ${sig}::text))
      WHERE club = ${code} AND id = ${row.id} RETURNING state, intents`;
    return send(res, 200, answer(updated));
  }

  if (body.action === 'ack') {
    const [row] = await sql`SELECT secret_hash FROM live_games WHERE club = ${code} AND id = ${String(body.game || '')}`;
    if (!row) throw fail(404, 'No live game with that name.');
    await requireSecret(sql, req, row, body.secret);
    const ack = Math.max(0, Math.trunc(Number(body.ack) || 0));
    await sql`UPDATE live_games SET intents = (SELECT COALESCE(jsonb_agg(i), '[]'::jsonb) FROM jsonb_array_elements(intents) i WHERE (i->>'n')::int > ${ack}) WHERE club = ${code} AND id = ${String(body.game || '')}`;
    return send(res, 200, { ok: true });
  }

  // Shared scoring: the server referees (applyRally, _livecore.js). Any phone holding the game's secret can score and every other
  // screen follows by reading the state. 'opId' (optional) makes a retried tap harmless: a repeated one applies nothing.
  if (body.action === 'rally' || body.action === 'unrally') {
    const kind = body.action;
    if (kind === 'rally' && body.side !== 0 && body.side !== 1) throw fail(400, 'Say which side scored: side 0 or 1.');
    const game = String(body.game || body.id || '');
    if (!game) throw fail(400, 'Say which live game this is: copy the game and secret from the scoring phone.');
    const since = new Date(Date.now() - FRESH_MS).toISOString();
    const [row] = await sql`SELECT id, state, stack, version, ops, secret_hash FROM live_games WHERE club = ${code} AND id = ${game} AND updated_at > ${since}`;
    if (!row) throw fail(404, 'No live game with that name. Check the game and secret on the scoring phone.');
    await requireSecret(sql, req, row, body.secret);
    const r = await applyRally(sql, { code, row, kind, side: body.side, base: body.base, opId: cleanOpId(body.opId) });
    return send(res, r.status, r.body);
  }

  throw fail(400, 'Unknown action.');
});
