// Organizer analytics: attendance, retention and busiest hours, worked out from the games the club already holds.
// Pure (no database) so `npm test` covers it. Nothing new is recorded about anyone: the numbers are totals, never a list of
// who came or missed, and the route (api/club.js ?analytics=1, via analyticsRoute below) answers organizers only.
import { nameKey } from './_names.js';
import { counts } from './_confirm.js';

export const WEEKS = 12; // weeks shown in the attendance table
export const ACTIVE_WEEKS = 4; // "active" = played this week or in the three before
const MAX_GAMES = 5000;

// A valid IANA zone from the browser, else UTC (the zone only decides which weekday and hour a game lands in).
export function cleanZone(z) {
  const s = String(z || '').slice(0, 64);
  try { new Intl.DateTimeFormat('en-US', { timeZone: s }); return s || 'UTC'; } catch { return 'UTC'; }
}

function localizer(tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric' });
  return ms => {
    const p = {};
    for (const x of f.formatToParts(ms)) p[x.type] = +x.value;
    const day = Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 864e5); // local calendar day number
    return { day, hour: p.hour % 24, dow: (day + 3) % 7 }; // dow: 0 = Monday (1970-01-01 was a Thursday)
  };
}
const weekIdx = day => Math.floor((day + 3) / 7); // Monday-based week number
const weekStartISO = idx => new Date((idx * 7 - 3) * 864e5).toISOString().slice(0, 10);
const r1 = n => Math.round(n * 10) / 10;

// games: the club's saved games ({teams, startedAt, endedAt, logged, confirmed?, event?}); required: the club's confirmation setting.
export function analyze(games, { now = Date.now(), tz = 'UTC', required = false } = {}) {
  const loc = localizer(tz);
  const first = new Map(); // player key -> first week index
  const seen = new Map(); // player key -> Set of week indexes
  const days = new Map(); // local day -> { games, players:Set }
  const perWeek = new Map(); // week index -> { games, players:Set }
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const nowWeek = weekIdx(loc(now).day);
  const since = nowWeek - (WEEKS - 1);
  let n = 0, minutes = 0, timed = 0, from = Infinity, to = 0;
  const list = games.filter(g => counts(g, required)).sort((a, b) => a.endedAt - b.endedAt);
  for (const g of list) {
    const at = loc(g.endedAt), w = weekIdx(at.day);
    const ps = [...new Set((g.teams || []).flat().map(nameKey))];
    for (const p of ps) {
      if (!first.has(p)) first.set(p, w);
      if (!seen.has(p)) seen.set(p, new Set());
      seen.get(p).add(w);
    }
    if (w < since) continue;
    n++; from = Math.min(from, g.endedAt); to = Math.max(to, g.endedAt);
    const wk = perWeek.get(w) || perWeek.set(w, { games: 0, players: new Set() }).get(w);
    wk.games++; ps.forEach(p => wk.players.add(p));
    const d = days.get(at.day) || days.set(at.day, { games: 0, players: new Set() }).get(at.day);
    d.games++; ps.forEach(p => d.players.add(p));
    const st = loc(Math.min(g.startedAt || g.endedAt, g.endedAt)); // when it began; a logged game just uses its end
    grid[st.dow][st.hour]++;
    if (!g.logged && g.startedAt && g.endedAt > g.startedAt && g.endedAt - g.startedAt < 3 * 36e5) { minutes += (g.endedAt - g.startedAt) / 6e4; timed++; }
  }
  const weeks = [];
  for (let w = since; w <= nowWeek; w++) {
    const x = perWeek.get(w);
    const players = x ? x.players.size : 0;
    const fresh = x ? [...x.players].filter(p => first.get(p) === w).length : 0;
    weeks.push({ start: weekStartISO(w), games: x ? x.games : 0, players, newPlayers: fresh, returning: players - fresh });
  }
  // Retention over the club's whole record: of the players whose first week is old enough to have had a chance to return,
  // how many played in a later week too.
  let cohort = 0, cameBack = 0, active = 0, lapsed = 0;
  for (const [p, f] of first) {
    const ws = seen.get(p);
    const last = Math.max(...ws);
    if (f <= nowWeek - ACTIVE_WEEKS) { cohort++; if (ws.size > 1) cameBack++; }
    if (last > nowWeek - ACTIVE_WEEKS) active++;
    else if (last > nowWeek - 2 * ACTIVE_WEEKS) lapsed++; // played in the four weeks before that, not since
  }
  const flat = [];
  grid.forEach((row, d) => row.forEach((c, h) => { if (c) flat.push({ day: d, hour: h, games: c }); }));
  flat.sort((a, b) => b.games - a.games || a.day - b.day || a.hour - b.hour);
  const playDays = days.size;
  let dayPlayers = 0; for (const d of days.values()) dayPlayers += d.players.size;
  return {
    tz, weeksShown: WEEKS, activeWeeks: ACTIVE_WEEKS,
    games: n, from: n ? from : null, to: n ? to : null, playDays,
    avgPlayersPerDay: playDays ? r1(dayPlayers / playDays) : 0,
    avgGamesPerDay: playDays ? r1(n / playDays) : 0,
    avgMinutes: timed ? Math.round(minutes / timed) : null,
    weeks,
    retention: { cohort, cameBack, rate: cohort ? Math.round(100 * cameBack / cohort) : null, active, lapsed },
    busiest: { grid, top: flat.slice(0, 5) }
  };
}

// GET /api/club?code=...&analytics=1&tz=Europe/London (X-Club-PIN / X-Club-Owner): organizers only.
export async function analyticsRoute(sql, club, tzParam) {
  const rows = await sql`SELECT data, confirmed_by FROM games WHERE club = ${club.code} AND deleted_at IS NULL ORDER BY ended_at DESC LIMIT ${MAX_GAMES}`;
  const games = rows.map(r => ({ ...r.data, ...(r.confirmed_by ? { confirmed: true } : {}) }));
  return analyze(games, { tz: cleanZone(tzParam), required: !!club.require_confirmation });
}
