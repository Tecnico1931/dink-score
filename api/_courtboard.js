// Open play court board, reached through /api/live (one route fewer for the function limit; the board builds on the live games).
//   GET  /api/live?code=ABC123&board=1                      -> {board, version}: courts, who waits, what to call next; each court shows the
//                                                              live score of the game being scored for those players. board is null until an organizer turns it on.
//   POST /api/live {code, action: 'board-config', ...settings, pin|ownerToken}   -> organizer: courts, format, mode, stayLimit, control, enabled
//   POST /api/live {code, action: 'board-checkin', name?, names?, playerToken?|pin|ownerToken}   -> a linked player checks themself in; an organizer checks anyone in
//   POST /api/live {code, action: 'board-checkout' | 'board-rest', name, ...}     -> yourself (or an organizer for anyone); rest = back of the queue
//   POST /api/live {code, action: 'board-call', court, teams?, ...}   -> put the suggested (or hand-picked) group on a free court
//   POST /api/live {code, action: 'board-finish', court, winner?, ...}-> the game ended: rotate, or winners stay. The winner comes from the court's live game when it has one
//   POST /api/live {code, action: 'board-cancel', court, ...}         -> the game never happened: everyone back to the front of the queue
//   POST /api/live {code, action: 'board-reset', pin|ownerToken}      -> organizer: end of session, everyone off the board
// Who may run it (call, finish, cancel, rest for others) is the club setting `control`: 'players' lets any player checked in on the board
// (a linked phone, proven by its player token) do it, 'organizer' leaves it to organizers. Checking in and out yourself is always open to a linked
// player. The board never saves a game: the scorer's normal save is what reaches the club record, so ratings can't count a game twice.
import { fail, requireOrganizer, tokenMatches, cleanName, nameKey } from './_db.js';
import { audit } from './_members.js';
import * as C from './_court.js';

export const BOARD_ACTIONS = ['board-config', 'board-checkin', 'board-checkout', 'board-rest', 'board-call', 'board-finish', 'board-cancel', 'board-reset'];
const FRESH_MS = 6 * 60 * 60 * 1000;
const MAX_CHECKIN_BATCH = 40;

async function liveGames(sql, code) {
  const since = new Date(Date.now() - FRESH_MS).toISOString();
  const rows = await sql`SELECT id, state FROM live_games WHERE club = ${code} AND updated_at > ${since} ORDER BY updated_at DESC LIMIT 20`;
  return rows.filter(r => r.state && r.state.cfg).map(r => ({ id: r.id, teams: r.state.cfg.teams, score: r.state.score, winner: r.state.winner }));
}

export async function boardGet(sql, club) {
  const [row] = await sql`SELECT data, version FROM court_boards WHERE club = ${club.code}`;
  if (!row || !row.data.config.enabled) return { board: null, version: row ? row.version : 0 };
  return { board: C.view(row.data, await liveGames(sql, club.code)), version: row.version };
}

// A linked player: the name and the token of the phone that claimed it.
async function playerFrom(sql, club, name, token) {
  if (!name || !token) return null;
  const [r] = await sql`SELECT name, claim_hash FROM roster WHERE club = ${club.code} AND name_key = ${nameKey(name)} AND blocked_at IS NULL`;
  return r && r.claim_hash && tokenMatches(r.claim_hash, token) ? r.name : null;
}

// The saved spelling of a name, or the cleaned name for a guest an organizer is adding.
async function canon(sql, club, raw) {
  const name = cleanName(raw);
  if (!name) throw fail(400, 'Enter a name.');
  const [r] = await sql`SELECT name FROM roster WHERE club = ${club.code} AND name_key = ${nameKey(name)}`;
  return r ? r.name : name;
}

export async function boardAction(sql, club, body, req) {
  const code = club.code, action = body.action;
  const hasOrg = !!(body.pin || body.ownerToken);
  const org = hasOrg ? await requireOrganizer(club, body.pin, req, body.ownerToken) : null;
  const me = org ? null : await playerFrom(sql, club, body.playerName || body.name, body.playerToken);
  if (!org && !me) throw fail(403, 'Pick your name in the club on this phone first (or use the organizer PIN) to use the court board.');

  if (action === 'board-config') {
    if (!org) throw fail(403, 'Only organizers can change the court board settings.');
    const patch = {};
    for (const k of ['courts', 'format', 'mode', 'stayLimit', 'control', 'enabled']) if (body[k] !== undefined) patch[k] = body[k];
    let before = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      let [row] = await sql`SELECT data, version FROM court_boards WHERE club = ${code}`;
      if (!row) {
        const fresh = C.emptyBoard(patch);
        await sql`INSERT INTO court_boards (club, data) VALUES (${code}, ${JSON.stringify(fresh)}::jsonb) ON CONFLICT (club) DO NOTHING`;
        [row] = await sql`SELECT data, version FROM court_boards WHERE club = ${code}`;
        if (JSON.stringify(row.data) === JSON.stringify(fresh)) { await audit(sql, code, org, 'court-board', null, { config: fresh.config }); return { ok: true, ...(await boardGet(sql, club)) }; }
      }
      before = row.data.config;
      const next = C.setConfig(row.data, patch);
      const upd = await sql`UPDATE court_boards SET data = ${JSON.stringify(next)}::jsonb, version = version + 1, updated_at = now() WHERE club = ${code} AND version = ${row.version} RETURNING version`;
      if (upd.length) { await audit(sql, code, org, 'court-board', null, { config: next.config }); return { ok: true, ...(await boardGet(sql, club)) }; }
    }
    throw fail(409, 'The board changed while you saved. Try again.');
  }

  // Everything else changes a board that already exists.
  for (let attempt = 0; attempt < 4; attempt++) {
    const [row] = await sql`SELECT data, version FROM court_boards WHERE club = ${code}`;
    if (!row || !row.data.config.enabled) throw fail(404, 'This club has no court board yet. An organizer can turn it on.');
    const board = row.data, cfg = board.config;
    const here = !!me && board.present.some(p => nameKey(p) === nameKey(me));
    const runner = !!org || (cfg.control === 'players' && here);
    const needRunner = () => { if (!runner) throw fail(403, cfg.control === 'organizer' ? 'Only organizers run the courts in this club.' : 'Check yourself in on the board first to run the courts.'); };
    let next;
    if (action === 'board-checkin') {
      const raws = org ? [].concat(body.names !== undefined ? body.names : body.name) : [me];
      if (raws.length > MAX_CHECKIN_BATCH) throw fail(400, 'Check in up to ' + MAX_CHECKIN_BATCH + ' players at a time.');
      next = board;
      for (const raw of raws) next = C.checkIn(next, await canon(sql, club, raw));
    } else if (action === 'board-checkout' || action === 'board-rest') {
      const name = body.target ? await canon(sql, club, body.target) : me || await canon(sql, club, body.name);
      const own = !!me && nameKey(name) === nameKey(me);
      if (!own && !org && !(action === 'board-rest' && runner)) throw fail(403, 'You can only check yourself out.');
      next = action === 'board-checkout' ? C.checkOut(board, name) : C.rest(board, name);
    } else if (action === 'board-call') {
      needRunner();
      next = C.call(board, body.court, body.teams === undefined ? undefined : body.teams);
    } else if (action === 'board-finish') {
      needRunner();
      const court = board.courts[Number(body.court) - 1];
      const live = court && C.liveFor(court, await liveGames(sql, code));
      const winner = live && live.winner !== null ? live.winner : body.winner;
      next = C.finish(board, body.court, winner === undefined || winner === null ? winner : Number(winner));
    } else if (action === 'board-cancel') {
      needRunner();
      next = C.cancel(board, body.court);
    } else if (action === 'board-reset') {
      if (!org) throw fail(403, 'Only organizers can clear the board.');
      next = C.emptyBoard(cfg);
    } else throw fail(400, 'Unknown action.');
    if (next === board && action !== 'board-reset') return { ok: true, ...(await boardGet(sql, club)) };
    const upd = await sql`UPDATE court_boards SET data = ${JSON.stringify(next)}::jsonb, version = version + 1, updated_at = now() WHERE club = ${code} AND version = ${row.version} RETURNING version`;
    if (upd.length) {
      if (action === 'board-reset') await audit(sql, code, org, 'court-board-reset', null, null);
      return { ok: true, ...(await boardGet(sql, club)) };
    }
  }
  throw fail(409, 'The board changed while you saved. Try again.');
}
