/* ---------- who is an organizer: the phones unlocked with the PIN, one private key each (api/_devices.js via api/club.js) ---------- */
// pins[code] is "<digits>[:<club-wide key>]" from an older app, or ":<phone key>" (80 hex) once this phone has its own key.
const odOwnKey = code => /^:[0-9a-f]{80}$/.test(pins[code] || '');
const odCanOrg = () => !!club && (isCreator() || (club.hasPin && hasOrganizer()));
const odCall = body => api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code }, body)) });
// Who this phone is linked to, so the list can name it. The server only believes it when the player token checks out.
const odWho = () => (myName() && myToken() ? { playerName: myName(), playerToken: myToken() } : {});
function odAgo(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return m + ' minutes ago';
  if (m < 1440) return Math.round(m / 60) + (Math.round(m / 60) === 1 ? ' hour ago' : ' hours ago');
  if (m < 43200) return Math.round(m / 1440) + (Math.round(m / 1440) === 1 ? ' day ago' : ' days ago');
  return new Date(ms).toLocaleDateString();
}
function odOpen() {
  clubSheet = { view: 'devices', data: null, error: '', msg: '', busy: false, armed: null };
  renderClub(); odLoad();
  const h = $('#club-h'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
}
async function odLoad() {
  const c = clubSheet;
  try {
    const d = await odCall(Object.assign({ action: 'device-list' }, adminCreds()));
    if (clubSheet === c) { c.data = d; renderClub(); }
  } catch (err) { if (clubSheet === c) { c.error = err.message; c.data = c.data || { devices: [] }; renderClub(); } }
}
// A phone that still holds the raw PIN (or the old club-wide key) trades it, once per launch, for a key of its own. After that it
// keeps no PIN, so removing this phone later really does end its access without changing the PIN for everyone.
const odTried = new Set();
async function odUpgrade() {
  if (!club || !club.hasPin || odTried.has(club.code) || !/^\d{4,8}(:[0-9a-f]{64})?$/.test(pins[club.code] || '')) return;
  odTried.add(club.code);
  const code = club.code;
  try {
    const v = await odCall(Object.assign({ action: 'verify-pin', pin: pins[code], device: true }, odWho()));
    if (v.organizerKey && club && club.code === code && /^\d{4,8}/.test(pins[code] || '')) { rememberPin(code, ':' + v.organizerKey); if (clubSheet) renderClub(); }
  } catch (e) { /* the PIN may have changed, or the network is down: it stays as it was and the next launch tries again */ }
}
// Lock this phone: the server forgets its key too (it needs only the key), so a phone that is locked can't be unlocked by copying anything.
async function odLockThis() {
  const code = club.code, key = pins[code] || '';
  let revoked = !odOwnKey(code);
  if (!revoked) { try { await odCall({ action: 'device-lock', pin: key }); revoked = true; } catch (e) { /* offline: locked here anyway, see the message */ } }
  forgetPin();
  const msg = revoked ? 'This phone is locked. Deleting games needs the PIN again.' : 'This phone is locked here, but the server could not be reached to cancel its key. Remove it from Who’s an organizer when you are online.';
  clubSheet = { view: 'club', msg }; announce(msg); renderClub(); render();
}
async function odRemove(id) {
  const c = clubSheet; if (!c || c.busy) return;
  const mine = (c.data && c.data.devices.find(d => d.id === id) || {}).you;
  if (mine) return odLockThis();
  c.busy = true; c.error = ''; c.msg = ''; renderClub();
  try {
    await odCall(Object.assign({ action: 'device-remove', id }, adminCreds()));
    c.msg = 'That phone is removed. It needs the PIN to be unlocked again.'; c.armed = null;
    await odLoad();
  } catch (err) { c.error = err.message || "Couldn't remove that phone."; }
  c.busy = false;
  if (clubSheet === c) { renderClub(); announce(c.error || c.msg); }
}
function odHTML(c) {
  const back = `<div class="btns"><button type="button" class="btn btn-soft" data-act="club-back">Back</button><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>`;
  const err = c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : '', msg = c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : '';
  const d = c.data;
  const rows = !d ? skel(3) : !d.devices.length ? '<p class="note">No phones are listed yet. A phone appears here the next time its organizer opens the app or enters the PIN.</p>'
    : `<ul class="deleted">${d.devices.map(p => `<li style="display:block"><b>${esc(p.name || 'Unnamed phone')}</b>${p.you ? ' <span class="badge on">This phone</span>' : ''}
      <span class="note" style="display:block">Unlocked ${esc(new Date(p.createdAt).toLocaleDateString())} · last used ${esc(odAgo(p.lastUsedAt))}</span>
      <div class="btns" style="margin-top:6px"><button type="button" class="btn btn-line-danger" data-od="remove" data-od-id="${esc(p.id)}" ${c.busy ? 'disabled' : ''}>${c.armed === p.id ? 'Tap again to ' : ''}${p.you ? 'Lock this phone' : 'Remove'}<span class="vh"> ${esc(p.name || 'unnamed phone')}</span></button></div></li>`).join('')}</ul>`;
  const own = pins[club.code] && !(d && d.devices.some(p => p.you)) ? `<button type="button" class="btn btn-soft block" data-od="lock" ${c.busy ? 'disabled' : ''}>Lock this phone</button>` : '';
  return `<h2 id="club-h">Who’s an organizer</h2>
    <p class="note">Phones unlocked with the organizer PIN. Remove one and only that phone loses access; the PIN and every other phone stay as they are.</p>${msg}${err}${rows}${own}
    <p class="note">${isCreator() ? 'This phone created the club, so it is always an organizer and is not listed. ' : ''}A phone that has not opened the app since this update is listed once it does. To cut off a phone that still knows the PIN, change the PIN: that locks every phone out.</p>${back}`;
}
function odAct(a, ds) {
  const c = clubSheet; if (!c || c.view !== 'devices') return;
  if (a === 'remove') { if (c.armed !== ds.odId) { c.armed = ds.odId; renderClub(); announce('Tap again to confirm.'); } else odRemove(ds.odId); }
  else if (a === 'lock') odLockThis();
}
