// Leagues (divisions playing a season of round robin weeks) and ladders (challenge matches that move players up). Pure functions
// on a plain object, no database; the API stores it as one JSON document (see _leagues.js).
//
// league = {
//   v, id, kind: 'league' | 'ladder', name, season, mode: 'singles' | 'doubles', status: 'live' | 'done',
//   scoring, target, winBy, resultsBy: 'players' | 'club', createdAt, updatedAt,
//   entries: [[names]], seeds: [rating, ...],           // one entry per player (singles) or team (doubles), strongest first by Dink Rating when made
//   // league: divisions: [{ label, entries: [index] }], legs, move (entries promoted/relegated each way between divisions; 0 = none, absent = 1),
//   //   tiebreak (stored as 'diff,pf,h2h' string, not a string array, so rewriteNames in _rename.js never mistakes a key for a player name; absent = legacy 'diff,pf'),
//   //   weeks: [{ n, title, date?, time?, notifiedAt?, matches: [match] }], champions: [[names] per division]
//   //   week.date 'YYYY-MM-DD' and week.time 'HH:MM' are the day's wall clock as the organizer typed it (no time zone); see _leagueweeks.js
//   // ladder: jump (how many places up a challenge may reach), decayDays (0/absent = off; idle days per place dropped), since (season start), open: [{ id, c, d, at, expiresAt, state }] (pending challenges, see openChallenge), results: [result], seasons: [{ label, endedAt, order: [[names]] }]
// }
// match  = { id, division, teams: [[a, b], [c, d]], score: null | [x, y], status: 'pending' | 'done', winner, startedAt, endedAt, rallies, live, gameId,
//            court?, date?, time? (this match moved off the week's day), forfeit? (settled by default: target to 0, never a game in the club record) }
// result = { id, teams: [[challenger], [defender]], c, d (entry indexes), score, winner, startedAt, endedAt, rallies, live, gameId, at }
// Names only ever sit inside arrays (entries, teams, order), so rename and anonymise (_rename.js, players.js) reach every one.
import { cleanName } from './_names.js';
import { pairTeams, roundRobin, standings, teamId } from './_schedule.js';
import { seedTeams, divisionLabel, MAX_DIVISIONS } from './_seeding.js';
import { checkScore } from './_bracket.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const MAX_ENTRIES = 32;
export const MIN_PER_DIVISION = 3;
const clone = x => JSON.parse(JSON.stringify(x));
const clamp = (v, lo, hi, d) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const optClamp = (v, lo, hi, d) => (v === undefined || v === null || v === '' ? d : clamp(v, lo, hi, d));
const keyOf = names => names.map(n => n.toLowerCase()).sort().join('|');

export const TIEBREAK_KEYS = ['diff', 'pf', 'h2h'];
export const DEFAULT_TIEBREAK = ['diff', 'pf', 'h2h'];
const LEGACY_TIEBREAK = ['diff', 'pf'];

function cleanTiebreak(raw) {
  if (raw === undefined || raw === null) return DEFAULT_TIEBREAK.join(',');
  const list = typeof raw === 'string' ? raw.split(',').map(s => s.trim()) : Array.isArray(raw) ? raw.map(s => String(s)) : null;
  if (!list || list.length !== TIEBREAK_KEYS.length || new Set(list).size !== TIEBREAK_KEYS.length || !list.every(k => TIEBREAK_KEYS.includes(k))) {
    throw bad('Tie-breakers must list head-to-head, point difference and points for, once each.');
  }
  return list.join(',');
}

export function tiebreakOf(L) {
  if (typeof L.tiebreak === 'string' && L.tiebreak) return L.tiebreak.split(',');
  if (Array.isArray(L.tiebreak) && L.tiebreak.length) return L.tiebreak.slice();
  return LEGACY_TIEBREAK.slice();
}

export function maxMoveFor(divisions) {
  const k = Array.isArray(divisions) ? divisions.length : 0;
  if (k <= 1) return 0;
  const min = Math.min(...divisions.map(d => d.entries.length));
  // With 2 divisions nobody both rises and falls; with 3+ a middle division sends both ways, so movers never overlap and at least one stays.
  return k === 2 ? Math.max(1, Math.floor(min / 2)) : Math.max(1, Math.floor((min - 1) / 2));
}

export const moveOf = L => (L.divisions.length <= 1 ? 0 : optClamp(L.move, 0, maxMoveFor(L.divisions), 1));

function names(input) {
  const seen = new Set(), out = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const p = cleanName(raw);
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase()); out.push(p);
  }
  return out;
}

// The entries of a new league or ladder, strongest first. Singles: each player. Doubles: teams from `input.teams` (the organizer's own
// pairs) or drawn strongest with weakest by rating. ratings is { name: Dink Rating } read on the server.
function makeEntries(input, mode, ratings) {
  const players = names(input.players);
  if (players.length > MAX_ENTRIES * (mode === 'doubles' ? 2 : 1)) throw bad(`At most ${MAX_ENTRIES} ${mode === 'doubles' ? 'teams' : 'players'} can join.`);
  if (mode === 'singles') {
    if (players.length < MIN_PER_DIVISION) throw bad(`Pick at least ${MIN_PER_DIVISION} players.`);
    const r = ratings || {};
    const rows = players.map((p, i) => ({ t: [p], i, r: Number.isFinite(r[p]) ? r[p] : 0 })).sort((a, b) => b.r - a.r || a.i - b.i);
    return { entries: rows.map(x => x.t), seeds: rows.map(x => Math.round(x.r * 100) / 100) };
  }
  if (players.length < 2 * MIN_PER_DIVISION) throw bad(`Doubles needs at least ${MIN_PER_DIVISION} teams (${2 * MIN_PER_DIVISION} players).`);
  const teams = pairTeams(players, { how: input.teams ? 'manual' : 'auto', ratings, teams: input.teams });
  const s = seedTeams(teams, ratings || {});
  return { entries: s.teams, seeds: s.seeds };
}

const base = (input, kind, now, rand) => {
  const name = cleanName(input && input.name);
  if (!name) throw bad('Give it a name.');
  const mode = input.mode === 'singles' ? 'singles' : 'doubles';
  return {
    v: 1, id: 'l' + now.toString(36) + Math.floor(rand() * 46656).toString(36).padStart(3, '0'), kind, name,
    season: cleanName(input.season) || 'Season 1', mode, status: 'live',
    target: [11, 15, 21].includes(Number(input.target)) ? Number(input.target) : 11,
    scoring: input.scoring === 'rally' ? 'rally' : 'sideout', winBy: Number(input.winBy) === 1 ? 1 : 2,
    resultsBy: input.resultsBy === 'club' ? 'club' : 'players', createdAt: now, updatedAt: now
  };
};

// ---------- league ----------

// Splits entries (strongest first) into `count` divisions of near-equal size, the strongest in Division A.
function divide(entryCount, count) {
  const k = clamp(count, 1, MAX_DIVISIONS, 1);
  if (entryCount < MIN_PER_DIVISION * k) throw bad(`${entryCount} ${entryCount === 1 ? 'entry is' : 'entries are'} too few for ${k} division${k === 1 ? '' : 's'}: each needs at least ${MIN_PER_DIVISION}.`);
  const out = [];
  let at = 0;
  for (let d = 0; d < k; d++) {
    const size = Math.floor(entryCount / k) + (d < entryCount % k ? 1 : 0);
    out.push({ label: k === 1 ? 'League' : divisionLabel(d), entries: Array.from({ length: size }, (_, i) => at + i) });
    at += size;
  }
  return out;
}

// Every division plays a round robin, `legs` times over (a second leg swaps who is listed first). Week n holds round n of every division.
function schedule(L) {
  const rounds = L.divisions.map(dv => {
    const one = roundRobin(dv.entries.length, 1 << 10);
    const all = one.slice();
    if (L.legs === 2) for (const r of one) all.push(r.map(([a, b]) => [b, a]));
    return all;
  });
  const weeks = Math.max(...rounds.map(r => r.length));
  L.weeks = Array.from({ length: weeks }, (_, w) => {
    const matches = [];
    rounds.forEach((r, d) => (r[w] || []).forEach(([a, b], i) => {
      const dv = L.divisions[d];
      matches.push({ id: `w${w + 1}d${d}m${i + 1}`, division: d, teams: [L.entries[dv.entries[a]], L.entries[dv.entries[b]]], score: null, status: 'pending' });
    }));
    return { n: w + 1, title: `Week ${w + 1}`, matches };
  });
  return L;
}

export function createLeague(input, ratings = {}, now = Date.now(), rand = Math.random) {
  if (!input || typeof input !== 'object') throw bad('League details are missing.');
  const L = base(input, 'league', now, rand);
  const { entries, seeds } = makeEntries(input, L.mode, ratings);
  const divisions = divide(entries.length, input.divisions);
  const move = divisions.length > 1 ? optClamp(input.move, 0, maxMoveFor(divisions), 1) : 0;
  const tiebreak = cleanTiebreak(input.tiebreak);
  Object.assign(L, { legs: Number(input.legs) === 2 ? 2 : 1, entries, seeds, divisions, move, tiebreak, champions: null });
  return schedule(L);
}

export const allMatches = L => L.weeks.flatMap(w => w.matches);

// Where and when a match is played: its own date if the organizer moved it, else the week's. court is null until one is given.
export const slotOf = (w, m) => (m.date ? { date: m.date, time: m.time || null, moved: true, court: m.court || null } : { date: w.date || null, time: w.time || null, moved: false, court: m.court || null });

// Who rests in a week. A division with an odd number of entries leaves one out of every round (the round robin's rest slot); a division
// with an even number never rests anyone, and one that has played all its rounds is just finished, not resting.
export function weekByes(L, w) {
  const out = [];
  L.divisions.forEach((dv, d) => {
    const n = dv.entries.length;
    if (n % 2 === 0 || w.n > n * (L.legs || 1)) return;
    const playing = new Set(w.matches.filter(m => m.division === d).flatMap(m => m.teams.map(keyOf)));
    for (const i of dv.entries) if (!playing.has(keyOf(L.entries[i]))) out.push({ division: d, members: L.entries[i] });
  });
  return out;
}

// Partitions a tied group by `rules` in order (each of 'diff', 'pf', 'h2h'), falling back to alphabetical name.
// For 'h2h': considers scored matches exclusively among entries in `group`; applies only once every pair in `group` has met,
// ranking by head-to-head win rate (exact integer cross-multiplication). If 'h2h' splits `group` into smaller sub-groups,
// each sub-group re-checks 'h2h' (strictly smaller, so guaranteed to terminate) before moving to the remaining rules.
function bucketBy(list, cmp) {
  const sorted = list.slice().sort(cmp), out = [];
  for (const r of sorted) {
    if (!out.length || cmp(out[out.length - 1][0], r) !== 0) out.push([r]);
    else out[out.length - 1].push(r);
  }
  return out;
}

function rankGroup(group, rules, matches) {
  if (group.length <= 1) return group;
  if (!rules.length) return group.slice().sort((a, b) => a.name.localeCompare(b.name));
  const [rule, ...rest] = rules;
  if (rule === 'diff' || rule === 'pf') {
    return bucketBy(group, (a, b) => b[rule] - a[rule]).flatMap(b => rankGroup(b, rest, matches));
  }
  if (rule === 'h2h') {
    const ids = new Set(group.map(r => r.id)), stat = new Map(group.map(r => [r.id, { w: 0, p: 0 }])), pairs = new Set();
    for (const m of matches) {
      if (!m || !m.score || !m.teams) continue;
      const a = teamId(m.teams[0]), b = teamId(m.teams[1]);
      if (a === b || !ids.has(a) || !ids.has(b)) continue;
      pairs.add(a < b ? a + '\0' + b : b + '\0' + a);
      stat.get(a).p++; stat.get(b).p++;
      if (m.score[0] > m.score[1]) stat.get(a).w++; else if (m.score[1] > m.score[0]) stat.get(b).w++;
    }
    if (pairs.size < (group.length * (group.length - 1)) / 2) return rankGroup(group, rest, matches);
    const cmp = (x, y) => { const sx = stat.get(x.id), sy = stat.get(y.id); return sy.w * sx.p - sx.w * sy.p; };
    const buckets = bucketBy(group, cmp);
    if (buckets.length === 1) return rankGroup(group, rest, matches);
    return buckets.flatMap(b => rankGroup(b, rules, matches));
  }
  return rankGroup(group, rest, matches);
}

export function divisionTable(L, d) {
  const dv = L.divisions[d];
  const rows = dv.entries.map(i => ({ id: teamId(L.entries[i]), name: L.entries[i].join(' & '), members: L.entries[i] }));
  const byId = new Map(rows.map(r => [r.id, r.members]));
  const played = allMatches(L).filter(m => m.division === d && m.score);
  const baseRows = standings(rows, played, { by: 'team' }).map(r => ({ ...r, members: byId.get(r.id) }));
  const rules = tiebreakOf(L);
  const ordered = bucketBy(baseRows, (a, b) => b.wins - a.wins).flatMap(g => rankGroup(g, rules, played));
  return ordered.map((r, i) => ({ ...r, rank: i + 1 }));
}

// Where a match's players may be named: any of the four (or two) players in the match.
export const findMatch = (L, id) => {
  if (L.kind === 'league') { const m = allMatches(L).find(x => x.id === id); return m ? { match: m, teams: m.teams } : null; }
  const r = L.results.find(x => x.id === id);
  return r ? { match: r, teams: r.teams } : null;
};

// Who may enter a result. actor: { organizer, name: lower-cased claimed player name or null }. Organizers always may; a player may for a
// match they are in; any club member only if the organizer allowed it.
export function checkResultActor(L, teams, actor) {
  if (actor && actor.organizer) return;
  if (L.resultsBy === 'club') return;
  if (actor && actor.name && teams.some(t => t.some(p => p.toLowerCase() === actor.name))) return;
  throw bad(actor && actor.name
    ? 'Only the players in this match or an organizer can enter its result.'
    : "Only the players in this match or an organizer can enter its result, and this phone hasn't proved which player it belongs to.", 403);
}

const extraOf = (L, id, p, now) => {
  const endedAt = Math.min(now + 864e5, Math.max(Date.UTC(2015, 0, 1), Math.trunc(Number(p.endedAt)) || now));
  return { startedAt: Math.min(endedAt, Math.trunc(Number(p.startedAt)) || endedAt), endedAt, rallies: clamp(p.rallies, 0, 999, 0), live: !!p.live, gameId: `${L.id}-${id}` };
};

export function gameFor(L, m) {
  if (!m || m.status === 'pending' || !m.score || m.forfeit) return null; // a forfeit was never played: it must not reach the ratings
  return { id: m.gameId || `${L.id}-${m.id}`, mode: L.mode, teams: m.teams, score: m.score, scoring: L.scoring, target: L.target, winBy: L.winBy,
    rallies: m.rallies || 0, startedAt: m.startedAt, endedAt: m.endedAt, logged: !m.live };
}

export function settle(L, now) {
  L.updatedAt = now;
  if (L.kind !== 'league') return;
  const done = allMatches(L).every(m => m.status === 'done');
  L.status = done ? 'done' : 'live';
  L.champions = done ? L.divisions.map((_, d) => (divisionTable(L, d)[0] || {}).members || null) : null;
}

// Records a played league match. payload: { score: [a, b], startedAt?, endedAt?, rallies?, live? }. Sending the same score again is fine
// (a phone retrying); a different score for a played match is refused. `actor` is who is sending it (see checkResultActor).
// Returns { league, match, game, changed }.
export function recordLeagueResult(L, matchId, payload, now = Date.now(), actor = null) {
  if (L.kind !== 'league') throw bad('That is a ladder: record a challenge instead.', 409);
  const found = findMatch(L, matchId);
  if (!found) throw bad('That match is not in this league.', 404);
  const score = checkScore(payload && payload.score), m = found.match;
  checkResultActor(L, found.teams, actor);
  if (m.forfeit) throw bad('That match was settled by a forfeit. An organizer can undo it.', 409);
  if (m.status === 'done') {
    if (m.score[0] === score[0] && m.score[1] === score[1]) return { league: L, match: m, game: gameFor(L, m), changed: false };
    throw bad('That match was already scored. An organizer can correct it.', 409);
  }
  if (L.status === 'done') throw bad('This season is finished.', 409);
  Object.assign(m, extraOf(L, m.id, payload || {}, now), { score, status: 'done', winner: score[0] > score[1] ? 0 : 1 });
  settle(L, now);
  return { league: L, match: m, game: gameFor(L, m), changed: true };
}

// An organizer fixing a played match or challenge result.
export function correctLeagueResult(L, matchId, score, now = Date.now()) {
  const found = findMatch(L, matchId);
  if (!found || found.match.status === 'pending') throw bad('That match has not been played.', 409);
  if (found.match.forfeit) throw bad('That match was a forfeit. Undo the forfeit before entering a score.', 409);
  const s = checkScore(score);
  Object.assign(found.match, { score: s, winner: s[0] > s[1] ? 0 : 1, status: 'done' });
  settle(L, now);
  return { league: L, match: found.match, game: gameFor(L, found.match) };
}

export function endSeason(L, now = Date.now()) {
  if (L.kind === 'ladder') return closeLadderSeason(L, undefined, now);
  if (L.status === 'done') throw bad('This season is already finished.', 409);
  L.status = 'done'; L.updatedAt = now;
  L.champions = L.divisions.map((_, d) => (divisionTable(L, d).find(r => r.played) || {}).members || null);
  return L;
}

// The next season of a finished league: the same entries, the top of each division moving up and the bottom moving down
// (`move` places each way, default 1). One division just plays again. Returns a new league; the old one is left as it is.
export function nextSeason(prev, input = {}, now = Date.now(), rand = Math.random) {
  if (prev.kind !== 'league') throw bad('Ladders keep going: close the season instead.', 409);
  if (prev.status !== 'done') throw bad('Finish this season first.', 409);
  const k = prev.divisions.length;
  const tables = prev.divisions.map((_, d) => divisionTable(prev, d).map(r => r.members));
  const maxMove = maxMoveFor(prev.divisions);
  const move = k === 1 ? 0 : optClamp(input.move, 0, maxMove, moveOf(prev));
  // The top `move` of each division go up one, the bottom `move` go down one; everyone else stays. Every division keeps its size.
  const next = tables.map(() => []);
  tables.forEach((t, d) => t.forEach((m, i) => next[i < move && d > 0 ? d - 1 : i >= t.length - move && d < k - 1 ? d + 1 : d].push(m)));
  const L = base({ ...prev, season: input.season || nextLabel(prev.season) }, 'league', now, rand);
  L.legs = prev.legs; L.move = move; L.previous = prev.id;
  if (input.tiebreak !== undefined) L.tiebreak = cleanTiebreak(input.tiebreak); else if (prev.tiebreak) L.tiebreak = prev.tiebreak;
  L.history = [...(prev.history || []), archive(prev)].slice(-MAX_HISTORY);
  L.entries = next.flat(); L.seeds = L.entries.map(() => null);
  let at = 0;
  L.divisions = next.map((t, d) => { const e = { label: prev.divisions[d].label, entries: t.map((_, i) => at + i) }; at += t.length; return e; });
  L.champions = null;
  return schedule(L);
}

// What a finished season leaves behind for the history view: the final table of every division (names only inside `members` arrays, so
// rename and anonymise reach them). Each season carries the ones before it, so no lookup of older rows is needed.
export const MAX_HISTORY = 20;
const archive = prev => ({ id: prev.id, season: prev.season, endedAt: prev.updatedAt,
  divisions: prev.divisions.map((dv, d) => ({ label: dv.label, rows: divisionTable(prev, d).map(r => ({ members: r.members, played: r.played, wins: r.wins, losses: r.losses, diff: r.diff })) })) });

const nextLabel = s => { const m = String(s || '').match(/^(.*?)(\d+)$/); return m ? m[1] + (Number(m[2]) + 1) : (String(s || 'Season') + ' 2').slice(0, 40); };

// ---------- ladder ----------

export function createLadder(input, ratings = {}, now = Date.now(), rand = Math.random) {
  if (!input || typeof input !== 'object') throw bad('Ladder details are missing.');
  const L = base(input, 'ladder', now, rand);
  const { entries, seeds } = makeEntries(input, L.mode, ratings);
  Object.assign(L, { entries, seeds, jump: clamp(input.jump, 1, 10, 3), decayDays: clamp(input.decayDays, 0, MAX_DECAY_DAYS, 0), since: now, results: [], seasons: [] });
  return L;
}

// Everyone's place, best first, as entry indexes: the starting order (strongest first) with every challenge replayed. A challenger who wins
// takes the defender's place and everyone between moves down one; a defender who wins changes nothing.
// Inactivity decay (optional, `decayDays` > 0): an entry that has not played a challenge (either side) for that many days drops one place,
// and one more for every further stretch of that length, until it plays again. Replayed from the results' times and the clock, so nothing
// is stored and a corrected score re-sorts everything. Never below last; an entry moved up because the one above fell starts a fresh
// stretch. `since` is when the season began (older ladders fall back to createdAt, and have decayDays undefined = off).
export const MAX_DECAY_DAYS = 365;
const DAY = 86400000;
function replay(L, now) {
  const order = L.entries.map((_, i) => i), step = (L.decayDays | 0) * DAY;
  const last = L.entries.map(() => L.since || L.createdAt || 0);
  const decayTo = t => {
    for (let guard = 0; guard < 10000; guard++) {
      let pick = -1, due = Infinity;
      order.forEach((i, p) => { const d = last[i] + step; if (p < order.length - 1 && d <= t && d < due) { due = d; pick = i; } });
      if (pick < 0) return;
      const p = order.indexOf(pick), up = order[p + 1];
      order[p] = up; order[p + 1] = pick; last[pick] = due; last[up] = Math.max(last[up], due);
    }
  };
  for (const r of L.results) {
    if (step) decayTo(r.at);
    if (r.winner === 0) {
      const from = order.indexOf(r.c), to = order.indexOf(r.d);
      if (from > to) { order.splice(from, 1); order.splice(to, 0, r.c); }
    }
    last[r.c] = last[r.d] = r.at;
  }
  if (step && now != null) decayTo(now);
  return { order, last, step };
}

export const ladderOrder = (L, now = null) => replay(L, now).order;

export function ladderRows(L, now = null) {
  const { order, last, step } = replay(L, now), stat = L.entries.map(() => ({ played: 0, wins: 0 }));
  for (const r of L.results) { stat[r.c].played++; stat[r.d].played++; stat[r.winner === 0 ? r.c : r.d].wins++; }
  return order.map((i, p) => ({ rank: p + 1, index: i, members: L.entries[i], name: L.entries[i].join(' & '), played: stat[i].played, wins: stat[i].wins, losses: stat[i].played - stat[i].wins,
    dropsAt: step && p < order.length - 1 ? last[i] + step : null })); // when the next idle drop is due (null: decay off, or already last)
}

// Who the entry at `index` may challenge: up to `jump` places above, never themselves.
export function challengeable(L, index, now = null) {
  const order = ladderOrder(L, now), at = order.indexOf(index);
  return order.slice(Math.max(0, at - L.jump), Math.max(0, at));
}

const entryAt = (L, names_) => {
  const list = Array.isArray(names_) ? names_ : [names_];
  const k = keyOf(list.map(cleanName));
  const i = L.entries.findIndex(e => keyOf(e) === k);
  if (i < 0) throw bad(`${list.map(String).join(' & ').slice(0, 60)} is not on this ladder.`);
  return i;
};

// A challenge result. payload: { key (a fresh id from the phone, so a retry is not counted twice), challenger, defender, score: [challenger, defender], ... }
export function recordChallenge(L, payload, now = Date.now(), actor = null) {
  if (L.kind !== 'ladder') throw bad('That is a league: score a league match instead.', 409);
  if (L.status === 'done') throw bad('This ladder is closed.', 409);
  const id = String((payload && payload.key) || '');
  if (!/^[A-Za-z0-9_-]{4,24}$/.test(id)) throw bad('A result needs a key of 4 to 24 letters or numbers.');
  const score = checkScore(payload.score);
  const c = entryAt(L, payload.challenger), d = entryAt(L, payload.defender);
  if (c === d) throw bad('A player cannot challenge themselves.');
  checkResultActor(L, [L.entries[c], L.entries[d]], actor);
  const old = L.results.find(r => r.id === id);
  if (old) {
    if (old.c === c && old.d === d && old.score[0] === score[0] && old.score[1] === score[1]) return { league: L, match: old, game: gameFor(L, old), changed: false };
    throw bad('That result key was already used for a different result.', 409);
  }
  const order = ladderOrder(L, now), pc = order.indexOf(c), pd = order.indexOf(d);
  if (pd > pc) throw bad('You can only challenge someone above you on the ladder.', 409);
  if (pc - pd > L.jump) throw bad(`You can challenge up to ${L.jump} place${L.jump === 1 ? '' : 's'} above you.`, 409);
  if (L.results.length >= 2000) throw bad('This ladder has reached its limit of results. Close the season to start fresh.', 409);
  const r = { id, teams: [L.entries[c], L.entries[d]], c, d, score, winner: score[0] > score[1] ? 0 : 1, ...extraOf(L, id, payload, now), at: now };
  if (L.results.length && r.at < L.results[L.results.length - 1].at) r.at = L.results[L.results.length - 1].at; // the replay needs results in time order
  L.results.push(r);
  L.open = liveOpen(L, now).filter(o => !(o.c === c && o.d === d)); // the played challenge settles the open one between the same two
  L.updatedAt = now;
  return { league: L, match: r, game: gameFor(L, r), changed: true };
}

// Open challenges (optional step before a result): L.open = [{ id, c, d, at, expiresAt, state: 'open' | 'accepted' }], entry indexes only (so rename and
// anonymise need nothing). A challenge waits CHALLENGE_DAYS for the defender, and CHALLENGE_DAYS more once accepted; then it lapses with no effect
// (nothing is stored when it does: expired rows are filtered out when read and dropped on the next write). Playing the match still goes through
// recordChallenge, which also settles the open one. A ladder with no `open` array (made before this) simply has none.
export const CHALLENGE_DAYS = 7;
const MAX_OPEN = 30;
const liveOpen = (L, now) => (L.open || []).filter(o => o.expiresAt > now);
const isIn = (L, i, actor) => !!(actor && actor.name && L.entries[i].some(p => p.toLowerCase() === actor.name));

// payload: { key (fresh id, a retry is safe), challenger, defender }. Who: the challenger's own phone or an organizer (any member if resultsBy is 'club').
export function openChallenge(L, payload, now = Date.now(), actor = null) {
  if (L.kind !== 'ladder') throw bad('Only a ladder has challenges.', 409);
  if (L.status === 'done') throw bad('This ladder is closed.', 409);
  const id = String((payload && payload.key) || '');
  if (!/^[A-Za-z0-9_-]{4,24}$/.test(id)) throw bad('A challenge needs a key of 4 to 24 letters or numbers.');
  const c = entryAt(L, payload.challenger), d = entryAt(L, payload.defender);
  if (c === d) throw bad('A player cannot challenge themselves.');
  if (!(actor && actor.organizer) && L.resultsBy !== 'club' && !isIn(L, c, actor)) throw bad('Only the challenger or an organizer can send this challenge.', 403);
  const open = liveOpen(L, now), same = open.find(o => o.id === id || (o.c === c && o.d === d));
  if (same) {
    if (same.c === c && same.d === d) return { league: L, open: same, changed: false };
    throw bad('That challenge key was already used.', 409);
  }
  const order = ladderOrder(L, now), pc = order.indexOf(c), pd = order.indexOf(d);
  if (pd > pc) throw bad('You can only challenge someone above you on the ladder.', 409);
  if (pc - pd > L.jump) throw bad(`You can challenge up to ${L.jump} place${L.jump === 1 ? '' : 's'} above you.`, 409);
  if (open.length >= MAX_OPEN) throw bad('This ladder has too many open challenges. Answer or withdraw some first.', 409);
  const o = { id, c, d, at: now, expiresAt: now + CHALLENGE_DAYS * DAY, state: 'open' };
  L.open = [...open, o]; L.updatedAt = now;
  return { league: L, open: o, changed: true };
}

// answer: 'accept' | 'decline' (the defender or an organizer) | 'withdraw' (the challenger or an organizer). Decline and withdraw remove it.
export function answerChallenge(L, id, answer, now = Date.now(), actor = null) {
  if (L.kind !== 'ladder') throw bad('Only a ladder has challenges.', 409);
  if (!['accept', 'decline', 'withdraw'].includes(answer)) throw bad('Pick accept, decline or withdraw.');
  const open = liveOpen(L, now), o = open.find(x => x.id === String(id));
  if (!o) throw bad('That challenge is no longer open: it was answered, played or ran out.', 404);
  const who = answer === 'withdraw' ? o.c : o.d;
  if (!(actor && actor.organizer) && L.resultsBy !== 'club' && !isIn(L, who, actor)) throw bad(answer === 'withdraw' ? 'Only the challenger or an organizer can withdraw it.' : 'Only the challenged player or an organizer can answer it.', 403);
  if (answer === 'accept') {
    if (o.state === 'accepted') return { league: L, open: o, changed: false };
    Object.assign(o, { state: 'accepted', expiresAt: now + CHALLENGE_DAYS * DAY });
    L.open = open;
  } else L.open = open.filter(x => x !== o);
  L.updatedAt = now;
  return { league: L, open: o, changed: true };
}

// Closes a ladder's season: keeps the final order, starts the next season from it with a clean list of results.
export function closeLadderSeason(L, label, now = Date.now()) {
  if (L.kind !== 'ladder') throw bad('Only a ladder has a season to close.', 409);
  if (L.seasons.length >= 50) throw bad('This ladder has 50 closed seasons already.', 409);
  const order = ladderOrder(L, now);
  L.seasons.push({ label: L.season, endedAt: now, order: order.map(i => L.entries[i]) });
  L.entries = order.map(i => L.entries[i]); L.seeds = L.entries.map(() => null);
  L.results = []; L.open = []; L.since = now; L.season = label || nextLabel(L.season); L.updatedAt = now;
  return L;
}

export function setResultsBy(L, who, now = Date.now()) {
  if (who !== 'players' && who !== 'club') throw bad('Pick who can enter results: the players in the match, or any club member.');
  L.resultsBy = who; L.updatedAt = now;
}

export function summary(L, now = Date.now()) {
  const out = { id: L.id, kind: L.kind, name: L.name, season: L.season, mode: L.mode, status: L.status, entries: L.entries.length, createdAt: L.createdAt, updatedAt: L.updatedAt };
  if (L.kind === 'league') {
    const all = allMatches(L);
    Object.assign(out, { divisions: L.divisions.length, played: all.filter(m => m.status === 'done').length, matches: all.length, champions: L.champions || null });
  } else {
    const rows = ladderRows(L, now);
    Object.assign(out, { top: rows[0] ? rows[0].members : null, results: L.results.length });
  }
  return out;
}

// The league as the app shows it: standings per division, or the ladder in order with who each entry may challenge.
export function view(L, now = Date.now()) {
  const out = clone(L);
  if (L.kind === 'league') {
    out.tiebreak = tiebreakOf(L);
    out.move = moveOf(L);
    out.maxMove = maxMoveFor(L.divisions);
    out.tables = L.divisions.map((dv, d) => ({ label: dv.label, rows: divisionTable(L, d) }));
    out.weeks.forEach((w, i) => { w.byes = weekByes(L, L.weeks[i]); w.matches.forEach((m, j) => { m.when = slotOf(L.weeks[i], L.weeks[i].matches[j]); }); });
    out.current = (L.weeks.find(w => w.matches.some(m => m.status === 'pending')) || {}).n || L.weeks.length;
    out.history = (L.history || []).slice().reverse(); // newest first; a league made before history existed starts with none
  } else {
    out.rows = ladderRows(L, now);
    out.rows.forEach(r => { r.canChallenge = challengeable(L, r.index, now).map(i => L.entries[i]); });
    out.results = out.results.slice(-30).reverse();
    out.open = liveOpen(L, now).map(o => ({ ...o, challenger: L.entries[o.c], defender: L.entries[o.d] })).sort((a, b) => a.at - b.at);
  }
  return out;
}
