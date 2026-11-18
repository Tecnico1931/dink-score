// Dink Rating v2: the one rating engine. Pure (no database, no app globals). The server runs it from here (api/_progress.js,
// api/_rating_store.js); the app's copy is the `DR` block in dink-score.html, and test/rating.test.js holds the two to the same numbers.
// v1 -> v2: each game's actual share of points is capped at 11-3 (CAP), so a blowout moves ratings no more than 11-3 does, and
// a player is "provisional" until PROVISIONAL games. Start level (2.00) and everything else is unchanged from v1.
export const VERSION = 2, START = 2, MIN = 2, MAX = 8, SCALE = 2.8, FULL = 20, PROVISIONAL = 10, CAP = 11 / 14, DAY = 864e5;
export const key = n => String(n).normalize('NFC').trim().toLowerCase();
export const expShare = gap => 1 / (1 + Math.pow(10, -gap / SCALE));
export const isProvisional = p => !p || p.games < PROVISIONAL;
export function reliability(p, now) {
  if (!p || !p.games) return 0;
  const volume = Math.min(1, p.games / FULL);
  const days = (now - p.last) / DAY;
  return volume * (days <= 30 ? 1 : Math.max(0.4, 1 - (days - 30) / 180));
}
const kFactor = rel => 0.06 + 0.24 * (1 - rel);
const clamp = r => Math.min(MAX, Math.max(MIN, r));
// Replays games in time order. `cap` is the share cap (1 = none, which is exactly v1). Returns the final tables per format,
// each game's change (`changes[id] = { expected, list: [{ name, team, before, after }] }`), and the same as `pA` / `after[id][key]`.
export function compute(games, { cap = CAP } = {}) {
  const tables = { doubles: new Map(), singles: new Map() };
  const changes = {}, pA = {}, after = {};
  const sorted = [...games].sort((a, b) => a.endedAt - b.endedAt);
  for (const g of sorted) {
    const tot = g.score[0] + g.score[1];
    if (!tot) continue;
    const T = tables[g.mode === 'singles' ? 'singles' : 'doubles'];
    const get = n => {
      const k = key(n);
      if (!T.has(k)) T.set(k, { key: k, name: String(n).trim(), rating: START, games: 0, wins: 0, last: g.endedAt, delta: 0 });
      return T.get(k);
    };
    const teams = g.teams.map(t => t.map(get));
    const tr = teams.map(t => t.reduce((s, p) => s + p.rating, 0) / t.length);
    const e = expShare(tr[0] - tr[1]);
    const sA = Math.min(cap, Math.max(1 - cap, g.score[0] / tot));
    const updates = [];
    teams.forEach((t, ti) => t.forEach(p => updates.push([p, clamp(p.rating + kFactor(reliability(p, g.endedAt)) * (ti === 0 ? sA - e : e - sA)), ti])));
    // applied after all are worked out, so partners and opponents all use pre-game ratings
    const list = [];
    after[g.id] = {};
    for (const [p, next, ti] of updates) {
      const before = p.rating;
      p.rating = next; p.delta = next - before; p.games++; p.last = g.endedAt;
      if (g.winner === ti) p.wins++;
      list.push({ name: p.name, team: ti, before, after: next });
      after[g.id][p.key] = next;
    }
    changes[g.id] = { expected: e, list };
    pA[g.id] = e;
  }
  return { tables, changes, pA, after };
}
