// The scoring rules, ported from the client's PB object in dink-score.html so the server can referee
// a shared live game (see api/live.js, actions 'rally' and 'unrally'). The two copies must never
// drift: tools/api-check.mjs replays the same rally sequences through both and compares every state.
export function rally(prev, w) {
  const s = JSON.parse(JSON.stringify(prev));
  s.justSwitched = false;
  if (s.winner !== null) return s;
  const doubles = s.cfg.mode === 'doubles';
  s.rallies++;
  if (s.cfg.scoring === 'rally') {
    s.score[w]++;
    if (w === s.serving) { if (doubles) s.right[w] = 1 - s.right[w]; }
    else { s.serving = w; s.server = doubles ? s.right[w] : 0; }
  } else if (w === s.serving) {
    s.score[w]++;
    if (doubles) s.right[w] = 1 - s.right[w]; // server moves to the other side and serves again
  } else if (doubles && s.serverNum === 1) {
    s.serverNum = 2; s.server = 1 - s.server; // partner serves from where they stand
  } else {
    s.serving = 1 - s.serving; s.serverNum = 1;
    s.server = doubles ? s.right[s.serving] : 0; // side out: player on the right serves first
  }
  const switchAt = Math.ceil(s.cfg.target / 2);
  const hi = Math.max(s.score[0], s.score[1]);
  if (!s.switched && hi >= switchAt) { s.switched = true; s.justSwitched = true; }
  for (const t of [0, 1]) {
    if (s.score[t] >= s.cfg.target && s.score[t] - s.score[1 - t] >= s.cfg.winBy) { s.winner = t; s.endedAt = Date.now(); }
  }
  return s;
}
export function call(s) {
  const a = s.score[s.serving], b = s.score[1 - s.serving];
  if (s.cfg.mode === 'doubles' && s.cfg.scoring === 'sideout') return [a, b, s.serverNum];
  return [a, b];
}
