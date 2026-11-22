/* ---------- rating change explanation sheet ---------- */
let ratingExplain = null; // { name, mode, scope, from }
function explainGamesFor(scope) {
  if (scope === 'season' && club) {
    const info = progressInfo();
    if (info && info.season) {
      const s = info.season;
      return ratedGames().filter(g => g.scoredBy && (g.receivedAt || g.endedAt) >= s.start && (g.receivedAt || g.endedAt) < s.end);
    }
  }
  return ratedGames();
}
function openRatingExplain(name, mode, scope, from) {
  ratingExplain = { name, mode: mode === 'singles' ? 'singles' : 'doubles', scope: scope === 'season' ? 'season' : 'all', from: from || null };
  renderRatingExplain();
  const btn = $('#sheet8 [data-act="explain-close"]');
  if (btn) btn.focus({ preventScroll: true });
}
function closeRatingExplain() {
  const back = ratingExplain && ratingExplain.from;
  ratingExplain = null;
  renderRatingExplain();
  if (back && back.isConnected) { try { back.focus({ preventScroll: true }); } catch {} }
}
function renderRatingExplain() {
  const root = $('#sheet8');
  if (!root) return;
  if (!ratingExplain) { root.innerHTML = ''; root._html = root._key = ''; return; }
  const { name, mode, scope } = ratingExplain;
  const ex = DR.explain(explainGamesFor(scope), mode, name);
  const modeLabel = mode === 'singles' ? 'Singles' : 'Doubles';
  let inner;
  if (!ex) {
    inner = `<div class="sheet-head"><h2 id="exp-h">Rating change</h2><button type="button" class="x" data-act="explain-close" aria-label="Close">✕</button></div>
      <div class="empty" style="box-shadow:none;background:var(--surface-2)"><p>No recent rated ${mode} game found for ${esc(name)}.</p></div>
      <div class="btns"><button type="button" class="btn btn-soft" data-act="explain-close">Done</button></div>`;
  } else {
    const t = DR.explainText(ex);
    const d = new Date(ex.game.endedAt);
    const when = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const v = ex.roundedDelta;
    const dCls = v === 0 ? 'flat' : v > 0 ? 'up' : 'down';
    const dTxt = v === 0 ? '±0.00' : `${v > 0 ? '▲ ' : '▼ '}${Math.abs(v).toFixed(2)}`;
    const side = ti => `<div class="side ${ex.score[ti] > ex.score[1 - ti] ? 'won' : ''}" style="--c:${TEAM_COLOR[ti]}"><small>${esc(teamLabel(ex.teams[ti]))}</small><small>Avg ${r2(ex.teamRatings[ti])}</small><b>${ex.score[ti]}</b></div>`;
    const expPct = Math.round(ex.expectedShare * 100);
    const actPct = Math.round(ex.actualShare * 100);
    const showProfileBtn = !profile || !sameName(profile.name, ex.player);
    inner = `<div class="sheet-head"><h2 id="exp-h">Why ${esc(ex.player)}’s rating moved</h2><button type="button" class="x" data-act="explain-close" aria-label="Close">✕</button></div>
      <div class="exp-hero"><span class="exp-move"><span class="exp-before">${r2(ex.before)}</span><span class="exp-sep" aria-hidden="true">→</span><span>${r2(ex.after)}</span></span><span class="exp-delta delta ${dCls}">${dTxt}</span></div>
      <div class="exp-meta"><span>${esc(when)}</span><span class="tag">${modeLabel}</span>${scope === 'season' ? '<span class="tag">Season</span>' : ''}${ex.game.logged ? '<span class="tag logged">Logged</span>' : ''}</div>
      <div class="result">${side(0)}<span class="vs">vs</span>${side(1)}</div>
      <div class="exp-grid">
        <div class="exp-box"><span class="exp-k">Forecast</span><b>${esc(t.forecastLabel)}</b><small>${expPct}% expected point share</small></div>
        <div class="exp-box"><span class="exp-k">Actual</span><b>${esc(t.actualLabel)}</b><small>${actPct}% of points${ex.capped ? ' (capped at 79%)' : ''}</small></div>
      </div>
      <div class="exp-why"><p>${esc(t.reason)}</p>${t.notes.map(n => `<p class="exp-note">${esc(n)}</p>`).join('')}</div>
      <div class="btns">${showProfileBtn ? `<button type="button" class="btn btn-soft" data-act="explain-profile">Open ${esc(ex.player)}’s profile</button>` : ''}<button type="button" class="btn btn-ink" data-act="explain-close">Done</button></div>`;
  }
  setSheet(root, `<div class="sheet-bg explain"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="exp-h"><span class="grip"></span>${inner}</div></div>`, name + '|' + mode + '|' + scope);
}
