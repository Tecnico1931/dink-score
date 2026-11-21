/* ---------- public result links (api/_resultsadmin.js via api/club.js, served at /r/<token>) ---------- */
const resultsCall = body => api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code }, body, { action: 'results-' + body.action })) });
const resultUrl = path => location.origin + path;
async function loadLinks() {
  const c = clubSheet;
  try {
    const d = await api('club?code=' + encodeURIComponent(club.code) + '&results=list', { headers: { 'Content-Type': 'application/json', 'x-club-pin': pins[club.code] || '', 'x-club-owner': owners[club.code] || '' } });
    if (clubSheet === c) { c.data = d; c.error = ''; renderClub(); }
  } catch (err) { if (clubSheet === c) { c.error = err.message; c.data = c.data || { enabled: !!club.publicResults, links: [] }; renderClub(); } }
}
async function linksAct(fn) {
  const c = clubSheet;
  try { await fn(); await refreshClub(); } catch (err) { if (clubSheet === c) c.error = err.message; }
  if (clubSheet === c) { renderClub(); loadLinks(); }
}
function linkLabel(l) {
  if (l.kind === 'session') return 'Games on ' + new Date(l.from).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const g = allGames().find(x => x.id === l.game);
  return g ? `${teamLabel(g.teams[0])} ${Number(g.score[0])}–${Number(g.score[1])} ${teamLabel(g.teams[1])}` : 'A game that is no longer in the record';
}
function linksHTML(c) {
  const d = c.data, on = d ? d.enabled : !!club.publicResults;
  const list = !d ? '<p class="note">Loading…</p>' : !d.links.length ? '<p class="note">No links yet. Players make them from a game\'s Share button.</p>'
    : `<ul class="deleted">${d.links.map(l => `<li style="display:block"><b>${esc(linkLabel(l))}</b> <span class="note">${esc(new Date(l.createdAt).toLocaleDateString())}</span><br><div class="invite"><input readonly value="${esc(resultUrl(l.path))}" aria-label="Link"></div><span class="g-actions"><button class="link" data-link-copy="${esc(l.path)}">Copy</button><button class="link" data-link-revoke="${esc(l.token)}">Turn off</button></span></li>`).join('')}</ul>`;
  return `<h2 id="club-h">Public result links</h2>
    <p class="note">${on ? 'On. Anyone in the club can make a read-only link for a finished game or a day\'s games. Whoever holds a link sees the teams, the score, the date and the score flow, nothing else: no club name, no code, no member list.' : 'Off. Turn this on to let players share a finished game or a day\'s games as a read-only link with a preview picture. Names on those games become visible to whoever receives the link.'}</p>
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
    <button class="btn ${on ? 'btn-soft' : 'btn-blue'} block" data-act="links-toggle">${on ? 'Turn off and end every link' : 'Turn on public links'}</button>
    ${on ? `<button class="btn btn-soft block" data-act="links-today">Make a link for today's games</button>${list}` : ''}
    <div class="btns"><button class="btn btn-soft" data-act="club-back">Back</button><button class="btn btn-soft" data-act="club-close">Done</button></div>`;
}
function copyText(t) {
  try { navigator.clipboard.writeText(t).then(() => showToast('Link copied', false), () => showToast(t, false)); } catch { showToast(t, false); }
}
// The link block in the share-result sheet: only for a saved club game, and only while the organizers have public links on.
function shareLinkHTML() {
  const s = shareSheet;
  if (!s || !s.gameId || !club || !club.publicResults) return '';
  if (s.link) return `<p class="note">Anyone with this link can see the teams, score and score flow. An organizer can turn it off.</p><div class="invite"><input readonly id="share-url" value="${esc(s.link)}" aria-label="Public link"></div><div class="btns"><button type="button" class="btn btn-soft block" data-act="share-link-copy">Copy link</button>${navigator.share ? '<button type="button" class="btn btn-soft block" data-act="share-link-go">Share link…</button>' : ''}</div>`;
  return `${s.linkError ? `<p class="err" role="alert">${esc(s.linkError)}</p>` : ''}<button type="button" class="btn btn-soft block" data-act="share-link" ${s.linkBusy ? 'disabled' : ''}>Get a public link</button>`;
}
function renderShareLink() { const el = $('#share-link'); if (el) el.innerHTML = shareLinkHTML(); }
async function makeShareLink() {
  const s = shareSheet;
  if (!s || !s.gameId) return;
  s.linkBusy = true; s.linkError = ''; renderShareLink();
  try { const d = await resultsCall({ action: 'create', game: s.gameId }); s.link = resultUrl(d.path); }
  catch (err) { s.linkError = err.message; }
  s.linkBusy = false;
  if (shareSheet === s) renderShareLink();
}
async function setConfirmation(required) {
  try { await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'set-confirmation', required }, adminCreds())) }); await refreshClub(); renderClub(); }
  catch (err) { showToast(err.message, false); }
}
const AUDIT_WORDS = { create: 'Recorded', edit: 'Edited', delete: 'Deleted', restore: 'Restored', confirm: 'Confirmed', 'keep-both': 'Kept as two games', setting: 'Setting changed' };
const auditWho = a => (a === 'creator' ? 'the club creator' : a === 'organizer-pin' ? 'an organizer (PIN)' : a === 'member' ? 'a club member' : /^player:/.test(a) ? a.slice(7) : 'someone with the club code');
async function loadAudit() {
  const c = clubSheet;
  try {
    const d = await api('games?code=' + encodeURIComponent(club.code) + '&audit=1', { headers: { 'Content-Type': 'application/json', 'x-club-pin': pins[club.code] || '', 'x-club-owner': owners[club.code] || '' } });
    if (clubSheet === c) { c.rows = d.audit; renderClub(); }
  } catch (err) { if (clubSheet === c) { c.error = err.message; c.rows = []; renderClub(); } }
}
function auditHTML(c) {
  const res = g => g ? `${esc(teamLabel(g.teams[0]))} ${Number(g.score[0])}\u2013${Number(g.score[1])} ${esc(teamLabel(g.teams[1]))}` : '';
  const rows = !c.rows ? '<p class="note">Loading\u2026</p>' : !c.rows.length ? '<p>Nothing recorded yet. Changes to games from now on show up here.</p>'
    : `<ul class="deleted">${c.rows.map(r => `<li style="display:block"><b>${esc(AUDIT_WORDS[r.action] || r.action)}</b> ${esc(res(r.after || r.before))}${r.before && r.after && r.action === 'edit' ? ` <span class="note">(was ${esc(res(r.before))})</span>` : ''}<br><span class="note">${esc(new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} by ${esc(auditWho(r.actor))}${r.note ? ', ' + esc(r.note) : ''}</span></li>`).join('')}</ul>`;
  return `<h2 id="club-h">Game history</h2><p class="note">Newest first: who recorded, edited, deleted or confirmed each game. Only organizers see this.</p>${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}${rows}<div class="btns"><button class="btn btn-soft" data-act="club-back">Back</button><button class="btn btn-soft" data-act="club-close">Done</button></div>`;
}
async function adminAction(body, okMsg) {
  try { await playerCall(Object.assign(body, adminCreds())); showToast(okMsg, false); await refreshClub(); await loadMembers(); renderClub(); }
  catch (err) { showToast(err.message, false); }
}
// Members sheet extras only organizers can read: who is blocked, and the log of role changes and removals.
async function loadMembers() {
  if (!club || !clubSheet || clubSheet.view !== 'members') return;
  try { const d = await playerCall(Object.assign({ action: 'members' }, adminCreds())); if (clubSheet && clubSheet.view === 'members') { clubSheet.membersData = d; renderClub(); } } catch (e) { /* the list still works without it */ }
}
function auditText(a) {
  const who = a.actor === 'owner' ? 'The club creator' : a.actor === 'pin' ? 'Someone with the organizer PIN' : a.actor === 'organizer' ? `${a.actorName} (organizer)` : (a.actorName || 'A member');
  const t = a.target || 'a member';
  const did = { promote: `made ${t} an organizer`, demote: `made ${t} a regular member`, remove: `removed ${t}${a.detail && a.detail.block ? ' and blocked the name' : ''}`, unblock: `unblocked ${t}`, release: `released ${t}`, leave: 'left the member list', rename: `renamed ${a.detail && a.detail.from ? a.detail.from + ' to ' : ''}${t}`, merge: `merged ${a.detail && a.detail.from ? a.detail.from : 'a player'} into ${t}`, undo: `undid ${a.detail && a.detail.undid === 'rename' ? `the rename of ${a.detail.from} (back to ${t})` : a.detail && a.detail.undid === 'promote' ? `making ${t} an organizer` : a.detail && a.detail.undid === 'demote' ? `making ${t} a regular member` : 'a change'}`, 'approve-claim': `approved ${t} on a new phone`, 'deny-claim': `said no to the request for ${t}` }[a.action] || a.action;
  return `${who} ${did}`;
}
function memberLeave(el) {
  if (!clubSheet.confirmLeave) { clubSheet.confirmLeave = true; el.textContent = 'Tap again to leave'; return; }
  const name = myName(), token = myToken();
  playerCall({ action: 'leave', name, playerToken: token }).then(() => {
    delete me[club.code]; store.set('pb.me', me); if (isCoOrganizer()) { delete owners[club.code]; store.set('pb.owners', owners); }
    clubSheet = { view: 'club', msg: `${name} is off the member list. Your games and ratings stay.` }; showToast('You left the member list', false);
    refreshClub().then(() => { render(); renderClub(); });
  }).catch(err => showToast(err.message, false));
}

