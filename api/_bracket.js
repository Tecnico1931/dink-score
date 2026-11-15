// Single and double elimination brackets. Pure functions, no database.
//
// A bracket is { kind: 'single' | 'double', size, count, matches: [...] } where count is the number of teams and
// teams are numbered 0..count-1 in seed order (0 is the top seed). A match is
//   { id, stage: 'W' | 'L' | 'F', round, pos, slots: [a, b], status, winner, score, court,
//     winnerTo: { id, slot } | null, loserTo: { id, slot } | null }
// A slot holds a team number, null while it is still to be decided, or -1 for "nobody" (a bye).
// status: 'pending' | 'done' | 'bye' (settled without a game) | 'skipped' (a grand final reset nobody needed).
// Every function returns a new bracket and leaves its input alone.

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Seed numbers (1 is best) in bracket order for a power-of-two size, so the top two seeds can only meet in the final.
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) { const n = order.length * 2; order = order.flatMap(s => [s, n + 1 - s]); }
  return order;
}

const pow2 = n => { let s = 2; while (s < n) s *= 2; return s; };
const clone = b => JSON.parse(JSON.stringify(b));
const find = (b, id) => b.matches.find(m => m.id === id);
const blank = (id, stage, round, pos) => ({ id, stage, round, pos, slots: [null, null], status: 'pending', winner: null, score: null, court: null, winnerTo: null, loserTo: null });

export function build(count, kind = 'single') {
  if (!Number.isInteger(count) || count < 2) throw bad('A bracket needs at least 2 teams.');
  if (kind === 'double' && count < 3) throw bad('Double elimination needs at least 3 teams.');
  if (count > 32) throw bad('A bracket holds at most 32 teams.');
  const size = pow2(count), k = Math.log2(size);
  const matches = [];
  const add = m => { matches.push(m); return m; };
  const link = (from, to, slot, key = 'winnerTo') => { from[key] = { id: to.id, slot }; };

  // Winners bracket.
  const W = [];
  for (let r = 1; r <= k; r++) {
    W[r] = Array.from({ length: size / 2 ** r }, (_, p) => add(blank(`W${r}-${p}`, 'W', r, p)));
    if (r > 1) W[r - 1].forEach((m, p) => link(m, W[r][p >> 1], p & 1));
  }
  const order = seedOrder(size);
  W[1].forEach((m, p) => { m.slots = [order[2 * p] - 1, order[2 * p + 1] - 1].map(t => (t < count ? t : -1)); });

  if (kind === 'single') return settle({ kind, size, count, matches });

  // Losers bracket: round 2j-1 takes the previous losers round (or the first winners round's losers, paired off), and
  // round 2j brings in the losers dropping from winners round j+1, in reverse order so rematches come late.
  const L = [];
  for (let j = 1; j <= k - 1; j++) {
    const per = size / 2 ** (j + 1);
    L[2 * j - 1] = Array.from({ length: per }, (_, p) => add(blank(`L${2 * j - 1}-${p}`, 'L', 2 * j - 1, p)));
    L[2 * j] = Array.from({ length: per }, (_, p) => add(blank(`L${2 * j}-${p}`, 'L', 2 * j, p)));
    if (j === 1) W[1].forEach((m, p) => link(m, L[1][p >> 1], p & 1, 'loserTo'));
    else L[2 * j - 2].forEach((m, p) => link(m, L[2 * j - 1][p >> 1], p & 1));
    L[2 * j - 1].forEach((m, p) => link(m, L[2 * j][p], 0));
    W[j + 1].forEach((m, p) => link(m, L[2 * j][per - 1 - p], 1, 'loserTo'));
  }
  const F1 = add(blank('F1', 'F', 1, 0)), F2 = add(blank('F2', 'F', 2, 0));
  link(W[k][0], F1, 0);
  link(L[2 * (k - 1)][0], F1, 1);
  return settle({ kind, size, count, matches });
}

// Pushes byes and finished matches forward until nothing more can move.
function settle(b) {
  const put = (to, team) => { if (to) find(b, to.id).slots[to.slot] = team; };
  for (let moved = true; moved;) {
    moved = false;
    for (const m of b.matches) {
      if (m.status !== 'pending' || m.stage === 'F') continue;
      const [x, y] = m.slots;
      if (x === -1 && y === -1) { m.status = 'bye'; put(m.winnerTo, -1); put(m.loserTo, -1); moved = true; }
      else if ((x === -1 && y !== null) || (y === -1 && x !== null)) {
        const team = x === -1 ? y : x;
        m.status = 'bye'; m.winner = x === -1 ? 1 : 0;
        put(m.winnerTo, team); put(m.loserTo, -1); moved = true;
      }
    }
  }
  return b;
}

const known = s => s !== null && s >= 0;
export const isReady = m => m.status === 'pending' && known(m.slots[0]) && known(m.slots[1]);

// Records a result and moves the winner (and, in double elimination, the loser) on. score: [a, b] for slots 0 and 1.
export function advance(bracket, matchId, score) {
  const b = clone(bracket);
  const m = find(b, matchId);
  if (!m) throw bad('That match is not in this bracket.', 404);
  if (m.status !== 'pending') throw bad('That match has already been played.', 409);
  if (!isReady(m)) throw bad('That match is still waiting for its teams.', 409);
  const [x, y] = checkScore(score);
  m.score = [x, y]; m.status = 'done'; m.winner = x > y ? 0 : 1;
  const winner = m.slots[m.winner], loser = m.slots[1 - m.winner];
  const put = (to, team) => { if (to) find(b, to.id).slots[to.slot] = team; };
  if (m.id === 'F1') {
    // The losers bracket champion has to win twice: if they win this, the reset match decides it.
    const f2 = find(b, 'F2');
    if (m.winner === 1) f2.slots = [m.slots[0], m.slots[1]]; else f2.status = 'skipped';
  } else {
    put(m.winnerTo, winner); put(m.loserTo, loser);
  }
  return settle(b);
}

export function checkScore(score) {
  const s = Array.isArray(score) ? score.map(v => Math.trunc(Number(v))) : [];
  if (s.length !== 2 || s.some(v => !Number.isFinite(v) || v < 0 || v > 99)) throw bad('Scores must be from 0 to 99.');
  if (s[0] === s[1]) throw bad("Scores can't be tied.");
  return s;
}

// Fixes the score of a match that was already played. A different winner would change who plays next, so that is
// only allowed while the matches it feeds have not been played yet.
export function correct(bracket, matchId, score) {
  const b = clone(bracket);
  const m = find(b, matchId);
  if (!m || m.status !== 'done') throw bad('That match has not been played.', 409);
  const [x, y] = checkScore(score);
  const winner = x > y ? 0 : 1;
  if (winner !== m.winner) {
    const downstream = [m.winnerTo, m.loserTo].filter(Boolean).map(to => find(b, to.id));
    if (m.stage === 'F' || downstream.some(d => d.status !== 'pending')) {
      throw bad('Later matches have been played from this result. Correct those first.', 409);
    }
    if (m.winnerTo) find(b, m.winnerTo.id).slots[m.winnerTo.slot] = m.slots[winner];
    if (m.loserTo) find(b, m.loserTo.id).slots[m.loserTo.slot] = m.slots[1 - winner];
    m.winner = winner;
  }
  m.score = [x, y];
  return b;
}

// The champion's team number once the bracket is finished, otherwise null.
export function champion(b) {
  const final = b.kind === 'single' ? find(b, `W${Math.log2(b.size)}-0`) : find(b, 'F1');
  if (b.kind === 'double') {
    if (final.status !== 'done') return null;
    if (final.winner === 0) return final.slots[0];
    const f2 = find(b, 'F2');
    return f2.status === 'done' ? f2.slots[f2.winner] : null;
  }
  return final.status === 'done' ? final.slots[final.winner] : null;
}

// Matches that can be played now, in the order courts should be handed out: winners bracket, then losers, then the final.
export function ready(b) {
  const rank = { W: 0, L: 1, F: 2 };
  return b.matches.filter(isReady).sort((p, q) => rank[p.stage] - rank[q.stage] || p.round - q.round || p.pos - q.pos);
}

// Gives free courts (1..courts) to ready matches in order. Matches already on a court keep it.
export function assignCourts(bracket, courts) {
  const b = clone(bracket);
  const queue = ready(b);
  const busy = new Set(queue.filter(m => m.court).map(m => m.court));
  for (const m of queue) {
    if (m.court) continue;
    let c = 1;
    while (c <= courts && busy.has(c)) c++;
    if (c > courts) break;
    m.court = c; busy.add(c);
  }
  return b;
}

// Display groups in playing order, with a name for each.
export function rounds(b) {
  const out = [];
  const total = Math.log2(b.size);
  const name = (stage, r) => {
    if (stage === 'F') return r === 1 ? 'Grand final' : 'Grand final reset';
    if (b.kind === 'single') {
      const fromEnd = total - r;
      return fromEnd === 0 ? 'Final' : fromEnd === 1 ? 'Semifinals' : fromEnd === 2 ? 'Quarterfinals' : `Round ${r}`;
    }
    if (stage === 'W') return r === total ? 'Winners final' : `Winners round ${r}`;
    return r === 2 * (total - 1) ? 'Losers final' : `Losers round ${r}`;
  };
  for (const stage of ['W', 'L', 'F']) {
    const rs = [...new Set(b.matches.filter(m => m.stage === stage).map(m => m.round))].sort((p, q) => p - q);
    for (const r of rs) {
      const ms = b.matches.filter(m => m.stage === stage && m.round === r).sort((p, q) => p.pos - q.pos);
      // A round of nothing but byes (and a reset that was skipped) is not worth showing.
      if (ms.every(m => m.status === 'bye' || m.status === 'skipped')) continue;
      out.push({ key: `${stage}${r}`, title: name(stage, r), matches: ms });
    }
  }
  return out;
}
