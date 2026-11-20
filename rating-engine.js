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
function expectedScore(pA, target) {
  const fav = pA >= 0.5 ? 0 : 1;
  const pf = fav === 0 ? pA : 1 - pA;
  const loser = Math.min(target - 1, Math.round(target * (1 - pf) / pf));
  return { fav, score: fav === 0 ? [target, loser] : [loser, target] };
}
// Replays games in time order. `cap` is the share cap (1 = none, which is exactly v1). Returns the final tables per format,
// each game's change (`changes[id] = { expected, teamRatings, actualShareA, usedShareA, capped, list }`), and the same as `pA` / `after[id][key]`.
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
      if (!T.has(k)) T.set(k, { key: k, name: String(n).trim(), rating: START, games: 0, wins: 0, last: g.endedAt, delta: 0, lastGameId: null });
      return T.get(k);
    };
    const teams = g.teams.map(t => t.map(get));
    const tr = teams.map(t => t.reduce((s, p) => s + p.rating, 0) / t.length);
    const e = expShare(tr[0] - tr[1]);
    const rawShareA = g.score[0] / tot;
    const sA = Math.min(cap, Math.max(1 - cap, rawShareA));
    const updates = [];
    teams.forEach((t, ti) => t.forEach(p => {
      const rel = reliability(p, g.endedAt);
      const k = kFactor(rel);
      const raw = p.rating + k * (ti === 0 ? sA - e : e - sA);
      updates.push([p, clamp(raw), ti, rel, k, raw]);
    }));
    // applied after all are worked out, so partners and opponents all use pre-game ratings
    const list = [];
    after[g.id] = {};
    for (const [p, next, ti, rel, k, raw] of updates) {
      const before = p.rating;
      const gamesBefore = p.games;
      p.rating = next; p.delta = next - before; p.games++; p.last = g.endedAt; p.lastGameId = g.id;
      if (g.winner === ti) p.wins++;
      list.push({ name: p.name, team: ti, before, after: next, rel, k, gamesBefore, clamped: Math.abs(next - raw) > 1e-12 });
      after[g.id][p.key] = next;
    }
    changes[g.id] = { expected: e, teamRatings: tr, actualShareA: rawShareA, usedShareA: sA, capped: Math.abs(rawShareA - sA) > 1e-12, list };
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
  const { fav, score } = expectedScore(pA, target);
  return { pA, fav, score, ratings: tr };
}
// Explains a player's rating change from their latest rated game in `mode` (or a specific `gameId`), using the exact same replay math.
function explain(games, mode, name, { gameId = null, cap = CAP } = {}) {
  const m = mode === 'singles' ? 'singles' : 'doubles';
  const k = key(name);
  if (!k) return null;
  const { tables, changes } = compute(games, { cap });
  const p = tables[m].get(k);
  if (!p) return null;
  const id = gameId || p.lastGameId;
  if (!id || !changes[id]) return null;
  const g = games.find(x => x.id === id && (x.mode === 'singles' ? 'singles' : 'doubles') === m);
  if (!g) return null;
  const ch = changes[id];
  const entry = ch.list.find(x => key(x.name) === k);
  if (!entry) return null;
  const team = entry.team, opp = 1 - team;
  const score = [Number(g.score[0]), Number(g.score[1])];
  const won = g.winner !== undefined ? g.winner === team : score[team] > score[opp];
  const target = Number(g.target) > 0 ? Number(g.target) : Math.max(11, score[0], score[1]);
  const exp = expectedScore(ch.expected, target);
  const even = Math.abs(ch.expected - 0.5) < 0.02;
  const expectedShare = team === 0 ? ch.expected : 1 - ch.expected;
  const actualShare = team === 0 ? ch.actualShareA : 1 - ch.actualShareA;
  const usedShare = team === 0 ? ch.usedShareA : 1 - ch.usedShareA;
  const delta = entry.after - entry.before;
  const roundedDelta = Math.round(delta * 100) / 100;
  const gamesAfter = entry.gamesBefore + 1;
  return {
    game: g, mode: m, player: entry.name, team, teams: g.teams, teamRatings: ch.teamRatings,
    score, won, before: entry.before, after: entry.after, delta, roundedDelta,
    expectedShare, actualShare, usedShare, shareDiff: usedShare - expectedShare,
    forecast: { fav: exp.fav, even, score: exp.score, target, pA: ch.expected },
    rel: entry.rel, relPct: Math.round(entry.rel * 100), k: entry.k,
    gamesBefore: entry.gamesBefore, gamesAfter, provisional: gamesAfter < PROVISIONAL,
    capped: ch.capped,
    floorClamped: entry.clamped && entry.after === MIN,
    ceilClamped: entry.clamped && entry.after === MAX
  };
}
// Plain-English explanation of an `explain()` result. Pure, no DOM or HTML escaping.
function explainText(ex) {
  if (!ex) return null;
  const teamStr = t => ex.teams[t].map(n => String(n).trim()).join(' & ');
  const fScore = ex.forecast.score;
  const fav = ex.forecast.fav;
  const myScore = `${ex.score[ex.team]}\u2013${ex.score[1 - ex.team]}`;
  const myExp = `${fScore[ex.team]}\u2013${fScore[1 - ex.team]}`;
  const dAbs = Math.abs(ex.roundedDelta).toFixed(2);
  const forecastLabel = ex.forecast.even
    ? 'Even matchup'
    : `${teamStr(fav)} favored ${fScore[fav]}\u2013${fScore[1 - fav]}`;
  const actualLabel = `${ex.won ? 'Won' : 'Lost'} ${myScore}`;
  let reason;
  if (ex.roundedDelta === 0) {
    if (ex.floorClamped) {
      reason = `${ex.player} is already at the ${MIN.toFixed(2)} rating floor, so this loss could not lower it further.`;
    } else if (ex.ceilClamped) {
      reason = `${ex.player} is already at the ${MAX.toFixed(2)} rating ceiling, so this win could not raise it further.`;
    } else {
      reason = `The ${myScore} finish matched the forecast closely enough that ${ex.player}'s rating stayed at ${ex.after.toFixed(2)}.`;
    }
  } else if (ex.roundedDelta > 0) {
    if (!ex.won) {
      reason = `Even in a ${myScore} loss, ${ex.player} beat the ${myExp} forecast \u2014 raising the rating by +${dAbs}.`;
    } else if (!ex.forecast.even && fav !== ex.team) {
      reason = `Forecast to lose ${myExp}, ${ex.player} won ${myScore} \u2014 beating the forecast raised the rating by +${dAbs}.`;
    } else if (ex.forecast.even) {
      reason = `In an even matchup, winning ${myScore} beat the forecast and raised ${ex.player}'s rating by +${dAbs}.`;
    } else {
      reason = `Winning ${myScore} beat the ${myExp} forecast, raising ${ex.player}'s rating by +${dAbs}.`;
    }
  } else {
    if (ex.won) {
      reason = `Even in a ${myScore} win, ${ex.player} was forecast to win ${myExp} \u2014 missing that margin lowered the rating by \u2212${dAbs}.`;
    } else if (!ex.forecast.even && fav === ex.team) {
      reason = `Forecast to win ${myExp}, ${ex.player} lost ${myScore} \u2014 missing the forecast lowered the rating by \u2212${dAbs}.`;
    } else if (ex.forecast.even) {
      reason = `In an even matchup, losing ${myScore} missed the forecast and lowered ${ex.player}'s rating by \u2212${dAbs}.`;
    } else {
      reason = `Losing ${myScore} missed the ${myExp} forecast, lowering ${ex.player}'s rating by \u2212${dAbs}.`;
    }
  }
  const notes = [];
  if (ex.gamesBefore === 0) {
    notes.push(`First rated ${ex.mode} game \u2014 ratings move faster while reliability builds.`);
  } else if (ex.provisional) {
    notes.push(`Provisional (${ex.gamesAfter} of ${PROVISIONAL} games, ${ex.relPct}% reliable) \u2014 ratings move faster until reliability grows.`);
  } else {
    notes.push(`Reliability was ${ex.relPct}% before this game \u2014 ratings move more gradually as reliability grows.`);
  }
  if (ex.capped) {
    notes.push('Blowouts are capped at an 11\u20133 point share (about 79%), so running up the score did not add extra movement.');
  }
  return { forecastLabel, actualLabel, reason, notes };
}
export { VERSION, START, MIN, MAX, SCALE, FULL, PROVISIONAL, CAP, DAY, key, expShare, isProvisional, reliability, kFactor, expectedScore, compute, lookup, forecast, explain, explainText };
