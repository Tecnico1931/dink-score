/* ---------- Apple Watch: link a watch, the linked watches, send this game (api/_watch.js through api/live.js; the scanner is scan.js, loaded on demand) ---------- */
// pb.watch holds {linkId: revokeKey} for the watches this phone linked. Their ids go out with every game this phone publishes (publishLive), so a
// new game is on those watches without a tap, and the key lets this phone unlink what it linked. Nothing else about a watch is kept here.
let watchKeys = (() => { const o = {}; for (const [k, v] of Object.entries(store.get('pb.watch', {}))) if (/^[0-9a-f]{16}$/.test(k) && typeof v === 'string') o[k] = v; return o; })();
const watchIds = () => Object.keys(watchKeys).slice(-20);
function rememberWatch(id, key) { watchKeys[id] = key; for (const old of Object.keys(watchKeys).slice(0, -20)) delete watchKeys[old]; store.set('pb.watch', watchKeys); }
function forgetWatch(id) { delete watchKeys[id]; store.set('pb.watch', watchKeys); }
const watchCall = body => api('live', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code }, body)) });
let watchScan = null, scanMod = null;
const scanLoad = () => (scanMod ? Promise.resolve(scanMod) : import('./scan.js').then(m => (scanMod = m)));
function watchStopScan() {
  if (watchScan) { try { watchScan.stop(); } catch {} watchScan = null; }
  if (clubSheet && clubSheet.scanning) clubSheet.scanning = false;
}
function watchReattach() { if (watchScan && clubSheet && clubSheet.view === 'watch-link' && clubSheet.scanning) watchScan.attach($('#scan-video')); }
document.addEventListener('visibilitychange', () => { if (document.hidden && watchScan) { const c = clubSheet; watchStopScan(); if (c && c.view === 'watch-link') renderClub(); } });

function watchSeen(ms) {
  if (!ms) return 'not used yet';
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 2 ? 'used just now' : m < 60 ? `used ${m} min ago` : m < 1440 ? `used ${Math.round(m / 60)} h ago` : `used ${Math.round(m / 1440)} d ago`;
}
function watchHTML(c) {
  const gameOn = !!(live && !live.event);
  const url = location.origin + '/api/live';
  const fields = rows => rows.map(r => `<div class="watch-field"><span>${esc(r[0])}</span><b>${esc(r[1])}</b><small>${esc(r[2])}</small></div>`).join('');
  const recipe = (name, rows) => `<div class="ev-card" style="margin-top:10px"><h3 style="margin-top:0">${esc(name)}</h3>${fields(rows)}</div>`;
  const links = c.links;
  const list = !links ? '<p class="note">Loading…</p>' : !links.length ? '<p class="note">No watch is linked to this club yet.</p>'
    : `<ul class="club-list">${links.map(l => `<li><span><b>${esc(l.label || 'Apple Watch')}</b><small>Linked ${esc(new Date(l.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} · ${esc(l.pending ? 'waiting for the watch' : watchSeen(l.lastSeenAt))}</small></span>
      <button class="btn btn-soft" style="min-height:44px" data-act="watch-unlink" data-link="${esc(l.id)}">${c.confirmUnlink === l.id ? 'Tap again to unlink' : 'Unlink'}</button></li>`).join('')}</ul>`;
  const ready = (links || []).filter(l => !l.pending); // a watch that has not collected its link yet cannot be sent a game
  const send = gameOn && ready.length
    ? `<div class="ev-card"><h3 style="margin-top:0">This game</h3>${isShared() ? `<p class="note">A watch can score this game once it is sent to it. A game started after you link a watch goes to it by itself.</p>${ready.map(l => `<button class="btn btn-soft block" data-act="watch-send" data-link="${esc(l.id)}">Send this game to ${esc(l.label || 'the watch')}</button>`).join('')}` : '<p class="note">This game is only on this phone, so a watch cannot score it.</p>'}</div>` : '';
  return `<h2 id="club-h">Apple Watch</h2>
  <p>Score from your wrist. The watch sends each point to the club's server, which keeps the score, so the scoring phone does not need to be open and every phone in the game follows within a few seconds.</p>
  ${c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : ''}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
  <div class="field" style="margin:0"><span class="lab">Linked watches</span>${list}</div>
  <button class="btn btn-ink block" data-act="watch-link-open">Link a watch</button>
  ${send}
  <details style="margin-top:14px"><summary style="min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:600">Score with Shortcuts instead (advanced)</summary>
  <p>Make three shortcuts in the Shortcuts app on your iPhone. In each one, add the action <b>Get Contents of URL</b> and set the URL to <b>${esc(url)}</b>. Tap Show More, choose Method <b>POST</b> and Request Body <b>JSON</b>, and add the fields listed below. Then add <b>Get Dictionary Value</b> (key <b>say</b>, from Contents of URL) and <b>Show Result</b> after it, so the watch reads the score back. In the shortcut's settings, turn on <b>Show on Apple Watch</b>.</p>
  ${gameOn ? `<div class="ev-card"><h3 style="margin-top:0">This game's name and secret</h3>${fields([['game', liveGameId(), 'Text'], ['secret', liveSecret(), 'Text']])}<p class="note">Every shortcut needs both. They belong to the game on this phone right now; a new game gets a new secret, so update the shortcuts when you start one. Only people you give the secret to can send points to this game.</p></div>` : `<p class="note"><b>Start a club game first.</b> Each game gets its own name and secret, shown here once it is running, and the shortcuts below need both. Event matches are not watch-scored.</p>`}
  ${recipe('Top point: the top team on the scoring screen scores', [['code', club.code, 'Text'], ['action', 'rally', 'Text'], ['game', gameOn ? liveGameId() : 'live-…', 'Text'], ['secret', gameOn ? liveSecret() : '…', 'Text'], ['side', '0', 'Number']])}
  ${recipe('Bottom point: the bottom team scores', [['code', club.code, 'Text'], ['action', 'rally', 'Text'], ['game', gameOn ? liveGameId() : 'live-…', 'Text'], ['secret', gameOn ? liveSecret() : '…', 'Text'], ['side', '1', 'Number']])}
  ${recipe('Undo: take back the last rally', [['code', club.code, 'Text'], ['action', 'unrally', 'Text'], ['game', gameOn ? liveGameId() : 'live-…', 'Text'], ['secret', gameOn ? liveSecret() : '…', 'Text']])}
  <p class="note" style="margin-top:12px">Top and bottom are the two halves of the scoring screen. The club code alone is not enough: the server ignores any tap that does not carry this game's secret. Shortcuts made earlier with point and undo still work while the scoring phone has the game open; rally and unrally work any time.</p></details>
  <div class="btns"><button class="btn btn-soft" data-act="club-back">Back</button><button class="btn btn-soft" data-act="club-close">Done</button></div>`;
}
function watchLinkHTML(c) {
  const camera = typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  const scanned = !!c.pairId;
  const scan = scanned ? '' : c.scanning
    ? `<video id="scan-video" playsinline muted autoplay aria-label="Camera view. Hold the square code from the watch inside it." style="width:100%;max-height:260px;border-radius:14px;background:#000;object-fit:cover"></video>
       <p class="note">Looking for the square code on the watch… ${c.hint ? esc(c.hint) : 'Hold the phone steady, about a hand away.'}</p>
       <button type="button" class="btn btn-soft block" data-act="watch-scan-stop">Stop the camera</button>`
    : camera ? `<button type="button" class="btn btn-blue block" data-act="watch-scan">Scan the code with the camera</button><p class="note">Or type what the watch shows:</p>` : '<p class="note">This phone cannot scan from here. Type what the watch shows:</p>';
  return `<h2 id="club-h">Link a watch</h2>
  <p>Open Dink Score on the Apple Watch. With no game going it shows a square code, 6 characters under it and 4 numbers.</p>
  ${scan}
  <form class="club-form" data-form="watch-claim">
    ${scanned ? '<p class="note" role="status">Code scanned.</p>' : `<label class="lab" for="watch-pair">The 6 characters under the square code</label>
    <input id="watch-pair" class="field-input" maxlength="60" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="For example K7Q2ZM" value="${esc(c.pairText || '')}">`}
    <label class="lab" for="watch-confirm">The 4 numbers on the watch</label>
    <input id="watch-confirm" class="field-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="0000" value="${esc(c.confirm || '')}">
    <p class="note">The 4 numbers show that you are looking at this watch.</p>
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}<button type="submit" class="btn btn-ink" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Linking…' : 'Link this watch'}</button></form>
  <div class="btns"><button class="btn btn-soft" data-act="watch-link-back">Back</button></div>`;
}
// The watch's QR opened the phone's own camera app and so Safari, which does not share the Home Screen app's storage: no club here.
const watchOpenHTML = () => `<h2 id="club-h">Open Dink Score from your Home Screen</h2>
  <p>This link comes from the code on your Apple Watch, but this window does not know your club. Open <b>Dink Score</b> from your Home Screen, choose your club, then <b>Apple Watch</b> and <b>Link a watch</b>, and scan the code again from there.</p>
  <p class="note">Dink Score is not on your Home Screen yet? Open it in Safari, join your club, and add it with Share, then Add to Home Screen.</p>
  <div class="btns"><button class="btn btn-soft" data-act="club-close">Close</button></div>`;

function watchOpen() { clubSheet = { view: 'watch', links: null }; renderClub(); loadWatchLinks(); }
async function loadWatchLinks() {
  const c = clubSheet;
  try {
    const d = await watchCall({ action: 'watch-list' });
    if (clubSheet === c) {
      const seen = d.links || [];
      c.pending = (c.pending || []).filter(p => !seen.some(l => l.id === p.id));
      c.links = seen.concat(c.pending);
      renderClub();
      if (c.pending.length && (c.polls = (c.polls || 0) + 1) < 20) setTimeout(() => { if (clubSheet === c && c.view === 'watch') loadWatchLinks(); }, 3000);
    }
  } catch (err) { if (clubSheet === c) { c.error = err.message; c.links = c.links || []; renderClub(); } }
}
// The link in the address (#watch=<id>) comes from the QR scanned with the phone's own camera app.
function watchFromFragment(pair) {
  clubSheet = club ? { view: 'watch-link', pairId: pair } : { view: 'watch-open' };
  renderClub();
  const n = $('#watch-confirm'); if (n) n.focus();
}
async function watchScanStart() {
  const c = clubSheet;
  if (!c || c.view !== 'watch-link' || c.scanning) return;
  c.scanning = true; c.error = ''; c.hint = ''; renderClub();
  const alive = () => clubSheet === c && c.scanning && c.view === 'watch-link';
  let m;
  try {
    m = await scanLoad();
    const s = await m.startScan($('#scan-video'), text => {
      const pair = m.pairFromUrl(text, location.origin);
      if (!pair) { if (alive() && !c.hint) { c.hint = 'That is not a Dink Score watch code.'; renderClub(); } return false; }
      watchScan = null; c.scanning = false; c.pairId = pair; c.pairText = ''; c.error = ''; renderClub();
      announce('Code scanned. Type the 4 numbers shown on the watch.');
      const n = $('#watch-confirm'); if (n) n.focus();
      return true;
    });
    if (c.pairId) return; // the first look already found it and the scanner has stopped itself
    if (!alive()) { s.stop(); return; } // the person left or stopped while the camera was starting
    watchScan = s; watchReattach();
  } catch (err) {
    if (clubSheet === c) { c.scanning = false; c.error = m ? m.cameraMessage(err) : 'The scanner could not load. Type the code from the watch below.'; renderClub(); }
  }
}
async function watchClaim() {
  const c = clubSheet;
  if (!c || c.view !== 'watch-link' || c.busy) return;
  const pe = $('#watch-pair'), ce = $('#watch-confirm');
  if (pe) c.pairText = pe.value;
  if (ce) c.confirm = ce.value;
  let m;
  try { m = await scanLoad(); } catch { c.error = 'This page could not finish loading. Check your connection and try again.'; renderClub(); return; }
  const pair = c.pairId || m.cleanPair(c.pairText, location.origin), confirm4 = m.cleanConfirm(c.confirm);
  if (!pair) { c.error = 'Type the 6 characters shown under the square code on the watch, or scan the code.'; renderClub(); return; }
  if (!confirm4) { c.error = 'Type the 4 numbers shown on the watch.'; renderClub(); return; }
  watchStopScan(); c.busy = true; c.error = ''; renderClub();
  try {
    const d = await watchCall({ action: 'watch-claim', pair, confirm4 });
    rememberWatch(d.link.id, d.revokeKey);
    let sent = false;
    // A game being scored right now goes to the new watch too. The link works without it, so a failure here is not an error.
    if (live && !live.event && isShared()) { try { await watchCall({ action: 'watch-attach', link: d.link.id, game: live.id || liveGameId(), secret: liveSecret() }); sent = true; } catch {} }
    const msg = `${d.link.label || 'The watch'} is linked.${sent ? ' This game is on it now.' : ''}`;
    announce(msg);
    // The watch collects its token within a couple of seconds; until then the server does not list it, so this phone shows it as waiting.
    if (clubSheet === c) { const p = { id: d.link.id, label: d.link.label, createdAt: Date.now(), lastSeenAt: null, pending: true }; clubSheet = { view: 'watch', links: [p], pending: [p], msg }; renderClub(); loadWatchLinks(); }
  } catch (err) { if (clubSheet === c) { c.busy = false; c.error = err.message; renderClub(); } }
}
async function watchUnlink(id) {
  const c = clubSheet;
  if (c.confirmUnlink !== id) { c.confirmUnlink = id; c.msg = ''; renderClub(); return; }
  c.confirmUnlink = null; c.error = '';
  const key = watchKeys[id];
  try {
    await watchCall(Object.assign({ action: 'watch-revoke', link: id }, key ? { revokeKey: key } : adminCreds()));
    forgetWatch(id);
    if (clubSheet === c) { c.links = (c.links || []).filter(l => l.id !== id); c.pending = (c.pending || []).filter(l => l.id !== id); c.msg = 'The watch is unlinked.'; announce(c.msg); renderClub(); }
  } catch (err) {
    if (clubSheet === c) { c.error = key || err.status !== 403 ? err.message : 'Only the phone that linked this watch, or an organizer, can unlink it.'; if (err.status === 404) forgetWatch(id); renderClub(); }
  }
}
async function watchSend(id) {
  const c = clubSheet;
  if (!(live && !live.event && isShared())) return;
  c.error = ''; c.msg = '';
  try {
    await watchCall({ action: 'watch-attach', link: id, game: live.id || liveGameId(), secret: liveSecret() });
    const l = (c.links || []).find(x => x.id === id);
    c.msg = `This game is on ${l && l.label ? l.label : 'the watch'} now.`; announce(c.msg);
  } catch (err) { c.error = err.message; }
  if (clubSheet === c) renderClub();
}
function watchClick(ds) {
  const a = ds.act;
  if (a === 'watch-link-open') { clubSheet = { view: 'watch-link' }; renderClub(); return; }
  if (a === 'watch-link-back') { watchStopScan(); watchOpen(); return; }
  if (a === 'watch-scan') { watchScanStart(); return; }
  if (a === 'watch-scan-stop') { watchStopScan(); renderClub(); return; }
  if (a === 'watch-unlink') { watchUnlink(ds.link); return; }
  if (a === 'watch-send') { watchSend(ds.link); return; }
}
