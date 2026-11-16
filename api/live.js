// Watch scoring (prototype): the phone scoring a game publishes its live state here. A watch
// (through Apple Shortcuts) appends point and undo intents. The phone polls for intents, applies
// them with the real scoring rules (PB.rally) and republishes, so the rules live in one place and
// an intent changes nothing until the phone takes it.
//   GET  /api/live?code=ABC123&id=live-xyz            -> { state, intents } for the scoring phone
//   POST /api/live {code, action:'state', id, state, ack} -> the phone publishes; ack drops applied intents
//   POST /api/live {code, action:'point', side}       -> an intent for the club's current live game; answers the score call
//   POST /api/live {code, action:'undo'}              -> an undo intent; answers the score call
//   POST /api/live {code, action:'end', id}           -> the phone removes the live game (saved or discarded)
// Same trust model as adding a game: anyone with the club code can send points.
import { db, handler, send, readBody, fail, cleanCode, requireClub } from './_db.js';

const FRESH_MS = 6 * 60 * 60 * 1000; // a live game nobody has published for in 6 hours is not live any more
const MAX_PENDING = 50;

function callOf(s) {
  const parts = [s.score[s.serving], s.score[1 - s.serving]];
  if (s.cfg && s.cfg.mode === 'doubles' && s.cfg.scoring === 'sideout') parts.push(s.serverNum);
  return parts;
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
    const [row] = await sql`SELECT state, intents FROM live_games WHERE club = ${code} AND id = ${id}`;
    return send(res, 200, row ? { state: row.state, intents: row.intents } : { state: null, intents: [] });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used

  if (body.action === 'state') {
    const id = String(body.id || ''), st = body.state;
    if (!id || !st || typeof st !== 'object' || !Array.isArray(st.score) || !st.cfg) throw fail(400, 'That live game looks wrong.');
    if (JSON.stringify(st).length > 30000) throw fail(400, 'That live game is too big.');
    const ack = Math.max(0, Math.trunc(Number(body.ack) || 0));
    await sql`INSERT INTO live_games (club, id, state) VALUES (${code}, ${id}, ${JSON.stringify(st)}::jsonb)
      ON CONFLICT (club, id) DO UPDATE SET state = EXCLUDED.state, updated_at = now(),
        intents = (SELECT COALESCE(jsonb_agg(i), '[]'::jsonb) FROM jsonb_array_elements(live_games.intents) i WHERE (i->>'n')::int > ${ack})`;
    return send(res, 200, { ok: true });
  }

  if (body.action === 'end') {
    await sql`DELETE FROM live_games WHERE club = ${code} AND id = ${String(body.id || '')}`;
    return send(res, 200, { ok: true });
  }

  if (body.action === 'point' || body.action === 'undo') {
    if (body.action === 'point' && body.side !== 0 && body.side !== 1) throw fail(400, 'Say which side scored: side 0 or 1.');
    const since = new Date(Date.now() - FRESH_MS).toISOString();
    const [row] = await sql`SELECT id, state, intents FROM live_games WHERE club = ${code} AND updated_at > ${since} ORDER BY updated_at DESC LIMIT 1`;
    if (!row) throw fail(404, 'No live game right now. Start a game on the phone first.');
    if (row.state.winner !== null && row.state.winner !== undefined) throw fail(409, 'That game is over.');
    if ((row.intents || []).length >= MAX_PENDING) throw fail(429, 'Too many taps are waiting. Open the game on the phone.');
    const kind = body.action, side = body.side === 1 ? 1 : 0;
    const [updated] = await sql`UPDATE live_games SET seq = seq + 1,
        intents = intents || jsonb_build_array(jsonb_build_object('n', seq + 1, 'kind', ${kind}::text, 'side', ${side}::int))
      WHERE club = ${code} AND id = ${row.id} RETURNING state, intents`;
    return send(res, 200, answer(updated));
  }

  throw fail(400, 'Unknown action.');
});
