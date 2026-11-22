/* ---------- club sync (the website's shared record; no accounts) ---------- */
// club: { code, name } when this device has joined a club. The shared games and saved players live on the server;
// changes made here wait in an outbox until they reach it, so scoring keeps working without signal.
/*OUTBOX-START*/
// What happens to a queued change the server refuses. Pure, so test/outbox.test.js can load this block alone.
// A refused change is never thrown away: it stays in the outbox, marked failed, until someone retries, fixes or exports it.
const Outbox = {
  pinOp: op => op.type === 'delete' || op.type === 'restore' || op.type === 'edit' || op.type === 'roster-del',
  // True when trying again later can work (no signal, server trouble, rate limit); false when the server said no.
  waits: (err, op) => !!(err.offline || err.status >= 500 || (err.status === 429 && !Outbox.pinOp(op))),
  fail(op, err, now) { op.failed = { status: err.status || 0, message: String(err.message || 'Not saved.'), at: now }; if (!op.uid) op.uid = now.toString(36) + Math.random().toString(36).slice(2, 6); return op; },
  active: (ops, code) => ops.filter(o => (!code || o.code === code) && !o.failed),
  failed: (ops, code) => ops.filter(o => (!code || o.code === code) && o.failed),
  retry(op) { delete op.failed; return op; },
  // Fix the score of a refused game and put it back in the queue. Returns false when the score isn't two whole numbers.
  rescore(op, a, b) {
    const x = Number(a), y = Number(b);
    if (op.type !== 'game' || !op.game || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 99 || y > 99) return false;
    op.game.score = [x, y]; Outbox.retry(op); return true;
  },
  // A file the person can keep: the refused changes exactly as this phone holds them.
  exportJson: (ops, code) => JSON.stringify({ app: 'dink-score', kind: 'unsent-changes', club: code || null, changes: ops.map(o => Object.assign({}, o, { ownerToken: undefined, pin: undefined })) }, null, 2)
};
/*OUTBOX-END*/
let club = API_OK ? Heal.club(store.get('pb.club', null)) : null;
let clubData = Heal.clubData(store.get('pb.clubCache', null), club && club.code); // { code, games, roster, deleted, players, progress, at, v }: only a copy, fetched again when unusable
// changes for every club this phone is in; each op carries its club's code. A change that can't be read is set aside, never deleted.
let outbox = (() => { const r = Heal.outbox(store.get('pb.outbox', [])); if (r.bad.length) { Heal.quarantine('pb.outbox', r.bad); store.set('pb.outbox', r.ok); } return r.ok; })();
// Every club this phone has joined. One is open at a time (club); the others keep their cached data until you switch back.
let clubs = API_OK ? Heal.clubs(store.get('pb.clubs', null)) : [];
if (club && !clubs.some(c => c.code === club.code)) clubs.unshift(club);
for (const op of outbox) if (!op.code && club) op.code = club.code; // ops saved before multiple clubs belong to the open one
const clubOps = () => (club ? Outbox.active(outbox, club.code) : []);
const failedOps = () => (club ? Outbox.failed(outbox, club.code) : []);
function saveClubs() {
  if (club) { const i = clubs.findIndex(c => c.code === club.code); if (i >= 0) clubs[i] = Object.assign({}, club); else clubs.push(Object.assign({}, club)); }
  store.set('pb.clubs', clubs); store.set('pb.club', club);
}
// An organizer changed the club code. Everything this phone keeps per club moves to the new code, so nothing is lost.
function adoptClubCode(from, to) {
  const move = (key, fallback) => { const m = store.get(key, fallback); if (m && m[from] !== undefined) { m[to] = m[from]; delete m[from]; store.set(key, m); } return m; };
  for (const c of clubs) if (c.code === from) c.code = to;
  if (club && club.code === from) club.code = to;
  for (const op of outbox) if (op.code === from) op.code = to;
  if (clubData && clubData.code === from) clubData.code = to;
  owners = move('pb.owners', {}); pins = move('pb.pins', {}); me = move('pb.me', {}); move('pb.clubCaches', {});
  store.set('pb.outbox', outbox); store.set('pb.clubCache', clubData); saveClubs();
}
function stashClubCache() {
  if (!club || !clubData || clubData.code !== club.code) return;
  const all = store.get('pb.clubCaches', {}); all[club.code] = clubData; store.set('pb.clubCaches', all);
}
function cachedClub(code) { return Heal.clubData(Heal.map(store.get('pb.clubCaches', {}))[code], code); }
let clubState = 'idle'; // idle | syncing | offline | error
let youHome = false;   // true while the "You" sheet (avatar) is the home the moved rows' Back buttons return to
let clubSheet = null;   // the club sheet when open: { view, error, joinCode, joinName, busy, msg }
let uploading = false;
if (clubData && (!club || clubData.code !== club.code)) clubData = null;
if (club) roster = (clubData && clubData.roster) ? clubData.roster.slice() : roster;

function clubGames() {
  const map = new Map();
  for (const g of (clubData ? clubData.games : [])) map.set(g.id, g);
  for (const op of failedOps()) if (op.type === 'game') map.set(op.game.id, op.game); // a refused game stays visible here
  for (const op of clubOps()) {
    if (op.type === 'game') map.set(op.game.id, op.game);
    if (op.type === 'delete') map.delete(op.id);
    if (op.type === 'edit' && map.has(op.id)) map.set(op.id, op.game);
    if (op.type === 'restore' && clubData) { const g = (clubData.deleted || []).find(x => x.id === op.id); if (g) map.set(g.id, g); }
  }
  return [...map.values()].sort((a, b) => b.endedAt - a.endedAt);
}
function rosterFromClub() {
  const list = clubData ? clubData.roster.slice() : [];
  for (const op of clubOps()) {
    if (op.type === 'roster-add' && !list.some(r => sameName(r, op.name))) list.push(op.name);
    if (op.type === 'roster-del') { const i = list.findIndex(r => sameName(r, op.name)); if (i >= 0) list.splice(i, 1); }
  }
  return list.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
// Sync v2: polled GETs send the ETag of the last answer they got (kept in memory, by full path, so one club's tag is never
// offered for another's address). An empty 304 means "unchanged": the caller gets the same data again, flagged `notModified`
// (non-enumerable) so a poller can skip redrawing. A server that sends no ETag is simply asked in full every time.
const etags = new Map();
async function api(path, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const tagged = method === 'GET' && (!opts.cache || opts.cache === 'no-store'); // a call that opts into the browser cache lets the browser revalidate it
  const known = tagged ? etags.get(path) : null;
  if (known) opts = Object.assign({}, opts, { headers: Object.assign({ 'If-None-Match': known.tag }, opts.headers || { 'Content-Type': 'application/json' }) });
  let res;
  // A request that hangs (weak signal at the courts) gives up after 15 seconds and counts as offline, so syncing retries
  // instead of waiting on it forever.
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
  try {
    res = await fetch('/api/' + path, Object.assign({ headers: { 'Content-Type': 'application/json' }, cache: 'no-store' }, ctrl ? { signal: ctrl.signal } : {}, opts));
  } catch { throw Object.assign(new Error("Can't reach the server. Check your connection."), { offline: true }); }
  finally { if (timer) clearTimeout(timer); }
  if (res.status === 304 && known) {
    const same = JSON.parse(known.text);
    Object.defineProperty(same, 'notModified', { value: true });
    return same;
  }
  let body = {}, text = '';
  try { text = await res.text(); body = JSON.parse(text); } catch {}
  if (!res.ok && body.removed && club && /^:[0-9a-f]{80}$/.test(pins[club.code] || '')) { delete pins[club.code]; store.set('pb.pins', pins); } // an organizer removed this phone: it stops showing organizer options
  if (!res.ok) { if (tagged) etags.delete(path); throw Object.assign(new Error(body.error || 'Something went wrong. Try again.'), { status: res.status, data: body }); }
  if (tagged) {
    const tag = res.headers.get('ETag');
    if (tag && text) { etags.delete(path); etags.set(path, { tag, text }); if (etags.size > 40) etags.delete(etags.keys().next().value); } else etags.delete(path);
  }
  return body;
}
function queueOp(op) {
  if (!club) return;
  outbox.push(Object.assign({ at: Date.now(), code: club.code }, op));
  store.set('pb.outbox', outbox);
  flush();
}
// Once a change has reached the server, fold it into the cached club data before it leaves the outbox.
// Otherwise a just-saved game would briefly be in neither place, and anything worked out in that moment would miss it.
function applyToCache(op) {
  if (!clubData || op.code !== clubData.code) { // a club that isn't open: fold it into that club's stored copy instead
    const all = store.get('pb.clubCaches', {}); const d = all[op.code];
    if (d && op.type === 'game' && !(d.games || []).some(g => g.id === op.game.id)) { (d.games = d.games || []).unshift(op.game); store.set('pb.clubCaches', all); }
    return;
  }
  const games = clubData.games || (clubData.games = []);
  const at = id => games.findIndex(g => g.id === id);
  if (op.type === 'game' && at(op.game.id) < 0) games.unshift(op.game);
  if (op.type === 'edit' && at(op.id) >= 0) games[at(op.id)] = op.game;
  if (op.type === 'delete' && at(op.id) >= 0) { const [g] = games.splice(at(op.id), 1); (clubData.deleted = clubData.deleted || []).unshift(Object.assign({}, g, { deletedAt: Date.now() })); }
  if (op.type === 'restore') { const d = clubData.deleted || []; const i = d.findIndex(g => g.id === op.id); if (i >= 0) { const [g] = d.splice(i, 1); if (at(g.id) < 0) games.unshift(g); } }
  if (op.type === 'roster-add' && !clubData.roster.some(r => sameName(r, op.name))) clubData.roster.push(op.name);
  if (op.type === 'roster-del') clubData.roster = clubData.roster.filter(r => !sameName(r, op.name));
  store.set('pb.clubCache', clubData);
}
let flushing = null;
function flush() {
  if (flushing || !outbox.some(o => !o.failed)) return flushing;
  flushing = (async () => {
    let sent = false;
    let op;
    while ((op = outbox.find(o => !o.failed))) {
      const code = op.code || (club && club.code);
      if (!code) { outbox.splice(outbox.indexOf(op), 1); continue; }
      try {
        if (op.type === 'game') await api('games', { method: 'POST', body: JSON.stringify(Object.assign({ code, games: [op.game] }, senderCreds(code))) });
        else if (op.type === 'delete') await api(`games?code=${code}&id=${encodeURIComponent(op.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Club-PIN': op.pin || '', 'X-Club-Owner': op.ownerToken || '' } });
        else if (op.type === 'edit') await api('games', { method: 'POST', body: JSON.stringify({ code, edit: op.game, pin: op.pin || '', ownerToken: op.ownerToken || '' }) });
        else if (op.type === 'restore') await api('games', { method: 'POST', body: JSON.stringify({ code, restore: op.id, pin: op.pin || '', ownerToken: op.ownerToken || '' }) });
        else if (op.type === 'event-result') await api('events', { method: 'POST', body: JSON.stringify(Object.assign({ code, action: 'result', id: op.eventId, matchId: op.matchId, score: op.score, startedAt: op.startedAt, endedAt: op.endedAt, rallies: op.rallies, rallyLog: op.rallyLog || undefined, live: op.live, pin: pins[code] || '' }, senderCreds(code))) });
        else if (op.type === 'league-result') await api('events', { method: 'POST', body: JSON.stringify(Object.assign({ code, action: 'league-result', id: op.leagueId, matchId: op.matchId, key: op.key, challenger: op.challenger, defender: op.defender, score: op.score, startedAt: op.startedAt, endedAt: op.endedAt, rallies: op.rallies, live: op.live, pin: pins[code] || '' }, senderCreds(code))) });
        else if (op.type === 'roster-add') await api('roster', { method: 'POST', body: JSON.stringify({ code, name: op.name, confirmNew: true }) });
        else if (op.type === 'roster-del') await api(`roster?code=${code}&name=${encodeURIComponent(op.name)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Club-PIN': op.pin || '', 'X-Club-Owner': op.ownerToken || '' } });
        applyToCache(op); // the server has it now; show it from the club list until the next refresh confirms
      } catch (err) {
        if (Outbox.waits(err, op)) { clubState = 'offline'; updateSyncPill(); break; }
        // The server refused it. Keep it, marked, in the "needs attention" list; the rest of the queue carries on.
        Outbox.fail(op, err, Date.now()); store.set('pb.outbox', outbox); sent = true;
        if (Outbox.pinOp(op) && err.status === 403) { delete pins[code]; store.set('pb.pins', pins); }
        showToast(`${op.type === 'game' ? "A game couldn't be saved to the club" : op.type === 'event-result' ? "A result couldn't be saved to the event" : op.type === 'league-result' ? "A result couldn't be saved to the league" : "A change couldn't be saved"}: ${err.message} It is kept under "Needs attention" in the club screen.`, false);
        updateSyncPill();
        continue;
      }
      outbox.splice(outbox.indexOf(op), 1); store.set('pb.outbox', outbox); sent = true;
    }
    flushing = null;
    if (sent && evScreen && (evScreen.view === 'detail' || evScreen.view === 'bracket')) evLoad(evScreen.id, true);
    else if (sent && evScreen) renderEvents(true);
    if (sent && lgScreen && lgScreen.view === 'detail') lgLoad(lgScreen.id, true);
    if (sent && !clubOps().length) await refreshClub();
    if (sent && typeof Rewards !== 'undefined') Rewards.sync(true); // a saved game may have earned today's reward; the server works that out
  })();
  return flushing;
}
// Photo pictures come separately from the club data (they are the big part of it). Cached by name and fingerprint.
const photoCache = {};
async function loadPhotos() {
  const want = (clubData && clubData.players || []).filter(p => p.avatar && p.avatar.type === 'photo' && !p.avatar.value);
  if (!want.length || !club) return;
  try {
    const { photos } = await api('club?code=' + club.code + '&avatars=1', { cache: 'default' }); // the browser keeps and revalidates these (the server sends an ETag)
    for (const [name, ph] of Object.entries(photos || {})) photoCache[name.toLowerCase()] = ph;
    let changed = false;
    for (const p of want) { const c = photoCache[p.name.toLowerCase()]; if (c && c.v === p.avatar.v) { p.avatar.value = c.value; changed = true; } }
    if (changed) safeRender();
  } catch (e) { /* pictures are optional: initials show until the next refresh */ }
}
let refreshing = false;
let calmPolls = 0; // club answers in a row that came back unchanged; the poll timer stretches its gap while this grows
async function refreshClub() {
  if (!club || refreshing) return;
  refreshing = true; clubState = 'syncing'; updateSyncPill();
  try {
    const asked = club && club.code;
    const data = await api('club?code=' + asked);
    if (!club || club.code !== asked) return;
    if (data.notModified) { calmPolls++; clubState = 'idle'; updateSyncPill(); return; } // the server says nothing changed since the last answer: nothing to redo
    calmPolls = 0;
    if (data.club.code !== asked) adoptClubCode(asked, data.club.code); // an organizer changed the code: carry this phone over
    club.name = data.club.name; club.hasPin = !!data.club.hasPin; club.openClaim = !!data.club.openClaim; club.requireConfirmation = !!data.club.requireConfirmation; club.rewards = !!data.club.rewards; club.publicResults = !!data.club.publicResults; club.payLink = data.club.payLink || ''; club.note = data.club.note || ''; if (data.club.deleteAt) club.deleteAt = data.club.deleteAt; else delete club.deleteAt; saveClubs();
    for (const p of data.players || []) if (p.avatar && p.avatar.type === 'photo') { const c = photoCache[p.name.toLowerCase()]; if (c && c.v === p.avatar.v) p.avatar.value = c.value; }
    clubData = Heal.clubData({ code: club.code, games: data.games, roster: data.roster, deleted: data.deleted, players: data.players || [], nights: data.nights || [], progress: data.progress || null, ratings: data.ratings || null, dupes: data.dupes || [], at: Date.now() }, club.code);
    store.set('pb.clubCache', clubData);
    roster = rosterFromClub();
    followRenames(data.renamed);
    if (myName() && clubData.players.length && !clubData.players.some(p => p.claimed && sameName(p.name, myName()))) { delete me[club.code]; store.set('pb.me', me); }
    syncCoOrg(); // promoted or demoted from another phone: this one follows
    odUpgrade(); // a phone that still holds the raw PIN trades it for its own key
    clubState = 'idle';
    safeRender();
    loadPhotos();
    evSummaryRefresh();
    announceUnlocks();
    if (typeof Rewards !== 'undefined') Rewards.sync();
    if (!myName() && !whoamiSkipped() && !askedWhoami && !clubSheet && !logForm && !profile && tourStep === null && !(live && live.open)) { askedWhoami = true; clubSheet = { view: 'whoami' }; renderClub(); }
  } catch (err) {
    clubState = err.offline ? 'offline' : 'error';
    if (err.status === 404) { showToast(`${club.name} no longer exists, so it was taken off this phone.`, false); leaveClub(); }
    updateSyncPill();
  } finally { refreshing = false; }
}
// Re-render with fresh club data, unless someone is typing or a form is open (that would wipe what they typed).
let renderPending = false;
function safeRender() {
  const a = document.activeElement;
  if (logForm || (clubSheet && clubSheet.busy) || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) { renderPending = true; updateSyncPill(); return; }
  renderPending = false; render();
}
document.addEventListener('focusout', () => { if (renderPending) setTimeout(() => { if (renderPending) safeRender(); }, 50); });
function syncPillHTML() {
  if (!API_OK) return `<span class="sync ${syncOn ? 'on' : ''}">${esc(syncNote)}</span>`;
  if (!club) return `<button class="sync club-btn" data-act="club-open">Join a club</button>`;
  const pending = clubOps().length, failed = failedOps().length;
  const note = failed ? `${failed} need${failed === 1 ? 's' : ''} attention` : clubState === 'offline' ? (pending ? `Offline, ${pending} to sync` : 'Offline') : clubState === 'error' ? 'Sync problem' : pending ? 'Syncing' : club.name;
  return `<button class="sync club-btn ${clubState === 'idle' && !pending && !failed ? 'on' : ''} ${clubState === 'offline' || clubState === 'error' || failed || !club.hasPin ? 'warn' : ''}" data-act="club-open" aria-label="Club: ${esc(club.name)}. ${esc(note)}${club.hasPin ? '' : '. Not protected: no organizer PIN'}">${esc(note)}</button>`;
}
// Round button in the top right: your picture, opening the "You" sheet (profile, notifications, display, account, DUPR, watch, data).
function profileButtonHTML() {
  const name = club ? myName() : null;
  const label = (name ? `You: ${esc(name)}` : 'You') + (typeof Rewards !== 'undefined' ? Rewards.label() : '');
  const inner = name ? avatarInner(name) : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M5 19.5c1.3-3.3 4-5 7-5s5.7 1.7 7 5"/></svg>`;
  return `<button class="me-btn" data-act="me-open" aria-label="${label}">${inner}${typeof Rewards !== 'undefined' ? Rewards.flameHTML() : ''}</button>`;
}
function updateSyncPill() { const el = document.querySelector('header.top .sync'); if (el) el.outerHTML = syncPillHTML(); }
/*SHARELINK-START*/
// The join link for a club (/?club=CODE, handled by checkInvite) and its QR code. Pure, so test/sharelink.test.js can load this block alone.
const ShareLink = {
  code: raw => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
  join(origin, code) { const c = ShareLink.code(code); return c ? String(origin).replace(/\/+$/, '') + '/?club=' + c : ''; },
  fromSearch: search => ShareLink.code(new URLSearchParams(search).get('club')),
  // A pickup session link (/?session=CODE, 8 characters; see checkInvite).
  session(origin, code) { const c = ShareLink.code(code); return c ? String(origin).replace(/\/+$/, '') + '/?session=' + c : ''; },
  sessionFromSearch: search => ShareLink.code(new URLSearchParams(search).get('session')),
  // qr is the vendored qrcode-generator. Margin is the 4-module quiet zone; the sheet draws it on white so it scans in the dark theme.
  qrSvg(qr, link) { const q = qr(0, 'M'); q.addData(link); q.make(); return q.createSvgTag({ cellSize: 8, margin: 32, scalable: true }); }
};
/*SHARELINK-END*/
/*MOVE-START*/
// Moving to a new phone: the transfer code never leaves the two phones. Both derive a lookup id and an AES key from it;
// the server only sees the id and an encrypted bundle (see api/transfer.js). Free of app globals so the tests can load it.
const Move = {
  ALPHA: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  newCode() {
    let out = '';
    while (out.length < 12) for (const b of crypto.getRandomValues(new Uint8Array(24))) if (b < 248 && out.length < 12) out += Move.ALPHA[b % 31];
    return out.replace(/(.{4})(?=.)/g, '$1-');
  },
  clean(raw) { const c = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return c.length === 12 && [...c].every(ch => Move.ALPHA.includes(ch)) ? c : ''; },
  async bits(code, salt) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: new TextEncoder().encode(salt) }, k, 256));
  },
  async id(raw) { return [...await Move.bits(Move.clean(raw), 'dink-move-id')].map(b => b.toString(16).padStart(2, '0')).join(''); },
  async key(code) { return crypto.subtle.importKey('raw', await Move.bits(code, 'dink-move-key'), 'AES-GCM', false, ['encrypt', 'decrypt']); },
  async seal(raw, payload) {
    const code = Move.clean(raw), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await Move.key(code), new TextEncoder().encode(JSON.stringify(payload))));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    let s = ''; for (const b of all) s += String.fromCharCode(b);
    return btoa(s);
  },
  async open(raw, blob) {
    const code = Move.clean(raw), all = Uint8Array.from(atob(blob), ch => ch.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await Move.key(code), all.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  },
  // What this phone holds per club: the player claim, the creator token and the remembered organizer PIN.
  pack(clubs, me, owners, pins) {
    return { v: 1, clubs: clubs.map(c => ({ code: c.code, name: c.name, me: me[c.code] || null, owner: owners[c.code] || null, pin: /^\d{4,8}$/.test(pins[c.code] || '') ? pins[c.code] : null })) }; // a phone key stays on its phone
  },
  // Folds a received bundle into this phone's own records. Anything this phone already has for a club is kept. Returns how many clubs were added.
  merge(payload, clubs, me, owners, pins) {
    if (!payload || payload.v !== 1 || !Array.isArray(payload.clubs)) throw new Error('That transfer was not valid.');
    let added = 0;
    for (const c of payload.clubs.slice(0, 50)) {
      if (!c || !/^[A-Z0-9]{6}$/.test(String(c.code))) continue;
      if (!clubs.some(x => x.code === c.code)) { clubs.push({ code: c.code, name: String(c.name || c.code).slice(0, 60) }); added++; }
      if (c.me && typeof c.me.name === 'string' && /^[0-9a-f]{48}$/.test(String(c.me.token)) && !me[c.code]) me[c.code] = { name: c.me.name.slice(0, 40), token: c.me.token };
      if (/^[0-9a-f]{48}$/.test(String(c.owner)) && !owners[c.code]) owners[c.code] = c.owner;
      if (/^\d{4,8}$/.test(String(c.pin)) && !pins[c.code]) pins[c.code] = String(c.pin);
    }
    return added;
  }
};
/*MOVE-END*/
