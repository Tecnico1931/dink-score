/* ---------- link friendly clubs into one leaderboard (L15: api/_clublinks.js via api/club.js) ---------- */
const clCanOrg = () => !!club && (isCreator() || (club.hasPin && hasOrganizer()));
const clCall = body => api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code }, body, adminCreds())) });
function clOpen(opener) {
  clubSheet = { view: 'clublinks', opener: opener || null, data: null, error: '', msg: '', busy: false, invite: '', preview: null, standing: null, mode: 'doubles' };
  renderClub(); clLoad();
  const h = $('#club-h'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
}
async function clLoad() {
  const c = clubSheet;
  try {
    const d = await api('club?code=' + encodeURIComponent(club.code) + '&links=1', { headers: { 'Content-Type': 'application/json', 'x-club-pin': pins[club.code] || '', 'x-club-owner': owners[club.code] || '' } });
    if (clubSheet === c) { c.data = d; renderClub(); }
  } catch (err) { if (clubSheet === c) { c.error = err.message; c.data = c.data || { links: [] }; renderClub(); } }
}
async function clStanding(id, mode) {
  const c = clubSheet; if (!c) return;
  c.mode = mode || c.mode; c.standing = { id, loading: true }; renderClub();
  try {
    const d = await api('club?code=' + encodeURIComponent(club.code) + '&links=1&link=' + encodeURIComponent(id) + '&mode=' + c.mode);
    if (clubSheet === c) { c.standing = Object.assign({ id }, d); c.error = ''; renderClub(); announce(`Combined standing, ${d.rows.length} players.`); }
  } catch (err) { if (clubSheet === c) { c.standing = null; c.error = err.message; renderClub(); } }
}
// One step at a time for the two-sided consent: make an invite here, or enter the code you were given, read who it is from, and confirm.
async function clRun(fn, fail) {
  const c = clubSheet; if (!c || c.busy) return;
  c.busy = true; c.error = ''; c.msg = ''; renderClub();
  try { await fn(c); } catch (err) { c.error = err.message || fail; }
  c.busy = false;
  if (clubSheet === c) { renderClub(); if (c.error) announce(c.error); else if (c.msg) announce(c.msg); }
}
const clInvite = () => clRun(async c => { await clCall({ action: 'link-invite' }); c.msg = 'Invite made. Give the code to the other club’s organizer.'; await clLoad(); }, "Couldn't make an invite.");
const clPreview = () => clRun(async c => { const f = $('#cl-code'); if (f) c.invite = f.value; c.preview = null; const r = await clCall({ action: 'link-preview', invite: c.invite }); c.preview = r.clubName; }, "Couldn't check that code.");
const clAccept = () => clRun(async c => {
  const r = await clCall({ action: 'link-accept', invite: c.invite });
  c.invite = ''; c.preview = null; c.msg = `Linked with ${r.club}.`; await clLoad();
}, "Couldn't link the clubs.");
const clLeave = id => clRun(async c => { await clCall({ action: 'link-leave', id }); if (c.standing && c.standing.id === id) c.standing = null; c.armed = null; c.msg = 'Link removed.'; await clLoad(); }, "Couldn't remove that link.");
function clSheetHTML(c) {
  const back = `<div class="btns"><button type="button" class="btn btn-soft" data-act="club-back">Back</button><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>`;
  const err = c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : '', msg = c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : '';
  const d = c.data, st = c.standing;
  if (st && !st.loading) {
    const rows = st.rows.map(r => `<div class="prow"><div class="prow-main"><span class="rank">${r.rank == null ? '–' : r.rank}</span><span class="pinfo"><span class="pname">${esc(r.name)}${r.provisional ? '<span class="badge prov">Provisional</span>' : ''}</span><span class="pstats"><span>${esc(st.clubs[r.club])}</span><span>${r.games} game${r.games === 1 ? '' : 's'}</span></span></span></div><span class="pr"><span class="rating">${r2(r.rating)}</span></span></div>`).join('');
    return `<h2 id="club-h">${esc(st.clubs[0])} + ${esc(st.clubs[1])}</h2>
      <p class="note">Everyone from both clubs, by Dink Rating. Only names, ratings and games played are shared between linked clubs.</p>
      ${seg('data-cl-mode', [['doubles', 'Doubles'], ['singles', 'Singles']], c.mode, 'sm')}${err}
      <section class="rows" aria-live="off" style="margin-top:12px">${rows || '<p class="note">No rated players yet.</p>'}</section>
      <div class="btns"><button type="button" class="btn btn-soft" data-cl="list">Back</button><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>`;
  }
  const links = !d ? '<p class="note">Loading…</p>' : !d.links.length ? '<p class="note">Not linked with any club yet.</p>'
    : `<ul class="deleted">${d.links.map(l => `<li style="display:block"><b>${esc(l.club)}</b> <span class="note">since ${esc(new Date(l.since).toLocaleDateString())}</span>
      <div class="btns" style="margin-top:6px"><button type="button" class="btn btn-ink" data-cl="view" data-cl-id="${esc(l.id)}" ${st && st.loading ? 'disabled' : ''}>Combined standing</button>${clCanOrg() ? `<button type="button" class="btn btn-line-danger" data-cl="leave" data-cl-id="${esc(l.id)}">${c.armed === l.id ? 'Tap again to unlink' : 'Unlink'}</button>` : ''}</div></li>`).join('')}</ul>`;
  const org = !clCanOrg() ? '<p class="note">An organizer links the clubs. Anyone in either club can see the combined standing.</p>' : `
    ${d && d.pending && d.pending.length ? `<div class="field"><span class="lab">Invites waiting</span><ul class="deleted">${d.pending.map(p => `<li style="display:block"><span class="code">${esc(p.invite)}</span> <span class="note">expires ${esc(new Date(p.expiresAt).toLocaleDateString())}</span>
      <div class="btns" style="margin-top:6px"><button type="button" class="btn btn-soft" data-cl="leave" data-cl-id="${esc(p.id)}">Cancel invite</button></div></li>`).join('')}</ul></div>` : ''}
    <button type="button" class="btn btn-soft block" data-cl="invite" ${c.busy ? 'disabled' : ''}>Invite another club</button>
    <p class="note">Linking needs both clubs to agree. Give the code to the other club’s organizer; it works for 7 days and once.</p>
    ${c.preview ? `<div class="org-card" role="status"><span class="lab">Link with ${esc(c.preview)}?</span><p>Both clubs will see each other’s player names, ratings and games played in one standing. Either organizer can unlink at any time.</p>
      <div class="btns"><button type="button" class="btn btn-ink" data-cl="accept" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Linking…' : 'Link the clubs'}</button><button type="button" class="btn btn-soft" data-cl="decline">Not now</button></div></div>`
    : `<form class="club-form" data-form="cl-preview" novalidate><label class="lab" for="cl-code">Got a code from another club?</label>
      <div class="add-player"><input id="cl-code" data-cl-in="invite" value="${esc(c.invite)}" placeholder="Invite code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12"><button type="submit" class="btn btn-blue" ${c.busy ? 'disabled' : ''}>Check</button></div></form>`}`;
  return `<h2 id="club-h">Linked clubs</h2>
    <p class="note">Friendly clubs can share one leaderboard. It is visible only to the members of the linked clubs, never public.</p>${msg}${err}${links}${org}${back}`;
}
function clAct(a, ds) {
  const c = clubSheet; if (!c || c.view !== 'clublinks') return;
  if (a === 'invite') clInvite();
  else if (a === 'accept') clAccept();
  else if (a === 'decline') { c.preview = null; c.error = ''; renderClub(); }
  else if (a === 'view') clStanding(ds.clId, c.mode);
  else if (a === 'list') { c.standing = null; c.error = ''; renderClub(); }
  else if (a === 'leave') { if (c.armed !== ds.clId && c.data && c.data.links.some(l => l.id === ds.clId)) { c.armed = ds.clId; renderClub(); } else clLeave(ds.clId); }
}
