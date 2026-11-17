// Open play court board: who is here, who is waiting, who is on which court. Pure functions, no database: the same board and the
// same call always give the same answer, so `npm test` covers the queue rules without an install. Files starting with "_" are not routes.
//
// A board is
//   config   {courts, format: doubles|singles, mode: rotate|winners-stay, stayLimit, control: players|organizer, enabled}
//   present  every name checked in (on a court or waiting), in check-in order
//   queue    the waiting names, longest wait first (always a subset of present, never on a court)
//   courts   one entry per court: null (free) | {teams, at, stay, streak} (a game) | {hold, streak, at} (winners waiting for challengers)
//   history  the last matches played here, {teams}, which is what the rotation code counts partners and opponents from
// Every function that changes a board returns a new one and throws an error with a `status` for anything not allowed.
import { tally, pairKey } from './_rotation.js';
import { nameKey } from './_names.js';

export const LIMITS = { courts: 12, present: 80, history: 60, window: 8, stayLimit: 9 };
export const DEFAULTS = { courts: 4, format: 'doubles', mode: 'rotate', stayLimit: 3, control: 'players', enabled: true };
const bad = (status, message) => Object.assign(new Error(message), { status });

export const teamSize = config => (config.format === 'singles' ? 1 : 2);
export function emptyBoard(config = {}) {
  const c = cleanConfig(DEFAULTS, config);
  return { v: 1, config: c, present: [], queue: [], courts: Array(c.courts).fill(null), history: [] };
}

// Validates a settings change on top of the current settings.
export function cleanConfig(base, patch = {}) {
  const c = { ...base };
  if (patch.courts !== undefined) {
    const n = Number(patch.courts);
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.courts) throw bad(400, `A club can have 1 to ${LIMITS.courts} courts on the board.`);
    c.courts = n;
  }
  if (patch.format !== undefined) { if (!['doubles', 'singles'].includes(patch.format)) throw bad(400, 'Format must be doubles or singles.'); c.format = patch.format; }
  if (patch.mode !== undefined) { if (!['rotate', 'winners-stay'].includes(patch.mode)) throw bad(400, 'Mode must be rotate or winners-stay.'); c.mode = patch.mode; }
  if (patch.control !== undefined) { if (!['players', 'organizer'].includes(patch.control)) throw bad(400, 'Control must be players or organizer.'); c.control = patch.control; }
  if (patch.stayLimit !== undefined) {
    const n = Number(patch.stayLimit);
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.stayLimit) throw bad(400, `Winners can stay for 1 to ${LIMITS.stayLimit} games in a row.`);
    c.stayLimit = n;
  }
  if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') throw bad(400, 'Say whether the board is on.'); c.enabled = patch.enabled; }
  return c;
}

const idx = (list, name) => list.findIndex(p => nameKey(p) === nameKey(name));
const onCourt = court => (court ? (court.teams ? court.teams.flat() : court.hold || []) : []);
export const courtOf = (board, name) => board.courts.findIndex(c => onCourt(c).some(p => nameKey(p) === nameKey(name))) + 1; // 0 = not on a court
const copy = b => ({ ...b, config: { ...b.config }, present: b.present.slice(), queue: b.queue.slice(), courts: b.courts.slice(), history: b.history.slice() });

export function setConfig(board, patch) {
  const config = cleanConfig(board.config, patch);
  const b = copy(board);
  if (config.format !== board.config.format && b.courts.some(Boolean)) throw bad(409, 'Finish or cancel the games on the courts before changing between doubles and singles.');
  if (config.courts < b.courts.length && b.courts.slice(config.courts).some(Boolean)) throw bad(409, 'Finish or cancel the games on the courts you are removing first.');
  b.courts = Array.from({ length: config.courts }, (_, i) => b.courts[i] || null);
  b.config = config;
  return b;
}

export function checkIn(board, name) {
  if (idx(board.present, name) >= 0) return board;
  if (board.present.length >= LIMITS.present) throw bad(409, `The board holds up to ${LIMITS.present} players. Check some out first.`);
  const b = copy(board);
  b.present.push(name); b.queue.push(name);
  return b;
}

export function checkOut(board, name) {
  if (idx(board.present, name) < 0) return board;
  const c = courtOf(board, name);
  if (c) throw bad(409, `${board.present[idx(board.present, name)]} is on court ${c}. Finish or cancel that game first.`);
  const b = copy(board);
  b.present = b.present.filter(p => nameKey(p) !== nameKey(name));
  b.queue = b.queue.filter(p => nameKey(p) !== nameKey(name));
  return b;
}

// "Sit this one out": a waiting player drops to the back of the queue.
export function rest(board, name) {
  const i = idx(board.queue, name);
  if (i < 0) throw bad(409, 'That player is not waiting in the queue.');
  const b = copy(board);
  b.queue = b.queue.filter((_, j) => j !== i).concat(board.queue[i]);
  return b;
}

// ---- who plays next ----
const combos = (arr, k) => {
  if (k === 0) return [[]];
  const out = [];
  arr.forEach((x, i) => { for (const rest of combos(arr.slice(i + 1), k - 1)) out.push([x, ...rest]); });
  return out;
};
const PARTNER_WEIGHT = 100, OPPONENT_WEIGHT = 2;

// The next group for court index `i` out of `pool` (the waiting names, longest wait first), or null when too few wait.
// The longest-waiting player always plays; the others come from the next few in line, chosen so that nobody repeats a partner
// or an opponent more often than they have to (the same counts the event rotation uses). Ties go to whoever has waited longest.
export function groupFor(board, i, pool) {
  const court = board.courts[i], per = teamSize(board.config), hold = court && court.hold;
  const need = hold ? per : per * 2;
  if (pool.length < need) return null;
  const t = tally(board.present, board.history.map(m => ({ matches: [m] })));
  const count = (map, a, b) => map.get(pairKey(a, b)) || 0;
  const window = pool.slice(0, Math.max(need, LIMITS.window));
  let best = null;
  for (const rest of combos(window.slice(1), need - 1)) {
    const players = [window[0], ...rest];
    const splits = hold ? [[hold, players]]
      : per === 1 ? [[[players[0]], [players[1]]]]
      : [[[players[0], players[1]], [players[2], players[3]]], [[players[0], players[2]], [players[1], players[3]]], [[players[0], players[3]], [players[1], players[2]]]];
    for (const teams of splits) {
      let cost = players.reduce((s, p) => s + pool.indexOf(p), 0);
      for (const team of teams) if (team.length === 2) { const n = count(t.partner, team[0], team[1]); cost += PARTNER_WEIGHT * n * n; }
      for (const a of teams[0]) for (const b of teams[1]) { const n = count(t.opp, a, b); cost += OPPONENT_WEIGHT * n * n; }
      if (!best || cost < best.cost) best = { cost, teams, players };
    }
  }
  return { court: i + 1, teams: best.teams, players: best.players };
}

// What to call next on every free court (or court waiting for challengers), in court order, each from what is left of the queue.
export function suggest(board) {
  let pool = board.queue.slice();
  const out = [];
  board.courts.forEach((c, i) => {
    if (c && c.teams) return;
    const g = groupFor(board, i, pool);
    if (!g) return;
    out.push({ court: g.court, teams: g.teams });
    pool = pool.filter(p => !g.players.includes(p));
  });
  return out;
}

// Put a game on a court: the suggested group, or `teams` picked by hand. Everyone must be waiting; winners holding the court stay put.
export function call(board, courtNo, teams) {
  const i = Number(courtNo) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= board.courts.length) throw bad(400, 'That court is not on the board.');
  const court = board.courts[i], per = teamSize(board.config);
  if (court && court.teams) throw bad(409, `Court ${i + 1} is in use. Finish its game first.`);
  let chosen;
  if (teams === undefined || teams === null) {
    const g = groupFor(board, i, board.queue);
    if (!g) throw bad(409, `Not enough players are waiting for court ${i + 1}.`);
    chosen = g.teams;
  } else {
    if (!Array.isArray(teams) || teams.length !== 2 || teams.some(t => !Array.isArray(t) || t.length !== per)) throw bad(400, `Pick two teams of ${per}.`);
    const seen = new Set();
    chosen = teams.map((team, ti) => team.map(n => {
      const k = nameKey(n);
      if (seen.has(k)) throw bad(400, 'A player can only be in one spot.');
      seen.add(k);
      const stays = court && court.hold && ti === 0 && court.hold.some(p => nameKey(p) === k);
      if (court && court.hold && ti === 0 && !stays) throw bad(409, 'The winners are holding this court; they have to be the first team.');
      if (stays) return court.hold.find(p => nameKey(p) === k);
      const q = idx(board.queue, n);
      if (q < 0) throw bad(409, `${String(n).slice(0, 40)} is not waiting in the queue.`);
      return board.queue[q];
    }));
    if (court && court.hold && chosen[0].length !== court.hold.length) throw bad(409, 'The winners are holding this court; they have to be the first team.');
  }
  const b = copy(board), taken = new Set(chosen.flat().map(nameKey));
  b.queue = b.queue.filter(p => !taken.has(nameKey(p)));
  b.courts[i] = { teams: chosen, at: Date.now(), stay: court && court.hold ? 0 : null, streak: court && court.hold ? court.streak : 0 };
  return b;
}

// A game ended: record it, then rotate or let the winners stay. Returns the new board.
export function finish(board, courtNo, winner) {
  const i = Number(courtNo) - 1, court = board.courts[i];
  if (!court || !court.teams) throw bad(409, `There is no game on court ${i + 1}.`);
  if (winner !== 0 && winner !== 1) throw bad(400, 'Say which team won: 0 or 1.');
  const b = copy(board), won = court.teams[winner], lost = court.teams[1 - winner];
  b.history = b.history.concat({ teams: court.teams }).slice(-LIMITS.history);
  const streak = court.stay === winner ? court.streak + 1 : 1;
  if (board.config.mode === 'winners-stay' && streak < board.config.stayLimit) {
    b.courts[i] = { hold: won.slice(), streak, at: Date.now() };
    b.queue = b.queue.concat(lost);
  } else {
    b.courts[i] = null;
    b.queue = b.queue.concat(won, lost);
  }
  return b;
}

// The game never happened (or nobody came): everyone goes back to the front of the queue.
export function cancel(board, courtNo) {
  const i = Number(courtNo) - 1, court = board.courts[i];
  if (!court) throw bad(409, `Court ${i + 1} is already free.`);
  const b = copy(board);
  b.queue = onCourt(court).concat(b.queue);
  b.courts[i] = null;
  return b;
}

// After names were renamed or merged elsewhere: no name twice, nobody waiting who is not here or who is on a court.
export function repair(board) {
  const b = copy(board);
  const uniq = list => { const seen = new Set(); return list.filter(p => { const k = nameKey(p); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const playing = new Set(b.courts.flatMap(c => onCourt(c).map(nameKey)));
  b.present = uniq(b.present);
  const here = new Set(b.present.map(nameKey));
  b.queue = uniq(b.queue).filter(p => here.has(nameKey(p)) && !playing.has(nameKey(p)));
  return b;
}

// The live game (from live.js: {id, teams, score, winner}) being scored for a court's players, if any: the same players on the same
// sides. Its score is given in the court's team order, so the board shows it without knowing how the scorer arranged the teams.
export function liveFor(court, games) {
  if (!court || !court.teams) return null;
  const side = t => t.map(nameKey).sort().join('|');
  const mine = court.teams.map(side);
  for (const g of games || []) {
    if (!g || !Array.isArray(g.teams) || g.teams.length !== 2 || !Array.isArray(g.score)) continue;
    const theirs = g.teams.map(t => side(t || []));
    const flip = theirs[0] === mine[1] && theirs[1] === mine[0];
    if (!flip && !(theirs[0] === mine[0] && theirs[1] === mine[1])) continue;
    const w = g.winner === 0 || g.winner === 1 ? (flip ? 1 - g.winner : g.winner) : null;
    return { id: g.id, score: flip ? [g.score[1], g.score[0]] : [g.score[0], g.score[1]], winner: w };
  }
  return null;
}

// What a phone or the TV gets: the board, what is being scored on each court, and what to call next.
export const view = (board, games = []) => ({ config: board.config, present: board.present, queue: board.queue, suggestions: suggest(board),
  courts: board.courts.map((c, i) => (c ? { court: i + 1, ...c, ...(c.teams && liveFor(c, games) ? { live: liveFor(c, games) } : {}) } : { court: i + 1 })) });
