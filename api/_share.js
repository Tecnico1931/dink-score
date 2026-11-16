// Public, read-only sharing of an event: the share token and the one serializer that decides what a spectator may see.
// Pure functions, no database. The token is the only credential: whoever holds the link can watch, nobody can change anything.
import { randomBytes } from 'node:crypto';
import { view } from './_events.js';
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
