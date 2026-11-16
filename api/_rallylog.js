// The rally log of a game scored live: who won each rally, so the game can be replayed after it is saved.
// Format: "<first server>:<one digit per rally>", e.g. "0:0110" = team 0 served first, then teams 0, 1, 1, 0 won rallies.
// Pure, no database. The scoring rules below are the server's copy of PB.rally in dink-score.html (only the parts that
// decide the score, the winner and who serves); test/rallylog.test.js holds the two to the same results.

export const MAX_LOG = 400; // cleanGame caps rallies at 999; no real game to 21 comes close to 400

export function parseLog(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_LOG + 2) return null;
  const m = /^([01]):([01]+)$/.exec(raw);
  if (!m || m[2].length > MAX_LOG) return null;
  return { first: +m[1], wins: Array.from(m[2], Number) };
}

export const encode = (first, wins) => `${first ? 1 : 0}:${wins.join('')}`;

// One rally on { score, serving, serverNum, winner }. cfg: { mode, scoring, target, winBy }.
function rally(cfg, s, w) {
  if (s.winner !== null) return s;
  const doubles = cfg.mode === 'doubles';
  const n = { score: s.score.slice(), serving: s.serving, serverNum: s.serverNum, winner: null };
  if (cfg.scoring === 'rally') {
    n.score[w]++;
    if (w !== s.serving) n.serving = w;
  } else if (w === s.serving) n.score[w]++;
  else if (doubles && s.serverNum === 1) n.serverNum = 2;
  else { n.serving = 1 - s.serving; n.serverNum = 1; }
  for (const t of [0, 1]) if (n.score[t] >= cfg.target && n.score[t] - n.score[1 - t] >= cfg.winBy) n.winner = t;
  return n;
}

// Every state of the game, from the start to the last rally (states[0] is before the first rally).
export function replay(cfg, first, wins) {
  const states = [{ score: [0, 0], serving: first, serverNum: cfg.mode === 'doubles' && cfg.scoring === 'sideout' ? 2 : 1, winner: null }];
  for (const w of wins) states.push(rally(cfg, states[states.length - 1], w));
  return states;
}

// Returns the log when it is a complete, honest record of this (already cleaned) game; null otherwise.
// Honest = valid format, replays to exactly the game's score and winner, ends on the winning rally, and has as many
// rallies as the game says. A game logged by hand has no rallies, so it never has one.
export function checkLog(game, raw) {
  const p = parseLog(raw);
  if (!p || game.logged || p.wins.length !== game.rallies) return null;
  const states = replay(game, p.first, p.wins);
  const end = states[states.length - 1];
  if (states.slice(0, -1).some(s => s.winner !== null)) return null; // rallies after the game was over
  if (end.winner === null || end.winner !== game.winner || end.score[0] !== game.score[0] || end.score[1] !== game.score[1]) return null;
  return raw;
}
