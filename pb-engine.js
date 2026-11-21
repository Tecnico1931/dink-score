// The one pickleball scoring engine, shared by the server and the app. Pure: no database, no app globals, no imports.
// The server imports it through api/_pb.js; `node build.cjs` pastes it into dink-score.html as the `PB` block
// (between PB-START/END) and the app runs that copy. Date.now() stamps startedAt/endedAt, as on both sides before.
// The Swift copy (watch/) can't share code: rerun `node tools/pb-vectors.mjs` after any change here.
// The last line, `export { ... }`, is also the list of names the app's `PB` exposes: keep it one line.
const clone = o => JSON.parse(JSON.stringify(o));
function newGame(cfg) {
  const doubles = cfg.mode === 'doubles';
  const first = cfg.first || 0;
  return {
    cfg: clone(cfg), score: [0, 0], serving: first,
    // Side-out doubles starts at 0-0-2: only one server on the first service turn.
    serverNum: doubles && cfg.scoring === 'sideout' ? 2 : 1,
    right: [0, 0],   // index of the player standing in the right-hand court, per team
    server: 0,       // index of the serving player within the serving team
    rallies: 0, switched: false, justSwitched: false, winner: null,
    startedAt: Date.now(), endedAt: null
  };
}
function switchAt(target) { return Math.ceil(target / 2); }
function rally(prev, w) {
  const s = clone(prev);
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
  const hi = Math.max(s.score[0], s.score[1]);
  if (!s.switched && hi >= switchAt(s.cfg.target)) { s.switched = true; s.justSwitched = true; }
  for (const t of [0, 1]) {
    if (s.score[t] >= s.cfg.target && s.score[t] - s.score[1 - t] >= s.cfg.winBy) { s.winner = t; s.endedAt = Date.now(); }
  }
  return s;
}
function call(s) {
  const a = s.score[s.serving], b = s.score[1 - s.serving];
  if (s.cfg.mode === 'doubles' && s.cfg.scoring === 'sideout') return [a, b, s.serverNum];
  return [a, b];
}
function serverSide(s) {
  if (s.cfg.mode === 'doubles') return s.server === s.right[s.serving] ? 'right' : 'left';
  return s.score[s.serving] % 2 === 0 ? 'right' : 'left';
}
export { newGame, rally, call, serverSide, switchAt };
