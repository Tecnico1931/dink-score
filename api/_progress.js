// Dink Rating replay, achievements, weekly challenges, and seasons, worked out on the server from the club's games.
// Not a route (files starting with "_"). The app's copies of these rules live in dink-score.html.

// --- Dink Rating: the engine is api/_rating.js (shared with the app's copy, pinned by test/rating.test.js) ---
import { compute, START, DAY, key } from './_rating.js';
export { START, DAY };
// Replays games in order: the expected share for team 0 in each game, each player's rating after it, and final tables.
export const replay = sorted => { const { pA, after, tables } = compute(sorted); return { pA, after, tables }; };
// ============================================================================================================
// Achievements, weekly challenges and seasons. Worked out here on the server from the club's games, so
// they can't be faked or drift from what the app shows (the app displays what the server sends).
// Only verified games count: scored live or logged, and sent from the phone of any linked club player (or the club creator).
// "When" is the server's receive time, so backdating games doesn't change weeks or seasons.
// ============================================================================================================
const when = g => g.receivedAt || g.endedAt;
const verified = g => !!g.scoredBy;
const isNamed = n => { const s = String(n).trim(); return !!s && !/^Player \d+$/.test(s); };

export const ACHIEVEMENTS = [
  { id: 'first-win', name: 'First win', desc: 'Win a game' },
  { id: 'games-10', name: 'Regular', desc: 'Play 10 games' },
  { id: 'games-50', name: 'Court rat', desc: 'Play 50 games' },
  { id: 'games-100', name: 'Centurion', desc: 'Play 100 games' },
  { id: 'streak-5', name: 'Heater', desc: 'Win 5 games in a row' },
  { id: 'streak-10', name: 'Unstoppable', desc: 'Win 10 games in a row' },
  { id: 'shutout', name: 'Shutout', desc: 'Win without the other side scoring' },
  { id: 'marathon', name: 'Marathon', desc: 'Win a game that goes past the target, like 13-11' },
  { id: 'giant-killer', name: 'Giant killer', desc: 'Win when the forecast gave you 35% or less' },
  { id: 'partners-5', name: 'Social butterfly', desc: 'Win with 5 different partners' },
  { id: 'rating-4', name: 'Two point five', desc: 'Reach a 2.50 Dink Rating' },
  { id: 'rating-45', name: 'Elite', desc: 'Reach a 3.00 Dink Rating' }
];

// Bonus Dinks per achievement, paid once (5 to 50 by difficulty). Kept apart from ACHIEVEMENTS, which is sent to phones and carries no currency.
export const ACHIEVEMENT_PAY = Object.freeze({ 'first-win': 5, 'games-10': 5, 'games-50': 15, 'games-100': 30, 'streak-5': 15, 'streak-10': 30, shutout: 10, marathon: 10,
  'giant-killer': 15, 'partners-5': 15, 'rating-4': 25, 'rating-45': 50 });
// Dinks for the top 3 of a finished season (5+ games, per format), on top of the trophy; index = place - 1.
export const SEASON_PRIZE = Object.freeze([100, 60, 40]);
// Ledger ids carry no name; a rename/merge may have moved a row under `m:<key>:`, so "already paid" matches the id or that suffix.
const paid = (ledger, id) => ledger.some(e => e.id === id || e.id.endsWith(':' + id));
// One row per achievement the player has, paid once (a later edit or delete never takes it back). `me` is computeProgress's entry for the player.
export function planAchievementRows({ ledger = [], me }) {
  const out = [];
  for (const a of (me && me.achievements) || []) {
    const id = `ach:${a.id}`, amount = ACHIEVEMENT_PAY[a.id];
    if (amount && !paid(ledger, id)) out.push({ id, kind: 'earn', amount, reason: `ach:${a.id}`, day: null, streak: null });
  }
  return out;
}

// Weekly challenges: three per week, the same for everyone, picked from this pool by the week id.
export const CHALLENGES = [
  { id: 'win-3', name: 'Win 3 games', goal: 3 },
  { id: 'play-5', name: 'Play 5 games', goal: 5 },
  { id: 'win-by-6', name: 'Win a game by 6 or more', goal: 1 },
  { id: 'upset', name: 'Beat a team the forecast favored', goal: 1 },
  { id: 'new-partner', name: "Win with a partner you've never won with", goal: 1 },
  { id: 'partners-3', name: 'Play with 3 different partners', goal: 3 },
  { id: 'streak-3', name: 'Win 3 in a row', goal: 3 },
  { id: 'singles', name: 'Play a singles game', goal: 1 }
];
// Weeks start Monday 00:00 UTC. Week id like "2026-W46".
export function weekOf(ts) {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY;
  const thursday = new Date(start + 3 * DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const n = Math.floor((thursday - yearStart) / DAY / 7) + 1;
  return { id: `${thursday.getUTCFullYear()}-W${String(n).padStart(2, '0')}`, start, end: start + 7 * DAY };
}
export function challengesFor(weekId) {
  let seed = 0;
  for (const ch of weekId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const pool = CHALLENGES.map(c => c.id);
  const out = [];
  while (out.length < 3) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; out.push(pool.splice(seed % pool.length, 1)[0]); }
  return out.map(id => CHALLENGES.find(c => c.id === id));
}

// Seasons are calendar quarters (UTC): Winter (Jan-Mar), Spring, Summer, Fall.
const SEASON_NAMES = ['Winter', 'Spring', 'Summer', 'Fall'];
export function seasonOf(ts) {
  const d = new Date(ts), q = Math.floor(d.getUTCMonth() / 3), y = d.getUTCFullYear();
  return { id: `${y}-Q${q + 1}`, name: `${SEASON_NAMES[q]} ${y}`, start: Date.UTC(y, q * 3, 1), end: Date.UTC(y, q * 3 + 3, 1) };
}
// Ending a season early (L21): an organizer closes the current season now and names the next. Each close is a "cut" {at, name}
// (the moment it happened and the NEXT season's name), kept in club_seasons. A club with no cuts has exactly the calendar quarters
// above. With cuts: the season before the first cut is its calendar quarter, ended early at the cut; a season that starts at a cut
// runs under its own name until the next cut or the end of the calendar quarter it began in, whichever comes first, and the
// calendar quarters carry on from there. So seasons never overlap and each moment belongs to exactly one season.
export const SEASON_NAME_MAX = 40;
export function seasonAt(ts, cuts = []) {
  const q = seasonOf(ts);
  let i = -1;
  for (let k = 0; k < cuts.length; k++) if (cuts[k].at <= ts) i = k;
  const next = cuts[i + 1];
  if (i >= 0) {
    const c = cuts[i], end = Math.min(seasonOf(c.at).end, next ? next.at : Infinity);
    if (ts < end) return { id: `x${c.at}`, name: c.name, start: c.at, end, custom: true };
  }
  return next && next.at < q.end ? Object.assign({}, q, { end: next.at }) : q;
}
// A sensible name for the season that follows `name` when the organizer doesn't pick one: "Summer 2026" -> "Summer 2026, part 2".
export function nextSeasonName(name) {
  const m = /^(.*), part (\d+)$/.exec(String(name));
  const base = (m ? m[1] : String(name)), n = m ? Number(m[2]) + 1 : 2, tail = `, part ${n}`;
  return base.slice(0, SEASON_NAME_MAX - tail.length).trimEnd() + tail;
}
export const SEASON_MIN_GAMES = 5;
// Final standings of a season for one format: everyone starts at 2.00 and only that season's verified games count
// (sent from a linked player's phone), so made-up results can't win a season. The app's season table uses the same rule.
export function seasonStandings(games, season, mode) {
  const inSeason = games.filter(g => verified(g) && !g.hold && when(g) >= season.start && when(g) < season.end && (g.mode === 'singles' ? 'singles' : 'doubles') === mode)
    .sort((a, b) => a.endedAt - b.endedAt);
  const { tables } = replay(inSeason);
  return [...tables[mode].values()].filter(p => isNamed(p.name) && p.games >= SEASON_MIN_GAMES)
    .sort((a, b) => b.rating - a.rating || b.games - a.games || a.name.localeCompare(b.name));
}

// Everything per player: achievements, weekly challenges and trophies.
export function computeProgress(games, now = Date.now(), cuts = []) {
  const sorted = [...games].sort((a, b) => a.endedAt - b.endedAt);
  // Forecasts and ratings used to judge achievements and challenges (Giant killer, upsets, Two point five) come from
  // verified games only, so results sent from other phones can't be used to set them up.
  const { pA, after } = replay(sorted.filter(g => verified(g) && !g.hold));
  const people = new Map();
  const get = (k, name) => {
    if (!people.has(k)) people.set(k, { name, achievements: [], weeks: {}, trophies: [],
      _s: { games: 0, streak: 0, wonWith: new Set(), achieved: new Set() } });
    return people.get(k);
  };
  const award = (p, id, at) => {
    if (p._s.achieved.has(id)) return;
    p._s.achieved.add(id); p.achievements.push({ id, at });
  };
  const weekState = new Map(); // player key -> Map(week id -> tallies). Nested, never a joined string, so names can't collide.
  for (const g of sorted) {
    if (!verified(g) || g.hold) continue;
    const ts = when(g), wk = weekOf(ts).id;
    for (const t of [0, 1]) {
      const won = g.winner === t, my = g.score[t], their = g.score[1 - t];
      const expected = g.id in pA ? (t === 0 ? pA[g.id] : 1 - pA[g.id]) : 0.5;
      for (const raw of g.teams[t]) {
        if (!isNamed(raw)) continue;
        const k = key(raw), p = get(k, String(raw).trim()), s = p._s;
        const partners = g.teams[t].filter(n => key(n) !== k && isNamed(n)).map(key);
        const newPartnerWin = won && partners.some(x => !s.wonWith.has(x));
        s.games++; s.streak = won ? s.streak + 1 : 0;
        if (won) partners.forEach(x => s.wonWith.add(x));
        if (won) award(p, 'first-win', ts);
        if (s.games >= 10) award(p, 'games-10', ts);
        if (s.games >= 50) award(p, 'games-50', ts);
        if (s.games >= 100) award(p, 'games-100', ts);
        if (s.streak >= 5) award(p, 'streak-5', ts);
        if (s.streak >= 10) award(p, 'streak-10', ts);
        if (won && their === 0) award(p, 'shutout', ts);
        if (won && my > (g.target || 11)) award(p, 'marathon', ts);
        if (won && expected <= 0.35) award(p, 'giant-killer', ts);
        if (s.wonWith.size >= 5) award(p, 'partners-5', ts);
        const r = after[g.id] && after[g.id][k];
        if (r >= 2.5) award(p, 'rating-4', ts);
        if (r >= 3) award(p, 'rating-45', ts);
        if (!weekState.has(k)) weekState.set(k, new Map());
        const weeks = weekState.get(k);
        const w = weeks.get(wk) || { wins: 0, games: 0, bigWin: 0, upset: 0, newPartner: 0, partners: new Set(), run: 0, bestRun: 0, singles: 0 };
        w.games++; if (won) w.wins++;
        if (won && my - their >= 6) w.bigWin = 1;
        if (won && expected < 0.5) w.upset = 1;
        if (newPartnerWin) w.newPartner = 1;
        partners.forEach(x => w.partners.add(x));
        w.run = won ? w.run + 1 : 0; w.bestRun = Math.max(w.bestRun, w.run);
        if (g.mode === 'singles') w.singles = 1;
        weeks.set(wk, w);
      }
    }
  }
  const measure = (id, w) => ({ 'win-3': w.wins, 'play-5': w.games, 'win-by-6': w.bigWin, 'upset': w.upset, 'new-partner': w.newPartner,
    'partners-3': w.partners.size, 'streak-3': w.bestRun, 'singles': w.singles }[id] || 0);
  for (const [k, weeks] of weekState) for (const [wk, w] of weeks) {
    const p = people.get(k);
    const items = challengesFor(wk).map(c => { const progress = Math.min(c.goal, measure(c.id, w)); return { id: c.id, progress, done: progress >= c.goal }; });
    p.weeks[wk] = items;
  }
  // Finished seasons: the top 3 in each format get a trophy.
  const seasons = new Map();
  for (const g of sorted) { if (g.hold) continue; const s = seasonAt(when(g), cuts); if (s.end <= now) seasons.set(s.id, s); }
  for (const s of seasons.values()) for (const mode of ['doubles', 'singles']) {
    seasonStandings(sorted, s, mode).slice(0, 3).forEach((row, i) => {
      const p = get(row.key, row.name);
      p.trophies.push({ season: s.id, name: s.name, start: s.start, mode, place: i + 1, rating: Math.round(row.rating * 100) / 100 });
    });
  }
  // Keep the current run with the progress payload. This is the same chronological,
  // verified-game replay used for achievements, so UI callers do not need to
  // reconstruct a streak from a differently filtered game list.
  for (const p of people.values()) { p.streak = p._s.streak; delete p._s; }
  return people;
}

// One row per finished season and format the player placed in (trophies are exactly those), paid once. `me` is computeProgress's entry.
export function planPrizeRows({ ledger = [], me }) {
  const out = [];
  for (const t of (me && me.trophies) || []) {
    const id = `sprz:${t.season}:${t.mode}`, amount = SEASON_PRIZE[t.place - 1];
    if (amount && !paid(ledger, id)) out.push({ id, kind: 'earn', amount, reason: `sprz:${t.place}`, day: null, streak: null });
  }
  return out;
}
