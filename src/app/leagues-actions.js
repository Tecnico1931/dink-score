async function lgRun(body, ok) {
  const s = lgScreen;
  if (!s || s.busy) return null;
  s.busy = true; s.error = ''; renderLeagues(true);
  let data = null;
  try {
    data = await lgCall(body);
    if (data.league && lgScreen === s) { s.league = data.league; s.id = data.league.id; s.nextMove = undefined; }
    s.entry = s.plan = s.rs = s.ff = null; s.armDelete = false;
    if (ok) showToast(ok, false);
  } catch (err) {
    if (err.status === 403 && body.action !== 'league-result') forgetPin();
    s.error = err.offline ? 'You are offline. Try again when you are back online.' : err.message;
  }
  s.busy = false; renderLeagues(true);
  return data;
}
function lgCreate() {
  const s = lgScreen, f = s.form;
  if (f.busy) return;
  const units = f.mode === 'singles' ? f.players.length : Math.floor(f.players.length / 2);
  const league = { kind: f.kind, name: f.name, season: f.season, mode: f.mode, players: f.players, target: f.target, scoring: f.scoring, winBy: f.winBy, resultsBy: f.resultsAny ? 'club' : 'players' };
  if (f.kind === 'ladder') Object.assign(league, { jump: f.jump, decayDays: f.decayDays });
  else Object.assign(league, { divisions: f.divisions, legs: f.legs, move: f.divisions > 1 ? Math.min(f.move, lgMaxMove(units, f.divisions)) : 0, tiebreak: f.tiebreak.slice() });
  f.busy = true; f.error = ''; renderLeagues(true);
  lgCall({ action: 'league-create', league }).then(d => {
    if (lgScreen !== s) return;
    s.view = 'detail'; s.id = d.league.id; s.league = d.league; s.loading = false; s.ch = null; s.form = null; s.error = '';
    showToast(f.kind === 'ladder' ? 'Ladder started' : 'League started', false);
  }).catch(err => { if (err.status === 403) forgetPin(); f.busy = false; f.error = err.offline ? 'You are offline. Try again when you are back online.' : err.message; }).finally(() => { f.busy = false; renderLeagues(true); });
}
const lgSavePlan = () => { const s = lgScreen, p = s.plan; lgRun({ action: 'league-schedule', id: s.league.id, week: p.n, date: p.date, time: p.time, courts: p.courts === '' ? undefined : +p.courts }, 'Week saved').then(d => { if (!d && lgScreen === s && s.plan === p) { p.error = s.error; s.error = ''; renderLeagues(true); } }); };
const lgSaveMove = () => { const s = lgScreen, r = s.rs; lgRun({ action: 'league-reschedule', id: s.league.id, matchId: r.m, date: r.date, time: r.time, court: r.court === '' ? null : +r.court }, 'Match moved').then(d => { if (!d && lgScreen === s && s.rs === r) { r.error = s.error; s.error = ''; renderLeagues(true); } }); };
const lgScores = e => { const sc = e.s.map(v => parseInt(v, 10)); return sc.some(v => !Number.isFinite(v) || v < 0 || v > 99) ? 'Enter both scores, from 0 to 99.' : sc[0] === sc[1] ? "Scores can't be tied. Pickleball games need a winner." : sc; };
async function lgSaveEntry() {
  const s = lgScreen, e = s.entry, L = s.league, sc = lgScores(e);
  if (typeof sc === 'string') { e.error = sc; renderLeagues(true); return; }
  const id = L.id, now = Date.now();
  if (e.fix) { await lgRun({ action: 'league-correct', id, matchId: e.m, score: sc }, 'Score fixed'); return; }
  queueOp({ type: 'league-result', leagueId: id, matchId: e.m, score: sc, startedAt: now, endedAt: now, rallies: 0, live: false });
  s.entry = null; renderLeagues(true); showToast('Score saved', false);
}
async function lgSaveChallenge() {
  const s = lgScreen, ch = s.ch, L = s.league, sc = lgScores({ s: ch.s });
  if (typeof sc === 'string') { ch.error = sc; renderLeagues(true); return; }
  const c = L.rows.find(r => r.name === ch.c), d = L.rows.find(r => r.name === ch.d);
  if (!c || !d) return;
  const now = Date.now();
  queueOp({ type: 'league-result', leagueId: L.id, key: ch.key, challenger: c.members, defender: d.members, score: sc, startedAt: now, endedAt: now, rallies: 0, live: false });
  s.ch = null; renderLeagues(true); showToast('Result saved', false);
}
function lgAct(a, d) {
  if (a === 'open') { lgOpen(); return; }
  if (a === 'tab-open') { lgScreen = { view: 'detail', id: d.id, league: null, loading: true, error: '', list: null, fromTab: true }; renderLeagues(true); lgLoad(d.id); return; }
  if (a === 'tab-new') { if (!club || !canOrganize()) return; lgScreen = { view: 'new', list: null, error: '', form: lgNewForm(), fromTab: true }; renderLeagues(true); return; }
  if (a === 'tab-tv') { evTabTv('league', d.id); return; }
  const s = lgScreen;
  if (!s) return;
  if (a === 'back' && s.fromTab && (s.view === 'detail' || s.view === 'new')) {
    const sel = s.view === 'new' ? '[data-lg="tab-new"]' : `[data-lg="tab-open"][data-id="${CSS.escape(s.id)}"]`;
    lgScreen = null; evTab.at = 0; renderLeagues(true); safeRender();
    const t = document.querySelector(sel) || document.querySelector('[data-lg="open"]'); if (t) t.focus({ preventScroll: true });
    return;
  }
  if (a === 'back') {
    if (s.view === 'list') { lgClose(); return; }
    s.view = 'list'; s.league = null; s.entry = s.ch = s.share = s.plan = s.rs = s.ff = null; s.error = ''; s.armDelete = s.arm = false; renderLeagues(true); lgLoadList(); return;
  }
  if (a === 'new') { s.view = 'new'; s.form = lgNewForm(); renderLeagues(true); return; }
  if (a === 'open-one') { Object.assign(s, { view: 'detail', id: d.id, league: null, loading: true, error: '', entry: null, ch: null, share: null, arm: '', plan: null, rs: null, ff: null, nextMove: undefined }); renderLeagues(true); lgLoad(d.id); return; }
  if (s.view === 'new') {
    const f = s.form;
    const units = f.mode === 'singles' ? f.players.length : Math.floor(f.players.length / 2);
    if (a === 'set') { f[d.k] = ['divisions', 'legs', 'target', 'winBy', 'decayDays'].includes(d.k) ? +d.v : d.v; f.error = ''; }
    if (a === 'step') {
      if (d.k === 'move') { const maxM = lgMaxMove(units, f.divisions); f.move = Math.min(maxM, Math.max(0, Math.min(f.move, maxM) + (+d.d))); announce(lgMoveNote(f.move)); }
      else f.jump = Math.min(10, Math.max(1, f.jump + (+d.d)));
    }
    if (a === 'tb') {
      const i = +d.i, dir = +d.d, ni = i + dir;
      if (ni >= 0 && ni < f.tiebreak.length) {
        [f.tiebreak[i], f.tiebreak[ni]] = [f.tiebreak[ni], f.tiebreak[i]];
        announce('Tie-break order: ' + f.tiebreak.map((k, idx) => `${idx + 1}. ${LG_TB_LABEL[k]}`).join(', '));
        renderLeagues(true);
        const btn = document.querySelector(`[data-lg="tb"][data-i="${ni}"][data-d="${dir}"]:not(:disabled)`) || document.querySelector(`[data-lg="tb"][data-i="${ni}"]:not(:disabled)`);
        if (btn) btn.focus({ preventScroll: true });
        return;
      }
    }
    if (a === 'pick') { const i = f.players.findIndex(x => sameName(x, d.pl)); if (i >= 0) f.players.splice(i, 1); else f.players.push(d.pl); }
    if (a === 'pick-all') f.players = roster.slice();
    if (a === 'pick-none') f.players = [];
    if (a === 'guest') {
      const el = $('#lg-guest'), v = el ? el.value.trim() : '';
      if (v && !f.players.some(x => sameName(x, v))) f.players.push(v);
      if (el) el.value = '';
    }
    renderLeagues(true);
    if (a === 'guest') { const el = $('#lg-guest'); if (el) el.focus(); }
    return;
  }
  const L = s.league;
  if (!L) return;
  if (a === 'enter') { s.entry = { m: d.m, s: ['', ''], error: '' }; renderLeagues(true); }
  else if (a === 'fix') { const m = L.weeks.flatMap(w => w.matches).find(x => x.id === d.m); s.entry = { m: d.m, s: m ? m.score.map(String) : ['', ''], fix: true, error: '' }; renderLeagues(true); }
  else if (a === 'fix-result') { const r = L.results.find(x => x.id === d.k); s.entry = { m: d.k, s: r ? r.score.map(String) : ['', ''], fix: true, error: '' }; renderLeagues(true); }
  else if (a === 'cancel') { s.entry = s.plan = s.rs = s.ff = null; renderLeagues(true); }
  else if (a === 'plan') { const w = L.weeks.find(x => x.n === +d.n); s.entry = s.rs = s.ff = null; s.plan = { n: +d.n, date: (w && w.date) || '', time: (w && w.time) || '', courts: '', error: '' }; renderLeagues(true); }
  else if (a === 'resched') { const m = L.weeks.flatMap(w => w.matches).find(x => x.id === d.m); s.entry = s.plan = s.ff = null; s.rs = { m: d.m, date: (m && m.date) || '', time: (m && m.time) || '', court: (m && m.court) || '', error: '' }; renderLeagues(true); }
  else if (a === 'forfeit') { s.entry = s.plan = s.rs = null; s.ff = d.m; renderLeagues(true); }
  else if (a === 'send-ch') { const ch = s.ch, c = L.rows.find(r => r.name === ch.c), dd = L.rows.find(r => r.name === ch.d); if (c && dd) lgRun({ action: 'league-challenge', id: L.id, key: lgKey(), challenger: c.members, defender: dd.members }, 'Challenge sent'); }
  else if (a === 'answer-ch') lgRun({ action: 'league-answer', id: L.id, challengeId: d.k, answer: d.w }, { accept: 'Challenge accepted', decline: 'Challenge declined', withdraw: 'Challenge withdrawn' }[d.w]);
  else if (a === 'forfeit-win') lgRun({ action: 'league-forfeit', id: L.id, matchId: s.ff, winner: +d.w }, 'Forfeit recorded');
  else if (a === 'forfeit-undo') lgRun({ action: 'league-forfeit', id: L.id, matchId: d.m, winner: null }, 'Forfeit undone');
  else if (a === 'notify') lgRun({ action: 'league-notify', id: L.id, week: +d.n }).then(r => { if (r) showToast(r.sent ? `Sent to ${r.sent} phone${r.sent === 1 ? '' : 's'}` : r.on ? 'Nobody has notifications on yet' : 'Notifications are not set up on this server yet', false); });
  else if (a === 'share-open' || a === 'share-new' || a === 'share-off') lgShare(a);
  else if (a === 'share-hide') { s.share = null; s.arm = ''; renderLeagues(true); }
  else if (a === 'share-copy') lgCopyLink();
  else if (a === 'end') lgRun({ action: 'league-end', id: L.id }, L.kind === 'ladder' ? 'Season closed' : 'Season finished');
  else if (a === 'step' && d.k === 'nextMove') {
    const cur = s.nextMove === undefined ? (L.move === undefined ? 1 : L.move) : s.nextMove;
    s.nextMove = Math.min(L.maxMove || 1, Math.max(0, cur + (+d.d)));
    announce(lgMoveNote(s.nextMove));
    renderLeagues(true);
  }
  else if (a === 'next') lgRun({ action: 'league-next-season', id: L.id, ...(L.divisions.length > 1 ? { move: s.nextMove === undefined ? (L.move === undefined ? 1 : L.move) : s.nextMove } : {}) }, 'Next season started');
  else if (a === 'delete') { s.armDelete = true; renderLeagues(true); }
  else if (a === 'delete-yes') lgRun({ action: 'league-delete', id: L.id }).then(d2 => { if (d2 && lgScreen === s) { s.view = 'list'; s.league = null; renderLeagues(true); lgLoadList(); } });
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('button[data-lg]');
  if (b) lgAct(b.dataset.lg, b.dataset);
});
document.addEventListener('submit', e => {
  const f = e.target.closest && e.target.closest('[data-lg-form]');
  if (!f || !lgScreen) return;
  e.preventDefault();
  const k = f.dataset.lgForm;
  if (k === 'create') lgCreate(); else if (k === 'entry') lgSaveEntry(); else if (k === 'challenge') lgSaveChallenge(); else if (k === 'plan') lgSavePlan(); else if (k === 'resched') lgSaveMove();
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && lgScreen && e.target.dataset && e.target.dataset.lgInput === 'guest') { e.preventDefault(); lgAct('guest', {}); } });
document.addEventListener('input', e => {
  const t = e.target, k = t.dataset && t.dataset.lgInput;
  if (!k || !lgScreen) return;
  if ((k === 'name' || k === 'season') && lgScreen.form) lgScreen.form[k] = t.value;
  if ((k === 's0' || k === 's1') && (lgScreen.entry || lgScreen.ch)) (lgScreen.entry || lgScreen.ch).s[+k[1]] = t.value;
  if (/^p(date|time|courts)$/.test(k) && lgScreen.plan) lgScreen.plan[k.slice(1)] = t.value;
  if (/^r(date|time|court)$/.test(k) && lgScreen.rs) lgScreen.rs[k.slice(1)] = t.value;
});
document.addEventListener('change', e => {
  const t = e.target;
  if (!lgScreen || !t.dataset) return;
  if (t.dataset.lgInput === 'resultsAny' && lgScreen.form) { lgScreen.form.resultsAny = t.checked; renderLeagues(true); }
  else if (t.dataset.lgInput === 'resultsBy' && lgScreen.league) lgRun({ action: 'league-results-by', id: lgScreen.league.id, who: t.checked ? 'club' : 'players' });
  else if (t.dataset.lgSel && lgScreen.ch) { lgScreen.ch[t.dataset.lgSel] = t.value; if (t.dataset.lgSel === 'c') lgScreen.ch.d = ''; lgScreen.ch.error = ''; renderLeagues(true); }
});
