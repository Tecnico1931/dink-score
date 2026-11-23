/* ---------- bell and inbox: alerts built on this phone from the club data it already loads (no server table, no endpoint) ---------- */
// Two kinds of item. "Needs you" is recomputed every time from live data and goes away when the thing is done (a game to confirm,
// a game night to answer, a refused change). "Recent" is news found by comparing the club data with what this phone remembered last
// time (a night changed, a round went live, league results came in); it is kept, newest first, in localStorage `pb.inbox` per club.
/*INBOX-START*/
// Pure, free of app globals, so test/inbox.test.js can load this block alone.
const Inbox = {
  KEEP: 30,
  nightFp: n => [n.startsAt, n.title, n.location || ''].join('|'),
  eventFp(e) {
    const r = typeof e.round === 'number' ? e.round
      : Array.isArray(e.rounds) && e.rounds.length ? ((e.rounds.find(x => x.status !== 'done') || e.rounds[e.rounds.length - 1]).n || 0) : 0;
    return `${e.status}:${r}`;
  },
  // Anything read back from storage is checked: a wrong shape counts as an empty inbox.
  parse(raw) {
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const map = m => { const r = {}; if (m && typeof m === 'object' && !Array.isArray(m)) for (const k of Object.keys(m).slice(0, 200)) if (typeof m[k] === 'string' || typeof m[k] === 'number') r[k] = m[k]; return r; };
    const log = (Array.isArray(o.log) ? o.log : []).filter(x => x && typeof x.id === 'string' && typeof x.title === 'string' && Number.isFinite(x.at)).slice(0, Inbox.KEEP)
      .map(x => ({ id: x.id.slice(0, 200), kind: String(x.kind || '').slice(0, 20), title: x.title.slice(0, 120), body: String(x.body || '').slice(0, 160), go: String(x.go || '').slice(0, 80), at: x.at }));
    return { base: map(o.base), fp: map(o.fp), ev: map(o.ev), lg: map(o.lg), read: map(o.read), log };
  },
  // Pre-record a fingerprint on this device so an action the author just took does not trigger a local Inbox alert.
  ack(memRaw, kind, id, fp) {
    const mem = Inbox.parse(memRaw), sid = id == null ? '' : String(id).trim();
    if (!sid) return mem;
    const map = kind === 'night' ? mem.fp : kind === 'event' ? mem.ev : kind === 'league' ? mem.lg : null;
    if (!map) return mem;
    if (fp == null) delete map[sid]; else map[sid] = String(fp);
    return mem;
  },
  // mem: what was remembered (or anything). s: what the phone knows now:
  //   { now, me, failed, sync, held: [{ id, label }], nights: [{ id, title, startsAt, location, when, mine }],
  //     events: [{ id, name, status, round }] or null while not loaded, leagues: [{ id, name, status, count }] or null }
  // -> { mem, needs, fresh }. The first look at a source only records it, so a new phone does not get a pile of old news.
  step(memRaw, s) {
    const mem = Inbox.parse(memRaw), now = s.now, fresh = [], needs = [];
    const add = (id, kind, title, body, go) => { if (!mem.log.some(x => x.id === id) && !fresh.some(x => x.id === id)) fresh.push({ id, kind, title, body, go, at: now }); };
    const nights = Array.isArray(s.nights) ? s.nights : null;
    if (nights) {
      const first = !mem.base.nights;
      const seen = new Set();
      for (const n of nights) {
        seen.add(n.id);
        const prev = mem.fp[n.id], k = Inbox.nightFp(n);
        if (!first && prev === undefined) add(`night:${n.id}:new`, 'night', 'New game night', `${n.title}, ${n.when}`, 'nights');
        else if (!first && prev !== k) add(`night:${n.id}:${k}`, 'night', 'Game night changed', `${n.title}, ${n.when}`, 'nights');
        mem.fp[n.id] = k;
        if (s.me && !n.mine) needs.push({ id: `rsvp:${n.id}`, kind: 'rsvp', title: `Are you in? ${n.title}`, body: n.when, go: 'nights' });
      }
      for (const id of Object.keys(mem.fp)) {
        if (seen.has(id)) continue;
        const [at, title] = String(mem.fp[id]).split('|');
        if (!first && Number(at) > s.now) add(`night:${id}:gone`, 'night', 'Game night cancelled', String(title), 'nights');
        delete mem.fp[id];
      }
      mem.base.nights = 1;
    }
    if (Array.isArray(s.events)) {
      const first = !mem.base.events;
      for (const e of s.events) {
        const k = Inbox.eventFp(e), prev = mem.ev[e.id];
        if (!first && prev !== k) {
          if (e.status === 'live') add(`ev:${e.id}:${k}`, 'event', e.round > 0 ? `Round ${e.round} is live` : 'Event is live', e.name, `event:${e.id}`);
          else if (e.status === 'done') add(`ev:${e.id}:${k}`, 'event', 'Event finished', e.name, `event:${e.id}`);
        }
        mem.ev[e.id] = k;
      }
      mem.base.events = 1;
    }
    if (Array.isArray(s.leagues)) {
      const first = !mem.base.leagues;
      for (const l of s.leagues) {
        const k = `${l.count}:${l.status}`, prev = mem.lg[l.id];
        if (!first && prev !== undefined && prev !== k) {
          const [pc, ps] = String(prev).split(':');
          if (l.status === 'done' && ps !== 'done') add(`lg:${l.id}:${k}`, 'league', 'League finished', l.name, 'league');
          else if (l.count > Number(pc)) { const d = l.count - Number(pc); add(`lg:${l.id}:${k}`, 'league', 'League results in', `${l.name}: ${d} new result${d === 1 ? '' : 's'}`, 'league'); }
        }
        mem.lg[l.id] = k;
      }
      mem.base.leagues = 1;
    }
    for (const g of (s.held || []).slice(0, 10)) needs.push({ id: `confirm:${g.id}`, kind: 'confirm', title: 'Confirm a game', body: g.label, go: 'history' });
    if (s.failed > 0) needs.push({ id: 'failed', kind: 'failed', title: `${s.failed} change${s.failed === 1 ? '' : 's'} need${s.failed === 1 ? 's' : ''} attention`, body: 'The club refused them. Nothing is lost.', go: 'club' });
    else if (s.sync === 'error') needs.push({ id: 'sync', kind: 'sync', title: 'Sync problem', body: 'The club could not be reached. Changes wait on this phone.', go: 'club' });
    mem.log = fresh.concat(mem.log).slice(0, Inbox.KEEP);
    const ids = new Set(mem.log.map(x => x.id));
    for (const id of Object.keys(mem.read)) if (!ids.has(id)) delete mem.read[id];
    return { mem, needs, fresh };
  },
  unread: mem => mem.log.filter(x => !mem.read[x.id]),
  count: (needs, mem) => needs.length + Inbox.unread(mem).length,
  markRead(mem) { for (const x of mem.log) mem.read[x.id] = 1; return mem; },
  label: n => (n > 0 ? `Notifications, ${n} new` : 'Notifications'),
  say(items) { return !items.length ? '' : items.length === 1 ? `New in your inbox: ${items[0].title}` : `${items.length} new in your inbox`; },
  ago(at, now) {
    const m = Math.floor((now - at) / 60000);
    return m < 1 ? 'Just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
  }
};
/*INBOX-END*/

let inboxOpen = false, inboxOpener = null, inboxNeeds = [], inboxMem = Inbox.parse(null), inboxKnown = null, inboxNew = new Set();
let inboxLeagues = null, inboxLeaguesAt = 0, inboxLeaguesFor = '', inboxAsked = '', inboxClub = '';
let inboxHeld = false; // true while this sheet keeps the page behind inert
let evLoadedFor = ''; // the club whose events evSummary holds (set where it is fetched)
const inboxStore = () => store.get('pb.inbox', {});

function inboxSnap() {
  const mine = myName();
  const held = !mine ? [] : allGames().filter(g => g.hold && !g.confirmed && !g.event && g.teams.some(t => t.some(n => sameName(n, mine))) && canConfirmGame(g))
    .map(g => ({ id: g.id, label: `${teamLabel(g.teams[0])} ${Number(g.score[0])}–${Number(g.score[1])} ${teamLabel(g.teams[1])}` }));
  const nights = clubData && Array.isArray(clubData.nights) ? gnUpcoming().map(n => ({ id: n.id, title: n.title, startsAt: n.startsAt, location: n.location || '', when: gnWhenParts(n.startsAt).label, mine: !!gnMyStatus(n) })) : null;
  return { now: Date.now(), me: mine, failed: failedOps().length, sync: clubState, held, nights, events: evLoadedFor === club.code ? evSummary.map(e => ({ id: e.id, name: e.name, status: e.status, round: e.round || 0 })) : null, leagues: inboxLeaguesFor === club.code ? inboxLeagues : null };
}
function inboxAck(kind, id, fp) {
  if (!club || !id) return;
  const all = inboxStore();
  all[club.code] = Inbox.ack(all[club.code], kind, id, fp);
  for (const k of Object.keys(all).slice(0, -12)) delete all[k];
  store.set('pb.inbox', all);
  if (inboxClub === club.code) inboxMem = all[club.code];
}
// Recompute from what the phone has; called on every draw, writes only when something changed.
function inboxRefresh() {
  if (!club) { inboxNeeds = []; inboxMem = Inbox.parse(null); return; }
  if (inboxClub !== club.code) { inboxClub = club.code; inboxKnown = null; inboxNew = new Set(); }
  const all = inboxStore();
  const r = Inbox.step(all[club.code], inboxSnap());
  const ids = r.needs.map(n => n.id);
  if (inboxOpen) { for (const x of Inbox.unread(r.mem)) inboxNew.add(x.id); Inbox.markRead(r.mem); }
  const said = inboxKnown ? r.fresh.concat(r.needs.filter(n => !inboxKnown.has(n.id))) : [];
  inboxKnown = new Set(ids);
  inboxNeeds = r.needs; inboxMem = r.mem;
  if (JSON.stringify(all[club.code]) !== JSON.stringify(r.mem)) { all[club.code] = r.mem; for (const k of Object.keys(all).slice(0, -12)) delete all[k]; store.set('pb.inbox', all); }
  if (said.length && !inboxOpen) announce(Inbox.say(said));
}
// Leagues are not part of the club answer, so ask for their list (the same call as the league screen) at most every two minutes.
async function inboxLoadLeagues() {
  if (!club || !API_OK || (inboxAsked === club.code && Date.now() - inboxLeaguesAt < 120000)) return;
  const code = club.code; inboxAsked = code; if (inboxLeaguesFor !== code) { inboxLeagues = null; inboxLeaguesFor = ''; } inboxLeaguesAt = Date.now();
  try {
    const d = await api('events?leagues=1&code=' + code);
    if (!club || club.code !== code || !Array.isArray(d.leagues)) return;
    inboxLeaguesFor = code;
    inboxLeagues = d.leagues.map(l => ({ id: l.id, name: l.name, status: l.status, count: Number(l.kind === 'league' ? l.played : l.results) || 0 }));
    safeRender();
  } catch (e) { /* the list just leaves league news out */ }
}
function bellButtonHTML() {
  if (!club) return '';
  const n = Inbox.count(inboxNeeds, inboxMem);
  return `<button class="bell-btn" data-act="inbox-open" aria-haspopup="dialog" aria-label="${Inbox.label(n)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0112 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z"/><path d="M10 20a2 2 0 004 0"/></svg>${n ? `<span class="bell-n" aria-hidden="true">${n > 9 ? '9+' : n}</span>` : ''}</button>`;
}
function inboxBehind(off) { for (const sel of ['#app', '#tabs']) { const el = $(sel); if (el) el.inert = off || !!(evScreen && club); } }
function openInbox() {
  if (!club) return;
  inboxOpener = document.activeElement; inboxNew = new Set();
  for (const x of Inbox.unread(inboxMem)) inboxNew.add(x.id);
  inboxOpen = true; inboxLoadLeagues();
  render();
  const h = $('#inbox-h'); if (h) h.focus();
}
function closeInbox() {
  inboxOpen = false; inboxNew = new Set();
  renderInbox(); render();
  const b = inboxOpener && inboxOpener.isConnected ? inboxOpener : $('[data-act="inbox-open"]');
  if (b && b.focus) b.focus({ preventScroll: true });
  inboxOpener = null;
}
function inboxItemHTML(x, fresh) {
  const when = x.at ? ` · ${Inbox.ago(x.at, Date.now())}` : '';
  return `<li><button type="button" class="inbox-item" data-inbox-go="${esc(x.go)}"><span class="inbox-t"><b>${esc(x.title)}</b><small>${esc(x.body)}${when}</small></span>${fresh ? '<span class="inbox-new">New</span>' : '<span class="inbox-chev" aria-hidden="true">›</span>'}</button></li>`;
}
function renderInbox() {
  const root = $('#sheet11');
  if (!root) return;
  if (!inboxOpen || !club) { if (inboxHeld) { inboxHeld = false; inboxBehind(false); } root.innerHTML = ''; root._html = root._key = ''; return; }
  const news = inboxMem.log;
  const body = `<div class="sheet-head"><h2 id="inbox-h" tabindex="-1">Inbox</h2><button type="button" class="x" data-act="inbox-close" aria-label="Close">✕</button></div>
    ${inboxNeeds.length ? `<h3 class="inbox-sec">Needs you</h3><ul class="inbox-list">${inboxNeeds.map(x => inboxItemHTML(x, false)).join('')}</ul>` : ''}
    ${news.length ? `<h3 class="inbox-sec">Recent</h3><ul class="inbox-list">${news.map(x => inboxItemHTML(x, inboxNew.has(x.id))).join('')}</ul>` : ''}
    ${inboxNeeds.length || news.length ? '' : '<p class="note">You are all caught up. Game night changes, games to confirm, live events and league results show up here.</p>'}
    <p class="note">Built on this phone from your club's data. Nothing is stored on the server.</p>
    <div class="btns">${myName() ? (myToken() ? '<button type="button" class="btn btn-soft" data-act="notify-open">Notification settings</button>' : '') : '<button type="button" class="btn btn-soft" data-act="inbox-pick-name">Pick your name for push alerts</button>'}<button type="button" class="btn btn-soft" data-act="inbox-close">Done</button></div>`;
  setSheet(root, `<div class="sheet-bg top"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="inbox-h"><span class="grip"></span>${body}</div></div>`, 'inbox');
  inboxHeld = true; inboxBehind(true);
}
function inboxGo(go) {
  inboxOpen = false; inboxNew = new Set(); renderInbox();
  if (go === 'history') { tab = 'history'; store.set('pb.tab', tab); render(); try { document.body.scrollTo(0, 0); } catch {} }
  else if (go === 'nights') { render(); gnOpen('inbox'); }
  else if (go === 'club') { render(); clubSheet = { view: 'club' }; renderClub(); }
  else if (go === 'league') { tab = 'events'; store.set('pb.tab', tab); render(); evOpenList(); lgOpen(); }
  else if (go.startsWith('event:')) { tab = 'events'; store.set('pb.tab', tab); render(); evOpenList(); evShow(go.slice(6)); }
  else render();
}
