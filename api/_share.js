// Public, read-only sharing of an event: the share token and the one serializer that decides what a spectator may see.
// Pure functions, no database. The token is the only credential: whoever holds the link can watch, nobody can change anything.
import { randomBytes } from 'node:crypto';
import { view } from './_events.js';
import { view as leagueView } from './_league.js';
import { cleanLogoUrl } from '../sheet-import.js';

// 24 random bytes (192 bits) as URL-safe base64: 32 characters, never guessable and safe in a path.
export const newShareToken = (bytes = randomBytes) => bytes(24).toString('base64url');
export const isShareToken = t => typeof t === 'string' && /^[A-Za-z0-9_-]{32}$/.test(t);

const str = (v, n = 80) => (typeof v === 'string' ? v.slice(0, n) : '');
const int = v => (Number.isFinite(v) ? Math.trunc(v) : null);
const names = t => (Array.isArray(t) ? t.slice(0, 2).map(p => str(p)) : null);
const teams = ts => (Array.isArray(ts) ? ts.slice(0, 2).map(names) : [null, null]);
const logo = u => (typeof u === 'string' ? cleanLogoUrl(u).value : ''); // only a valid https image link ever leaves, whatever was stored
const score = s => (Array.isArray(s) && s.length === 2 ? [int(s[0]), int(s[1])] : null);
const match = m => ({ id: str(m.id, 24), court: int(m.court), teams: teams(m.teams), score: score(m.score), status: str(m.status, 12), winner: int(m.winner), ready: !!m.ready });
const treeMatch = m => ({ ...match(m), stage: str(m.stage, 1), round: int(m.round), pos: int(m.pos),
  slots: Array.isArray(m.slots) ? m.slots.slice(0, 2).map(int) : [null, null], winnerTo: m.winnerTo ? str(m.winnerTo, 24) : null, loserTo: m.loserTo ? str(m.loserTo, 24) : null });

// What a spectator sees of an event. Everything is copied field by field, so a field added to an event later is
// private until it is listed here. Never in it: the club code, organizer PIN or token, other events, saved-player
// claims, the draw seed, game ids, or anything that could write.
export function publicView(ev) {
  const v = view(ev);
  const logos = v.publicLogos === true; // team logos are the organizer's choice per event: the viewer's browser contacts the logo's host
  const out = {
    v: 1,
    name: str(v.name, 60), format: str(v.format, 16), partners: str(v.partners, 10), status: str(v.status, 8), stage: str(v.stage, 8),
    target: int(v.target), scoring: str(v.scoring, 8), winBy: int(v.winBy), courts: int(v.courts),
    advance: int(v.advance) || 0, poolDone: !!v.poolDone, roundsPlanned: int(v.roundsPlanned) || 0,
    champion: names(v.champion), updatedAt: int(v.updatedAt),
    teamInfo: (v.teamInfo || []).slice(0, 64).map(i => ({ players: names(i.players), name: str(i.name, 40), logo: logos ? logo(i.logo) : '' })),
    standings: (v.standings || []).map(r => ({ rank: int(r.rank), name: str(r.name), logo: logos ? logo(r.logo) : '', played: int(r.played), wins: int(r.wins), losses: int(r.losses), diff: int(r.diff) })),
    rounds: (v.rounds || []).map(r => ({ n: int(r.n), title: str(r.title, 24), status: str(r.status, 8), matches: r.matches.map(match), byes: (r.byes || []).map(p => str(p)) })),
    knockout: (v.knockout || []).map(r => ({ key: str(r.key, 4), title: str(r.title, 24), matches: r.matches.map(match) })),
    tree: null
  };
  if (v.tree) out.tree = { kind: str(v.tree.kind, 8), rounds: v.tree.rounds.map(r => ({ key: str(r.key, 4), title: str(r.title, 24) })), matches: v.tree.matches.map(treeMatch) };
  return out;
}

// What a spectator sees of a league or ladder (the /l/<token> page). Same rule as publicView: copied field by field, so a
// field added to a league later is private until it is listed here. Names, scores and standings only: never the club code,
// PIN or token, game ids, the results-by setting, who may challenge whom, or anything that could write.
export function leaguePublicView(L) {
  const v = leagueView(L);
  const side = t => (Array.isArray(t) ? t.slice(0, 2).map(p => str(p)) : []);
  const out = { v: 1, kind: str(v.kind, 8), name: str(v.name, 60), season: str(v.season, 40), mode: str(v.mode, 8), status: str(v.status, 8),
    target: int(v.target), scoring: str(v.scoring, 8), winBy: int(v.winBy), updatedAt: int(v.updatedAt) };
  if (v.kind === 'league') {
    Object.assign(out, { current: int(v.current), move: int(v.move),
      tiebreak: Array.isArray(v.tiebreak) ? v.tiebreak.slice(0, 3).map(k => str(k, 8)) : null,
      champions: Array.isArray(v.champions) ? v.champions.slice(0, 4).map(c => (c ? side(c) : null)) : null,
      divisions: v.tables.slice(0, 4).map(t => ({ label: str(t.label, 20), rows: t.rows.slice(0, 64).map(r => ({ rank: int(r.rank), name: str(r.name), played: int(r.played), wins: int(r.wins), losses: int(r.losses), diff: int(r.diff), pf: int(r.pf) })) })),
      weeks: v.weeks.slice(0, 80).map(w => ({ n: int(w.n), title: str(w.title, 24), byes: (w.byes || []).slice(0, 16).map(b => ({ division: int(b.division), name: side(b.members).join(' & ') })),
        matches: w.matches.slice(0, 64).map(m => ({ division: int(m.division), teams: [side(m.teams[0]), side(m.teams[1])], score: score(m.score), status: str(m.status, 8), forfeit: m.forfeit === true,
          when: { date: str(m.when && m.when.date, 10) || null, time: str(m.when && m.when.time, 5) || null, moved: !!(m.when && m.when.moved), court: int(m.when && m.when.court) } })) })) });
  } else {
    Object.assign(out, { jump: int(v.jump), decayDays: int(v.decayDays),
      rows: v.rows.slice(0, 128).map(r => ({ rank: int(r.rank), name: str(r.name), played: int(r.played), wins: int(r.wins), losses: int(r.losses) })),
      results: v.results.slice(0, 15).map(r => ({ teams: [side(r.teams[0]), side(r.teams[1])], score: score(r.score), winner: int(r.winner) })) });
  }
  return out;
}
