/* ---------- DUPR link and send (off unless the server has DUPR keys) ---------- */
// Everything here stays hidden until GET /api/dupr says {enabled:true}. A player signs in on DUPR's own page (an iframe),
// the server confirms who they are with DUPR, and only a DUPR id and a rating are kept. Organizers review finished event
// matches and send them to DUPR after an explicit confirm. DUPR numbers are shown as labelled by DUPR and never feed the
// Dink Rating, achievements or the leaderboard order. (The self-reported rating further up is a separate thing.)
let dsso = { code: null, cfg: null, loading: false, failedAt: 0 };
let dssoUI = null; // { view: 'connect' | 'review', name, event, busy, error, review, round, ok, results }
function dssoCfg() {
  if (!club || !API_OK) return null;
  if (dsso.code === club.code && dsso.cfg) return dsso.cfg.enabled ? dsso.cfg : null;
  if (!dsso.loading && (dsso.code !== club.code || Date.now() - dsso.failedAt > 60000)) {
    const code = club.code; dsso = { code, cfg: null, loading: true, failedAt: 0 };
    api('dupr?code=' + code).then(d => { if (club && club.code === code) { dsso = { code, cfg: d, loading: false, failedAt: 0 }; if (d.enabled) { refreshDupr(); if (evScreen) renderEvents(true); dssoLazyRefresh(); } } })
      .catch(() => { dsso = { code, cfg: null, loading: false, failedAt: Date.now() }; });
  }
  return null;
}
// Once per club load, and only for this phone's own player: if the saved rating is over 6 hours old (the server's own limit),
// ask the server to read it again. Never for other players and never on a club refresh; a failure just keeps the saved rating.
async function dssoLazyRefresh() {
  const name = myName(), p = name && dsso.cfg && dsso.cfg.players && dsso.cfg.players[String(name).trim().toLowerCase()];
  if (!p || p.needsRelink || (p.at && Date.now() - p.at < 6 * 3600 * 1000)) return;
  try { const d = await dssoPost({ action: 'refresh', playerName: name }); if (!d.cached) { dssoSetPlayer(name, d.snapshot); refreshDupr(); } } catch { /* DUPR unavailable: keep what is saved */ }
}
const dssoFmt = v => (typeof v === 'number' ? v.toFixed(2) : '–');
const dssoAgo = at => { const m = Math.max(0, Math.round((Date.now() - at) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const DSSO_CONSENT = 'You sign in on DUPR’s own page, so Dink Score never sees your DUPR password. Dink Score keeps your DUPR ID and your DUPR rating, and your club sees the rating labelled as DUPR’s. If an organizer sends event scores to DUPR, what goes to DUPR is the players’ DUPR IDs, the scores, the match date and the event name. Nothing is sent without an organizer confirming it. You can revoke access in your DUPR settings, or tap Unlink here, which deletes the stored ID and rating. DUPR numbers never change your Dink Rating or leaderboard.';
// DUPR uses its production site unless the server sets DUPR_ENV=uat; in that case say so where a real account may fail.
const duprTestNote = c => DuprEntry.testMode(c) ? '<p class="note"><span class="test" style="font-weight:700">DUPR test mode.</span> This connects to DUPR’s test site (uat.dupr.gg). A real DUPR account may not sign in here, and that is not a bug in Dink Score.</p>' : '';
/*DUPRENTRY-START*/
// Which "Your DUPR" card to show. Pure, so test/duprentry.test.js can load this block alone.
const DuprEntry = {
  // cfg is the enabled /api/dupr answer or null
  state: ({ club, cfg, myName }) => (!club ? 'noclub' : !myName ? 'pickname' : cfg ? 'connect' : 'self'),
  testMode: cfg => !!cfg && cfg.env === 'uat'
};
/*DUPRENTRY-END*/
// The always-findable "Your DUPR" card: header DUPR button and the club sheet. Reuses the profile's DUPR boxes.
function yourDuprHTML(label = true) {
  const c = dssoCfg(), mine = myName();
  const st = DuprEntry.state({ club, cfg: c, myName: mine });
  const tag = DuprEntry.testMode(c) ? '<span class="test">DUPR test mode</span>' : '';
  let inner;
  if (st === 'noclub') inner = '<p class="note">DUPR linking is per club, so join or start a club first. Then you can link your DUPR here.</p><button type="button" class="btn btn-blue" data-act="club-open">Join or start a club</button>';
  else if (st === 'pickname') inner = `<p class="note">First tell ${esc(club.name)} which player you are. Pick your name, then you can connect your DUPR.</p><button type="button" class="btn btn-blue" data-act="whoami-open">Pick my name</button>`;
  else if (st === 'connect') inner = `<p class="note">You are <b>${esc(mine)}</b> in ${esc(club.name)}.</p>${duprTestNote(c)}${dssoProfileHTML(mine)}`;
  else inner = `<p class="note">You are <b>${esc(mine)}</b> in ${esc(club.name)}. Linking with DUPR is not switched on, so you can enter your rating yourself.</p>${selfDuprHTML(mine)}`;
  return `<section class="dupr-entry" aria-label="Your DUPR">${label ? '<span class="lab">Your DUPR</span>' : ''}${tag}${inner}</section>`;
}
function dssoProfileHTML(name) {
  const c = dssoCfg(); if (!c) return '';
  const p = c.players[String(name).trim().toLowerCase()];
  const can = isMe(name) || canOrganize();
  if (!p) return can ? `<div class="dupr-box"><div class="dupr-row"><span class="note">Not connected to DUPR</span><button type="button" class="link" data-dsso="connect" data-name="${esc(name)}">Connect DUPR</button></div></div>` : '';
  const r = p.rating || {};
  const prov = p.provisional || {};
  const rel = p.reliability || {};
  return `<div class="dupr-box"><div class="dupr-row"><span class="dsso-chip" aria-label="DUPR doubles ${dssoFmt(r.doubles)}, singles ${dssoFmt(r.singles)}, from DUPR">DUPR ${dssoFmt(r.doubles)}<small>doubles${prov.doubles ? ' (provisional)' : ''}</small> ${dssoFmt(r.singles)}<small>singles${prov.singles ? ' (provisional)' : ''}</small></span></div>
    <span class="note">Rating from DUPR${p.at ? `, updated ${dssoAgo(p.at)}` : ''}${rel.doubles != null || rel.singles != null ? `. Reliability ${[rel.doubles != null ? `${rel.doubles}% doubles` : '', rel.singles != null ? `${rel.singles}% singles` : ''].filter(Boolean).join(', ')}` : ''}. Not used for your Dink Rating.</span>
    ${p.needsRelink ? `<p class="err" role="alert">DUPR access ended, so this rating may be out of date. Connect again to refresh it.</p>` : ''}
    ${can ? `<div class="dupr-row">${p.needsRelink ? `<button type="button" class="link" data-dsso="connect" data-name="${esc(name)}">Connect again</button>` : `<button type="button" class="link" data-dsso="refresh" data-name="${esc(name)}">Refresh from DUPR</button>`}<button type="button" class="link armed" data-dsso="unlink" data-name="${esc(name)}">Unlink DUPR</button></div>` : ''}</div>`;
}
function dssoEventHTML(ev, org) {
  const c = dssoCfg(); if (!c || !org) return '';
  const done = [...ev.rounds.flatMap(r => r.matches), ...(ev.knockout || []).flatMap(r => r.matches)].filter(m => m.score).length;
  if (!done) return '';
  const linked = ev.players.filter(p => c.players[p.toLowerCase()]).length;
  return `<section class="ev-card" aria-labelledby="ev-dsso"><h3 id="ev-dsso">Send scores to DUPR</h3>
    <p class="note">${linked} of ${ev.players.length} players are connected to DUPR. Only matches where all four players are connected can be sent, and nothing is sent until you confirm.</p>
    ${c.paused ? `<p class="err" role="status">Sending${c.paused.club ? ' for ' + esc(c.paused.club) : ''} is paused: ${esc(c.paused.reason)}</p>` : ''}
    <div class="ev-actions"><button class="btn btn-ink ev-small" data-dsso="review-open" data-id="${esc(ev.id)}">Review and send</button></div></section>`;
}
const dssoCreds = () => Object.assign({ playerToken: myToken() || '' }, adminCreds());
const dssoTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const dssoPost = body => api('dupr', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code }, body)) });
function dssoSetPlayer(name, snap) { const c = dsso.cfg; if (c && c.players) { if (snap) c.players[name.toLowerCase()] = snap; else delete c.players[name.toLowerCase()]; } }

function renderDsso() {
  const root = $('#sheet6'); if (!root) return;
  const u = dssoUI, c = dssoCfg();
  if (!u || !c) { root.innerHTML = ''; root._html = root._key = ''; return; }
  let inner;
  if (u.view === 'connect') {
    inner = `<div class="sheet-head"><h2 id="dsso-h">Connect ${esc(u.name)} to DUPR</h2><button type="button" class="x" data-dsso="close" aria-label="Close">✕</button></div>
      ${duprTestNote(c)}
      <p class="note">${esc(DSSO_CONSENT)}</p>
      ${u.error ? `<p class="err" role="alert">${esc(u.error)}</p>` : ''}
      ${u.busy ? '<p class="note" role="status">Checking with DUPR…</p>' : `<iframe class="dsso-frame" id="dsso-frame" title="Sign in to DUPR" src="${esc(c.loginUrl)}"></iframe>`}`;
  } else {
    const r = u.review;
    const rounds = r ? r.rounds : [];
    const items = r ? r.items.filter(i => !u.round || i.round === u.round) : [];
    const ready = items.filter(i => i.state === 'ready'), failed = items.filter(i => i.state === 'failed');
    const label = { ready: 'Ready', blocked: 'Blocked', sent: 'Sent', failed: 'Refused', skipped: 'Not counted' };
    const todo = { create: 'Will be sent', update: 'Score changed: will update DUPR', delete: 'Deleted here: will be removed from DUPR' };
    const team = t => t.join(' & ');
    inner = `<div class="sheet-head"><h2 id="dsso-h">Send to DUPR</h2><button type="button" class="x" data-dsso="close" aria-label="Close">✕</button></div>
      <p class="note">${esc(u.event.name)}. Sent to DUPR: the four players’ DUPR IDs, the score, the match date and the event name. DUPR changes real ratings from these, so check them first.</p>
      ${u.error ? `<p class="err" role="alert">${esc(u.error)}</p>` : ''}
      ${!r ? skel(3) : `
        ${r.paused ? `<p class="err" role="status">Sending${r.paused.club ? ' for ' + esc(r.paused.club) : ''} is paused: ${esc(r.paused.reason)} It tries again later.</p>` : ''}
        ${u.results ? `<p class="note" role="status"><b>Done.</b> ${[['created', 'sent'], ['updated', 'updated'], ['deleted', 'removed'], ['alreadyAtDupr', 'already at DUPR'], ['failed', 'refused by DUPR'], ['retryLater', 'to retry later']].filter(([k]) => u.results[k]).map(([k, w]) => `${u.results[k]} ${w}`).join(', ') || 'Nothing to send.'}</p>` : ''}
        <p class="note"><b>${r.summary.ready}</b> ready · <b>${r.summary.blocked}</b> blocked · <b>${r.summary.sent}</b> sent${r.summary.failed ? ` · <b>${r.summary.failed}</b> refused` : ''}</p>
        ${rounds.length > 1 ? `<label class="lab" for="dsso-round">Round</label><select id="dsso-round" class="field-input" data-dsso-round><option value="">All rounds</option>${rounds.map(x => `<option value="${esc(x)}" ${u.round === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : ''}
        <ul class="dsso-list">${items.map(i => `<li class="dsso-item"><div class="top"><b>${esc(team(i.teams[0]))} vs ${esc(team(i.teams[1]))}</b><span class="badge ${i.state === 'ready' || i.state === 'sent' ? 'on' : i.state === 'blocked' || i.state === 'failed' ? 'hot' : 'prov'}">${label[i.state]}</span></div>
          <span class="note">${esc(i.round)} · ${i.score ? `${i.score[0]}–${i.score[1]}` : 'no score'}${i.state === 'ready' ? ` · ${todo[i.action] || ''}` : ''}</span>
          ${i.reasons.map(x => `<p class="bad">${esc(x.text)}</p>`).join('')}${i.note ? `<span class="note">${esc(i.note)}</span>` : ''}</li>`).join('') || '<li class="note">No finished matches yet.</li>'}</ul>
        ${ready.length || failed.length ? `<label class="dsso-check"><input type="checkbox" data-dsso-ok ${u.ok ? 'checked' : ''}><span>I checked these scores and players. Send ${ready.length} match${ready.length === 1 ? '' : 'es'} to DUPR.</span></label>
          <div class="ev-actions"><button class="btn btn-ink ev-small" data-dsso="send" ${u.ok && ready.length && !u.busy && !r.paused ? '' : 'disabled'}>${u.busy ? 'Sending…' : `Send ${ready.length} to DUPR`}</button>${failed.length ? `<button class="btn btn-soft ev-small" data-dsso="retry" ${u.ok && !u.busy && !r.paused ? '' : 'disabled'}>Try the ${failed.length} refused again</button>` : ''}</div>` : ''}`}`;
  }
  setSheet(root, `<div class="sheet-bg top"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="dsso-h"><span class="grip"></span>${inner}</div></div>`, u.view + (u.event ? u.event.id : u.name));
}
function dssoClose() { dssoUI = null; renderDsso(); }
async function dssoLink(userToken) {
  const u = dssoUI; if (!u || u.busy) return;
  u.busy = true; u.error = ''; renderDsso();
  try {
    const d = await dssoPost(Object.assign({ action: 'link', playerName: u.name, userToken }, dssoCreds()));
    dssoSetPlayer(u.name, d.snapshot);
    if (dssoUI === u) dssoUI = null;
    showToast(d.basic === false ? 'DUPR connected. DUPR shows no membership for this account yet.' : 'DUPR connected', false);
  } catch (err) { u.busy = false; u.error = err.message; }
  renderDsso(); refreshDupr();
}
async function dssoReview(quiet) {
  const u = dssoUI; if (!u) return;
  try { u.review = await dssoPost(Object.assign({ action: 'review', id: u.event.id, tz: dssoTz() }, adminCreds())); if (!quiet) u.error = ''; }
  catch (err) { if (err.status === 403) forgetPin(); u.error = err.message; u.review = u.review || { items: [], rounds: [], summary: { ready: 0, blocked: 0, sent: 0, failed: 0, skipped: 0 }, paused: null }; }
  renderDsso();
}
async function dssoSend(retryFailed) {
  const u = dssoUI; if (!u || u.busy || !u.ok) return;
  const ids = u.review.items.filter(i => (!u.round || i.round === u.round) && (i.state === 'ready' || (retryFailed && i.state === 'failed'))).map(i => i.matchId);
  if (!ids.length) return;
  u.busy = true; u.error = ''; renderDsso();
  try {
    const d = await dssoPost(Object.assign({ action: 'send', id: u.event.id, tz: dssoTz(), confirm: true, matchIds: ids, retryFailed: !!retryFailed }, adminCreds()));
    u.review = d; u.results = d.results; u.ok = false;
  } catch (err) { if (err.status === 403) forgetPin(); u.error = err.message; }
  u.busy = false; renderDsso();
}
// The login iframe reports the signed-in player with a message. Anything not from DUPR's login origin and this iframe is ignored;
// the server then asks DUPR who the token belongs to, so the message itself proves nothing.
window.addEventListener('message', e => {
  const c = dssoCfg(), fr = document.getElementById('dsso-frame');
  if (!c || !dssoUI || dssoUI.view !== 'connect' || !fr || e.origin !== c.loginOrigin || e.source !== fr.contentWindow) return;
  let d = e.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
  const t = d && (d.userToken || d.accessToken);
  if (typeof t === 'string' && t) dssoLink(t);
});
document.addEventListener('click', async e => {
  const b = e.target.closest && e.target.closest('button[data-dsso]');
  if (!b || !dssoCfg()) return;
  const a = b.dataset.dsso, name = b.dataset.name;
  if (a === 'close') dssoClose();
  else if (a === 'connect') { dssoUI = { view: 'connect', name }; renderDsso(); }
  else if (a === 'review-open') { dssoUI = { view: 'review', event: { id: b.dataset.id, name: evScreen && evScreen.event ? evScreen.event.name : 'Event' }, review: null, round: '', ok: false }; renderDsso(); dssoReview(); }
  else if (a === 'send') dssoSend(false);
  else if (a === 'retry') dssoSend(true);
  else if (a === 'refresh') {
    b.disabled = true;
    try { const d = await dssoPost({ action: 'refresh', playerName: name }); dssoSetPlayer(name, d.snapshot); showToast(d.needsRelink ? 'DUPR access ended. Connect again.' : d.cached ? 'Already up to date' : 'Rating updated from DUPR', false); }
    catch (err) { showToast(err.message, false); }
    refreshDupr();
  } else if (a === 'unlink') {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to unlink'; return; }
    try { await dssoPost(Object.assign({ action: 'unlink', playerName: name }, dssoCreds())); dssoSetPlayer(name, null); showToast('DUPR unlinked. The stored ID and rating are deleted.', false); }
    catch (err) { showToast(err.message, false); }
    refreshDupr();
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (!dssoUI) return;
  if (t.matches && t.matches('[data-dsso-round]')) { dssoUI.round = t.value; dssoUI.ok = false; renderDsso(); }
  if (t.matches && t.matches('[data-dsso-ok]')) { dssoUI.ok = t.checked; renderDsso(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && dssoUI) { e.stopImmediatePropagation(); dssoClose(); } }, true);
