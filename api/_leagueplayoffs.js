// League playoffs: after a season is finished, the top of each division meets in a single elimination bracket. Pure functions, no database.
//   L.playoffs = { top, field: [{ members: [names], division, rank }], bracket (see _bracket.js), champion: null | [names], startedAt, updatedAt }
// Seeds go by finishing place first, then division (every division's winner outranks every runner-up), so the top two seeds cannot meet before the final.
// Names only sit inside `members` arrays, so rename and anonymise (_rename.js, players.js) reach them like the entries.
// A playoff match is an extra game in the club record, with the id from playoffGame() (<leagueId>-po-<matchId>), written once like a league match:
// the regular season tables never see it, so standings and ratings count nothing twice.
import { build, advance, correct, champion, isReady, rounds } from './_bracket.js';
import { divisionTable } from './_league.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clone = x => JSON.parse(JSON.stringify(x));
export const MAX_TOP = 8;

// The qualifiers, best seed first. Only entries that played at least one match qualify.
export function playoffField(L, top) {
  const t = Math.trunc(Number(top));
  if (!Number.isFinite(t) || t < 1 || t > MAX_TOP) throw bad(`Pick 1 to ${MAX_TOP} qualifiers per division.`);
  const tables = L.divisions.map((_, d) => divisionTable(L, d).filter(r => r.played));
  const field = [];
  for (let rank = 1; rank <= t; rank++) tables.forEach((rows, d) => { if (rows[rank - 1]) field.push({ members: rows[rank - 1].members, division: d, rank }); });
  return field;
}

export function startPlayoffs(L, input = {}, now = Date.now()) {
  if (L.kind !== 'league') throw bad('Only leagues have playoffs.', 409);
  if (L.status !== 'done') throw bad('Finish the season first.', 409);
  if (L.playoffs) throw bad('The playoffs have already started.', 409);
  const top = input.top === undefined ? 2 : input.top;
  const field = playoffField(L, top);
  if (field.length < 2) throw bad('Fewer than two entries qualified. Play more matches first.', 409);
  L.playoffs = { top: Math.trunc(Number(top)), field, bracket: build(field.length, 'single'), champion: null, startedAt: now, updatedAt: now };
  L.updatedAt = now;
  return L;
}

const need = L => { if (!L.playoffs) throw bad('The playoffs have not started.', 409); return L.playoffs; };
const settlePlayoffs = (L, P, bracket, now) => {
  P.bracket = bracket;
  const c = champion(bracket);
  P.champion = c === null ? null : P.field[c].members;
  P.updatedAt = L.updatedAt = now;
};

// Records a playoff match. Returns { league, match, game, changed }; the same score again is a harmless retry.
export function recordPlayoff(L, matchId, score, now = Date.now()) {
  const P = need(L);
  const m = P.bracket.matches.find(x => x.id === matchId);
  if (m && m.status === 'done' && Array.isArray(score) && m.score[0] === Number(score[0]) && m.score[1] === Number(score[1])) return { league: L, match: m, game: playoffGame(L, matchId), changed: false };
  settlePlayoffs(L, P, advance(P.bracket, matchId, score), now);
  return { league: L, match: P.bracket.matches.find(x => x.id === matchId), game: playoffGame(L, matchId), changed: true };
}

export function correctPlayoff(L, matchId, score, now = Date.now()) {
  const P = need(L);
  settlePlayoffs(L, P, correct(P.bracket, matchId, score), now);
  return L;
}

// The club-record game for a played playoff match, or null.
export function playoffGame(L, matchId, endedAt = null) {
  const P = L.playoffs, m = P && P.bracket.matches.find(x => x.id === matchId);
  if (!m || m.status !== 'done') return null;
  return { id: `${L.id}-po-${m.id}`, mode: L.mode, teams: m.slots.map(s => P.field[s].members), score: m.score, scoring: L.scoring, target: L.target, winBy: L.winBy, rallies: 0, startedAt: endedAt, endedAt, logged: true };
}

// The bracket as the app shows it: each slot named, and which matches can be played now.
export function playoffView(L) {
  if (!L.playoffs) return null;
  const P = clone(L.playoffs);
  const name = s => (s === null ? null : s === -1 ? 'bye' : P.field[s].members);
  P.bracket.matches.forEach(m => { m.teams = m.slots.map(name); m.ready = isReady(m); });
  P.rounds = rounds(P.bracket).map(r => ({ key: r.key, title: r.title, ids: r.matches.map(m => m.id) })); // the display groups, so the phone never needs the bracket code
  return P;
}
