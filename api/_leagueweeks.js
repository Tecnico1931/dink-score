// Week by week running of a league: a day, a time and courts for each week, a match moved to another day, a forfeit, and noticing that a new
// week has opened. Pure functions on the league object from _league.js, no database; _leagues.js stores the result and sends the notifications.
// Dates are the organizer's wall clock ('YYYY-MM-DD', 'HH:MM'): the server has no club time zone, so it never converts them.
import { findMatch, settle } from './_league.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const MAX_COURT = 99;
export const NOTIFY_GAP = 10 * 60 * 1000; // the organizer's "tell the players" button may be pressed again after this long

export function cleanDate(v) {
  if (v === '' || v == null) return null;
  const m = /^(20\d\d)-(\d\d)-(\d\d)$/.exec(String(v));
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw bad('That date is not valid.');
  return String(v);
}
export function cleanTime(v) {
  if (v === '' || v == null) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw bad('That time is not valid.');
  return String(v);
}
const cleanCourt = v => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COURT) throw bad(`A court number is 1 to ${MAX_COURT}.`);
  return n;
};

// The week a league is on: the first with a match still to play (the last week once everything is played). Same rule as view().current.
export const currentWeek = L => (L.weeks.find(w => w.matches.some(m => m.status === 'pending')) || {}).n || L.weeks.length;

const weekOf = (L, n) => {
  if (L.kind !== 'league') throw bad('Only a league has weeks.', 409);
  const w = L.weeks.find(x => x.n === Number(n));
  if (!w) throw bad('That week is not in this league.', 404);
  return w;
};
const live = L => { if (L.status === 'done') throw bad('This season is finished.', 409); };

// A day, a time and courts for one week. input: { date, time, courts }. A blank date or time clears it. courts: a number 1 to 20 spreads the week's
// unplayed matches over that many courts in order (more matches than courts means some share a court and play in turn), 0 clears the courts,
// left out leaves them alone.
export function setWeekPlan(L, n, input, now = Date.now()) {
  const w = weekOf(L, n), p = input || {};
  live(L);
  const date = cleanDate(p.date), time = cleanTime(p.time);
  if (time && !date) throw bad('Pick a day for that time.');
  const open = w.matches.filter(m => m.status === 'pending');
  if (p.courts !== undefined && p.courts !== null && p.courts !== '') {
    const c = Number(p.courts);
    if (!Number.isInteger(c) || c < 0 || c > 20) throw bad('Use 1 to 20 courts, or 0 to clear them.');
    open.forEach((m, i) => { if (c) m.court = (i % c) + 1; else delete m.court; });
  }
  if (date) w.date = date; else delete w.date;
  if (time) w.time = time; else delete w.time;
  L.updatedAt = now;
  return { league: L, week: w };
}

// One match played on another day, time or court than its week. input: { date, time, court }. A blank date puts it back on the week's day.
// A match that was already played cannot move.
export function rescheduleMatch(L, matchId, input, now = Date.now()) {
  if (L.kind !== 'league') throw bad('Only a league has weeks.', 409);
  const found = findMatch(L, String(matchId || ''));
  if (!found) throw bad('That match is not in this league.', 404);
  live(L);
  const m = found.match, p = input || {};
  if (m.status === 'done') throw bad('That match has been played.', 409);
  const date = cleanDate(p.date), time = cleanTime(p.time), court = cleanCourt(p.court);
  if (time && !date) throw bad('Pick a day for that time.');
  const before = JSON.stringify([m.date, m.time, m.court]);
  if (date) m.date = date; else delete m.date;
  if (time) m.time = time; else delete m.time;
  if (court) m.court = court; else delete m.court;
  const changed = JSON.stringify([m.date, m.time, m.court]) !== before;
  if (changed) L.updatedAt = now;
  return { league: L, match: m, changed };
}

// Settles a match by forfeit: `winner` 0 or 1 gives that side the win, target points to 0 (it counts in the table like any score, but it is not a
// game, so it never reaches the club record or the ratings). `winner` null undoes it. Returns { league, match, changed }.
export function forfeitMatch(L, matchId, winner, now = Date.now()) {
  if (L.kind !== 'league') throw bad('Only a league has weeks.', 409);
  const found = findMatch(L, String(matchId || ''));
  if (!found) throw bad('That match is not in this league.', 404);
  live(L);
  const m = found.match;
  if (winner === null || winner === undefined) {
    if (!m.forfeit) throw bad('That match was not a forfeit.', 409);
    for (const k of ['score', 'winner', 'forfeit', 'startedAt', 'endedAt', 'rallies', 'live', 'gameId']) delete m[k];
    m.score = null; m.status = 'pending';
    settle(L, now);
    return { league: L, match: m, changed: true };
  }
  if (winner !== 0 && winner !== 1) throw bad('Pick which side wins the forfeit.');
  if (m.status === 'done' && !m.forfeit) throw bad('That match was already played. Fix its score instead.', 409);
  if (m.forfeit && m.winner === winner) return { league: L, match: m, changed: false };
  Object.assign(m, { score: winner === 0 ? [L.target, 0] : [0, L.target], winner, status: 'done', forfeit: true, startedAt: now, endedAt: now, rallies: 0, live: false });
  delete m.gameId;
  settle(L, now);
  return { league: L, match: m, changed: true };
}

// After a change: if the league moved on to a later week that nobody has been told about, marks it told and returns it. (Weeks only open once.)
export function openedWeek(L, before, now = Date.now()) {
  if (L.kind !== 'league' || L.status !== 'live') return null;
  const n = currentWeek(L);
  if (n <= before) return null;
  const w = L.weeks.find(x => x.n === n);
  if (!w || w.notifiedAt) return null;
  w.notifiedAt = now;
  return w;
}

// The organizer's "tell the players": any week of a season still running that has matches left, at most every NOTIFY_GAP.
export function noteWeekSent(L, n, now = Date.now()) {
  const w = weekOf(L, n);
  live(L);
  if (w.matches.every(m => m.status === 'done')) throw bad('That week has been played.', 409);
  if (w.notifiedAt && now - w.notifiedAt < NOTIFY_GAP) throw bad('The players were told a moment ago. Try again in a few minutes.', 429);
  w.notifiedAt = now; L.updatedAt = now;
  return w;
}
