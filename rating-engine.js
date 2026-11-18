// The one Dink Rating engine (v2), shared by the server and the app. Pure: no database, no app globals, no imports.
// The server imports it through api/_rating.js; `node build.cjs` pastes it into dink-score.html as the `DR` block
// (between RATING-START/END) and the app runs that copy. test/rating.test.js holds the two to the same numbers.
// The last line, `export { ... }`, is also the list of names the app's `DR` exposes: keep it one line.
/* Dink Rating: our own performance rating, inspired by how DUPR is publicly described.
   - Scale 2.00 to 8.00. New players start at 2.00. Doubles and singles are rated separately.
   - A team's rating is the average of its players.
   - Each game has an expected share of points: share = 1 / (1 + 10^(-gap / 2.8)).
     A 0.50 rating gap expects roughly 11-7.
   - After the game: change = K x (actual share - expected share). Beat the forecast and you go up, even in a loss.
     v2: the actual share is capped at 11-3 (about 0.79), so a blowout counts no more than 11-3. Under 10 games a player is provisional.
   - K shrinks as reliability grows: K = 0.06 + 0.24 x (1 - reliability).
   - Reliability = min(1, games / 20), fading after 30 days without a game (never below 40% of its value).
   Ratings are always recomputed by replaying saved games in order, so deleting a game corrects everything after it. */
// v1 -> v2: each game's actual share of points is capped at 11-3 (CAP), so a blowout moves ratings no more than 11-3 does, and
// a player is "provisional" until PROVISIONAL games. Start level (2.00) and everything else is unchanged from v1.
const VERSION = 2, START = 2, MIN = 2, MAX = 8, SCALE = 2.8, FULL = 20, PROVISIONAL = 10, CAP = 11 / 14, DAY = 864e5;
const key = n => String(n).normalize('NFC').trim().toLowerCase();
const expShare = gap => 1 / (1 + Math.pow(10, -gap / SCALE));
const isProvisional = p => !p || p.games < PROVISIONAL;
function reliability(p, now) {
  if (!p || !p.games) return 0;
  const volume = Math.min(1, p.games / FULL);
  const days = (now - p.last) / DAY;
  return volume * (days <= 30 ? 1 : Math.max(0.4, 1 - (days - 30) / 180));
}
const kFactor = rel => 0.06 + 0.24 * (1 - rel);
const clamp = r => Math.min(MAX, Math.max(MIN, r));
// Replays games in time order. `cap` is the share cap (1 = none, which is exactly v1). Returns the final tables per format,
// each game's change (`changes[id] = { expected, list: [{ name, team, before, after }] }`), and the same as `pA` / `after[id][key]`.
function compute(games, { cap = CAP } = {}) {
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
function lookup(tables, mode, name) {
  return tables[mode === 'singles' ? 'singles' : 'doubles'].get(key(name)) || null;
}
// What the setup screen shows before a game: the expected winner and score for `target` points, from the players' ratings.
function forecast(tables, mode, teams, target) {
  const tr = teams.map(t => t.reduce((s, n) => s + ((lookup(tables, mode, n) || {}).rating ?? START), 0) / t.length);
  const pA = expShare(tr[0] - tr[1]);
  const fav = pA >= 0.5 ? 0 : 1;
  const pf = fav === 0 ? pA : 1 - pA;
  const loser = Math.min(target - 1, Math.round(target * (1 - pf) / pf));
  return { pA, fav, score: fav === 0 ? [target, loser] : [loser, target], ratings: tr };
}
export { VERSION, START, MIN, MAX, SCALE, FULL, PROVISIONAL, CAP, DAY, key, expShare, isProvisional, reliability, compute, lookup, forecast };
