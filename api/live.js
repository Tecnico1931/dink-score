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
//   GET/POST board-*: the open play court board built on these live games, documented in _courtboard.js
// Each live game has its own short-lived secret, made on the scoring phone and shown there (and on the watch setup page).
// Intents must name the game and carry its secret; the club code alone is not enough, so two games at once never mix.
// The server keeps only a hash of the secret, hands intents only to a caller who holds it, and signs each intent with it,
// so the phone also ignores any intent that was not made by someone holding the secret.
import { createHash } from 'node:crypto';
import { db, handler, send, readBody, fail, cleanCode, requireClub, clientIp } from './_db.js';
import { rally as rallyOf, call as pbCall } from './_pb.js';
import { boardGet, boardAction, BOARD_ACTIONS } from './_courtboard.js';

export const secretOk = v => typeof v === 'string' && /^[A-Za-z0-9]{6,32}$/.test(v);
export const hashSecret = v => createHash('sha256').update('live:' + v).digest('hex');
// What the phone recomputes to accept an intent: sha256 of "secret:n:kind:side:game", hex.
export const signIntent = (secret, game, n, kind, side) => createHash('sha256').update(`${secret}:${n}:${kind}:${side}:${game}`).digest('hex');
const MAX_BAD_SECRETS = 30; // wrong or missing secrets per network address per 15 minutes

const FRESH_MS = 6 * 60 * 60 * 1000; // a live game nobody has published for in 6 hours is not live any more
const MAX_PENDING = 50;
const MAX_LIVE_ROWS = 20; // live games one club can have at once; stale ones are purged first

function callOf(s) {
  if (s && s.cfg) return pbCall(s);
  const parts = [s.score[s.serving], s.score[1 - s.serving]];
  if (s.cfg && s.cfg.mode === 'doubles' && s.cfg.scoring === 'sideout') parts.push(s.serverNum);
  return parts;
}
// The caller must hold this game's secret. Wrong guesses are counted per address, like wrong club codes.
async function requireSecret(sql, req, row, secret) {
  const key = 'live:' + clientIp(req);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '15 minutes'`;
  if (n >= MAX_BAD_SECRETS) throw fail(429, 'Too many wrong game secrets. Wait 15 minutes and try again.');
  const ok = secretOk(secret) && row && row.secret_hash && row.secret_hash === hashSecret(secret);
  if (!ok) { await sql`INSERT INTO lookup_fails (ip) VALUES (${key})`; throw fail(403, 'That game secret is wrong. Copy the game and secret again from the scoring phone.'); }
}
function answer(row) {
  const s = row.state, call = callOf(s);
  return { ok: true, score: s.score, call, say: s.winner !== null && s.winner !== undefined ? 'Game over' : 'Score: ' + call.join(', '), pending: (row.intents || []).length };
}

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
    const code = club.code; // the club's permanent key, even when an old club code was used
    const id = String(url.searchParams.get('id') || '');
    if (url.searchParams.get('board')) return send(res, 200, await boardGet(sql, club)); // the open play court board (see _courtboard.js)
    if (!id) {
      // The club's games going on right now: players and scores only. Anyone with the club code can
      // already see the club's finished games; a live score is no more private. Scoring one still
      // needs that game's secret.
      const since = new Date(Date.now() - FRESH_MS).toISOString();
      const rows = await sql`SELECT id, state, updated_at FROM live_games WHERE club = ${code} AND updated_at > ${since} ORDER BY updated_at DESC LIMIT ${MAX_LIVE_ROWS}`;
      const games = rows.map(r => ({ id: r.id, teams: r.state.cfg.teams, score: r.state.score, serving: r.state.serving, serverNum: r.state.serverNum, winner: r.state.winner, mode: r.state.cfg.mode, scoring: r.state.cfg.scoring, target: r.state.cfg.target, startedAt: r.state.startedAt, updatedAt: new Date(r.updated_at).getTime() }));
      return send(res, 200, { games });
    }
    const [row] = await sql`SELECT state, intents, secret_hash, version FROM live_games WHERE club = ${code} AND id = ${id}`;
    if (!row) return send(res, 200, { state: null, intents: [], version: 0 });
    await requireSecret(sql, req, row, url.searchParams.get('secret'));
    return send(res, 200, { state: row.state, intents: row.intents, version: row.version });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used

  if (BOARD_ACTIONS.includes(body.action)) return send(res, 200, await boardAction(sql, club, body, req));

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
    return send(res, 200, { ok: true });
  }

  if (body.action === 'end') {
    const [row] = await sql`SELECT secret_hash FROM live_games WHERE club = ${code} AND id = ${String(body.id || '')}`;
    if (row) { await requireSecret(sql, req, row, body.secret); await sql`DELETE FROM live_games WHERE club = ${code} AND id = ${String(body.id || '')}`; }
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

  // Shared scoring: the server referees. A rally is applied to the server-held state with the ported
  // rules (_pb.js), so any phone or watch holding the game's secret can score and every other screen
  // follows by reading the state. Callers that pass the version they saw ('base') get a 200 conflict
  // answer with the latest state when someone else scored first, so they can resync and retry; taps
  // without a base (a watch) are retried against the fresh state until they land.
  if (body.action === 'rally' || body.action === 'unrally') {
    const kind = body.action;
    if (kind === 'rally' && body.side !== 0 && body.side !== 1) throw fail(400, 'Say which side scored: side 0 or 1.');
    const game = String(body.game || body.id || '');
    if (!game) throw fail(400, 'Say which live game this is: copy the game and secret from the scoring phone.');
    const since = new Date(Date.now() - FRESH_MS).toISOString();
    let [row] = await sql`SELECT id, state, stack, version, secret_hash FROM live_games WHERE club = ${code} AND id = ${game} AND updated_at > ${since}`;
    if (!row) throw fail(404, 'No live game with that name. Check the game and secret on the scoring phone.');
    await requireSecret(sql, req, row, body.secret);
    const hasBase = body.base !== undefined && body.base !== null && Number.isFinite(+body.base);
    const conflict = r => send(res, 200, { ok: false, conflict: true, state: r.state, version: r.version });
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) { const [fresh] = await sql`SELECT id, state, stack, version FROM live_games WHERE club = ${code} AND id = ${row.id}`; if (!fresh) throw fail(404, 'That live game is gone.'); row = fresh; }
      if (kind === 'rally' && row.state.winner !== null && row.state.winner !== undefined) throw fail(409, 'That game is over.');
      if (hasBase && +body.base !== row.version) return conflict(row);
      let next, stack;
      if (kind === 'rally') { next = rallyOf(row.state, body.side === 1 ? 1 : 0); stack = [...(row.stack || []), row.state].slice(-200); }
      else {
        if (!(row.stack || []).length) return send(res, 200, { ok: true, unchanged: true, state: row.state, version: row.version });
        next = row.stack[row.stack.length - 1]; stack = row.stack.slice(0, -1);
      }
      const upd = await sql`UPDATE live_games SET state = ${JSON.stringify(next)}::jsonb, stack = ${JSON.stringify(stack)}::jsonb, version = version + 1, updated_at = now() WHERE club = ${code} AND id = ${row.id} AND version = ${row.version} RETURNING version`;
      if (upd.length) {
        const call = callOf(next);
        return send(res, 200, { ok: true, state: next, version: upd[0].version, score: next.score, call, say: next.winner !== null && next.winner !== undefined ? 'Game over' : 'Score: ' + call.join(', ') });
      }
      if (hasBase) { const [fresh] = await sql`SELECT state, version FROM live_games WHERE club = ${code} AND id = ${row.id}`; return conflict(fresh || row); }
    }
    const [fresh] = await sql`SELECT state, version FROM live_games WHERE club = ${code} AND id = ${row.id}`;
    return conflict(fresh || row);
  }

  throw fail(400, 'Unknown action.');
});
