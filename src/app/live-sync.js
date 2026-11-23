/* ---------- watch scoring (prototype) ----------
   While a club game is scored on this phone, the phone publishes the live state to /api/live. An
   Apple Watch running Shortcuts (setup steps are on the club sheet's watch page) appends point and
   undo intents there; this phone polls for them and applies them with PB.rally, so the scoring
   rules live in exactly one place and a watch tap changes nothing until this phone takes it.
   Event matches are not watch-scored: they already report to the event. */
let watchAck = 0, publishedLiveId = null, publishedSecret = null, publishTimer = null;
let sharedChain = Promise.resolve(), sharedInFlight = 0;
const liveGameId = () => 'live-' + live.state.startedAt.toString(36);
// Each live game has its own short-lived secret, made here and shown on the watch page. A watch must name the game and carry it,
// and this phone drops any intent whose signature does not match, so a tap meant for one court can never score another.
function liveSecret() {
  if (!live.secret) { const b = crypto.getRandomValues(new Uint8Array(10)); live.secret = Array.from(b, x => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join(''); }
  return live.secret;
}
async function intentOk(it, game, secret) {
  if (!it || it.g !== game || typeof it.sig !== 'string') return false;
  try {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${secret}:${it.n}:${it.kind}:${it.side}:${game}`));
    return Array.from(new Uint8Array(h), x => x.toString(16).padStart(2, '0')).join('') === it.sig;
  } catch { return false; }
}
// Where this game is held on the server: the club's code, or, with no club (or in a pickup session), the quick game room made when the scorer chose to link a watch.
const liveCode = () => live && live.room ? live.room : club && !pickup ? club.code : null;
let publishedCode = null;
if (live && live.shared && live.room && live.id && live.secret) { publishedLiveId = live.id; publishedSecret = live.secret; publishedCode = live.room; } // a quick game room reopened after a reload still ends with its game
const isShared = () => !!(live && live.shared && liveCode() && API_OK);
function markShared() { if (live && liveCode() && API_OK && !live.event) { live.shared = true; live.id = liveGameId(); if (live.version === undefined) live.version = 0; } }
function schedulePublishLive() {
  if (!API_OK || !(liveCode() || publishedCode)) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(publishLive, 250);
}
async function publishLive() {
  if (!API_OK || !(liveCode() || publishedCode)) return;
  try {
    if (live && !live.event) {
      const id = liveGameId();
      // In shared mode the server holds the game once it is published; republishing this phone's state
      // would clobber rallies other people scored. Publish once, at the start — or again only when this
      // phone scored offline and has to resync (live.stale), which takes the game back over.
      if (live.shared && publishedLiveId === id && !live.stale) return;
      publishedLiveId = id; publishedSecret = liveSecret(); publishedCode = liveCode();
      await api('live', { method: 'POST', body: JSON.stringify({ code: publishedCode, action: 'state', id, secret: publishedSecret, state: live.state, ack: watchAck, ...(watchIds().length ? { watch: watchIds() } : {}) }) });
      if (live && live.shared && liveGameId() === id) { live.stale = false; live.version = null; } // the next poll adopts the server's version
    } else if (publishedLiveId) {
      const id = publishedLiveId, secret = publishedSecret, code = publishedCode; publishedLiveId = null; publishedSecret = null; publishedCode = null; watchAck = 0;
      await api('live', { method: 'POST', body: JSON.stringify({ code, action: 'end', id, secret }) });
    }
  } catch {}
}
function queueShared(fn) { sharedInFlight++; sharedChain = sharedChain.then(fn).catch(() => {}).finally(() => { sharedInFlight--; }); }
// Shared scoring: this phone shows the tap at once, then the server referees it. If someone else
// scored first, the server answers with a conflict and the latest state; this rally goes on top.
function adoptShared(state, version) {
  const beforeWinner = live.state ? live.state.winner : null;
  live.state = state; live.version = version; live.stale = false;
  if (live.log && live.log.length !== state.rallies) live.log = null; // rallies scored on other phones are not in this phone's log; such a game saves without a replay
  persistLive(); renderCourt();
  celebrateWin(beforeWinner, live.state.winner);
}
function serverRally(side, fromIntent) {
  if (!isShared()) return false;
  const id = live.id || liveGameId(), secret = liveSecret();
  if (!fromIntent) {
    buzz();
    const beforeWinner = live.state.winner;
    const before = live.state.score.slice();
    Scoring.rally(live, side);
    bumpTeam = live.state.score[0] !== before[0] ? 0 : live.state.score[1] !== before[1] ? 1 : null;
    if (live.state.justSwitched && live.state.winner === null) showToast(`Change ends. A team reached ${PB.switchAt(live.state.cfg.target)}.`);
    persistLive(); renderCourt();
    celebrateWin(beforeWinner, live.state.winner);
  }
  queueShared(async () => {
    if (!live || (live.id || liveGameId()) !== id) return;
    try {
      let r = await api('live', { method: 'POST', body: JSON.stringify({ code: liveCode(), action: 'rally', game: id, secret, side, base: live.version }) });
      if (r && r.conflict) {
        adoptShared(r.state, r.version);
        r = await api('live', { method: 'POST', body: JSON.stringify({ code: liveCode(), action: 'rally', game: id, secret, side, base: live.version }) });
      }
      if (!live || (live.id || liveGameId()) !== id) return;
      if (r && r.state) adoptShared(r.state, r.version);
    } catch { if (live && (live.id || liveGameId()) === id) { live.stale = true; schedulePublishLive(); } }
  });
  return true;
}
function serverUnrally() {
  if (!isShared()) return false;
  const id = live.id || liveGameId(), secret = liveSecret();
  queueShared(async () => {
    if (!live || (live.id || liveGameId()) !== id) return;
    try {
      let r = await api('live', { method: 'POST', body: JSON.stringify({ code: liveCode(), action: 'unrally', game: id, secret, base: live.version }) });
      if (r && r.conflict) {
        adoptShared(r.state, r.version);
        r = await api('live', { method: 'POST', body: JSON.stringify({ code: liveCode(), action: 'unrally', game: id, secret, base: live.version }) });
      }
      if (!live || (live.id || liveGameId()) !== id) return;
      if (r && r.state) { live.toast = null; adoptShared(r.state, r.version); }
    } catch { showToast("Couldn't reach the server to undo."); }
  });
  return true;
}
function applyWatchIntent(it) {
  if (!live || live.event) return;
  if (isShared()) { // the server referees now: forward the tap as a rally instead of applying it here
    if (it.kind === 'point' && live.state.winner === null) serverRally(it.side === 1 ? 1 : 0, true);
    else if (it.kind === 'undo') serverUnrally();
    return;
  }
  if (it.kind === 'point' && live.state.winner === null && !live.confirmEnd && !logForm) {
    const beforeWinner = live.state.winner;
    buzz();
    Scoring.rally(live, it.side === 1 ? 1 : 0);
    persistLive(); renderCourt();
    celebrateWin(beforeWinner, live.state.winner);
  } else if (it.kind === 'undo' && live.stack.length) {
    clearConfetti();
    Scoring.undo(live); live.toast = null;
    persistLive(); renderCourt();
  }
}
setInterval(async () => {
  if (!API_OK || !liveCode() || !live || live.event || !live.open || document.hidden) return;
  try {
    const game = live.id || liveGameId(), secret = liveSecret();
    const d = await api('live?code=' + liveCode() + '&id=' + encodeURIComponent(game) + '&secret=' + encodeURIComponent(secret));
    if (!live || (live.id || liveGameId()) !== game) return;
    // Follow the server: a newer version means someone else scored (or this phone's tap landed).
    if (live.shared && d.state && !sharedInFlight && (live.version === null || live.version === undefined || (d.version || 0) > live.version)) adoptShared(d.state, d.version);
    const fresh = (d.intents || []).filter(i => i.n > watchAck).sort((a, b) => a.n - b.n);
    for (const it of fresh) { if (await intentOk(it, game, secret)) applyWatchIntent(it); watchAck = Math.max(watchAck, it.n); } // unsigned or foreign intents are skipped, never applied
    if (fresh.length) { try { await api('live', { method: 'POST', body: JSON.stringify({ code: liveCode(), action: 'ack', game, secret, ack: watchAck }) }); } catch {} }
  } catch {}
}, 2500);

function persistLive() { store.set('pb.live', live ? { state: live.state, stack: live.stack.slice(-200), log: live.log, open: live.open, event: live.event || null, secret: live.secret || null, shared: live.shared || false, room: live.room || null, id: live.id || null, version: live.version === undefined ? null : live.version, stale: live.stale || false } : null); schedulePublishLive(); }
let toastTimer;
function showToast(msg, inCourt = true) {
  if (inCourt && live) { announce(msg); live.toast = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => { if (live) { live.toast = null; renderCourt(); } }, 3500); return; }
  announce(msg);
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3000);
}
function startGame(cfgOverride) {
  const cfg = cfgOverride || { mode: setup.mode, scoring: setup.scoring, target: +setup.target, winBy: +setup.winBy, first: setup.first, teams: [teamPlayers(0), teamPlayers(1)] };
  live = { state: PB.newGame(cfg), stack: [], log: [], open: true };
  markShared();
  persistLive(); keepAwake(true); render();
}
// A shared game is saved under its live id, so the watch's save (api/_watch.js) and every phone's save are one game, stored once.
function record(s, rallyLog, id) {
  return { ...(rallyLog ? { rallyLog } : {}), id: id || newId(s.startedAt), startedAt: s.startedAt, endedAt: s.endedAt, mode: s.cfg.mode, scoring: s.cfg.scoring, target: s.cfg.target, winBy: s.cfg.winBy, teams: s.cfg.teams, score: s.score, winner: s.winner, rallies: s.rallies };
}
