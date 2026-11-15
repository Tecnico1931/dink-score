// Doubles partner rotation for events. Pure functions, no database: the same inputs always give the same round.
// Files starting with "_" are not routes.
//
// A round is { matches: [{ court, teams: [[a, b], [c, d]] }], byes: [names] }.
// Three ways to make one:
//   auto    spreads partners and opponents as evenly as it can, given every earlier round
//   random  a fresh draw each round (byes are still shared fairly)
//   manual  the organizer picks; validateRound() checks the picks

// Seeded random numbers (mulberry32), so a seed reproduces an event exactly.
export function makeRng(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = (h ^ (h >>> 16)) >>> 0 || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const pairKey = (a, b) => (a < b ? a + '\u0000' + b : b + '\u0000' + a);
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

// How often each pair has partnered and faced each other, and how many byes each player has had.
// history: earlier rounds. Players missing from a round's matches are counted as sitting out.
export function tally(players, history) {
  const t = { partner: new Map(), opp: new Map(), byes: new Map(players.map(p => [p, 0])), lastBye: new Map(players.map(p => [p, -1])) };
  history.forEach((r, i) => addRound(t, players, r, i));
  return t;
}
function addRound(t, players, r, i) {
  const playing = new Set();
  for (const m of r.matches || []) {
    const [A, B] = m.teams;
    bump(t.partner, pairKey(A[0], A[1])); bump(t.partner, pairKey(B[0], B[1]));
    for (const a of A) for (const b of B) bump(t.opp, pairKey(a, b));
    for (const p of [...A, ...B]) playing.add(p);
  }
  for (const p of players) if (!playing.has(p)) { t.byes.set(p, t.byes.get(p) + 1); t.lastBye.set(p, i); }
}
const cloneTally = t => ({ partner: new Map(t.partner), opp: new Map(t.opp), byes: new Map(t.byes), lastBye: new Map(t.lastBye) });

// Spread of the counts over every pair of players (pairs never met count as 0) and over byes.
export function fairness(players, history) {
  const t = tally(players, history);
  const span = (vals) => ({ min: Math.min(...vals), max: Math.max(...vals) });
  const pairs = [];
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) pairs.push(pairKey(players[i], players[j]));
  return {
    partner: span(pairs.map(k => t.partner.get(k) || 0)),
    opponent: span(pairs.map(k => t.opp.get(k) || 0)),
    byes: span(players.map(p => t.byes.get(p)))
  };
}

// How many matches a round can hold: one per court, four players each.
export const matchesPerRound = (playerCount, courts) => Math.max(0, Math.min(Math.floor(courts), Math.floor(playerCount / 4)));

// Who sits out: the players with the fewest byes so far, so byes never differ by more than one. Within a tie, anyone
// who sat out last round goes last (no back-to-back byes when it can be helped) and the rest is drawn from the seed.
function pickSitters(players, t, count, rand, round) {
  if (count <= 0) return [];
  const order = shuffle(players, rand);
  const justSat = p => (t.lastBye.get(p) === round - 1 ? 1 : 0);
  return order.sort((a, b) => t.byes.get(a) - t.byes.get(b) || justSat(a) - justSat(b)).slice(0, count);
}

// Cheapest way to pair up 'items' (an even count, up to 16) when pairing i with j costs w(i, j).
// Exact, by dynamic programming over subsets. The order of 'items' decides between equal-cost answers.
function cheapestPairing(items, w) {
  const m = items.length;
  const full = (1 << m) - 1;
  const best = new Float64Array(full + 1).fill(Infinity);
  const pick = new Uint8Array(full + 1);
  best[0] = 0;
  const cost = items.map((a, i) => items.map((b, j) => (i === j ? 0 : w(a, b))));
  for (let mask = 1; mask <= full; mask++) {
    let pop = 0; for (let x = mask; x; x &= x - 1) pop++;
    if (pop & 1) continue;
    const i = 31 - Math.clz32(mask & -mask);
    const rest = mask & ~(1 << i);
    for (let j = i + 1; j < m; j++) {
      if (!(rest & (1 << j))) continue;
      const c = best[rest & ~(1 << j)] + cost[i][j];
      if (c < best[mask]) { best[mask] = c; pick[mask] = j; }
    }
  }
  const pairs = [];
  for (let mask = full; mask;) {
    const i = 31 - Math.clz32(mask & -mask), j = pick[mask];
    pairs.push([items[i], items[j]]);
    mask &= ~(1 << i) & ~(1 << j);
  }
  return pairs;
}

// Greedy pairing for rounds of more than 16 players (more than four courts): a good start for the swap search below.
function greedyPairing(items, w, rand) {
  const left = shuffle(items, rand), pairs = [];
  while (left.length) {
    const a = left.shift();
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (w(a, left[i]) < w(a, left[bi])) bi = i;
    pairs.push([a, left.splice(bi, 1)[0]]);
  }
  return pairs;
}

const PARTNER_WEIGHT = 100; // partners matter far more than opponents
const BACK_TO_BACK_BYE = 30;  // a bye straight after a bye is worth less than a repeated partner

function roundCost(arr, t) {
  let c = 0;
  for (let k = 0; k < arr.length; k += 4) {
    const [a, b, x, y] = [arr[k], arr[k + 1], arr[k + 2], arr[k + 3]];
    for (const [p, q] of [[a, b], [x, y]]) { const n = t.partner.get(pairKey(p, q)) || 0; c += PARTNER_WEIGHT * n * n; }
    for (const p of [a, b]) for (const q of [x, y]) { const n = t.opp.get(pairKey(p, q)) || 0; c += n * n; }
  }
  return c;
}

// Improve an arrangement (4 slots per match: team A, team A, team B, team B) by swapping players and whole teams.
// teamsOnly keeps every partnership as it is and only moves whole teams between matches.
function improve(arr, t, teamsOnly = false) {
  let cost = roundCost(arr, t), moved = true;
  const swap = (i, j) => { const x = arr[i]; arr[i] = arr[j]; arr[j] = x; };
  while (moved) {
    moved = false;
    for (let i = 0; !teamsOnly && i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (i >> 1 === j >> 1) continue; // same team
        swap(i, j);
        const c = roundCost(arr, t);
        if (c < cost) { cost = c; moved = true; } else swap(i, j);
      }
    }
    for (let i = 0; i < arr.length; i += 2) {
      for (let j = i + 2; j < arr.length; j += 2) {
        if (i >> 2 === j >> 2) continue; // the two teams of one match: swapping them changes nothing
        swap(i, j); swap(i + 1, j + 1);
        const c = roundCost(arr, t);
        if (c < cost) { cost = c; moved = true; } else { swap(i, j); swap(i + 1, j + 1); }
      }
    }
  }
  return cost;
}

// The classic circle method: n - 1 sets of pairs in which every two players are partners exactly once.
function circleFactors(items) {
  const m = items.length, rest = items.slice(1), factors = [];
  for (let r = 0; r < m - 1; r++) {
    const row = [items[0], ...rest];
    factors.push(Array.from({ length: m / 2 }, (_, i) => [row[i], row[m - 1 - i]]));
    rest.unshift(rest.pop());
  }
  return factors;
}

// Every candidate round for a group where everyone plays: the circle sets that repeat the fewest partnerships so far,
// each with a few draws of which teams share a court (improved by moving whole teams).
function allPlayCandidates(factors, t, rand, perFactor) {
  const cost = f => f.reduce((s, [a, b]) => { const c = t.partner.get(pairKey(a, b)) || 0; return s + c * c; }, 0);
  const lowest = Math.min(...factors.map(cost));
  const out = [];
  for (const f of factors) {
    if (cost(f) !== lowest) continue;
    for (let k = 0; k < perFactor; k++) {
      const arr = shuffle(f, rand).flat();
      out.push({ arr, cost: improve(arr, t, true) });
    }
  }
  return out;
}
const oppTotal = t => { let s = 0; for (const n of t.opp.values()) s += n * n; return s; };
const asRound = arr => ({ matches: toMatches(arr) });
const partnerSlots = t => { let s = 0; for (const n of t.partner.values()) s += n; return s; };
const oppSlots = t => { let s = 0; for (const n of t.opp.values()) s += n; return s; };

// For a group where everyone plays, look for the rest of the cycle in which no pair partners more than 'pBound' times and
// no pair faces the same opponents more than 'oBound' times. With bounds 1 and 2 a full cycle is a whist schedule:
// every pair partners once and faces each other twice. Depth-first, one match at a time, with a node budget; returns the
// next round as a flat array of players (team, team, team, team, ...) or null when none is found in budget.
function searchCycle({ players, t, left, rand, pBound, oBound, budget, attempts = 1 }) {
  const n = players.length, idx = new Map(players.map((p, i) => [p, i]));
  const key = (a, b) => (a < b ? a * n + b : b * n + a);
  const partner = new Int8Array(n * n), opp = new Int8Array(n * n);
  for (const [k, v] of t.partner) { const [a, b] = k.split('\u0000'); partner[key(idx.get(a), idx.get(b))] = v; }
  for (const [k, v] of t.opp) { const [a, b] = k.split('\u0000'); opp[key(idx.get(a), idx.get(b))] = v; }
  let nodes = 0;
  const first = [];
  const free = [];
  const other = (arr, skip) => arr.filter(x => !skip.includes(x));
  function fill(depth, left0, arr) {
    if (++nodes > budget) return false;
    if (!left0.length) {
      if (depth === 0) first.push(arr.slice());
      if (depth >= left) return true;
      if (fill(depth + 1, free.slice(), [])) return true;
      if (depth === 0) first.pop();
      return false;
    }
    const i = left0[0], rest = left0.slice(1);
    for (const j of shuffle(rest.filter(j => partner[key(i, j)] < pBound), rand)) {
      const rest2 = other(rest, [j]);
      const teams = [];
      for (let a = 0; a < rest2.length; a++) for (let b = a + 1; b < rest2.length; b++) if (partner[key(rest2[a], rest2[b])] < pBound) teams.push([rest2[a], rest2[b]]);
      for (const [k, l] of shuffle(teams, rand)) {
        const pairs = [[i, k], [i, l], [j, k], [j, l]];
        if (pairs.some(([x, y]) => opp[key(x, y)] >= oBound)) continue;
        partner[key(i, j)]++; partner[key(k, l)]++;
        for (const [x, y] of pairs) opp[key(x, y)]++;
        arr.push(i, j, k, l);
        if (fill(depth, other(rest2, [k, l]), arr)) return true;
        arr.length -= 4;
        partner[key(i, j)]--; partner[key(k, l)]--;
        for (const [x, y] of pairs) opp[key(x, y)]--;
        if (nodes > budget) return false;
      }
    }
    return false;
  }
  for (let i = 0; i < n; i++) free.push(i);
  // Restarts with fresh random orders beat one long search: a bad early choice can't be undone by backtracking alone.
  for (let attempt = 0; attempt < attempts; attempt++) {
    nodes = 0;
    if (fill(0, free.slice(), [])) return first[0].map(i => players[i]);
    first.length = 0;
  }
  return null;
}

function toMatches(arr) {
  const matches = [];
  for (let k = 0; k < arr.length; k += 4) matches.push({ court: k / 4 + 1, teams: [[arr[k], arr[k + 1]], [arr[k + 2], arr[k + 3]]] });
  return matches;
}

// The next round. history: rounds so far (played or planned). mode: 'auto' | 'random'.
export function planRound({ players, courts = 1, history = [], mode = 'auto', seed = 'seed' }) {
  if (players.length < 4) throw Object.assign(new Error('Doubles needs at least 4 players.'), { status: 400 });
  const n = matchesPerRound(players.length, courts);
  const round = history.length;
  const rand = makeRng(`${seed}|${round}|${mode}`);
  const t = tally(players, history);
  const sitCount = players.length - n * 4;
  let arr, sit;
  if (mode === 'auto' && sitCount === 0) {
    // Everyone plays: partners come from the circle method, so nobody partners twice until everyone has partnered
    // everyone. Of its n - 1 sets, only those repeating the fewest partnerships so far are considered (a hand-edited
    // round just changes which are left); the best of them for opponents wins, moving whole teams between courts.
    sit = new Set();
    const factors = circleFactors(shuffle(players, makeRng(`${seed}|circle`)));
    const left = factors.length - 1 - (round % factors.length);
    const pairs = players.length * (players.length - 1) / 2;
    // A schedule that is even on both counts, if one turns up. Bigger groups rarely find one in budget; they use the
    // greedy choice below instead of a loosely bounded schedule.
    const found = searchCycle({ players, t, left, rand, budget: 4000, attempts: players.length <= 8 ? 60 : 12,
      pBound: Math.ceil((partnerSlots(t) + (left + 1) * players.length / 2) / pairs),
      oBound: Math.ceil((oppSlots(t) + (left + 1) * players.length) / pairs) });
    const cands = found ? [] : allPlayCandidates(factors, t, rand, players.length <= 12 ? 6 : 8);
    if (found) {
      arr = found;
    } else if (players.length <= 12) {
      // Small groups can afford to look ahead: play each candidate out to the end of the cycle (greedily) and keep the
      // one that leaves opponents most even.
      let bestScore = Infinity;
      for (const c of cands) {
        const tt = cloneTally(t);
        addRound(tt, players, asRound(c.arr), round);
        for (let k = 1; k <= left; k++) {
          const next = allPlayCandidates(factors, tt, rand, 2).sort((a, b) => a.cost - b.cost)[0];
          addRound(tt, players, asRound(next.arr), round + k);
        }
        const score = oppTotal(tt);
        if (score < bestScore) { bestScore = score; arr = c.arr; }
      }
    } else {
      arr = cands.sort((a, b) => a.cost - b.cost)[0].arr;
    }
  } else if (mode === 'random') {
    sit = new Set(pickSitters(players, t, sitCount, rand, round));
    arr = shuffle(players.filter(p => !sit.has(p)), rand);
  } else {
    // Each trial draws its own sitters (all equally fair) and its own tie-breaks; the cheapest round wins.
    const trials = n * 4 <= 8 ? 120 : n * 4 <= 12 ? 40 : 16;
    const w = (a, b) => { const c = t.partner.get(pairKey(a, b)) || 0; return c * c; };
    let bestCost = Infinity;
    for (let k = 0; k < trials; k++) {
      const s = new Set(pickSitters(players, t, sitCount, rand, round));
      const playing = players.filter(p => !s.has(p));
      const order = shuffle(playing, rand);
      const pairs = playing.length <= 16 ? cheapestPairing(order, w) : greedyPairing(order, w, rand);
      const cand = shuffle(pairs, rand).flat();
      const c = improve(cand, t) + BACK_TO_BACK_BYE * [...s].filter(p => t.lastBye.get(p) === round - 1).length;
      if (c < bestCost) { bestCost = c; arr = cand; sit = s; }
      if (c === 0) break;
    }
  }
  return { matches: toMatches(arr), byes: players.filter(p => sit.has(p)) };
}

// Checks a hand-picked round: every name is a player in the event, nobody twice, every team has two, at most one match per court.
// Returns the cleaned round (byes filled in) or throws a 400 with a plain message.
export function validateRound({ players, courts = 1, matches }) {
  const bad = msg => Object.assign(new Error(msg), { status: 400 });
  if (!Array.isArray(matches) || !matches.length) throw bad('Add at least one match.');
  if (matches.length > courts) throw bad(`This event has ${courts} court${courts === 1 ? '' : 's'}, so a round holds at most ${courts} match${courts === 1 ? '' : 'es'}.`);
  const known = new Map(players.map(p => [p.toLowerCase(), p]));
  const seen = new Set();
  const clean = matches.map((m, i) => {
    if (!m || !Array.isArray(m.teams) || m.teams.length !== 2) throw bad('Every match needs two teams.');
    const teams = m.teams.map(team => {
      if (!Array.isArray(team) || team.length !== 2) throw bad('Every team needs two players.');
      return team.map(name => {
        const p = known.get(String(name ?? '').trim().toLowerCase());
        if (!p) throw bad(`${String(name).slice(0, 40)} is not in this event.`);
        if (seen.has(p)) throw bad(`${p} is in more than one spot in this round.`);
        seen.add(p);
        return p;
      });
    });
    return { court: i + 1, teams };
  });
  return { matches: clean, byes: players.filter(p => !seen.has(p)) };
}
