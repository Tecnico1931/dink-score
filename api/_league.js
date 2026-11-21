// Leagues (divisions playing a season of round robin weeks) and ladders (challenge matches that move players up). Pure functions
// on a plain object, no database; the API stores it as one JSON document (see _leagues.js).
//
// league = {
//   v, id, kind: 'league' | 'ladder', name, season, mode: 'singles' | 'doubles', status: 'live' | 'done',
//   scoring, target, winBy, resultsBy: 'players' | 'club', createdAt, updatedAt,
//   entries: [[names]], seeds: [rating, ...],           // one entry per player (singles) or team (doubles), strongest first by Dink Rating when made
//   // league: divisions: [{ label, entries: [index] }], legs, weeks: [{ n, title, matches: [match] }], champions: [[names] per division]
//   // ladder: jump (how many places up a challenge may reach), results: [result], seasons: [{ label, endedAt, order: [[names]] }]
// }
// match  = { id, division, teams: [[a, b], [c, d]], score: null | [x, y], status: 'pending' | 'done', winner, startedAt, endedAt, rallies, live, gameId }
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
const keyOf = names => names.map(n => n.toLowerCase()).sort().join('|');

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
  Object.assign(L, { legs: Number(input.legs) === 2 ? 2 : 1, entries, seeds, divisions: divide(entries.length, input.divisions), champions: null });
  return schedule(L);
}

const allMatches = L => L.weeks.flatMap(w => w.matches);

export function divisionTable(L, d) {
  const dv = L.divisions[d];
  const rows = dv.entries.map(i => ({ id: teamId(L.entries[i]), name: L.entries[i].join(' & '), members: L.entries[i] }));
  const byId = new Map(rows.map(r => [r.id, r.members]));
  return standings(rows, allMatches(L).filter(m => m.division === d && m.score), { by: 'team' }).map(r => ({ ...r, members: byId.get(r.id) }));
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
  if (!m || m.status === 'pending' || !m.score) return null;
  return { id: m.gameId || `${L.id}-${m.id}`, mode: L.mode, teams: m.teams, score: m.score, scoring: L.scoring, target: L.target, winBy: L.winBy,
    rallies: m.rallies || 0, startedAt: m.startedAt, endedAt: m.endedAt, logged: !m.live };
}

function settle(L, now) {
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
  const maxMove = Math.max(1, Math.floor((Math.min(...tables.map(t => t.length)) - 1) / 2)); // top and bottom movers of one division never overlap
  const move = k === 1 ? 0 : clamp(input.move, 0, maxMove, 1);
  // The top `move` of each division go up one, the bottom `move` go down one; everyone else stays. Every division keeps its size.
  const next = tables.map(() => []);
  tables.forEach((t, d) => t.forEach((m, i) => next[i < move && d > 0 ? d - 1 : i >= t.length - move && d < k - 1 ? d + 1 : d].push(m)));
  const L = base({ ...prev, season: input.season || nextLabel(prev.season) }, 'league', now, rand);
  L.legs = prev.legs; L.previous = prev.id;
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
  Object.assign(L, { entries, seeds, jump: clamp(input.jump, 1, 10, 3), results: [], seasons: [] });
  return L;
}

// Everyone's place, best first, as entry indexes: the starting order (strongest first) with every challenge replayed. A challenger who wins
// takes the defender's place and everyone between moves down one; a defender who wins changes nothing.
export function ladderOrder(L) {
  const order = L.entries.map((_, i) => i);
  for (const r of L.results) {
    if (r.winner !== 0) continue;
    const from = order.indexOf(r.c), to = order.indexOf(r.d);
    if (from > to) { order.splice(from, 1); order.splice(to, 0, r.c); }
  }
  return order;
}

export function ladderRows(L) {
  const order = ladderOrder(L), stat = L.entries.map(() => ({ played: 0, wins: 0 }));
  for (const r of L.results) { stat[r.c].played++; stat[r.d].played++; stat[r.winner === 0 ? r.c : r.d].wins++; }
  return order.map((i, p) => ({ rank: p + 1, index: i, members: L.entries[i], name: L.entries[i].join(' & '), played: stat[i].played, wins: stat[i].wins, losses: stat[i].played - stat[i].wins }));
}

// Who the entry at `index` may challenge: up to `jump` places above, never themselves.
export function challengeable(L, index) {
  const order = ladderOrder(L), at = order.indexOf(index);
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
  const order = ladderOrder(L), pc = order.indexOf(c), pd = order.indexOf(d);
  if (pd > pc) throw bad('You can only challenge someone above you on the ladder.', 409);
  if (pc - pd > L.jump) throw bad(`You can challenge up to ${L.jump} place${L.jump === 1 ? '' : 's'} above you.`, 409);
  if (L.results.length >= 2000) throw bad('This ladder has reached its limit of results. Close the season to start fresh.', 409);
  const r = { id, teams: [L.entries[c], L.entries[d]], c, d, score, winner: score[0] > score[1] ? 0 : 1, ...extraOf(L, id, payload, now), at: now };
  L.results.push(r);
  L.updatedAt = now;
  return { league: L, match: r, game: gameFor(L, r), changed: true };
}

// Closes a ladder's season: keeps the final order, starts the next season from it with a clean list of results.
export function closeLadderSeason(L, label, now = Date.now()) {
  if (L.kind !== 'ladder') throw bad('Only a ladder has a season to close.', 409);
  if (L.seasons.length >= 50) throw bad('This ladder has 50 closed seasons already.', 409);
  const order = ladderOrder(L);
  L.seasons.push({ label: L.season, endedAt: now, order: order.map(i => L.entries[i]) });
  L.entries = order.map(i => L.entries[i]); L.seeds = L.entries.map(() => null);
  L.results = []; L.season = label || nextLabel(L.season); L.updatedAt = now;
  return L;
}

export function setResultsBy(L, who, now = Date.now()) {
  if (who !== 'players' && who !== 'club') throw bad('Pick who can enter results: the players in the match, or any club member.');
  L.resultsBy = who; L.updatedAt = now;
}

export function summary(L) {
  const out = { id: L.id, kind: L.kind, name: L.name, season: L.season, mode: L.mode, status: L.status, entries: L.entries.length, createdAt: L.createdAt, updatedAt: L.updatedAt };
  if (L.kind === 'league') {
    const all = allMatches(L);
    Object.assign(out, { divisions: L.divisions.length, played: all.filter(m => m.status === 'done').length, matches: all.length, champions: L.champions || null });
  } else {
    const rows = ladderRows(L);
    Object.assign(out, { top: rows[0] ? rows[0].members : null, results: L.results.length });
  }
  return out;
}

// The league as the app shows it: standings per division, or the ladder in order with who each entry may challenge.
export function view(L) {
  const out = clone(L);
  if (L.kind === 'league') {
    out.tables = L.divisions.map((dv, d) => ({ label: dv.label, rows: divisionTable(L, d) }));
    out.current = (L.weeks.find(w => w.matches.some(m => m.status === 'pending')) || {}).n || L.weeks.length;
    out.history = (L.history || []).slice().reverse(); // newest first; a league made before history existed starts with none
  } else {
    out.rows = ladderRows(L);
    out.rows.forEach(r => { r.canChallenge = challengeable(L, r.index).map(i => L.entries[i]); });
    out.results = out.results.slice(-30).reverse();
  }
  return out;
}
