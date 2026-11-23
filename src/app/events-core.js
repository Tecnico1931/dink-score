/* ---------- events: tournaments and rotating doubles ---------- */
// An organizer sets an event up; the players in a match and organizers score it (or any member, if the organizer allows). The server keeps the rounds, courts and
// standings and, when a match is finished, adds it to the club's games itself, so this screen never saves a game twice.
const EV_FORMATS = [['roundrobin', 'Round robin'], ['pool_knockout', 'Pool + knockout'], ['single_elim', 'Single elim'], ['double_elim', 'Double elim']];
const EV_FORMAT_NAME = { roundrobin: 'Round robin', pool_knockout: 'Pool play + knockout', single_elim: 'Single elimination', double_elim: 'Double elimination' };
const EV_FORMAT_NOTE = {
  roundrobin: 'Round after round, on as many courts as you pick. Standings count wins, then point difference.',
  pool_knockout: 'A round robin first, then the best teams play a knockout bracket.',
  single_elim: 'Lose once and you are out. Top seeds get byes when the bracket is not full.',
  double_elim: 'Out after a second loss. The losers bracket can still win it all.'
};
const EV_ROT_NOTE = {
  'rotating-auto': 'Partners and opponents are spread as evenly as possible. When there are more players than courts, everyone takes turns sitting out.',
  'rotating-random': 'A fresh random draw every round. Byes are still shared evenly.',
  'rotating-manual': 'Each round starts as a suggestion. You change the pairings, then open it.',
  'fixed-auto': 'The strongest player is paired with the weakest by Dink Rating, so teams come out even.',
  'fixed-random': 'Teams are drawn at random.',
  'fixed-manual': 'Teams are the players in the order you tap them: 1st with 2nd, 3rd with 4th.'
};
let evScreen = null;  // null, or { view: 'list' | 'new' | 'detail', list, id, event, form, entry, edit, error, busy }
let evSummary = [];   // the club's events, for the home tile
let evPending = false;
const canOrganize = () => !!club && (!!owners[club.code] || (!!club.hasPin && !!pins[club.code]));
const evCall = body => api('events', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code }, body, adminCreds())) });
const evTeamName = (t, ev) => (t ? BK.teamName(ev, t) : 'To be decided'); // a team's name from the sheet, else its players
function evNewForm() {
  return { name: '', format: 'roundrobin', partners: 'rotating', rotation: 'auto', courts: 2, rounds: null, advance: 4, target: +setup.target || 11, scoring: setup.scoring, winBy: +setup.winBy || 2, players: [], imp: null, seeding: false, divisions: 0, seedPv: null, error: '', busy: false };
}
const evDefaultRounds = n => Math.min(15, Math.max(3, n - 1));

function evOpenList() {
  if (!club) return;
  evScreen = { view: 'list', list: null, error: '' };
  renderEvents(true); evLoadList();
  const b = document.querySelector('#events .ev-back'); if (b) b.focus();
}
function evShow(id) {
  evScreen = { view: 'detail', id, event: null, loading: true, error: '', list: evScreen ? evScreen.list : null };
  renderEvents(true); evLoad(id);
}
async function evLoadList() {
  const s = evScreen;
  try {
    const data = await api('events?code=' + club.code);
    evSummary = data.events; evLoadedFor = club.code;
    if (evScreen === s) { s.list = data.events; s.more = !!data.more; s.error = ''; }
  } catch (err) { if (evScreen === s) { s.list = s.list || []; s.error = err.message; } }
  renderEvents(); if (tab === 'play' || tab === 'events') safeRender();
}
// The list shows 50 at a time; this fetches the next page and adds it on.
async function evLoadMore() {
  const s = evScreen;
  if (!s || !s.list || s.loadingMore) return;
  s.loadingMore = true; renderEvents(true);
  try {
    const data = await api(`events?code=${club.code}&offset=${s.list.length}`);
    if (evScreen === s) { const have = new Set(s.list.map(e => e.id)); s.list = s.list.concat(data.events.filter(e => !have.has(e.id))); s.more = !!data.more && data.events.length > 0; s.error = ''; }
  } catch (err) { if (evScreen === s) s.error = err.message; }
  if (evScreen === s) { s.loadingMore = false; renderEvents(true); }
}
// The Events tab page: its data, and the TV shortcut (the same share links as the event and league screens; only organizers can see a token).
const evTab = { code: '', at: 0, busy: false, leagues: null, evd: null, lgd: null, tokens: {}, arm: '', err: '' };
async function evTabLoad() {
  if (!club || !API_OK || evTab.busy) return;
  const code = club.code, same = () => !!club && club.code === code;
  evTab.busy = true;
  try {
    const [e, l] = await Promise.all([api('events?code=' + code), api('events?leagues=1&code=' + code)]);
    if (!same()) return;
    evSummary = e.events; evTab.leagues = l.leagues; evTab.err = '';
    const ev = evSummary.find(x => x.status === 'live' && !evElim(x)), lg = l.leagues.find(x => x.status === 'live' && x.kind !== 'ladder');
    const [ed, ld] = await Promise.all([ev ? api(`events?code=${code}&id=${encodeURIComponent(ev.id)}`).catch(() => null) : null, lg ? api(`events?code=${code}&league=${encodeURIComponent(lg.id)}`).catch(() => null) : null]);
    if (!same()) return;
    evTab.evd = ed && ed.event; evTab.lgd = ld && ld.league;
  } catch (err) { evTab.err = err.offline ? 'You are offline. Events show here when you are back online.' : err.message; }
  finally { evTab.busy = false; evTab.at = Date.now(); }
  if (tab === 'events' && !evScreen && !lgScreen) safeRender();
}
async function evTabTv(kind, id) {
  if (!canOrganize()) return;
  const key = kind + id, lg = kind === 'league', fx = () => { const b = document.querySelector(`[data-${lg ? 'lg' : 'ev'}="tab-tv"][data-id="${CSS.escape(id)}"]`); if (b) b.focus({ preventScroll: true }); };
  if (!evTab.tokens[key] && evTab.arm !== key) { // making the public link is the one side effect, so it takes a second tap
    evTab.arm = key; safeRender(); fx(); announce('Tap again to make a public link and open it. Anyone with the link can watch; names and scores only.'); return;
  }
  evTab.arm = '';
  const w = window.open('', '_blank'); // opened now, while the tap still counts, so the pop-up blocker lets it through
  try {
    let t = evTab.tokens[key];
    if (!t) { const d = lg ? await lgCall({ action: 'league-share', id }) : await evCall({ action: 'share', id }); t = evTab.tokens[key] = d.shareToken; }
    const url = lg ? lgShareUrl(t) : evShareUrl(t) + '?tv=1';
    if (w) { w.location.href = url; announce(lg ? 'Opened the public page.' : 'Opened the TV view.'); } else { showToast('Allow pop-ups to open the TV view.', false); announce('Allow pop-ups to open the TV view.'); }
  } catch (err) {
    if (w) w.close();
    if (err.status === 403) forgetPin();
    const msg = err.offline ? 'You are offline. Try again when you are back online.' : err.message;
    showToast(msg, false); announce(msg);
  }
  safeRender(); fx();
}
async function evSummaryRefresh() {
  if (!club || !API_OK || (tab !== 'play' && !evScreen)) return; // the summary only feeds the tile on Play
  try {
    const data = await api('events?code=' + club.code);
    if (JSON.stringify(data.events.map(e => [e.id, e.status])) !== JSON.stringify(evSummary.map(e => [e.id, e.status]))) { evSummary = data.events; evLoadedFor = club.code; if ((tab === 'play' || tab === 'events') && !evScreen) safeRender(); }
    else { evSummary = data.events; if (evLoadedFor !== club.code) { evLoadedFor = club.code; safeRender(); } }
  } catch {}
}
async function evLoad(id, quiet) {
  const s = evScreen;
  if (!s || !club) return;
  try {
    const data = await api(`events?code=${club.code}&id=${encodeURIComponent(id)}`);
    if (evScreen !== s || s.id !== id) return;
    s.event = data.event; s.loading = false; if (!quiet) s.error = '';
    evRefsLoad(s);
  } catch (err) {
    if (evScreen !== s) return;
    s.loading = false;
    if (err.status === 404) { s.view = 'list'; s.error = 'That event no longer exists.'; evLoadList(); }
    else if (!quiet || !s.event) s.error = err.offline && s.event ? '' : err.message;
  }
  renderEvents();
}
// While someone is typing a score, the polling refresh waits so it can't wipe what they typed.
const evTyping = () => { const a = document.activeElement; return !!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest && a.closest('#events')); };
function renderEvents(force) {
  const root = $('#events');
  if (!root) return;
  const open = !!(evScreen && club);
  for (const sel of ['#app', '#tabs']) { const el = $(sel); if (el) el.inert = open; } // the page behind is out of reach while the screen is open
  if (!open) { if (root._html) { root.innerHTML = ''; root._html = ''; } return; }
  if (!force && evTyping()) { evPending = true; return; }
  evPending = false;
  const html = evHTML();
  if (root._html === html) return;
  const old = root.querySelector('.ev-screen');
  const key = evScreen.view + ':' + (evScreen.id || '');
  const y = old && root._key === key ? old.scrollTop : 0;
  const sx = root._key === key ? [...root.querySelectorAll('.bk-scroll')].map(e => e.scrollLeft) : [];
  const fa = document.activeElement, pickId = fa && fa.dataset && fa.dataset.ev === 'pick' && root.contains(fa) ? fa.dataset.m : null;
  root.innerHTML = html; root._html = html; root._key = key;
  const sc = root.querySelector('.ev-screen');
  if (sc && y) sc.scrollTop = y;
  BK.fitAll(root);
  if (evScreen.view === 'new') evImpRefresh(); // fills in the messages next to the import preview's rows
  root.querySelectorAll('.bk-scroll').forEach((e, i) => { if (sx[i]) e.scrollLeft = sx[i]; });
  if (pickId) { const b = root.querySelector(`[data-ev="pick"][data-m="${CSS.escape(pickId)}"]`); if (b) b.focus({ preventScroll: true }); }
  if (!old || root._focusKey !== key) { root._focusKey = key; const b = root.querySelector('.ev-back'); if (b) b.focus({ preventScroll: true }); }
}
BK.watchLogos();
// The scroller (body) keeps a stable gutter, so the fixed tab bar is inset by its width to share the column's center.
function syncGutter() { document.documentElement.style.setProperty('--sbw', (document.body.offsetWidth - document.body.clientWidth) + 'px'); }
syncGutter(); window.addEventListener('resize', syncGutter);
window.addEventListener('resize', () => { if (evScreen && evScreen.view === 'bracket') requestAnimationFrame(() => BK.fitAll($('#events'))); });
document.addEventListener('focusout', () => { if (evPending) setTimeout(() => { if (evPending && !evTyping()) renderEvents(); }, 50); });
setInterval(() => { if (evScreen && (evScreen.view === 'detail' || evScreen.view === 'bracket') && !document.hidden && !evScreen.busy && club) evLoad(evScreen.id, true); }, 8000);

function evSeg(key, options, value) {
  return `<div class="seg" role="group">${options.map(([v, l]) => `<button type="button" data-ev="set" data-k="${key}" data-v="${v}" aria-pressed="${String(v) === String(value)}">${l}</button>`).join('')}</div>`;
}
function evStepper(key, label, value, min, max) {
  return `<div class="field"><span class="lab" id="ev-l-${key}">${label}</span><div class="ev-step" role="group" aria-labelledby="ev-l-${key}"><button type="button" data-ev="step" data-k="${key}" data-d="-1" aria-label="Fewer" ${value <= min ? 'disabled' : ''}>−</button><b class="num" aria-live="polite">${value}</b><button type="button" data-ev="step" data-k="${key}" data-d="1" aria-label="More" ${value >= max ? 'disabled' : ''}>+</button></div></div>`;
}
const evItemBody = e => `<span class="ev-item-head"><b>${esc(e.name)}</b><span class="badge ${e.status === 'live' ? 'hot' : 'prov'}">${e.status === 'live' ? 'Live' : 'Finished'}</span></span>
    <span class="note">${esc(EV_FORMAT_NAME[e.format])}${e.partners === 'rotating' ? ', partners rotate' : ', fixed teams'} · ${e.players} players · ${e.courts} court${e.courts === 1 ? '' : 's'}</span><span class="note">${esc(evProgress(e))}</span>`;
const evProgress = e => e.status === 'done' ? (e.champion ? `Won by ${e.champion.join(' & ')}` : 'Finished')
  : e.stage === 'knockout' ? 'Knockout under way' : `Round ${Math.max(1, e.round)} of ${e.roundsPlanned}`;

function evHTML() {
  const s = evScreen;
  const body = s.view === 'new' ? evNewHTML(s) : s.view === 'detail' ? evDetailHTML(s) : s.view === 'bracket' ? evBracketHTML(s) : evListHTML(s);
  const title = s.view === 'new' ? 'New event' : s.view === 'detail' || s.view === 'bracket' ? (s.event ? s.event.name : 'Event') : 'Events';
  return `<div class="ev-screen" role="dialog" aria-modal="true" aria-labelledby="ev-h"><div class="ev-wrap${s.view === 'bracket' ? ' wide' : ''}">
    <div class="ev-top"><button class="ev-back" data-ev="back" aria-label="${s.view === 'list' ? 'Close events' : s.view === 'bracket' ? 'Back to the event' : 'Back to events'}">${ICON.back}</button><h2 id="ev-h">${esc(title)}</h2></div>${body}</div></div>`;
}
function evListHTML(s) {
  const org = canOrganize();
  const hint = club.hasPin ? 'Starting and running events needs the organizer PIN.' : 'Only the phone that created the club can start events. Set an organizer PIN from the club screen to let other organizers help.';
  const make = org ? '<button class="btn btn-ink block" data-ev="new">New event</button>'
    : `<div class="org-card"><p>${esc(hint)}</p>${club.hasPin ? '<button class="btn btn-ink" data-ev="unlock">Unlock this phone</button>' : ''}</div>`;
  const items = (s.list || []).map(e => `<button class="ev-card ev-item" data-ev="open" data-id="${esc(e.id)}">${evItemBody(e)}</button>`).join('');
  return `${s.error ? `<p class="err" role="alert">${esc(s.error)}</p>` : ''}${make}
    <button class="btn btn-soft block" data-lg="open">Leagues and ladders</button>
    ${s.list === null ? skel(3, true) : items ? `<div class="ev-sec">${items}</div>${s.more ? `<button class="btn btn-soft block" data-ev="more" ${s.loadingMore ? 'disabled' : ''}>${s.loadingMore ? 'Loading…' : 'Show more events'}</button>` : ''}` : '<div class="empty"><p>No events yet. An organizer can run a round robin with rotating partners, a pool play and knockout, or a single or double elimination bracket.</p></div>'}`;
}
// Seeding and divisions from Dink Rating. The ratings are the club's, read by the server when the event is made.
function evSeedingHTML(f, n, elim, fixed, imported) {
  if (imported) return '';
  const canDivide = !(fixed && f.rotation === 'manual');
  const pv = f.seedPv, rate = p => `${esc(p.name)} ${p.rating.toFixed(2)}${p.provisional ? ' (provisional)' : ''}`;
  const pvHTML = !pv ? '' : pv.divisions ? `<ul class="note ev-seedpv">${pv.divisions.map(d => `<li><b>${esc(d.label)}</b>: ${d.players.map(rate).join(', ')}</li>`).join('')}</ul>`
    : `<ul class="note ev-seedpv"><li>${pv.players.map(rate).join('</li><li>')}</li></ul>`;
  return `${elim ? `<div class="field"><label class="imp-check"><input type="checkbox" data-ev-input="seeding" ${f.seeding ? 'checked' : ''}> Seed teams by rating</label><p class="note">${f.seeding ? 'The strongest team is seed 1, by Dink Rating. Players without games count as 2.00.' : 'Teams are seeded in the order they are formed.'}</p></div>` : ''}
    ${canDivide ? `<div class="field"><span class="lab">Divisions</span>${evSeg('divisions', [[0, 'One event'], [2, '2'], [3, '3'], [4, '4']], f.divisions)}<p class="note">${f.divisions ? `Splits the players by Dink Rating into ${f.divisions} events, the strongest in Division A.` : 'Everyone plays in one event.'}</p></div>` : ''}
    ${n >= 4 && (f.seeding || f.divisions) ? `<div class="field"><button type="button" class="btn btn-soft ev-small" data-ev="seed-pv" ${f.busy ? 'disabled' : ''}>Preview ratings${f.divisions ? ' and divisions' : ''}</button>${pvHTML}</div>` : ''}`;
}
function evNewHTML(s) {
  const f = s.form, n = f.players.length, rotating = f.partners === 'rotating' && (f.format === 'roundrobin' || f.format === 'pool_knockout');
  const elim = f.format === 'single_elim' || f.format === 'double_elim';
  const fixed = !rotating;
  const imp = f.imp && f.imp.draft && imMod ? imMod.validate(f.imp.draft, evImpOpts(f)) : null; // the checked import, once a sheet has been read
  const rotLabels = rotating ? [['auto', 'Fair rotation'], ['random', 'Random draw'], ['manual', 'I pick']] : [['auto', 'Balanced'], ['random', 'Random draw'], ['manual', 'I pick']];
  const names = [...roster, ...f.players.filter(p => !roster.some(r => sameName(r, p)))];
  const chips = names.map(p => { const i = f.players.findIndex(x => sameName(x, p)); return `<button type="button" class="chip-btn" data-ev="pick" data-pl="${esc(p)}" aria-pressed="${i >= 0}">${i >= 0 && fixed && f.rotation === 'manual' ? `<span class="r">${i + 1}</span>` : ''}${esc(p)}</button>`; }).join('');
  const hint = imp ? (imp.ok ? '' : 'Fix the problems in the import first.') : n < 4 ? 'Pick at least 4 players.' : fixed && n % 2 ? 'Fixed teams need an even number of players.' : f.format === 'double_elim' && n < 6 ? 'Double elimination needs at least 6 players (3 teams).'
    : f.format === 'pool_knockout' && n < 8 ? 'Pool play and knockout needs at least 8 players.' : n > 32 ? 'An event holds at most 32 players.' : '';
  const rounds = f.rounds || evDefaultRounds(n || 8);
  const maxAdv = Math.max(2, Math.min(16, Math.floor(n / 2)));
  const teamsPreview = fixed && f.rotation === 'manual' && n >= 2 ? `<p class="note">${Array.from({ length: Math.floor(n / 2) }, (_, i) => `Team ${i + 1}: ${esc(f.players[2 * i])} &amp; ${esc(f.players[2 * i + 1])}`).join('<br>')}</p>` : '';
  return `<form class="ev-card" data-ev-form="create" novalidate>
    <div class="field"><label class="lab" for="ev-name">Name</label><input id="ev-name" class="field-input" data-ev-input="name" maxlength="40" autocomplete="off" placeholder="Saturday ladder, Club cup…" value="${esc(f.name)}"></div>
    <div class="field"><span class="lab">Format</span><div class="seg ev-seg2" role="group">${EV_FORMATS.map(([v, l]) => `<button type="button" data-ev="set" data-k="format" data-v="${v}" aria-pressed="${f.format === v}">${l}</button>`).join('')}</div><p class="note">${esc(EV_FORMAT_NOTE[f.format])}</p></div>
    ${elim ? '' : `<div class="field"><span class="lab">Partners</span>${evSeg('partners', [['rotating', 'Rotate every round'], ['fixed', 'Fixed teams']], f.partners)}</div>`}
    ${imp && imp.usesTeams ? '' : `<div class="field"><span class="lab">${rotating ? 'Who plays with whom' : 'Forming teams'}</span>${evSeg('rotation', rotLabels, f.rotation)}<p class="note">${esc(EV_ROT_NOTE[(rotating ? 'rotating-' : 'fixed-') + f.rotation])}</p></div>`}
    ${evStepper('courts', 'Courts', f.courts, 1, 8)}
    ${rotating ? evStepper('rounds', 'Rounds', rounds, 1, 30) : ''}
    ${f.format === 'pool_knockout' ? evStepper('advance', 'Teams in the knockout', Math.min(f.advance, maxAdv), 2, maxAdv) : ''}
    <div class="seg-row" style="margin:0"><div class="field"><span class="lab">Play to</span>${evSeg('target', [[11, '11'], [15, '15'], [21, '21']], f.target)}</div>
      <div class="field" style="margin:0"><span class="lab">Win by</span>${evSeg('winBy', [[2, '2'], [1, '1']], f.winBy)}</div></div>
    <div class="field"><span class="lab">Scoring</span>${evSeg('scoring', [['sideout', 'Side-out'], ['rally', 'Rally']], f.scoring)}</div>
    ${evSeedingHTML(f, n, elim, fixed, !!imp)}
    <div class="field"><label class="imp-check"><input type="checkbox" data-ev-input="results-any" ${f.resultsAny ? 'checked' : ''}> Let any club member enter results</label><p class="note">${f.resultsAny ? 'Anyone who has joined the club can enter any match result.' : 'Only the players in a match and organizers can enter its result. You can change this later.'}</p></div>
    ${evImportHTML(f)}
    ${imp ? '' : `<div class="field"><div class="rhead"><span class="lab">Players (${n})</span><span><button type="button" class="link" data-ev="pick-all">All</button> <button type="button" class="link" data-ev="pick-none">None</button></span></div>
      <div class="chips">${chips || '<span class="note">Add the players below.</span>'}</div>${teamsPreview}
      <div class="add-player"><input id="ev-guest" data-ev-input="guest" placeholder="Add a player" autocomplete="off" maxlength="40" aria-label="Add a player"><button type="button" class="btn btn-soft" data-ev="guest" style="padding:10px 16px;border-radius:12px">Add</button></div></div>`}
    ${hint ? `<p class="note" role="status">${esc(hint)}</p>` : ''}${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <button type="submit" class="btn btn-ink block" ${imp ? 'data-imp-go' : ''} ${f.busy || hint ? 'disabled' : ''}>${f.busy ? 'Starting…' : imp ? `Create the event with ${imp.players.length} players` : 'Start event'}</button></form>`;
}
