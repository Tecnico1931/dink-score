/* ---------- leagues and ladders (api/_leagues.js, through /api/events) ---------- */
// A league is a season of weekly round robin matches in divisions; a ladder is a ranking moved by challenge matches. A new result goes through the
// outbox like an event result (queueOp, so it waits for signal); fixing a score is organizer-only and online. The server also saves each result as a normal game, once.
let lgScreen = null; // null, or { view: 'list' | 'new' | 'detail', list, id, league, form, entry, ch, plan (week form), rs (move form), ff (forfeit choice), error, busy }
const lgCall = body => api('events', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code }, body, senderCreds(), adminCreds())) });
const lgName = names => names.join(' & ');
const lgQueued = id => lgScreen && lgScreen.league && clubOps().find(o => o.type === 'league-result' && o.leagueId === lgScreen.league.id && (o.matchId || o.key) === id);
const lgKey = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => (b % 36).toString(36)).join('');
const LG_TB_LABEL = { diff: 'Point difference', pf: 'Points for', h2h: 'Head-to-head' };
const LG_TB_SHORT = { diff: '+/−', pf: 'points for', h2h: 'head-to-head' };
const lgTbCustom = tb => Array.isArray(tb) && tb.join(',') !== 'diff,pf' && tb.join(',') !== 'diff,pf,h2h';
const lgTbText = tb => (Array.isArray(tb) ? tb : []).map(k => LG_TB_SHORT[k] || k).join(', ');
const lgMaxMove = (units, divs) => { if (divs <= 1) return 0; if (units < 3 * divs) return 3; const min = Math.floor(units / divs); return divs === 2 ? Math.max(1, Math.floor(min / 2)) : Math.max(1, Math.floor((min - 1) / 2)); };
const lgMoveNote = n => !n ? 'Everyone stays in the same division next season.' : n === 1 ? 'The top 1 of each division moves up and the bottom 1 moves down.' : `The top ${n} of each division move up and the bottom ${n} move down.`;
const lgNewForm = () => ({ kind: 'league', name: '', season: '', mode: 'doubles', divisions: 1, legs: 1, move: 1, tiebreak: ['diff', 'pf', 'h2h'], jump: 3, decayDays: 0, target: +setup.target || 11, scoring: setup.scoring, winBy: +setup.winBy || 2, resultsAny: false, players: [], error: '', busy: false });
function lgOpen() {
  if (!club) return;
  lgScreen = { view: 'list', list: null, error: '' };
  renderLeagues(true); lgLoadList();
}
function lgClose() { lgScreen = null; renderLeagues(true); const b = document.querySelector('[data-lg="open"]'); if (b) b.focus({ preventScroll: true }); }
async function lgLoadList() {
  const s = lgScreen;
  try { const d = await api('events?leagues=1&code=' + club.code); if (lgScreen === s) { s.list = d.leagues; s.error = ''; } }
  catch (err) { if (lgScreen === s) { s.list = s.list || []; s.error = err.message; } }
  renderLeagues();
}
async function lgLoad(id, quiet) {
  const s = lgScreen;
  if (!s || !club) return;
  try {
    const d = await api(`events?code=${club.code}&league=${encodeURIComponent(id)}`);
    if (lgScreen !== s || s.id !== id) return;
    s.league = d.league; s.loading = false; if (!quiet) s.error = '';
  } catch (err) {
    if (lgScreen !== s) return;
    s.loading = false;
    if (err.status === 404) { s.view = 'list'; s.error = 'That one no longer exists.'; lgLoadList(); }
    else if (!quiet || !s.league) s.error = err.message;
  }
  renderLeagues();
}
const lgTyping = () => { const a = document.activeElement; return !!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest && a.closest('#leagues')); };
function renderLeagues(force) {
  const root = $('#leagues');
  if (!root) return;
  const open = !!(lgScreen && club);
  const ev = $('#events'); if (ev) ev.inert = open; // the events screen behind is out of reach while this one is open
  if (!open) { if (root._html) { root.innerHTML = ''; root._html = ''; } for (const sel of ['#app', '#tabs']) { const el = $(sel); if (el && !evScreen) el.inert = false; } return; }
  for (const sel of ['#app', '#tabs']) { const el = $(sel); if (el) el.inert = true; }
  if (!force && lgTyping()) return;
  const html = lgHTML();
  if (root._html === html) return;
  const old = root.querySelector('.ev-screen'), key = lgScreen.view + ':' + (lgScreen.id || '');
  const y = old && root._key === key ? old.scrollTop : 0;
  root.innerHTML = html; root._html = html; root._key = key;
  const sc = root.querySelector('.ev-screen');
  if (sc && y) sc.scrollTop = y;
  if (!old || root._focusKey !== key) { root._focusKey = key; const b = root.querySelector('.ev-back'); if (b) b.focus({ preventScroll: true }); }
}
setInterval(() => { if (lgScreen && lgScreen.view === 'detail' && !document.hidden && !lgScreen.busy && club) lgLoad(lgScreen.id, true); }, 8000);

function lgHTML() {
  const s = lgScreen, L = s.league;
  const body = s.view === 'new' ? lgNewHTML(s) : s.view === 'detail' ? (s.loading || !L ? `${s.error ? `<p class="err" role="alert">${esc(s.error)}</p>` : skel(3)}` : L.kind === 'ladder' ? lgLadderHTML(s, L) : lgLeagueHTML(s, L)) : lgListHTML(s);
  const title = s.view === 'new' ? 'New league or ladder' : s.view === 'detail' ? (L ? L.name : 'League') : 'Leagues and ladders';
  return `<div class="ev-screen" role="dialog" aria-modal="true" aria-labelledby="lg-h"><div class="ev-wrap">
    <div class="ev-top"><button class="ev-back" data-lg="back" aria-label="${s.view === 'list' ? 'Close leagues and ladders' : 'Back to leagues and ladders'}">${ICON.back}</button><h2 id="lg-h">${esc(title)}</h2></div>${body}</div></div>`;
}
const lgProgress = e => e.kind === 'ladder' ? `${e.results} result${e.results === 1 ? '' : 's'} this season${e.top ? ` · top: ${lgName(e.top)}` : ''}`
  : e.status === 'done' ? `Season finished${e.champions && e.champions[0] ? ` · ${e.champions.map(c => c ? lgName(c) : '').filter(Boolean).join(', ')}` : ''}` : `${e.played} of ${e.matches} matches played`;
const lgItemBody = e => `<span class="ev-item-head"><b>${esc(e.name)}</b><span class="badge ${e.status === 'live' ? 'hot' : 'prov'}">${e.kind === 'ladder' ? 'Ladder' : e.status === 'live' ? 'Live' : 'Finished'}</span></span>
    <span class="note">${esc(e.season)} · ${e.kind === 'ladder' ? 'Ladder' : `League, ${e.divisions} division${e.divisions === 1 ? '' : 's'}`} · ${e.entries} ${e.mode === 'doubles' ? 'teams' : 'players'}</span><span class="note">${esc(lgProgress(e))}</span>`;
function lgListHTML(s) {
  const org = canOrganize();
  const make = org ? '<button class="btn btn-ink block" data-lg="new">New league or ladder</button>' : `<div class="org-card"><p>${esc(club.hasPin ? 'Starting leagues and ladders needs the organizer PIN.' : 'Only the phone that created the club can start leagues and ladders.')}</p></div>`;
  const items = (s.list || []).map(e => `<button class="ev-card ev-item" data-lg="open-one" data-id="${esc(e.id)}">${lgItemBody(e)}</button>`).join('');
  return `${s.error ? `<p class="err" role="alert">${esc(s.error)}</p>` : ''}${make}
    ${s.list === null ? skel(3) : items ? `<div class="ev-sec">${items}</div>` : '<div class="empty"><p>Nothing yet. A league plays a season of weekly matches in divisions; a ladder lets players challenge the ones above them.</p></div>'}`;
}
function lgNewHTML(s) {
  const f = s.form, n = f.players.length, ladder = f.kind === 'ladder', singles = f.mode === 'singles';
  const names = [...roster, ...f.players.filter(p => !roster.some(r => sameName(r, p)))];
  const chips = names.map(p => `<button type="button" class="chip-btn" data-lg="pick" data-pl="${esc(p)}" aria-pressed="${f.players.some(x => sameName(x, p))}">${esc(p)}</button>`).join('');
  const units = singles ? n : Math.floor(n / 2), per = ladder ? 1 : f.divisions, maxM = lgMaxMove(units, f.divisions), curMove = f.divisions > 1 ? Math.min(f.move, maxM) : 0;
  const hint = !singles && n % 2 ? 'Doubles teams need an even number of players.' : units < 3 * per ? `Pick at least ${3 * per * (singles ? 1 : 2)} players${per > 1 ? ` for ${per} divisions` : ''}.` : units > 32 ? 'At most 32 players or teams.' : '';
  const seg = (k, opts) => evSeg(k, opts, f[k]).replaceAll('data-ev="set"', 'data-lg="set"');
  const tbList = f.tiebreak.map((k, i) => `<li><span>${i + 1}. ${LG_TB_LABEL[k]}</span><span class="lg-tb-btns"><button type="button" data-lg="tb" data-i="${i}" data-d="-1" aria-label="Move ${LG_TB_LABEL[k]} up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-lg="tb" data-i="${i}" data-d="1" aria-label="Move ${LG_TB_LABEL[k]} down" ${i === f.tiebreak.length - 1 ? 'disabled' : ''}>↓</button></span></li>`).join('');
  return `<form class="ev-card" data-lg-form="create" novalidate>
    <div class="field"><span class="lab">Kind</span>${seg('kind', [['league', 'League'], ['ladder', 'Ladder']])}<p class="note">${ladder ? 'Players challenge someone a few places above them. Win and you take their place; lose and nothing changes.' : 'Everyone in a division plays everyone, a match or two each week, and the table decides the season. The top of each division moves up next season.'}</p></div>
    <div class="field"><label class="lab" for="lg-name">Name</label><input id="lg-name" class="field-input" data-lg-input="name" maxlength="40" autocomplete="off" placeholder="Tuesday league, Club ladder…" value="${esc(f.name)}"></div>
    <div class="field"><label class="lab" for="lg-season">Season (optional)</label><input id="lg-season" class="field-input" data-lg-input="season" maxlength="40" autocomplete="off" placeholder="Autumn 1" value="${esc(f.season)}"></div>
    <div class="field"><span class="lab">Who plays</span>${seg('mode', [['doubles', 'Doubles teams'], ['singles', 'Singles']])}<p class="note">${singles ? 'Each player is on their own.' : 'Teams are paired strongest with weakest by Dink Rating, so they come out even.'}</p></div>
    ${ladder ? evStepper('jump', 'Challenge up to this many places above', f.jump, 1, 10).replaceAll('data-ev="step"', 'data-lg="step"')
      + `<div class="field"><span class="lab">Idle players slip down</span>${seg('decayDays', [[0, 'Never'], [7, 'After 7 days'], [14, '14 days'], [30, '30 days']])}<p class="note">${f.decayDays ? `Anyone who has not played a challenge for ${f.decayDays} days drops one place, and one more for each further ${f.decayDays} days, until they play again.` : 'Places only change when someone wins a challenge.'}</p></div>`
      : `<div class="field"><span class="lab">Divisions</span>${seg('divisions', [[1, 'One'], [2, '2'], [3, '3'], [4, '4']])}<p class="note">${f.divisions > 1 ? `Split by Dink Rating into ${f.divisions} divisions, the strongest in Division A.` : 'Everyone plays in one table.'}</p></div>
      ${f.divisions > 1 ? evStepper('move', 'Promotion and relegation (each way)', curMove, 0, maxM).replaceAll('data-ev="step"', 'data-lg="step"') + `<p class="note">${lgMoveNote(curMove)}</p>` : ''}
      <div class="field"><span class="lab">Games against each opponent</span>${seg('legs', [[1, 'Once'], [2, 'Home and away']])}</div>
      <div class="field"><span class="lab" id="lg-tb-l">Tie-breakers (after wins)</span><ol class="lg-tb" aria-labelledby="lg-tb-l">${tbList}</ol><p class="note">After wins, tied entries are sorted in this order, then by name.</p></div>`}
    <div class="seg-row" style="margin:0"><div class="field"><span class="lab">Play to</span>${seg('target', [[11, '11'], [15, '15'], [21, '21']])}</div>
      <div class="field" style="margin:0"><span class="lab">Win by</span>${seg('winBy', [[2, '2'], [1, '1']])}</div></div>
    <div class="field"><span class="lab">Scoring</span>${seg('scoring', [['sideout', 'Side-out'], ['rally', 'Rally']])}</div>
    <div class="field"><label class="imp-check"><input type="checkbox" data-lg-input="resultsAny" ${f.resultsAny ? 'checked' : ''}> Let any club member enter results</label><p class="note">${f.resultsAny ? 'Anyone who has joined the club can enter any result.' : 'Only the players in a match and organizers can enter its result.'}</p></div>
    <div class="field"><div class="rhead"><span class="lab">Players (${n})</span><span><button type="button" class="link" data-lg="pick-all">All</button> <button type="button" class="link" data-lg="pick-none">None</button></span></div>
      <div class="chips">${chips || '<span class="note">Add the players below.</span>'}</div>
      <div class="add-player"><input id="lg-guest" data-lg-input="guest" placeholder="Add a player" autocomplete="off" maxlength="40" aria-label="Add a player"><button type="button" class="btn btn-soft" data-lg="guest" style="padding:10px 16px;border-radius:12px">Add</button></div></div>
    ${hint ? `<p class="note" role="status">${esc(hint)}</p>` : ''}${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <button type="submit" class="btn btn-ink block" ${f.busy || hint ? 'disabled' : ''}>${f.busy ? 'Starting…' : ladder ? 'Start ladder' : 'Start league'}</button></form>`;
}
function lgMatchHTML(s, L, m, org) {
  const done = m.status === 'done', win = done ? (m.score[0] > m.score[1] ? 0 : 1) : null;
  const line = t => `<div class="line ${win === t ? 'win' : ''}" style="--c:${TEAM_COLOR[t]}"><span class="tick"></span><span class="who">${esc(lgName(m.teams[t]))}</span><span class="pts">${done ? m.score[t] : ''}</span></div>`;
  const entry = s.entry && s.entry.m === m.id ? s.entry : null;
  const mine = m.teams.flat().some(isMe);
  const can = L.status === 'live' && (org || L.resultsBy === 'club' || mine);
  const q = !done && lgQueued(m.id);
  const rs = s.rs && s.rs.m === m.id ? s.rs : null, ff = s.ff === m.id;
  const busy = entry || rs || ff, own = org && L.status === 'live' && !busy, id = `data-m="${esc(m.id)}"`;
  const actions = q ? `<span class="tag">Waiting to send ${q.score[0]}–${q.score[1]}</span>`
    : (!done && can && !busy ? `<button class="btn btn-soft ev-small" data-lg="enter" ${id}>Enter score</button>` : '')
      + (!done && own ? `<button class="link" data-lg="resched" ${id}>Move</button><button class="link" data-lg="forfeit" ${id}>Forfeit</button>` : '')
      + (done && org && !busy ? (m.forfeit ? (own ? `<button class="link" data-lg="forfeit-undo" ${id}>Undo forfeit</button>` : '') : `<button class="link" data-lg="fix" ${id}>Fix score</button>`) : '');
  const slot = !done ? lgSlot(m.when || {}).map(t => `<span class="tag">${esc(t)}</span>`).join('') : '';
  return `<li class="game ev-game${done ? ' done' : ''}"><div class="lines">${line(0)}${line(1)}</div>
    <div class="meta">${L.divisions.length > 1 ? `<span class="tag">${esc(L.divisions[m.division].label)}</span>` : ''}${slot}${m.forfeit ? '<span class="tag">Forfeit</span>' : done ? '<span class="tag">Final</span>' : ''}</div>${actions ? `<div class="ev-actions">${actions}</div>` : ''}${entry ? lgScoreForm(entry, m.teams, 'entry', entry.fix ? 'Save the fix' : 'Save score') : ''}${rs ? lgMoveForm(rs) : ''}${ff ? lgForfeitChoice(m) : ''}</li>`;
}
// Day, time and court wording shared by the match lines, the week header and the forms (the date is a calendar date typed by the organizer, never shifted by a time zone).
const lgDay = d => { const p = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d || ''); return p ? new Date(+p[1], +p[2] - 1, +p[3]).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : ''; };
const lgSlot = x => [lgDay(x.date) && (x.moved ? 'Moved to ' : '') + lgDay(x.date) + (x.time ? ' ' + x.time : ''), x.court ? 'Court ' + x.court : ''].filter(Boolean);
const lgField = (id, label, type, key, val, extra = '') => `<div class="field"><label class="lab" for="${id}">${label}</label><input id="${id}" class="field-input" type="${type}" data-lg-input="${key}" value="${esc(val)}" ${extra}></div>`;
function lgMoveForm(r) {
  return `<form class="lg-plan" data-lg-form="resched" novalidate>${lgField('lg-rdate', 'New day', 'date', 'rdate', r.date)}${lgField('lg-rtime', 'Start time (optional)', 'time', 'rtime', r.time)}${lgField('lg-rcourt', 'Court (optional)', 'number', 'rcourt', r.court, 'inputmode="numeric" min="1" max="99"')}
    <p class="note">Leave the day empty to put the match back on its week's day. The players in it are told if they have notifications on.</p>${r.error ? `<p class="err" role="alert">${esc(r.error)}</p>` : ''}
    <div class="ev-actions"><button type="submit" class="btn btn-ink ev-small">Save</button><button type="button" class="btn btn-soft ev-small" data-lg="cancel">Cancel</button></div></form>`;
}
function lgForfeitChoice(m) {
  return `<div class="lg-plan"><p class="note">Who wins by forfeit? It counts ${esc(String(lgScreen.league.target))} to 0 in the table. It is not saved as a game, so ratings do not change.</p>
    <div class="ev-actions">${[0, 1].map(t => `<button class="btn btn-soft ev-small" style="border-left:5px solid ${TEAM_COLOR[t]}" data-lg="forfeit-win" data-w="${t}">${esc(lgName(m.teams[t]))} win</button>`).join('')}<button class="btn btn-soft ev-small" data-lg="cancel">Cancel</button></div></div>`;
}
// A week's day and byes, and for an organizer the plan and "tell the players" buttons (the form shows once: skipForm for the copy in All weeks).
function lgWeekHTML(s, L, w, org, skipForm) {
  const day = lgDay(w.date), left = w.matches.some(m => m.status === 'pending'), p = !skipForm && s.plan && s.plan.n === w.n ? s.plan : null, byes = w.byes || [];
  const info = `<p class="note">${day ? esc(day + (w.time ? ' at ' + w.time : '')) : 'No day set yet'}${byes.length ? ` · Bye: ${byes.map(b => esc(lgName(b.members))).join(', ')}` : ''}</p>`;
  const btns = org && L.status === 'live' && left && !(s.plan && s.plan.n === w.n) ? `<div class="ev-actions"><button class="btn btn-soft ev-small" data-lg="plan" data-n="${w.n}">Plan this week</button><button class="btn btn-soft ev-small" data-lg="notify" data-n="${w.n}" ${s.busy ? 'disabled' : ''}>Tell the players</button></div>` : '';
  const form = p ? `<form class="lg-plan" data-lg-form="plan" novalidate>${lgField('lg-pdate', 'Day', 'date', 'pdate', p.date)}${lgField('lg-ptime', 'Start time (optional)', 'time', 'ptime', p.time)}${lgField('lg-pcourts', 'Courts (optional)', 'number', 'pcourts', p.courts, 'inputmode="numeric" min="0" max="20"')}
    <p class="note">Matches get courts in order. With more matches than courts, some share a court and play in turn. Leave courts empty to keep them, or enter 0 to clear them.</p>${p.error ? `<p class="err" role="alert">${esc(p.error)}</p>` : ''}
    <div class="ev-actions"><button type="submit" class="btn btn-ink ev-small">Save week</button><button type="button" class="btn btn-soft ev-small" data-lg="cancel">Cancel</button></div></form>` : '';
  return info + btns + form;
}
function lgScoreForm(e, teams, kind, label) {
  return `<form class="ev-entry" data-lg-form="${kind}">${[0, 1].map(t => `<label style="--c:${TEAM_COLOR[t]}"><span>${esc(lgName(teams[t]))}</span><input type="number" inputmode="numeric" min="0" max="99" data-lg-input="s${t}" value="${esc(e.s[t])}" aria-label="${esc(lgName(teams[t]))} score"></label>`).join('')}
    ${e.error ? `<p class="err" role="alert">${esc(e.error)}</p>` : ''}<div class="ev-actions"><button type="submit" class="btn btn-blue ev-small">${label}</button><button type="button" class="btn btn-soft ev-small" data-lg="cancel">Cancel</button></div></form>`;
}
function lgOrgHTML(s, L) {
  if (!canOrganize()) return '';
  const done = L.status === 'done', ladder = L.kind === 'ladder', multi = !ladder && L.divisions.length > 1;
  const nextMove = multi ? (s.nextMove === undefined ? (L.move === undefined ? 1 : L.move) : s.nextMove) : 0;
  return `<section class="ev-card" aria-labelledby="lg-org"><h3 id="lg-org">Organizer</h3>
    <div class="field"><label class="imp-check"><input type="checkbox" data-lg-input="resultsBy" ${L.resultsBy === 'club' ? 'checked' : ''}> Let any club member enter results</label></div>
    ${done && multi ? evStepper('nextMove', 'Move up and down for next season', nextMove, 0, L.maxMove || 1).replaceAll('data-ev="step"', 'data-lg="step"') : ''}
    <div class="ev-actions">${ladder ? `<button class="btn btn-soft ev-small" data-lg="end" ${s.busy ? 'disabled' : ''}>Close this season</button>` : !done ? `<button class="btn btn-soft ev-small" data-lg="end" ${s.busy ? 'disabled' : ''}>Finish the season now</button>` : `<button class="btn btn-ink ev-small" data-lg="next" ${s.busy ? 'disabled' : ''}>Start the next season</button>`}
    <button class="btn btn-soft ev-small" data-lg="${s.armDelete ? 'delete-yes' : 'delete'}">${s.armDelete ? 'Tap again to delete' : 'Delete'}</button></div>
    <p class="note">${ladder ? 'Closing keeps the order as the next season’s start and clears the results.' : done ? (multi ? lgMoveNote(nextMove) : 'Everyone plays another season in the same table.') : 'Finishing early crowns whoever leads each table.'} Games already played stay in the club record.</p></section>${lgShareHTML(s, L)}`;
}
const lgShareUrl = t => `${location.origin}/l/${t}`;
function lgShareHTML(s, L) {
  const sh = s.share, shared = !!(sh && sh.token), arm = s.arm || '', what = L.kind === 'ladder' ? 'ladder' : 'league';
  if (!shared) return `<section class="ev-card" aria-labelledby="lg-sh"><h3 id="lg-sh">Watch without the app</h3><p class="note">Make a link anyone can open to follow this ${what} on a phone or a screen. It shows names, scores and the table only, and nobody can change anything.</p>
    ${sh && sh.error ? `<p class="err" role="alert">${esc(sh.error)}</p>` : ''}<div class="ev-actions"><button class="btn btn-ink ev-small" data-lg="share-open" ${sh && sh.busy ? 'disabled' : ''}>${sh && sh.busy ? 'Making the link…' : 'Share ' + what}</button></div></section>`;
  const url = lgShareUrl(sh.token);
  return `<section class="ev-card" aria-labelledby="lg-sh"><div class="ev-item-head"><h3 id="lg-sh">Public link</h3><button class="link" data-lg="share-hide">Hide</button></div>
    <p class="note">Anyone with this link can watch, nobody can change anything.</p>
    <input class="bk-share-url" type="text" readonly value="${esc(url)}" aria-label="Public ${what} link" id="lg-url">
    ${sh.error ? `<p class="err" role="alert">${esc(sh.error)}</p>` : ''}
    <div class="ev-actions"><button class="btn btn-ink ev-small" data-lg="share-copy">Copy link</button><a class="btn btn-soft ev-small" href="${esc(url)}" target="_blank" rel="noopener">Open</a></div>
    <div class="ev-actions"><button class="link ${arm === 'share-new' ? 'armed' : ''}" data-lg="share-new" ${sh.busy ? 'disabled' : ''}>${arm === 'share-new' ? 'Tap again: the old link stops working' : 'Make a new link'}</button><button class="link ${arm === 'share-off' ? 'armed' : ''}" data-lg="share-off" ${sh.busy ? 'disabled' : ''}>${arm === 'share-off' ? 'Tap again to stop sharing' : 'Stop sharing'}</button></div></section>`;
}
async function lgShare(a) {
  const s = lgScreen;
  if (!s || !s.league || (s.share && s.share.busy)) return;
  if ((a === 'share-new' || a === 'share-off') && s.arm !== a) { s.arm = a; renderLeagues(true); return; }
  s.arm = '';
  s.share = Object.assign({}, s.share, { busy: true, error: '' }); renderLeagues(true);
  try {
    const data = await lgCall({ action: a === 'share-open' ? 'league-share' : 'league-' + a, id: s.league.id });
    s.share = data.shareToken ? { token: data.shareToken } : null;
    if (a === 'share-off') showToast('Sharing stopped. The link no longer works.', false);
  } catch (err) {
    if (err.status === 403) forgetPin();
    s.share = Object.assign({}, s.share, { busy: false, error: err.offline ? 'You are offline. Try again when you are back online.' : err.message });
  }
  renderLeagues(true);
}
async function lgCopyLink() {
  const sh = lgScreen && lgScreen.share;
  if (!sh || !sh.token) return;
  try { await navigator.clipboard.writeText(lgShareUrl(sh.token)); showToast('Link copied', false); }
  catch { const i = $('#lg-url'); if (i) { i.focus(); i.select(); } showToast('Press and hold the link to copy it', false); }
}
function lgLeagueHTML(s, L) {
  const org = canOrganize();
  const wk = L.weeks.find(w => w.n === L.current) || L.weeks[0];
  const showPf = Array.isArray(L.tiebreak) && L.tiebreak.indexOf('pf') >= 0 && L.tiebreak.indexOf('pf') < L.tiebreak.indexOf('diff');
  const multi = L.divisions.length > 1, mv = multi ? (L.move === undefined ? 1 : L.move) : 0;
  const tables = L.tables.map((t, d) => `<section class="ev-sec"><h3>${esc(multi ? t.label : 'Standings')}</h3><div class="ev-card" style="padding:8px 12px"><table class="ev-table"><caption class="vh">${esc(t.label)}: wins, losses and point difference</caption>
    <tr><th class="who" scope="col">${L.mode === 'doubles' ? 'Team' : 'Player'}</th><th scope="col">P</th><th scope="col">W</th><th scope="col">L</th><th scope="col">+/-</th>${showPf ? '<th scope="col">PF</th>' : ''}</tr>
    ${t.rows.map((r, i) => {
      const zone = mv > 0 ? (d > 0 && i < mv ? ' <span class="badge hot">Up</span>' : d < L.divisions.length - 1 && i >= t.rows.length - mv ? ' <span class="badge prov">Down</span>' : '') : '';
      return `<tr><td class="who">${r.rank}. ${esc(r.name)}${r.members.some(isMe) ? ' <span class="badge you">You</span>' : ''}${zone}</td><td class="num">${r.played}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${r.diff > 0 ? '+' : ''}${r.diff}</td>${showPf ? `<td class="num">${r.pf}</td>` : ''}</tr>`;
    }).join('')}</table></div></section>`).join('');
  const champs = L.status === 'done' && L.champions ? `<p class="note"><b>Season winners:</b> ${L.champions.map((c, d) => c ? `${multi ? esc(L.divisions[d].label) + ': ' : ''}${esc(lgName(c))}` : '').filter(Boolean).join(' · ')}</p>` : '';
  const extras = `${lgTbCustom(L.tiebreak) ? ` · tie-break: ${lgTbText(L.tiebreak)}` : ''}${multi ? ` · ${mv ? `${mv} up / ${mv} down` : 'no promotion'}` : ''}`;
  return `${s.error ? `<p class="err" role="alert">${esc(s.error)}</p>` : ''}
    <p class="note">${esc(L.season)} · ${L.mode === 'doubles' ? 'Doubles' : 'Singles'}, ${L.scoring === 'rally' ? 'rally scoring' : 'side-out'} to ${L.target} · ${L.status === 'done' ? 'Season finished' : `Week ${L.current} of ${L.weeks.length}`}${extras}</p>${champs}
    ${L.status === 'live' && wk ? `<section class="ev-sec" aria-labelledby="lg-now"><h3 id="lg-now">${esc(wk.title)}</h3>${lgWeekHTML(s, L, wk, org)}<ul class="games">${wk.matches.map(m => lgMatchHTML(s, L, m, org)).join('')}</ul></section>` : ''}
    ${tables}
    <section class="ev-sec" aria-labelledby="lg-all"><h3 id="lg-all">All weeks</h3>${L.weeks.map(w => `<details class="ev-more"><summary>${esc(w.title)}${w.matches.every(m => m.status === 'done') ? ' · done' : lgDay(w.date) ? ' · ' + esc(lgDay(w.date)) : ''}</summary>${lgWeekHTML(s, L, w, org, w.n === L.current && L.status === 'live')}<ul class="games">${w.matches.map(m => lgMatchHTML(s, L, m, org)).join('')}</ul></details>`).join('')}</section>
    ${lgHistoryHTML(L)}${lgOrgHTML(s, L)}`;
}
// Earlier seasons of this league, newest first, each with the final table of every division (kept by api/_league.js nextSeason).
function lgHistoryHTML(L) {
  if (!L.history || !L.history.length) return '';
  const one = h => `<details class="ev-more"><summary>${esc(h.season)}${h.divisions[0] && h.divisions[0].rows[0] ? ` · ${esc(lgName(h.divisions[0].rows[0].members))}` : ''}</summary>${h.divisions.map(d => `<div class="ev-card" style="padding:8px 12px"><table class="ev-table"><caption class="vh">${esc(h.season)}, ${esc(d.label)}: final standings</caption>
    <tr><th class="who" scope="col">${h.divisions.length > 1 ? esc(d.label) : L.mode === 'doubles' ? 'Team' : 'Player'}</th><th scope="col">W</th><th scope="col">L</th><th scope="col">+/-</th></tr>
    ${d.rows.map((r, i) => `<tr><td class="who">${i + 1}. ${esc(lgName(r.members))}${r.members.some(isMe) ? ' <span class="badge you">You</span>' : ''}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${r.diff > 0 ? '+' : ''}${r.diff}</td></tr>`).join('')}</table></div>`).join('')}</details>`;
  return `<section class="ev-sec" aria-labelledby="lg-hist"><h3 id="lg-hist">Past seasons</h3>${L.history.map(one).join('')}</section>`;
}
function lgLadderHTML(s, L) {
  const org = canOrganize(), ch = s.ch || (s.ch = { c: (L.rows.find(r => r.members.some(isMe)) || {}).name || '', d: '', s: ['', ''], key: lgKey(), error: '' });
  const crow = L.rows.find(r => r.name === ch.c), opts = crow ? crow.canChallenge.map(lgName) : [];
  if (!opts.includes(ch.d)) ch.d = opts[opts.length - 1] || ''; // the nearest place above is the usual challenge
  const rows = `<div class="ev-card" style="padding:8px 12px"><table class="ev-table"><caption class="vh">Ladder order with wins and losses this season</caption>
    <tr><th class="who" scope="col">${L.mode === 'doubles' ? 'Team' : 'Player'}</th><th scope="col">W</th><th scope="col">L</th></tr>
    ${L.rows.map(r => `<tr><td class="who">${r.rank}. ${esc(r.name)}${r.members.some(isMe) ? ' <span class="badge you">You</span>' : ''}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td></tr>`).join('')}</table></div>`;
  const sel = (k, list) => `<select class="field-input" data-lg-sel="${k}" aria-label="${k === 'c' ? 'Challenger' : 'Who is challenged'}">${list.map(n => `<option ${n === ch[k] ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  const form = L.status === 'live' ? `<section class="ev-card" aria-labelledby="lg-ch"><h3 id="lg-ch">Record a challenge</h3>
    <div class="field"><span class="lab">Challenger</span>${sel('c', L.rows.map(r => r.name))}</div>
    <div class="field"><span class="lab">Challenges (up to ${L.jump} place${L.jump === 1 ? '' : 's'} above)</span>${opts.length ? sel('d', opts) : '<p class="note">Nobody is above them: they are top of the ladder.</p>'}</div>
    ${opts.length ? `<p class="note">Not played yet? Send the challenge first: they can accept or decline, and it lapses after 7 days.</p><div class="ev-actions"><button type="button" class="btn btn-soft ev-small" style="min-height:44px" data-lg="send-ch">Send challenge</button></div>` : ''}
    ${opts.length ? lgScoreForm({ s: ch.s, error: ch.error }, [crow.members, (L.rows.find(r => r.name === ch.d) || { members: [''] }).members], 'challenge', 'Save result').replace('<button type="button" class="btn btn-soft ev-small" data-lg="cancel">Cancel</button>', '') : ''}</section>` : '';
  const recent = L.results.length ? `<section class="ev-sec" aria-labelledby="lg-rec"><h3 id="lg-rec">Recent results</h3><ul class="games">${L.results.slice(0, 15).map(r => { const w = r.winner, l = 1 - w; return `<li class="game ev-game done"><div class="lines"><div class="line win" style="--c:${TEAM_COLOR[0]}"><span class="tick"></span><span class="who">${esc(lgName(r.teams[w]))}</span><span class="pts">${r.score[w]}</span></div><div class="line" style="--c:${TEAM_COLOR[1]}"><span class="tick"></span><span class="who">${esc(lgName(r.teams[l]))}</span><span class="pts">${r.score[l]}</span></div></div>
    <div class="meta"><span class="tag">${w === 0 ? 'Challenger won' : 'Defender held'}</span></div>${org ? `<div class="ev-actions"><button class="link" data-lg="fix-result" data-k="${esc(r.id)}">Fix score</button></div>` : ''}${s.entry && s.entry.m === r.id ? lgScoreForm(s.entry, [r.teams[0], r.teams[1]], 'entry', 'Save the fix') : ''}</li>`; }).join('')}</ul></section>` : '';
  const left = o => { const d = Math.max(1, Math.ceil((o.expiresAt - Date.now()) / 864e5)); return `${d} day${d === 1 ? '' : 's'} left`; };
  const btn = (o, w, label) => `<button type="button" class="btn btn-soft ev-small" style="min-height:44px" data-lg="answer-ch" data-k="${esc(o.id)}" data-w="${w}" aria-label="${label} the challenge from ${esc(lgName(o.challenger))} to ${esc(lgName(o.defender))}">${label}</button>`;
  const openCh = L.status === 'live' && L.open && L.open.length ? `<section class="ev-sec" aria-labelledby="lg-open"><h3 id="lg-open">Open challenges</h3><ul class="games">${L.open.map(o => {
    const mineD = org || o.defender.some(isMe), mineC = org || o.challenger.some(isMe);
    return `<li class="game ev-game"><div class="lines"><div class="line" style="--c:${TEAM_COLOR[0]}"><span class="tick"></span><span class="who">${esc(lgName(o.challenger))} challenged ${esc(lgName(o.defender))}</span></div></div>
      <div class="meta"><span class="tag">${o.state === 'accepted' ? 'Accepted: play it' : 'Waiting for an answer'}</span><span class="tag">${left(o)}</span></div>
      <div class="ev-actions">${mineD && o.state === 'open' ? btn(o, 'accept', 'Accept') : ''}${mineD ? btn(o, 'decline', 'Decline') : ''}${mineC ? btn(o, 'withdraw', 'Withdraw') : ''}</div></li>`; }).join('')}</ul></section>` : '';
  const waiting = clubOps().filter(o => o.type === 'league-result' && o.leagueId === L.id);
  const pending = waiting.length ? `<section class="ev-sec" aria-labelledby="lg-wait"><h3 id="lg-wait">Waiting to send</h3><ul class="note">${waiting.map(o => `<li>${esc(lgName(o.challenger))} challenged ${esc(lgName(o.defender))}: ${o.score[0]}–${o.score[1]}</li>`).join('')}</ul></section>` : '';
  const past = L.seasons.length ? `<section class="ev-sec"><h3>Past seasons</h3>${L.seasons.slice().reverse().map(p => `<details class="ev-more"><summary>${esc(p.label)}</summary><ol class="note">${p.order.map(o => `<li>${esc(lgName(o))}</li>`).join('')}</ol></details>`).join('')}</section>` : '';
  return `${s.error ? `<p class="err" role="alert">${esc(s.error)}</p>` : ''}
    <p class="note">${esc(L.season)} · ${L.mode === 'doubles' ? 'Doubles' : 'Singles'}, ${L.scoring === 'rally' ? 'rally scoring' : 'side-out'} to ${L.target} · challenge up to ${L.jump} above${L.decayDays ? ` · idle ${L.decayDays} days = one place down` : ''}</p>
    <section class="ev-sec" aria-labelledby="lg-lad"><h3 id="lg-lad">Ladder</h3>${rows}</section>${openCh}${form}${pending}${recent}${past}${lgOrgHTML(s, L)}`;
}
