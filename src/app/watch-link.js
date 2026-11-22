/* ---------- Apple Watch: link a watch, the linked watches, send this game (api/_watch.js through api/live.js; the scanner is scan.js, loaded on demand) ---------- */
// pb.watch holds {linkId: revokeKey} for the watches this phone linked. Their ids go out with every game this phone publishes (publishLive), so a
// new game is on those watches without a tap, and the key lets this phone unlink what it linked. Nothing else about a watch is kept here.
let watchKeys = (() => { const o = {}; for (const [k, v] of Object.entries(store.get('pb.watch', {}))) if (/^[0-9a-f]{16}$/.test(k) && typeof v === 'string') o[k] = v; return o; })();
const watchIds = () => Object.keys(watchKeys).slice(-20);
function rememberWatch(id, key) { watchKeys[id] = key; for (const old of Object.keys(watchKeys).slice(0, -20)) delete watchKeys[old]; store.set('pb.watch', watchKeys); }
function forgetWatch(id) { delete watchKeys[id]; store.set('pb.watch', watchKeys); }
const watchCall = body => api('live', { method: 'POST', body: JSON.stringify(Object.assign({ code: liveCode() || club.code }, body)) }); // a game with no club is held in its quick game room
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
  const all = c.links, gid = gameOn ? (live.id || liveGameId()) : '';
  const links = all && all.filter(l => !l.game), mine = all ? all.filter(l => l.game && l.game === gid) : []; // single-game watches are listed under their own game
  const row = (l, btn) => `<li><span><b>${esc(l.label || 'Apple Watch')}</b><small>Linked ${esc(new Date(l.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} · ${esc(l.pending ? 'waiting for the watch' : watchSeen(l.lastSeenAt))}</small></span>${btn}</li>`;
  const unlinkBtn = l => `<button class="btn btn-soft" style="min-height:44px" data-act="watch-unlink" data-link="${esc(l.id)}">${c.confirmUnlink === l.id ? 'Tap again to unlink' : 'Unlink'}</button>`;
  const list = !links ? skel(3) : !links.length ? '<p class="note">No watch is linked to this club yet.</p>'
    : `<ul class="club-list">${links.map(l => `<li><span><b>${esc(l.label || 'Apple Watch')}</b><small>Linked ${esc(new Date(l.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} · ${esc(l.pending ? 'waiting for the watch' : watchSeen(l.lastSeenAt))}</small></span>
      <button class="btn btn-soft" style="min-height:44px" data-act="watch-unlink" data-link="${esc(l.id)}">${c.confirmUnlink === l.id ? 'Tap again to unlink' : 'Unlink'}</button></li>`).join('')}</ul>`;
  const ready = (links || []).filter(l => !l.pending); // a watch that has not collected its link yet cannot be sent a game
  const sendBtns = ready.length ? `<p class="note">A club watch can score this game once it is sent to it. A game started after you link a watch goes to it by itself.</p>${ready.map(l => `<button class="btn btn-soft block" data-act="watch-send" data-link="${esc(l.id)}">Send this game to ${esc(l.label || 'the watch')}</button>`).join('')}` : '';
  const send = gameOn
    ? `<div class="ev-card"><h3 style="margin-top:0">This game</h3>${isShared() ? `<p class="note">Link a watch to this game only: it can score this game and nothing else, needs no club link, and stops when the game ends.</p>
      <button class="btn btn-blue block" data-act="watch-offer">Show a code for the watch to type</button>
      <button class="btn btn-soft block" data-act="watch-game-open">Link a watch to this game only (scan or type its code)</button>
      ${mine.length ? `<ul class="club-list">${mine.map(l => row(l, unlinkBtn(l))).join('')}</ul>` : ''}${sendBtns}` : '<p class="note">This game is only on this phone, so a watch cannot score it.</p>'}</div>` : '';
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
  const gameOn = !!(live && !live.event && isShared());
  return `<h2 id="club-h">${c.single ? 'Link a watch to this game' : 'Link a watch'}</h2>
  <p>Open Dink Score on the Apple Watch. With no game going it shows a square code, 6 characters under it and 4 numbers.</p>
  ${scan}
  <form class="club-form" data-form="watch-claim">
    ${scanned ? `<p class="note" role="status">Code scanned.${c.confirm ? ' The 4 numbers are filled in.' : ''}</p>` : `<label class="lab" for="watch-pair">The 6 characters under the square code</label>
    <input id="watch-pair" class="field-input" maxlength="60" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="For example K7Q2ZM" value="${esc(c.pairText || '')}">`}
    <label class="lab" for="watch-confirm">The 4 numbers on the watch</label>
    <input id="watch-confirm" class="field-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="0000" value="${esc(c.confirm || '')}">
    <p class="note">The 4 numbers show that you are looking at this watch.</p>
    ${c.pairId && !gameOn ? '<button type="button" class="btn btn-soft block" data-act="watch-other-game">Link it to a game on another phone instead</button>' : ''}
    ${gameOn && !c.auto ? `<label class="check" style="display:flex;gap:10px;align-items:flex-start;min-height:44px;margin:8px 0"><input type="checkbox" id="watch-single" ${c.single ? 'checked' : ''} style="width:24px;height:24px;flex:none"><span>This game only. The watch scores this game and cannot see the club.</span></label>` : ''}
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}<button type="submit" id="watch-link-go" class="btn btn-ink" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Linking…' : 'Link this watch'}</button></form>
  <div class="btns"><button class="btn btn-soft" data-act="${c.auto ? 'watch-court' : 'watch-link-back'}">Back</button></div>`;
}

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
// The link in the address (#watch=<id>.<4 numbers>) comes from the QR scanned with the phone's own camera app. An older link has no numbers.
// With a club on this phone it can link the watch to the club; with none (Safari, which does not share the Home Screen app's storage) it links it to one game.
function watchFromFragment(pair, confirm) {
  if (!club) { watchGameFrom({ pair, confirm: confirm || '' }); return; }
  clubSheet = { view: 'watch-link', pairId: pair, confirm: confirm || '' };
  renderClub();
  if (confirm) announce('Code scanned. The 4 numbers are filled in. Tap Link this watch.');
  const n = $(confirm ? '#watch-link-go' : '#watch-confirm'); if (n) n.focus();
}
// ---- one game, no club: the watch's code and the game's code meet on this page (Safari, or any phone), see api/_watch.js watch-claim-game ----
// The game's code comes from the scoring phone (6 characters and 4 numbers, or its game link); the watch's from the watch (the camera link, or 6 characters and 4 numbers).
function watchGameFrom(init) { clubSheet = Object.assign({ view: 'watch-game', pair: '', pairText: '', confirm: '', offer: '', offerText: '', offerConfirm: '' }, init); renderClub(); const n = $('#wg-offer') || $('#wg-pair') || $('#wg-confirm'); if (n) n.focus(); }
function watchGameHTML(c) {
  const lab = (id, text) => `<label class="lab" for="${id}">${text}</label>`;
  const field = (id, ph, value, extra = '') => `<input id="${id}" class="field-input" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="${ph}" value="${esc(value || '')}" ${extra}>`;
  const num = (id, value) => `<input id="${id}" class="field-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="0000" value="${esc(value || '')}">`;
  if (c.done) return `<h2 id="club-h">Watch linked</h2><p role="status">${esc(c.done)} The watch picks the game up within a few seconds. It scores this game only and stops when the game ends.</p><div class="btns"><button class="btn btn-soft" data-act="club-close">Done</button></div>`;
  const game = c.offer ? '<p class="note" role="status">Game link opened. It is good for one watch.</p>'
    : `${lab('wg-offer', 'The game code on the scoring phone (6 characters)')}${field('wg-offer', 'For example K7Q2ZM', c.offerText)}
    ${lab('wg-offer-confirm', 'The 4 numbers on the scoring phone')}${num('wg-offer-confirm', c.offerConfirm)}`;
  const watch = c.pair ? `<p class="note" role="status">Watch code opened.${c.confirm ? ' Its 4 numbers are filled in.' : ''}</p>`
    : `${lab('wg-pair', 'The 6 characters on the watch under its square code')}${field('wg-pair', 'For example K7Q2ZM', c.pairText)}`;
  const watchNum = c.pair && c.confirm ? '' : `${lab('wg-confirm', 'The 4 numbers on the watch')}${num('wg-confirm', c.confirm)}`;
  return `<h2 id="club-h">Link a watch to one game</h2>
  <p>The watch will score one game, and only that game. It cannot see the club, and it stops when the game ends. You need the code from the phone that is scoring.</p>
  <form class="club-form" data-form="watch-game">${game}${watch}${watchNum}
    <p class="note">The numbers show that you are looking at the scoring phone and the watch. Three wrong numbers end a code.</p>
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}<button type="submit" class="btn btn-ink" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Linking…' : 'Link this watch to the game'}</button></form>
  <div class="btns"><button class="btn btn-soft" data-act="club-close">Close</button></div>`;
}
async function watchGameClaim() {
  const c = clubSheet;
  if (!c || c.view !== 'watch-game' || c.busy) return;
  for (const [k, id] of [['offerText', 'wg-offer'], ['offerConfirm', 'wg-offer-confirm'], ['pairText', 'wg-pair'], ['confirm', 'wg-confirm']]) { const e = $('#' + id); if (e) c[k] = e.value; }
  let m;
  try { m = await scanLoad(); } catch { c.error = 'This page could not finish loading. Check your connection and try again.'; renderClub(); return; }
  const offer = c.offer || m.cleanShort(c.offerText), offerConfirm = m.cleanConfirm(c.offerConfirm), pair = c.pair || m.cleanShort(c.pairText), confirm4 = m.cleanConfirm(c.confirm);
  const err = !offer ? 'Type the 6 characters of the game code shown on the scoring phone.'
    : !c.offer && !offerConfirm ? 'Type the 4 numbers shown on the scoring phone.'
    : !pair ? 'Type the 6 characters shown on the watch under its square code.'
    : !confirm4 ? 'Type the 4 numbers shown on the watch.' : '';
  if (err) { c.error = err; renderClub(); return; }
  c.busy = true; c.error = ''; renderClub();
  try {
    await api('live', { method: 'POST', body: JSON.stringify({ action: 'watch-claim-game', offer, ...(c.offer ? {} : { offerConfirm }), pair, confirm4 }) });
    if (clubSheet === c) { c.busy = false; c.done = 'The watch is linked to the game.'; announce(c.done); renderClub(); }
  } catch (err) { if (clubSheet === c) { c.busy = false; c.error = err.message; renderClub(); } }
}
// ---- the scoring phone shows the game's code ----
async function watchOfferOpen() {
  if (!(live && !live.event && isShared())) return;
  const c = clubSheet = { view: 'watch-offer', offer: null, from: clubSheet && clubSheet.from };
  renderClub();
  try {
    const d = await watchCall({ action: 'watch-offer', game: live.id || liveGameId(), secret: liveSecret() });
    if (clubSheet === c) { c.offer = d.offer; c.at = Date.now(); renderClub(); announce(`Game code ${d.offer.short.split('').join(' ')}, numbers ${d.offer.confirm4.split('').join(' ')}.`); watchOfferWatch(c); }
  } catch (err) { if (clubSheet === c) { c.error = err.message; renderClub(); } }
}
// While the code is on screen, see the watch arrive: the list of this game's watches refreshes every few seconds.
function watchOfferWatch(c) {
  const tick = async () => {
    if (clubSheet !== c || c.view !== 'watch-offer' || Date.now() - c.at > 11 * 60 * 1000) return;
    try { const d = await watchCall({ action: 'watch-list' }); if (clubSheet === c) { const n = (d.links || []).filter(l => l.game === (live && (live.id || liveGameId()))).length; if (c.count !== undefined && n > c.count) { c.msg = 'A watch linked to this game.'; announce(c.msg); c.offer = null; renderClub(); watchOfferOpen(); return; } c.count = n; } } catch {}
    setTimeout(tick, 4000);
  };
  tick();
}
function watchOfferHTML(c) {
  const o = c.offer, spaced = o ? o.short.slice(0, 3) + ' ' + o.short.slice(3) : '';
  let qr = '';
  if (o) { try { qr = ShareLink.qrSvg(qrcode, location.origin + '/#game=' + o.id); } catch {} }
  return `<h2 id="club-h">Link a watch to this game</h2>
  ${c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : ''}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
  ${o ? `<p>On the watch, open Dink Score. Under the square code is a green button, <b>Enter a game code</b>: tap it, then type the code and the 4 numbers. The watch scores this game only.</p>
  <div class="code-card share-card"><span class="lab">Game code</span><span class="code" aria-label="${esc(o.short.split('').join(' '))}">${esc(spaced)}</span>
    <span class="lab">Numbers to type</span><span class="code" aria-label="${esc(o.confirm4.split('').join(' '))}">${esc(o.confirm4)}</span>
    <p class="note">Good for one watch and ${Number(o.expiresInMinutes) || 10} minutes. It stops working when this game ends.</p></div>
  ${qr ? `<details><summary style="min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:600">The watch wearer has an iPhone: a link instead</summary><p class="note">The wearer scans this with the Camera app, then types the 6 characters and 4 numbers shown on their watch. One watch per code.</p><div class="share-qr" role="img" aria-label="QR code for the game link">${qr}</div></details>` : ''}
  <button class="btn btn-soft block" data-act="watch-offer">Show a new code</button>` : c.error ? '' : '<p class="note">Getting a code…</p>'}
  <div class="btns"><button class="btn btn-soft" data-act="${c.from === 'court' ? 'watch-court' : 'watch-link-back'}">Back</button></div>`;
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
      const pair = m.pairFromUrl(text, location.origin), digits = m.confirmFromUrl(text, location.origin);
      if (!pair) { if (alive() && !c.hint) { c.hint = 'That is not a Dink Score watch code.'; renderClub(); } return false; }
      watchScan = null; c.scanning = false; c.pairId = pair; c.pairText = ''; c.confirm = digits; c.error = ''; renderClub();
      announce(digits ? 'Code scanned. The 4 numbers are filled in. Tap Link this watch.' : 'Code scanned. Type the 4 numbers shown on the watch.');
      const n = $(digits ? '#watch-link-go' : '#watch-confirm'); if (n) n.focus();
      if (c.auto && digits) setTimeout(watchClaim, 0); // from the court the scan is the whole job: the numbers came in the code, so nothing is left to type
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
  const se = $('#watch-single'); if (se) c.single = se.checked;
  let m;
  try { m = await scanLoad(); } catch { c.error = 'This page could not finish loading. Check your connection and try again.'; renderClub(); return; }
  const pair = c.pairId || m.cleanPair(c.pairText, location.origin), confirm4 = m.cleanConfirm(c.confirm);
  if (!pair) { c.error = 'Type the 6 characters shown under the square code on the watch, or scan the code.'; renderClub(); return; }
  if (!confirm4) { c.error = 'Type the 4 numbers shown on the watch.'; renderClub(); return; }
  watchStopScan(); c.busy = true; c.error = ''; renderClub();
  try {
    const single = !!(c.single && live && !live.event && isShared());
    const d = await watchCall(Object.assign({ action: 'watch-claim', pair, confirm4 }, single ? { single: true, game: live.id || liveGameId(), secret: liveSecret() } : {}));
    if (!single) rememberWatch(d.link.id, d.revokeKey); // a single-game link is ended by the game or by this game's secret, so no key is kept
    let sent = false;
    // A game being scored right now goes to the new watch too. The link works without it, so a failure here is not an error.
    if (single) sent = true;
    else if (live && !live.event && isShared()) { try { await watchCall({ action: 'watch-attach', link: d.link.id, game: live.id || liveGameId(), secret: liveSecret() }); sent = true; } catch {} }
    const msg = `${d.link.label || 'The watch'} is linked${single ? ' to this game only' : ''}.${sent ? ' This game is on it now.' : ''}`;
    announce(msg);
    // The watch collects its token within a couple of seconds; until then the server does not list it, so this phone shows it as waiting.
    if (clubSheet === c && c.auto) { clubSheet = null; renderClub(); showToast(msg); return; } // back to the court, which now shows the watch's score
    if (clubSheet === c) { const p = { id: d.link.id, label: d.link.label, createdAt: Date.now(), lastSeenAt: null, pending: true }; clubSheet = { view: 'watch', links: [p], pending: [p], msg }; renderClub(); loadWatchLinks(); }
  } catch (err) { if (clubSheet === c) { c.busy = false; c.error = err.message; renderClub(); } }
}
async function watchUnlink(id) {
  const c = clubSheet;
  if (c.confirmUnlink !== id) { c.confirmUnlink = id; c.msg = ''; renderClub(); return; }
  c.confirmUnlink = null; c.error = '';
  const key = watchKeys[id], one = (c.links || []).find(l => l.id === id), byGame = !!(one && one.game && live && isShared()); // the phone scoring a game may unlink the watches on it
  try {
    await watchCall(Object.assign({ action: 'watch-revoke', link: id }, byGame ? { secret: liveSecret() } : key ? { revokeKey: key } : adminCreds()));
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
// "Link a watch" on the scoring screen, for any game in progress: scan the watch's code with the camera, or show a code for the watch to type.
// A game that is not on the server yet (no club, or a pickup session) is shared first, only after the scorer says so.
function watchCourtSheet() { if (!live) return; clubSheet = { view: 'watch-court', from: 'court' }; renderClub(); const n = $('#club-h'); if (n) { n.tabIndex = -1; n.focus({ preventScroll: true }); } }
function watchCourtHTML(c) {
  const head = '<h2 id="club-h">Link a watch to this game</h2>';
  const close = '<div class="btns"><button class="btn btn-soft" data-act="club-close">Close</button></div>';
  if (!live) return head + close;
  if (live.event) return `${head}<p>This is a match in <b>${esc(live.event.name)}</b>. Event matches are scored on this phone and sent to the event when they end, so a watch cannot score them yet.</p><p class="note">Games in a club, and quick games, can be scored from a watch.</p>${close}`;
  if (isShared()) return `${head}${c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : ''}<p>The watch will score this game and nothing else, and stops when the game ends. Open Dink Score on the watch first.</p>
    <button class="btn btn-blue block" data-act="watch-court-scan">Scan the watch's code with the camera</button>
    <p class="note">The watch shows a square code, with 6 characters and 4 numbers under it.</p>
    <button class="btn btn-soft block" data-act="watch-offer">Show a code for the watch to type</button>
    <p class="note">The watch asks for 6 characters and 4 numbers. The code is good for 10 minutes and one watch.</p>${close}`;
  if (!API_OK) return `${head}<p>A watch scores through the Dink Score server, and this page cannot reach it. Open Dink Score from its web address and try again.</p>${close}`;
  return `${head}<p>A watch scores through the Dink Score server, so this game has to go there first.</p>
    <div class="ev-card"><h3 style="margin-top:0">What happens when you share it</h3><ul class="note" style="margin:0;padding-left:20px">
      <li>The teams' names and the score are kept on the server while you play.</li><li>No club or account is made.</li><li>It is removed when the game ends, and after 24 hours at the latest.</li><li>Only a watch you link to this game can score it.</li></ul></div>
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}<button class="btn btn-ink block" data-act="watch-share" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Sharing…' : 'Share this game and link a watch'}</button>
    <div class="btns"><button class="btn btn-soft" data-act="club-close">Not now</button></div>`;
}
async function watchShareGame() {
  const c = clubSheet, g = live;
  if (!c || c.view !== 'watch-court' || c.busy || !g || g.event || isShared()) return;
  c.busy = true; c.error = ''; renderClub();
  try {
    const d = await api('club', { method: 'POST', body: JSON.stringify({ room: true }) });
    const id = liveGameId(), secret = liveSecret();
    let sent;
    do { sent = g.state.rallies; await api('live', { method: 'POST', body: JSON.stringify({ code: d.room, action: 'state', id, secret, state: g.state, ack: watchAck }) }); } while (live === g && g.state.rallies !== sent); // a point scored while it was going up goes up too
    if (live !== g) return;
    g.room = d.room; markShared(); g.version = null; publishedLiveId = id; publishedSecret = secret; publishedCode = d.room; persistLive();
    if (clubSheet === c) { c.busy = false; c.msg = 'This game is shared.'; announce('This game is shared. Choose how to link the watch.'); renderClub(); const n = $('#club-h'); if (n) { n.tabIndex = -1; n.focus({ preventScroll: true }); } }
  } catch (err) { if (clubSheet === c) { c.busy = false; c.error = err.message || 'This game could not be shared. Check your connection and try again.'; renderClub(); } }
}
function watchCourtOpen() {
  if (!(live && !live.event && isShared())) return;
  clubSheet = { view: 'watch-link', single: true, auto: true, from: 'court' }; renderClub(); watchScanStart();
}
function watchClick(ds) {
  const a = ds.act;
  if (a === 'watch-court') { watchCourtSheet(); return; }
  if (a === 'watch-court-scan') { watchCourtOpen(); return; }
  if (a === 'watch-share') { watchShareGame(); return; }
  if (a === 'watch-link-open') { clubSheet = { view: 'watch-link' }; renderClub(); return; }
  if (a === 'watch-game-open') { clubSheet = { view: 'watch-link', single: true }; renderClub(); return; }
  if (a === 'watch-offer') { watchOfferOpen(); return; }
  if (a === 'watch-other-game') { watchGameFrom({ pair: clubSheet.pairId || '', confirm: clubSheet.confirm || '' }); return; }
  if (a === 'watch-link-back') { watchStopScan(); watchOpen(); return; }
  if (a === 'watch-scan') { watchScanStart(); return; }
  if (a === 'watch-scan-stop') { watchStopScan(); renderClub(); return; }
  if (a === 'watch-unlink') { watchUnlink(ds.link); return; }
  if (a === 'watch-send') { watchSend(ds.link); return; }
}
