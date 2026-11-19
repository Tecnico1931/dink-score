// What /api/live's scoring routes and the watch routes (_watch.js) share: the game-secret check and the server-applied rally.
import { createHash } from 'node:crypto';
import { fail, clientIp } from './_db.js';
import { rally as rallyOf } from './_pb.js';
import { callOf, sayOf, seenOp, pushOp } from './_watchrules.js';

export const secretOk = v => typeof v === 'string' && /^[A-Za-z0-9]{6,32}$/.test(v);
export const hashSecret = v => createHash('sha256').update('live:' + v).digest('hex');
export const FRESH_MS = 6 * 60 * 60 * 1000; // a live game nobody has published for in 6 hours is not live any more
const MAX_BAD_SECRETS = 30; // wrong or missing secrets per network address per 15 minutes

// The caller must hold this game's secret. Wrong guesses are counted per address, like wrong club codes.
export async function requireSecret(sql, req, row, secret) {
  const key = 'live:' + clientIp(req);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '15 minutes'`;
  if (n >= MAX_BAD_SECRETS) throw fail(429, 'Too many wrong game secrets. Wait 15 minutes and try again.');
  const ok = secretOk(secret) && row && row.secret_hash && row.secret_hash === hashSecret(secret);
  if (!ok) { await sql`INSERT INTO lookup_fails (ip) VALUES (${key})`; throw fail(403, 'That game secret is wrong. Copy the game and secret again from the scoring phone.'); }
}

// Shared scoring: the server referees. A rally is applied to the server-held state with the ported rules (_pb.js), so any
// phone or watch allowed to score the game can score it and every other screen follows by reading the state. Callers that pass
// the version they saw ('base') get a conflict answer with the latest state when someone else scored first, so they can resync
// and retry; taps without a base (a watch) are retried against the fresh state until they land.
// `opId` (optional, a tap's own id): the last OPS_KEEP ids are kept on the game, and a repeated one applies nothing and answers
// with the current state and duplicate:true, so a retry after a lost answer never counts a point twice. The id is stored in the same
// version-guarded UPDATE that applies the tap, so two copies of one tap arriving together cannot both land.
// `row` is {id, state, stack, version, ops}. Returns {status, body}; a missing game or a finished one throws.
export async function applyRally(sql, { code, row, kind, side, base, opId }) {
  const hasBase = base !== undefined && base !== null && Number.isFinite(+base);
  const conflict = r => ({ status: 200, body: { ok: false, conflict: true, state: r.state, version: r.version } });
  const answer = (state, version, extra = {}) => { const call = callOf(state); return { status: 200, body: { ok: true, state, version, score: state.score, call, say: sayOf(state, call), ...extra } }; };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) { const [fresh] = await sql`SELECT id, state, stack, version, ops FROM live_games WHERE club = ${code} AND id = ${row.id}`; if (!fresh) throw fail(404, 'That live game is gone.'); row = fresh; }
    if (seenOp(row.ops, opId)) return answer(row.state, row.version, { duplicate: true });
    if (kind === 'rally' && row.state.winner !== null && row.state.winner !== undefined) throw fail(409, 'That game is over.');
    if (hasBase && +base !== row.version) return conflict(row);
    const ops = opId ? pushOp(row.ops, opId) : (row.ops || []);
    let next, stack;
    if (kind === 'rally') { next = rallyOf(row.state, side === 1 ? 1 : 0); stack = [...(row.stack || []), row.state].slice(-200); }
    else {
      if (!(row.stack || []).length) {
        // Nothing to take back. The tap id is still remembered (no version bump), so a retry cannot undo a later point.
        if (opId) await sql`UPDATE live_games SET ops = ${JSON.stringify(ops)}::jsonb WHERE club = ${code} AND id = ${row.id} AND version = ${row.version}`;
        return { status: 200, body: { ok: true, unchanged: true, state: row.state, version: row.version } };
      }
      next = row.stack[row.stack.length - 1]; stack = row.stack.slice(0, -1);
    }
    const upd = await sql`UPDATE live_games SET state = ${JSON.stringify(next)}::jsonb, stack = ${JSON.stringify(stack)}::jsonb, ops = ${JSON.stringify(ops)}::jsonb, version = version + 1, updated_at = now() WHERE club = ${code} AND id = ${row.id} AND version = ${row.version} RETURNING version`;
    if (upd.length) return answer(next, upd[0].version);
    if (hasBase) { const [fresh] = await sql`SELECT state, version FROM live_games WHERE club = ${code} AND id = ${row.id}`; return conflict(fresh || row); }
  }
  const [fresh] = await sql`SELECT state, version FROM live_games WHERE club = ${code} AND id = ${row.id}`;
  return conflict(fresh || row);
}
