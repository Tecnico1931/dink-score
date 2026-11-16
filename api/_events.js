// Events (tournaments and rotating-partner sessions): creating one, moving it through its rounds, recording results.
// Pure functions on a plain event object, no database. The API stores the object as one JSON document.
//
// event = {
//   id, name, format, partners, rotation, courts, target, scoring, winBy, seed, status, stage,
//   players: [names], teams: [[a, b], ...] | null,        // teams: fixed partners (round robin with fixed teams, brackets)
//   roundsPlanned, advance,                               // how many rounds, and how many teams a knockout takes
//   rounds: [{ n, title, status, matches: [match], byes: [names] }],   // round robin / pool play
//   bracket: null | { kind, size, count, teams, matches },              // knockout / elimination (see _bracket.js)
//   champion: null | [names], createdAt, updatedAt,
//   teamInfo: [{ players: [a, b], name, logo }], publicLogos   // optional team names and logos (from a sheet import); logos only reach the public page when publicLogos is true
// }
// A DUPR ID typed in a sheet is NOT part of the event: it is a private reference kept in its own column (events.refs).
// match = { id, court, teams: [[a, b], [c, d]], score: null | [x, y], status: 'pending' | 'done', winner, startedAt, endedAt, rallies, live, gameId }
import { cleanName } from './_names.js';
import { planRound, validateRound } from './_rotation.js';
import { pairTeams, roundRobin, standings, teamId } from './_schedule.js';
import * as B from './_bracket.js';
import { cleanLogoUrl, cleanDupr } from '../sheet-import.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const FORMATS = ['roundrobin', 'pool_knockout', 'single_elim', 'double_elim'];
export const MAX_PLAYERS = 32;
export const MAX_COURTS = 8;
const clamp = (v, lo, hi, d) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const clone = x => JSON.parse(JSON.stringify(x));

export function createEvent(input, now = Date.now(), rand = Math.random) {
  if (!input || typeof input !== 'object') throw bad('Event details are missing.');
  const name = cleanName(input.name);
  if (!name) throw bad('Give the event a name.');
  const format = FORMATS.includes(input.format) ? input.format : null;
  if (!format) throw bad('Pick a format.');
  const elimination = format === 'single_elim' || format === 'double_elim';
  const partners = elimination || input.partners === 'fixed' ? 'fixed' : 'rotating';
  const rotation = ['auto', 'random', 'manual'].includes(input.rotation) ? input.rotation : 'auto';
  const seen = new Set(), players = [];
  for (const raw of Array.isArray(input.players) ? input.players : []) {
    const p = cleanName(raw);
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase()); players.push(p);
  }
  if (players.length > MAX_PLAYERS) throw bad(`An event holds at most ${MAX_PLAYERS} players.`);
  if (players.length < 4) throw bad('Pick at least 4 players for doubles.');
  const courts = clamp(input.courts, 1, MAX_COURTS, 1);
  const ev = {
    v: 1,
    id: 'e' + now.toString(36) + Math.floor(rand() * 46656).toString(36).padStart(3, '0'),
    name, format, partners, rotation, courts,
    target: [11, 15, 21].includes(Number(input.target)) ? Number(input.target) : 11,
    scoring: input.scoring === 'rally' ? 'rally' : 'sideout',
    winBy: Number(input.winBy) === 1 ? 1 : 2,
    seed: String(input.seed || now),
    status: 'live', stage: 'pool',
    players, teams: null, roundsPlanned: 0, advance: 0,
    rounds: [], bracket: null, champion: null, poolDone: false,
    resultsBy: input.resultsBy === 'club' ? 'club' : 'players', // who may enter results: the players in the match (and organizers), or any club member
    createdAt: now, updatedAt: now
  };
  if (partners === 'fixed') {
    ev.teams = pairTeams(players, { how: rotation, seed: ev.seed, ratings: input.ratings, teams: input.teams });
    if (elimination && ev.teams.length < (format === 'double_elim' ? 3 : 2)) throw bad('Double elimination needs at least 3 teams (6 players).');
    // Names and logos only make sense for the organizer's own pairs: they are matched to the teams one for one.
    if (rotation === 'manual' && Array.isArray(input.teamMeta)) {
      ev.teamInfo = buildTeamInfo(ev.teams, input.teamMeta);
      ev.publicLogos = input.publicLogos !== false;
    }
  }
  if (elimination) {
    startBracket(ev, ev.teams, format === 'double_elim' ? 'double' : 'single');
    return ev;
  }
  if (partners === 'fixed') {
    const plan = roundRobin(ev.teams.length, courts);
    ev.rounds = plan.map((pairs, i) => makeRound(i + 1, 'live', pairs.map(([a, b], k) => ({ court: k + 1, teams: [ev.teams[a], ev.teams[b]] })), players));
    ev.roundsPlanned = ev.rounds.length;
  } else {
    ev.roundsPlanned = clamp(input.rounds, 1, 30, Math.min(15, Math.max(3, players.length - 1)));
  }
  if (format === 'pool_knockout') {
    const teamCount = partners === 'fixed' ? ev.teams.length : Math.floor(players.length / 2);
    if (teamCount < 4) throw bad('Pool play and knockout needs at least 8 players, so there are 4 teams to take through.');
    ev.advance = clamp(input.advance, 2, Math.min(16, teamCount), Math.min(4, teamCount));
  }
  if (partners === 'rotating') startNextRound(ev, now);
  return ev;
}

// Team names and logos, one entry per team in the same order as teams. Returns [] when nothing was named.
function buildTeamInfo(teams, meta) {
  if (meta.length !== teams.length) throw bad('The team names do not match the teams.');
  const out = [];
  meta.forEach((m, i) => {
    const name = cleanName(m && m.name);
    const logo = cleanLogoUrl(m && m.logo);
    if (logo.error) throw bad(`${name || teams[i].join(' & ')}: ${logo.error}`);
    if (name || logo.value) out.push({ players: teams[i].slice(), name, logo: logo.value });
  });
  return out;
}

// Reference DUPR IDs from an import: { player name: ID } for players of this event only. Kept out of the event itself
// (see events.refs in api/events.js) so no event view, spectator page or export can include them.
export function cleanRefs(input, players) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const byLower = new Map(players.map(p => [p.toLowerCase(), p]));
  for (const [name, raw] of Object.entries(input)) {
    const p = byLower.get(cleanName(name).toLowerCase());
    if (!p) continue;
    const d = cleanDupr(raw);
    if (d.error) throw bad(`${p}: ${d.error}`);
    if (d.value) out[p] = d.value;
  }
  return out;
}

// Looks a team up by its players (order does not matter); { name, logo } or null.
export const teamKey = t => t.slice().sort().join('|');
const infoMap = ev => new Map((ev.teamInfo || []).map(i => [teamKey(i.players), i]));

const makeRound = (n, status, matches, players) => {
  const ms = matches.map((m, i) => ({ id: `r${n}m${i + 1}`, court: m.court || i + 1, teams: m.teams, score: null, status: 'pending' }));
  const playing = new Set(ms.flatMap(m => m.teams.flat()));
  return { n, title: `Round ${n}`, status, matches: ms, byes: players.filter(p => !playing.has(p)) };
};

function startBracket(ev, teams, kind) {
  const b = B.build(teams.length, kind);
  ev.bracket = B.assignCourts({ ...b, teams: clone(teams) }, ev.courts);
  ev.stage = 'knockout';
  settleBracket(ev);
}

// Rounds of a rotating-partner event are made one at a time, from everything played so far, so a hand-edited round
// is taken into account by the next one. Manual events get a suggested round for the organizer to change and publish.
export function startNextRound(ev, now = Date.now()) {
  if (ev.partners !== 'rotating' || ev.stage !== 'pool') throw bad('This event schedules its rounds up front.', 409);
  if (ev.status === 'done') throw bad('This event is finished.', 409);
  if (ev.rounds.length >= ev.roundsPlanned) throw bad('Every round has been planned.', 409);
  if (ev.rounds.some(r => r.status !== 'done')) throw bad('Finish the current round first.', 409);
  const history = ev.rounds.map(r => ({ matches: r.matches.map(m => ({ teams: m.teams })), byes: r.byes }));
  const plan = planRound({ players: ev.players, courts: ev.courts, history, mode: ev.rotation === 'random' ? 'random' : 'auto', seed: ev.seed });
  ev.rounds.push(makeRound(ev.rounds.length + 1, ev.rotation === 'manual' ? 'draft' : 'live', plan.matches, ev.players));
  ev.updatedAt = now;
  return ev;
}

const roundOf = (ev, n) => {
  const r = ev.rounds.find(x => x.n === Number(n));
  if (!r) throw bad('That round does not exist.', 404);
  return r;
};

// Replaces the pairings of a round nobody has scored yet (any rotating-partner round, whatever the rotation mode).
export function setRound(ev, n, matches, now = Date.now()) {
  if (ev.partners !== 'rotating') throw bad('Teams are fixed in this event.', 409);
  const r = roundOf(ev, n);
  if (r.status === 'done' || r.matches.some(m => m.score)) throw bad('That round already has scores, so its pairings are locked.', 409);
  const clean = validateRound({ players: ev.players, courts: ev.courts, matches });
  const fresh = makeRound(r.n, r.status, clean.matches, ev.players);
  r.matches = fresh.matches; r.byes = fresh.byes;
  ev.updatedAt = now;
  return ev;
}

export function publishRound(ev, n, now = Date.now()) {
  const r = roundOf(ev, n);
  if (r.status !== 'draft') throw bad('That round is already open.', 409);
  r.status = 'live';
  ev.updatedAt = now;
  return ev;
}

const allRoundMatches = ev => ev.rounds.flatMap(r => r.matches);
export function findMatch(ev, id) {
  const m = allRoundMatches(ev).find(x => x.id === id);
  if (m) return { kind: 'round', match: m, round: ev.rounds.find(r => r.matches.includes(m)) };
  const bm = ev.bracket && ev.bracket.matches.find(x => x.id === id);
  return bm ? { kind: 'bracket', match: bm } : null;
}

// The four players of a match, as [[a, b], [c, d]], or null for a side that isn't known yet.
export function matchTeams(ev, m) {
  if (m.teams) return m.teams;
  return m.slots.map(s => (s >= 0 ? ev.bracket.teams[s] : null));
}

// Who may enter a result. actor: { organizer: bool, name: lower-cased claimed player name or null }. Organizers always may; a
// player may for a match they are in; any club member may only if the organizer allowed it. Events from before this setting
// count as 'players'. Throws a 403 with text for the person.
export function checkResultActor(ev, matchId, actor) {
  if (actor && actor.organizer) return;
  if (ev.resultsBy === 'club') return;
  const found = findMatch(ev, matchId);
  if (!found) throw bad('That match is not in this event.', 404);
  const mine = actor && actor.name && matchTeams(ev, found.match).some(t => t && t.some(p => p.toLowerCase() === actor.name));
  if (mine) return;
  throw bad(actor && actor.name
    ? 'Only the players in this match or an organizer can enter its result. Ask an organizer, or ask them to let any club member score.'
    : "Only the players in this match or an organizer can enter its result, and this phone hasn't proved which player it belongs to. Join the club as that player on this phone, or ask an organizer.", 403);
}

export function setResultsBy(ev, who, now = Date.now()) {
  if (who !== 'players' && who !== 'club') throw bad('Pick who can enter results: the players in the match, or any club member.', 400);
  ev.resultsBy = who; ev.updatedAt = now;
}

// Records a finished match. payload: { score: [a, b], startedAt?, endedAt?, rallies?, live? }.
// Sending the same score again is fine (a phone retrying); a different score for a played match is refused.
// Returns { event, match, game, changed } where game is what belongs in the club's record.
export function recordResult(ev, matchId, payload, now = Date.now()) {
  const found = findMatch(ev, matchId);
  if (!found) throw bad('That match is not in this event.', 404);
  const score = B.checkScore(payload && payload.score);
  const m = found.match;
  if (m.status === 'done') {
    if (m.score[0] === score[0] && m.score[1] === score[1]) return { event: ev, match: m, game: gameFor(ev, m), changed: false };
    throw bad('That match was already scored. An organizer can correct it.', 409);
  }
  if (ev.status === 'done') throw bad('This event is finished.', 409);
  const endedAt = Math.min(now + 864e5, Math.max(Date.UTC(2015, 0, 1), Math.trunc(Number(payload.endedAt)) || now));
  const startedAt = Math.min(endedAt, Math.trunc(Number(payload.startedAt)) || endedAt);
  const extra = { startedAt, endedAt, rallies: clamp(payload.rallies, 0, 999, 0), live: !!payload.live, gameId: `${ev.id}-${m.id}` };
  if (found.kind === 'round') {
    if (found.round.status !== 'live') throw bad('That round has not been opened yet.', 409);
    Object.assign(m, extra, { score, status: 'done', winner: score[0] > score[1] ? 0 : 1 });
    if (found.round.matches.every(x => x.status === 'done')) found.round.status = 'done';
  } else {
    ev.bracket = B.advance(ev.bracket, m.id, score);
    Object.assign(ev.bracket.matches.find(x => x.id === m.id), extra);
    settleBracket(ev);
  }
  afterChange(ev, now);
  const now_m = findMatch(ev, matchId).match;
  return { event: ev, match: now_m, game: gameFor(ev, now_m), changed: true };
}

// An organizer fixing a played match's score.
export function correctResult(ev, matchId, score, now = Date.now()) {
  const found = findMatch(ev, matchId);
  if (!found || found.match.status !== 'done') throw bad('That match has not been played.', 409);
  const s = B.checkScore(score);
  if (found.kind === 'round') {
    Object.assign(found.match, { score: s, winner: s[0] > s[1] ? 0 : 1 });
  } else {
    ev.bracket = B.correct(ev.bracket, matchId, s);
    settleBracket(ev);
  }
  afterChange(ev, now);
  const m = findMatch(ev, matchId).match;
  return { event: ev, match: m, game: gameFor(ev, m) };
}

function settleBracket(ev) {
  ev.bracket = B.assignCourts(ev.bracket, ev.courts);
}

function afterChange(ev, now) {
  ev.updatedAt = now;
  if (ev.bracket) {
    const c = B.champion(ev.bracket);
    ev.champion = c === null ? null : ev.bracket.teams[c];
    ev.status = c === null ? 'live' : 'done';
    return;
  }
  const finished = ev.rounds.length >= ev.roundsPlanned && ev.rounds.every(r => r.status === 'done');
  if (ev.format === 'pool_knockout') { ev.poolDone = finished; return; }
  ev.status = finished ? 'done' : 'live';
  ev.champion = finished ? ((standingsFor(ev)[0] || {}).members || null) : null;
}

// Pool play is finished: take the top of the table into a single elimination bracket. Rotating-partner events pair the
// best with the weakest of the top players, so the new teams are even; the strongest team is seed 1.
export function startKnockout(ev, advance, now = Date.now()) {
  if (ev.format !== 'pool_knockout') throw bad('This event has no knockout stage.', 409);
  if (ev.bracket) throw bad('The knockout has already started.', 409);
  if (!ev.poolDone) throw bad('Finish pool play first.', 409);
  const table = standingsFor(ev);
  const k = clamp(advance, 2, Math.min(16, ev.partners === 'fixed' ? ev.teams.length : Math.floor(ev.players.length / 2)), ev.advance);
  let teams;
  if (ev.partners === 'fixed') {
    teams = table.slice(0, k).map(row => ev.teams.find(t => teamId(t) === row.id));
  } else {
    const top = table.slice(0, k * 2).map(r => r.id);
    const ratings = Object.fromEntries(top.map((p, i) => [p, top.length - i]));
    teams = pairTeams(top, { how: 'auto', ratings });
  }
  ev.advance = k;
  startBracket(ev, teams, 'single');
  ev.updatedAt = now;
  return ev;
}

export function endEvent(ev, now = Date.now()) {
  ev.status = 'done'; ev.updatedAt = now;
  if (!ev.champion && !ev.bracket && ev.rounds.some(r => r.status === 'done')) ev.champion = (standingsFor(ev)[0] || {}).members || null;
  return ev;
}

// The pool / round robin table. Rotating-partner events rank players; fixed-team events rank teams.
export function standingsFor(ev) {
  const matches = allRoundMatches(ev).filter(m => m.score);
  if (ev.partners === 'fixed') {
    const rows = (ev.teams || []).map(t => ({ id: teamId(t), name: t.join(' & '), members: t }));
    const byId = new Map(rows.map(r => [r.id, r.members]));
    const info = infoMap(ev);
    return standings(rows, matches, { by: 'team' }).map(r => {
      const i = info.get(teamKey(byId.get(r.id)));
      return { ...r, members: byId.get(r.id), ...(i ? { name: i.name || r.name, logo: i.logo || '' } : {}) };
    });
  }
  return standings(ev.players, matches).map(r => ({ ...r, members: [r.id] }));
}

// What a finished match adds to the club's record. cleanGame() in _db.js checks it before it is stored.
export function gameFor(ev, m) {
  if (!m || m.status !== 'done') return null;
  return {
    id: m.gameId || `${ev.id}-${m.id}`, mode: 'doubles', teams: matchTeams(ev, m), score: m.score,
    scoring: ev.scoring, target: ev.target, winBy: ev.winBy, rallies: m.rallies || 0,
    startedAt: m.startedAt, endedAt: m.endedAt, logged: !m.live
  };
}

// The event as the app shows it: matches get their players spelled out, with standings and the knockout laid out.
export function view(ev) {
  const out = clone(ev);
  const mv = m => {
    const teams = matchTeams(ev, m);
    return { id: m.id, court: m.court || null, teams, score: m.score || null, status: m.status, winner: m.winner ?? null, startedAt: m.startedAt || null, endedAt: m.endedAt || null,
      ready: m.status === 'pending' && teams.every(Boolean) };
  };
  out.rounds.forEach(r => { r.matches = r.matches.map(m => mv(m)); });
  out.standings = standingsFor(ev);
  if (ev.bracket) {
    out.knockout = B.rounds(ev.bracket).map(r => ({ key: r.key, title: r.title, matches: r.matches.filter(m => m.status !== 'bye' && m.status !== 'skipped').map(mv) }));
    // The whole bracket tree (byes and later rounds included, with where each match's winner and loser go), for drawing it.
    out.tree = { kind: ev.bracket.kind, rounds: B.rounds(ev.bracket).map(r => ({ key: r.key, title: r.title })),
      matches: ev.bracket.matches.map(m => Object.assign(mv(m), { stage: m.stage, round: m.round, pos: m.pos, slots: m.slots.slice(), winnerTo: m.winnerTo ? m.winnerTo.id : null, loserTo: m.loserTo ? m.loserTo.id : null })) };
    delete out.bracket;
  }
  return out;
}
