/* ---------- replay a game that was scored live ---------- */
// The saved game carries only who won each rally (see Scoring); every state is rebuilt here with PB.rally, so the replay
// can't disagree with the rules the game was scored by. Club games say `replay: true` and fetch the log when opened.
let replay = null; // { g, status: 'loading' | 'ready' | 'error', msg, wins, states, model, i, playing, timer, opener }
const replayLogs = {}; // game id -> log string, kept for the visit
const canReplay = g => !g.logged && !!(g.rallyLog || g.replay);
function replayBuild(r, raw) {
  const m = /^([01]):([01]{1,400})$/.exec(String(raw || ''));
  const g = r.g;
  if (m) {
    const wins = Array.from(m[2], Number);
    const states = [PB.newGame({ mode: g.mode, scoring: g.scoring, target: g.target, winBy: g.winBy, first: +m[1], teams: g.teams })];
    for (const w of wins) states.push(PB.rally(states[states.length - 1], w));
    const end = states[states.length - 1];
    // A log that doesn't end on this game's own score (say, the score was corrected on another phone) is not shown.
    if (end.winner === g.winner && end.score[0] === g.score[0] && end.score[1] === g.score[1] && states.slice(0, -1).every(s => s.winner === null)) {
      r.wins = wins; r.states = states; r.model = replayModel(states, wins); r.status = 'ready';
      return;
    }
  }
  r.status = 'error'; r.msg = "The replay for this game doesn't match its saved score, so it isn't shown.";
}
// What the chart and its caption need: the lead after each rally, side-outs, and runs of 3+ unanswered points.
function replayModel(st, wins) {
  const lead = st.map(s => s.score[0] - s.score[1]);
  const sideouts = [], runs = [];
  let cur = null;
  wins.forEach((w, k) => {
    const a = st[k], b = st[k + 1];
    if (b.serving !== a.serving) sideouts.push(k + 1);
    if (b.score[0] + b.score[1] === a.score[0] + a.score[1]) return;
    if (cur && cur.team === w) { cur.to = k + 1; cur.n++; } else { cur = { team: w, from: k + 1, to: k + 1, n: 1 }; runs.push(cur); }
  });
  const big = runs.filter(x => x.n >= 3);
  return { lead, sideouts, runs: big, best: big.reduce((a, x) => (!a || x.n > a.n ? x : a), null), span: Math.max(3, ...lead.map(Math.abs)) };
}
function openReplay(id) {
  const g = allGames().find(x => x.id === id);
  if (!g || !canReplay(g)) return;
  replayStop();
  replay = { g, status: 'loading', i: 0, playing: false, timer: null, opener: document.activeElement };
  const raw = g.rallyLog || replayLogs[id];
  if (raw) replayBuild(replay, raw);
  else if (club && API_OK) {
    const r = replay;
    api(`games?code=${encodeURIComponent(club.code)}&id=${encodeURIComponent(id)}`).then(d => {
      if (replay !== r) return;
      if (d.rallyLog) { replayLogs[id] = d.rallyLog; replayBuild(r, d.rallyLog); } else { r.status = 'error'; r.msg = 'This game has no replay.'; }
      renderReplay();
    }).catch(err => { if (replay !== r) return; r.status = 'error'; r.msg = err.offline ? "The replay can't load without a connection." : err.message; renderReplay(); });
  } else { replay.status = 'error'; replay.msg = 'This game has no replay.'; }
  renderReplay();
}
function replayStop() { if (replay && replay.timer) clearInterval(replay.timer); if (replay) { replay.timer = null; replay.playing = false; } }
function closeReplay() {
  const opener = replay && replay.opener;
  replayStop(); replay = null; renderReplay();
  if (opener && opener.isConnected) { try { opener.focus(); } catch {} }
}
function replayGo(i, keepPlaying) {
  const r = replay;
  if (!r || r.status !== 'ready') return;
  r.i = Math.max(0, Math.min(r.wins.length, i));
  if (!keepPlaying || r.i >= r.wins.length) replayStop();
  updateReplay();
}
function replayPlay() {
  const r = replay;
  if (!r || r.status !== 'ready') return;
  if (r.playing) { replayStop(); updateReplay(); return; }
  if (r.i >= r.wins.length) r.i = 0;
  r.playing = true;
  r.timer = setInterval(() => replayGo(r.i + 1, true), 900);
  updateReplay();
}
// The words for step i: who served, who won the rally, how it ended, and the score call after it.
function replayStepText(r, i) {
  const g = r.g, st = r.states, a = st[Math.max(0, i - 1)], b = st[i];
  const who = s => `${esc(g.teams[s.serving][s.server])} (${TEAM_NAME[s.serving]})`;
  const call = PB.call(b).join('-');
  if (i === 0) return { head: 'Start', text: `${who(b)} serves first. The call is ${call}.`, call };
  const w = r.wins[i - 1];
  const pts = b.score[0] + b.score[1] > a.score[0] + a.score[1];
  const how = pts ? 'point' : b.serving !== a.serving ? 'side-out' : 'second server up';
  let text = `${who(a)} served. ${TEAM_NAME[w]} won the rally: ${how}. The call is ${call}.`;
  if (i === r.wins.length) text += ` Game over: ${esc(teamLabel(g.teams[g.winner]))} won ${g.score[g.winner]}–${g.score[1 - g.winner]}.`;
  return { head: `Rally ${i}`, text, call };
}
const replayChart = r => RC.chart(r.model, r.wins.length, TEAM_NAME, esc);
/*REPLAYCHART-START*/
// The score-flow chart, shared with the public result page (build.cjs pastes this block into r.js): free of app globals.
// m: { lead, sideouts, runs, best, span } as replayModel() makes it (or the server's flow()), n: rallies, names: team names.
const RC = {
chart(m, n, names, esc, controls = true) {
  const W = 320, H = 150, L = 8, R = 8, T = 10, B = 20, mid = (T + H - B) / 2;
  const x = i => L + (i / n) * (W - L - R);
  const y = v => mid - (v / m.span) * (mid - T - 2);
  const pts = (from, to) => { const o = []; for (let i = from; i <= to; i++) o.push(`${x(i).toFixed(1)},${y(m.lead[i]).toFixed(1)}`); return o.join(' '); };
  const label = `Score flow over ${n} rallies. ${m.best ? `Longest run: ${m.best.n} unanswered points by ${names[m.best.team]}. ` : 'No run of 3 or more unanswered points. '}${m.sideouts.length} side-out${m.sideouts.length === 1 ? '' : 's'}.${controls ? ' Use the replay controls to step through it.' : ''}`;
  return `<svg class="rp-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    <line class="rp-zero" x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}"/>
    <text class="rp-ax" x="${L}" y="${T + 8}">+${m.span}</text><text class="rp-ax" x="${L}" y="${H - B - 3}">+${m.span}</text>
    ${m.sideouts.map(k => `<line class="rp-so" x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${H - B + 3}" y2="${H - B + 11}"/>`).join('')}
    <polyline class="rp-line" points="${pts(0, n)}"/>
    ${m.runs.map(u => `<polyline class="rp-run t${u.team}" points="${pts(u.from - 1, u.to)}"/>`).join('')}
    <line class="rp-cur" x1="0" x2="0" y1="${T}" y2="${H - B + 11}"/><circle class="rp-dot" r="5" cx="0" cy="0"/>
  </svg>`;
}
};
/*REPLAYCHART-END*/
function renderReplay() {
  const root = $('#sheet7');
  if (!replay) { root.innerHTML = ''; lockBody(!!(logForm || shareSheet || (live && live.open))); return; }
  lockBody(true);
  const r = replay, g = r.g;
  const head = `<div class="sheet-head"><h2 id="rp-h">Replay</h2><button type="button" class="x" data-act="replay-close" aria-label="Close replay">✕</button></div>`;
  let body;
  if (r.status === 'loading') body = `<p role="status">Loading the replay…</p>`;
  else if (r.status === 'error') body = `<p class="err" role="alert">${esc(r.msg)}</p>`;
  else {
    const m = r.model, n = r.wins.length;
    body = `<div class="chart-card rp-chart"><h3>Score flow</h3>${replayChart(r)}
      <p class="rp-sum">${m.best ? `Longest run: ${m.best.n} unanswered points by ${esc(TEAM_NAME[m.best.team])}. ` : ''}${m.sideouts.length} side-out${m.sideouts.length === 1 ? '' : 's'} in ${n} rallies.</p>
      <div class="rp-key"><span><i class="line-sw"></i>Above the line: Blue ahead. Below: Green ahead.</span><span><i class="run-sw"></i>Thick: 3 or more unanswered points</span><span><i class="so-sw"></i>Tick below: side-out</span></div></div>
      <div id="rp-now"></div><p id="rp-say" class="rp-say" role="status"></p>
      <label class="lab" for="rp-scrub">Rally</label>
      <input type="range" id="rp-scrub" class="rp-scrub" min="0" max="${n}" step="1" value="0">
      <div class="rp-ctl"><button type="button" class="btn btn-soft" data-act="replay-prev" aria-label="Previous rally">${ICON.back}Back</button>
        <button type="button" class="btn btn-ink" data-act="replay-play"></button>
        <button type="button" class="btn btn-soft" data-act="replay-next" aria-label="Next rally">Next<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button></div>`;
  }
  root.innerHTML = `<div class="sheet-bg top"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="rp-h"><span class="grip"></span>${head}
    <p class="rp-title">${esc(teamLabel(g.teams[0]))} vs ${esc(teamLabel(g.teams[1]))}, ${Number(g.score[0])}–${Number(g.score[1])}</p>${body}</div></div>`;
  if (r.status === 'ready') updateReplay();
  const first = root.querySelector('[data-act="replay-play"]') || root.querySelector('.x');
  if (first) first.focus();
}
// Redraws only what changes between steps, so the buttons and the slider keep keyboard focus.
function updateReplay() {
  const root = $('#sheet7');
  const r = replay;
  if (!root || !r || r.status !== 'ready') return;
  const g = r.g, n = r.wins.length, s = r.states[r.i], step = replayStepText(r, r.i);
  const row = t => {
    const on = s.serving === t && r.i < n;
    return `<div class="rp-team${on ? ' on' : ''}${r.i === n && g.winner === t ? ' won' : ''}" style="--c:${TEAM_COLOR[t]}"><span class="tick"></span><span class="who">${esc(teamLabel(g.teams[t]))}${on ? `<small>Serving: ${esc(g.teams[t][s.server])}</small>` : ''}</span><span class="pts">${s.score[t]}</span></div>`;
  };
  const now = root.querySelector('#rp-now');
  now.innerHTML = `<div class="rp-board">${row(0)}${row(1)}</div>`;
  const say = root.querySelector('#rp-say'); // a steady live region: announced after a manual step, silent while playing
  say.setAttribute('aria-live', r.playing ? 'off' : 'polite');
  say.innerHTML = `<b>${step.head}.</b> ${step.text}`;
  const scrub = root.querySelector('#rp-scrub');
  scrub.value = r.i;
  scrub.setAttribute('aria-valuetext', `Rally ${r.i} of ${n}, call ${step.call}`);
  root.querySelector('[data-act="replay-prev"]').disabled = r.i === 0;
  root.querySelector('[data-act="replay-next"]').disabled = r.i === n;
  const play = root.querySelector('[data-act="replay-play"]');
  const label = r.playing ? 'Pause' : r.i >= n ? 'Replay' : 'Play';
  play.setAttribute('aria-label', `${label} the replay`);
  play.innerHTML = (r.playing ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>') + label;
  const svg = root.querySelector('.rp-svg'), W = 320, L = 8, R = 8, T = 10, H = 150, B = 20, mid = (T + H - B) / 2;
  const cx = L + (r.i / n) * (W - L - R), cy = mid - (r.model.lead[r.i] / r.model.span) * (mid - T - 2);
  const cur = svg.querySelector('.rp-cur'), dot = svg.querySelector('.rp-dot');
  cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
}
// Tapping or dragging on the chart moves the replay there.
function replaySeek(e) {
  const svg = e.target.closest && e.target.closest('.rp-svg');
  if (!svg || !replay || replay.status !== 'ready') return false;
  const box = svg.getBoundingClientRect();
  const v = (e.clientX - box.left) / box.width * 320;
  replayGo(Math.round((v - 8) / (320 - 16) * replay.wins.length));
  return true;
}
