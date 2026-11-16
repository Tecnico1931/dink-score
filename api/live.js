// Watch scoring (prototype): the phone scoring a game publishes its live state here. A watch
// (through Apple Shortcuts) appends point and undo intents. The phone polls for intents, applies
// them with the real scoring rules (PB.rally) and republishes, so the rules live in one place and
// an intent changes nothing until the phone takes it.
//   GET  /api/live?code=ABC123&id=live-xyz&secret=K   -> { state, intents } for the scoring phone
//   POST /api/live {code, action:'state', id, secret, state, ack} -> the phone publishes; ack drops applied intents
//   POST /api/live {code, action:'point', game, secret, side}     -> an intent for that live game; answers the score call
//   POST /api/live {code, action:'undo', game, secret}            -> an undo intent; answers the score call
//   POST /api/live {code, action:'end', id, secret}   -> the phone removes the live game (saved or discarded)
// Each live game has its own short-lived secret, made on the scoring phone and shown there (and on the watch setup page).
// Intents must name the game and carry its secret; the club code alone is not enough, so two games at once never mix.
// The server keeps only a hash of the secret, hands intents only to a caller who holds it, and signs each intent with it,
// so the phone also ignores any intent that was not made by someone holding the secret.
import { createHash } from 'node:crypto';
import { db, handler, send, readBody, fail, cleanCode, requireClub, clientIp } from './_db.js';

export const secretOk = v => typeof v === 'string' && /^[A-Za-z0-9]{6,32}$/.test(v);
export const hashSecret = v => createHash('sha256').update('live:' + v).digest('hex');
// What the phone recomputes to accept an intent: sha256 of "secret:n:kind:side:game", hex.
export const signIntent = (secret, game, n, kind, side) => createHash('sha256').update(`${secret}:${n}:${kind}:${side}:${game}`).digest('hex');
const MAX_BAD_SECRETS = 30; // wrong or missing secrets per network address per 15 minutes

const FRESH_MS = 6 * 60 * 60 * 1000; // a live game nobody has published for in 6 hours is not live any more
const MAX_PENDING = 50;
const MAX_LIVE_ROWS = 20; // live games one club can have at once; stale ones are purged first

function callOf(s) {
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
    const [row] = await sql`SELECT state, intents, secret_hash FROM live_games WHERE club = ${code} AND id = ${id}`;
    if (!row) return send(res, 200, { state: null, intents: [] });
    await requireSecret(sql, req, row, url.searchParams.get('secret'));
    return send(res, 200, { state: row.state, intents: row.intents });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used

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
      ON CONFLICT (club, id) DO UPDATE SET state = EXCLUDED.state, updated_at = now(), secret_hash = EXCLUDED.secret_hash,
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

  throw fail(400, 'Unknown action.');
});
