/* ---------- end the club season early (L21: api/_seasons.js via api/club.js) ---------- */
const seCanOrg = () => !!club && (isCreator() || (club.hasPin && hasOrganizer()));
// Same rule as the server's default: "Summer 2026" becomes "Summer 2026, part 2".
function seDefaultName(name) {
  const m = /^(.*), part (\d+)$/.exec(String(name)), tail = `, part ${m ? Number(m[2]) + 1 : 2}`;
  return (m ? m[1] : String(name)).slice(0, 40 - tail.length).trimEnd() + tail;
}
// Who would win a trophy if the season ended now: the top 3 in each format with enough games, as seasonRows() has them.
function seWinners(info) {
  return ['doubles', 'singles'].map(mode => ({ mode, rows: seasonRows(mode).filter(p => p.games >= info.season.minGames).slice(0, 3) }));
}
// The button under the season leaderboard; only organizers see it.
function seButtonHTML(season) {
  if (!season || !seCanOrg()) return '';
  return `<div class="btns" style="margin-top:12px"><button type="button" class="btn btn-soft" data-se="open">End season early</button></div>`;
}
function seOpen(opener) {
  const info = club ? progressInfo() : null;
  if (!info || !seCanOrg()) return;
  clubSheet = { view: 'season-end', seasonId: info.season.id, name: '', error: '', busy: false, opener: opener || null };
  renderClub();
  const h = $('#club-h'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
}
function seClose() {
  const back = clubSheet && clubSheet.opener;
  clubSheet = null; renderClub();
  const target = back && back.isConnected ? back : $('[data-se="open"]');
  if (target) { try { target.focus({ preventScroll: true }); } catch {} }
}
function seSheetHTML(c) {
  const info = progressInfo();
  if (!info || !seCanOrg()) return `<h2 id="club-h">End season early</h2><p class="note">Only organizers can end a season.</p><div class="btns"><button type="button" class="btn btn-soft" data-se="cancel">Done</button></div>`;
  const s = info.season, changed = s.id !== c.seasonId;
  const err = c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : '';
  if (changed) return `<h2 id="club-h">End season early</h2><p class="note" role="status">The season changed while this was open. Close this and check the current season first.</p><div class="btns"><button type="button" class="btn btn-soft" data-se="cancel">Close</button></div>`;
  const winners = seWinners(info);
  const any = winners.some(w => w.rows.length);
  const list = winners.map(w => `<div class="champ"><b>${w.mode === 'doubles' ? 'Doubles' : 'Singles'}</b>${w.rows.length ? w.rows.map((p, i) => `<span>${MEDAL[i]} ${esc(p.name)} · ${r2(p.rating)}</span>`).join('') : `<span>No one yet</span>`}</div>`).join('');
  return `<h2 id="club-h">End ${esc(s.name)} early?</h2>
    <p class="note">This closes the season now. Standings start again at 2.00 in the next season. It can’t be undone.</p>
    <div class="field" style="margin:0"><span class="lab" id="se-win-l">${any ? 'Trophies awarded now' : 'No trophies yet'}</span>
      <div class="champs" role="group" aria-labelledby="se-win-l">${list}</div>
      <p class="note">${any ? `The top 3 in each format with ${s.minGames}+ games from a club player’s phone win a trophy.` : `Nobody has ${s.minGames} games from a club player’s phone this season yet, so nobody would win a trophy.`}</p></div>
    <form class="club-form" data-form="season-end" novalidate>
      <label class="lab" for="se-name">Name the next season (optional)</label>
      <input id="se-name" class="field-input" data-se-in="name" maxlength="40" autocomplete="off" placeholder="${esc(seDefaultName(s.name))}" value="${esc(c.name)}">
      ${err}
      <button type="submit" class="btn btn-ink block" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Ending…' : 'End season now'}</button>
    </form>
    <div class="btns"><button type="button" class="btn btn-soft" data-se="cancel" ${c.busy ? 'disabled' : ''}>Cancel</button></div>`;
}
async function seSave() {
  const c = clubSheet;
  if (!c || c.view !== 'season-end' || c.busy) return;
  const field = $('#se-name'); if (field) c.name = field.value;
  c.busy = true; c.error = ''; renderClub();
  try {
    const r = await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'season-end', seasonId: c.seasonId, name: String(c.name || '').trim() }, adminCreds())) });
    if (clubSheet === c) { clubSheet = null; renderClub(); }
    lbScope = 'season'; store.set('pb.lbScope', 'season');
    await refreshClub();
    render();
    announce(`${r.closed.name} has ended. ${r.season.name} has started.`);
    showToast(`${r.season.name} has started`, false);
    const h = $('[data-lbscope="season"]'); if (h) { try { h.focus({ preventScroll: true }); } catch {} }
  } catch (err) {
    c.busy = false; c.error = err.message || "Couldn't end the season."; 
    if (clubSheet === c) { renderClub(); announce(c.error); }
  }
}
