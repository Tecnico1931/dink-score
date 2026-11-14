// Dinks: the club's play money. Earned from games, spent in the shop. Not a route (files starting with "_").
// The earning rules below must match computeDinks() in dink-score.html, which shows the same numbers in the app.
// The server's copy is the one that counts when someone buys something.

// --- Dink Rating forecast (same maths as DR in dink-score.html), only what earning needs ---
const START = 3.5, MIN = 2, MAX = 8, SCALE = 2.8, FULL = 20, DAY = 864e5;
const key = n => String(n).trim().toLowerCase();
const expShare = gap => 1 / (1 + Math.pow(10, -gap / SCALE));
function reliability(p, now) {
  if (!p || !p.games) return 0;
  const volume = Math.min(1, p.games / FULL);
  const days = (now - p.last) / DAY;
  return volume * (days <= 30 ? 1 : Math.max(0.4, 1 - (days - 30) / 180));
}
// Replays games in order: the expected share for team 0 in each game, each player's rating after it, and final tables.
function replay(sorted) {
  const tables = { doubles: new Map(), singles: new Map() };
  const pA = {}, after = {};
  for (const g of sorted) {
    const tot = g.score[0] + g.score[1];
    if (!tot) continue;
    const T = tables[g.mode === 'singles' ? 'singles' : 'doubles'];
    const get = n => { const k = key(n); if (!T.has(k)) T.set(k, { key: k, name: String(n).trim(), rating: START, games: 0, last: g.endedAt }); return T.get(k); };
    const teams = g.teams.map(t => t.map(get));
    const tr = teams.map(t => t.reduce((s, p) => s + p.rating, 0) / t.length);
    const e = expShare(tr[0] - tr[1]);
    const sA = g.score[0] / tot;
    const updates = [];
    teams.forEach((t, ti) => t.forEach(p => updates.push([p, Math.min(MAX, Math.max(MIN, p.rating + (0.06 + 0.24 * (1 - reliability(p, g.endedAt))) * (ti === 0 ? sA - e : e - sA)))])));
    after[g.id] = {};
    for (const [p, next] of updates) { p.rating = next; p.games++; p.last = g.endedAt; after[g.id][p.key] = next; }
    pA[g.id] = e;
  }
  return { pA, after, tables };
}
// Expected share of points for team 0 in each game, keyed by game id.
const forecasts = sorted => replay(sorted).pA;

// --- Earning ---
export const EARN = { play: 2, win: 10, beatForecast: 3, streak: 5, streakFrom: 3, dailyCap: 60 };
// Returns Map(nameKey -> { name, earned, games: { gameId: dinks } }).
// Win, forecast and streak Dinks need a game scored live AND sent from the phone linked to one of its players (or the
// club creator), which the server records as scoredBy. Everything else earns only the play bonus, so made-up results
// can't farm Dinks. The daily cap counts by the server's receivedAt, so backdating games doesn't get around it.
// Each player earns at most EARN.dailyCap per UTC day.
export function computeDinks(games) {
  const sorted = [...games].sort((a, b) => a.endedAt - b.endedAt);
  const pA = forecasts(sorted);
  const people = new Map(), streaks = new Map(), daily = new Map(); // daily: player key -> Map(day -> Dinks)
  for (const g of sorted) {
    const day = new Date(g.receivedAt || g.endedAt).toISOString().slice(0, 10); // server receive time, not the claimed finish time
    for (const t of [0, 1]) {
      const won = g.winner === t;
      const share = (g.score[0] + g.score[1]) ? g.score[t] / (g.score[0] + g.score[1]) : 0;
      const expected = g.id in pA ? (t === 0 ? pA[g.id] : 1 - pA[g.id]) : 0.5;
      for (const raw of g.teams[t]) {
        const name = String(raw).trim();
        if (!name || /^Player \d+$/.test(name)) continue;
        const k = key(name);
        let n = EARN.play;
        if (!g.logged && g.scoredBy) { // scored live and sent by one of its players (or the club creator), as the server recorded
          const s = won ? (streaks.get(k) || 0) + 1 : 0;
          streaks.set(k, s);
          if (won) n += EARN.win;
          if (share > expected) n += EARN.beatForecast;
          if (won && s >= EARN.streakFrom) n += EARN.streak;
        }
        if (!daily.has(k)) daily.set(k, new Map());
        const used = daily.get(k).get(day) || 0;
        n = Math.max(0, Math.min(n, EARN.dailyCap - used));
        daily.get(k).set(day, used + n);
        const e = people.get(k) || { name, earned: 0, games: {} };
        e.earned += n; e.games[g.id] = n;
        people.set(k, e);
      }
    }
  }
  return people;
}

// --- The shop catalog. Prices are defaults; organizers can change any of them. ---
// slot: which part of a player's look an item fills (one equipped item per slot).
export const CATALOG = [
  { id: 'title-kitchen-king', slot: 'title', name: 'Kitchen King', price: 25 },
  { id: 'title-dink-master', slot: 'title', name: 'Dink Master', price: 25 },
  { id: 'title-banger', slot: 'title', name: 'Banger', price: 20 },
  { id: 'title-lob-legend', slot: 'title', name: 'Lob Legend', price: 30 },
  { id: 'title-third-shot', slot: 'title', name: 'Third-Shot Wizard', price: 35 },
  { id: 'title-erne-artist', slot: 'title', name: 'Erne Artist', price: 40 },
  { id: 'frame-ball', slot: 'frame', name: 'Optic ring', price: 15 },
  { id: 'frame-cobalt', slot: 'frame', name: 'Cobalt ring', price: 15 },
  { id: 'frame-forest', slot: 'frame', name: 'Forest ring', price: 15 },
  { id: 'frame-sunset', slot: 'frame', name: 'Sunset ring', price: 30 },
  { id: 'frame-prism', slot: 'frame', name: 'Prism ring', price: 45 },
  { id: 'style-gold', slot: 'style', name: 'Gold name', price: 40 },
  { id: 'style-glow', slot: 'style', name: 'Glowing name', price: 50 },
  { id: 'style-flame', slot: 'style', name: 'Flame name', price: 60 },
  { id: 'theme-sunset', slot: 'theme', name: 'Sunset court', price: 50 },
  { id: 'theme-clay', slot: 'theme', name: 'Clay court', price: 50 },
  { id: 'theme-grass', slot: 'theme', name: 'Grass court', price: 50 },
  { id: 'theme-neon', slot: 'theme', name: 'Neon court', price: 70 },
  { id: 'celebrate-confetti', slot: 'celebrate', name: 'Confetti', price: 40 },
  { id: 'celebrate-balls', slot: 'celebrate', name: 'Ball burst', price: 40 },
  // Legendary: animated showpieces, priced for one to three weeks of steady winning (60 Dinks a day at most).
  { id: 'title-legend-erne', slot: 'title', name: 'Erne Overlord', price: 500, rarity: 'legendary' },
  { id: 'title-legend-kitchen', slot: 'title', name: 'Ruler of the Kitchen', price: 600, rarity: 'legendary' },
  { id: 'style-holo', slot: 'style', name: 'Holographic name', price: 650, rarity: 'legendary' },
  { id: 'style-molten', slot: 'style', name: 'Molten gold name', price: 700, rarity: 'legendary' },
  { id: 'frame-orbit', slot: 'frame', name: 'Orbiting ball', price: 600, rarity: 'legendary' },
  { id: 'frame-crown', slot: 'frame', name: "Champion's crown", price: 800, rarity: 'legendary' },
  { id: 'theme-aurora', slot: 'theme', name: 'Aurora court', price: 900, rarity: 'legendary' },
  { id: 'theme-galaxy', slot: 'theme', name: 'Galaxy court', price: 900, rarity: 'legendary' },
  { id: 'celebrate-fireworks', slot: 'celebrate', name: 'Fireworks', price: 750, rarity: 'legendary' },
  { id: 'celebrate-trophy', slot: 'celebrate', name: 'Trophy shower', price: 1000, rarity: 'legendary' }
];
// Every item gets a rarity for the shop: legendary as marked, rare from 40 Dinks, common below.
for (const item of CATALOG) if (!item.rarity) item.rarity = item.price >= 40 ? 'rare' : 'common';
export const DEFAULT_REWARDS = [
  { id: 'reward-pick-game', name: 'Pick the next game', price: 30 },
  { id: 'reward-music', name: 'Choose the music', price: 20 },
  { id: 'reward-skip-pickup', name: 'Skip ball pickup', price: 15 }
];
export const SLOTS = ['title', 'frame', 'style', 'theme', 'celebrate'];

// Club shop settings with defaults filled in. Stored on the club as JSON.
export function shopSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const prices = {};
  for (const item of CATALOG) {
    const p = s.prices && Number.isInteger(s.prices[item.id]) ? s.prices[item.id] : item.price;
    prices[item.id] = Math.max(0, Math.min(9999, p));
  }
  const rewards = Array.isArray(s.rewards) ? s.rewards : DEFAULT_REWARDS;
  return { rewardsEnabled: !!s.rewardsEnabled, prices, rewards };
}

// ============================================================================================================
// Achievements, weekly challenges and seasons. Worked out here on the server from the club's games, so the bonus
// Dinks they pay can't be faked or drift from what the app shows (the app displays what the server sends).
// Only verified games count: scored live and sent from the phone of one of its players (or the club creator).
// "When" is the server's receive time, so backdating games doesn't change weeks or seasons.
// ============================================================================================================
const when = g => g.receivedAt || g.endedAt;
const verified = g => !g.logged && !!g.scoredBy;
const isNamed = n => { const s = String(n).trim(); return !!s && !/^Player \d+$/.test(s); };

export const ACHIEVEMENTS = [
  { id: 'first-win', name: 'First win', desc: 'Win a game', dinks: 10 },
  { id: 'games-10', name: 'Regular', desc: 'Play 10 games', dinks: 10 },
  { id: 'games-50', name: 'Court rat', desc: 'Play 50 games', dinks: 30 },
  { id: 'games-100', name: 'Centurion', desc: 'Play 100 games', dinks: 75 },
  { id: 'streak-5', name: 'Heater', desc: 'Win 5 games in a row', dinks: 25 },
  { id: 'streak-10', name: 'Unstoppable', desc: 'Win 10 games in a row', dinks: 60 },
  { id: 'shutout', name: 'Shutout', desc: 'Win without the other side scoring', dinks: 20 },
  { id: 'marathon', name: 'Marathon', desc: 'Win a game that goes past the target, like 13-11', dinks: 15 },
  { id: 'giant-killer', name: 'Giant killer', desc: 'Win when the forecast gave you 35% or less', dinks: 20 },
  { id: 'partners-5', name: 'Social butterfly', desc: 'Win with 5 different partners', dinks: 20 },
  { id: 'rating-4', name: 'Four point oh', desc: 'Reach a 4.00 Dink Rating', dinks: 30 },
  { id: 'rating-45', name: 'Elite', desc: 'Reach a 4.50 Dink Rating', dinks: 60 }
];

// Weekly challenges: three per week, the same for everyone, picked from this pool by the week id.
export const CHALLENGES = [
  { id: 'win-3', name: 'Win 3 games', goal: 3, dinks: 15 },
  { id: 'play-5', name: 'Play 5 games', goal: 5, dinks: 10 },
  { id: 'win-by-6', name: 'Win a game by 6 or more', goal: 1, dinks: 10 },
  { id: 'upset', name: 'Beat a team the forecast favored', goal: 1, dinks: 15 },
  { id: 'new-partner', name: "Win with a partner you've never won with", goal: 1, dinks: 15 },
  { id: 'partners-3', name: 'Play with 3 different partners', goal: 3, dinks: 15 },
  { id: 'streak-3', name: 'Win 3 in a row', goal: 3, dinks: 20 },
  { id: 'singles', name: 'Play a singles game', goal: 1, dinks: 10 }
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
export const SEASON_PRIZES = [100, 60, 40];
export const SEASON_MIN_GAMES = 5;
// Final standings of a season for one format: everyone starts at 3.50 and only that season's verified games count
// (scored live from a player's phone), so made-up results can't win a season. The app's season table uses the same rule.
export function seasonStandings(games, season, mode) {
  const inSeason = games.filter(g => verified(g) && when(g) >= season.start && when(g) < season.end && (g.mode === 'singles' ? 'singles' : 'doubles') === mode)
    .sort((a, b) => a.endedAt - b.endedAt);
  const { tables } = replay(inSeason);
  return [...tables[mode].values()].filter(p => isNamed(p.name) && p.games >= SEASON_MIN_GAMES)
    .sort((a, b) => b.rating - a.rating || b.games - a.games || a.name.localeCompare(b.name));
}

// Everything per player: base Dinks from games, bonus Dinks, achievements, weekly challenges and trophies.
export function computeProgress(games, now = Date.now()) {
  const base = computeDinks(games);
  const sorted = [...games].sort((a, b) => a.endedAt - b.endedAt);
  // Forecasts and ratings used to judge achievements and challenges (Giant killer, upsets, Four point oh) come from
  // verified games only, so logged results can't be used to set them up.
  const { pA, after } = replay(sorted.filter(verified));
  const people = new Map();
  const get = (k, name) => {
    if (!people.has(k)) people.set(k, { name, base: (base.get(k) || { earned: 0 }).earned, bonus: 0, achievements: [], weeks: {}, trophies: [],
      _s: { games: 0, streak: 0, wonWith: new Set(), achieved: new Set() } });
    return people.get(k);
  };
  for (const [k, v] of base) get(k, v.name);
  const award = (p, id, at) => {
    if (p._s.achieved.has(id)) return;
    p._s.achieved.add(id); p.achievements.push({ id, at }); p.bonus += ACHIEVEMENTS.find(x => x.id === id).dinks;
  };
  const weekState = new Map(); // player key -> Map(week id -> tallies). Nested, never a joined string, so names can't collide.
  for (const g of sorted) {
    if (!verified(g)) continue;
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
        if (r >= 4) award(p, 'rating-4', ts);
        if (r >= 4.5) award(p, 'rating-45', ts);
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
    for (const it of items) if (it.done) p.bonus += CHALLENGES.find(c => c.id === it.id).dinks;
    p.weeks[wk] = items;
  }
  // Finished seasons: the top 3 in each format get a trophy and Dinks.
  const seasons = new Map();
  for (const g of sorted) { const s = seasonOf(when(g)); if (s.end <= now) seasons.set(s.id, s); }
  for (const s of seasons.values()) for (const mode of ['doubles', 'singles']) {
    seasonStandings(sorted, s, mode).slice(0, 3).forEach((row, i) => {
      const p = get(row.key, row.name);
      p.trophies.push({ season: s.id, name: s.name, mode, place: i + 1, rating: Math.round(row.rating * 100) / 100 });
      p.bonus += SEASON_PRIZES[i];
    });
  }
  for (const p of people.values()) { p.earned = p.base + p.bonus; delete p._s; }
  return people;
}
