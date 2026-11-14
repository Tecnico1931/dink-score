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
// Expected share of points for team 0 in each game, keyed by game id.
function forecasts(sorted) {
  const tables = { doubles: new Map(), singles: new Map() };
  const out = {};
  for (const g of sorted) {
    const tot = g.score[0] + g.score[1];
    if (!tot) continue;
    const T = tables[g.mode === 'singles' ? 'singles' : 'doubles'];
    const get = n => { const k = key(n); if (!T.has(k)) T.set(k, { rating: START, games: 0, last: g.endedAt }); return T.get(k); };
    const teams = g.teams.map(t => t.map(get));
    const tr = teams.map(t => t.reduce((s, p) => s + p.rating, 0) / t.length);
    const pA = expShare(tr[0] - tr[1]);
    const sA = g.score[0] / tot;
    const updates = [];
    teams.forEach((t, ti) => t.forEach(p => updates.push([p, Math.min(MAX, Math.max(MIN, p.rating + (0.06 + 0.24 * (1 - reliability(p, g.endedAt))) * (ti === 0 ? sA - pA : pA - sA)))])));
    for (const [p, next] of updates) { p.rating = next; p.games++; p.last = g.endedAt; }
    out[g.id] = pA;
  }
  return out;
}

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
  const people = new Map(), streaks = new Map(), daily = new Map();
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
        const dk = k + '|' + day;
        const used = daily.get(dk) || 0;
        n = Math.max(0, Math.min(n, EARN.dailyCap - used));
        daily.set(dk, used + n);
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
