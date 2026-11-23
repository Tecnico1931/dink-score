// A result this phone has sent that the server has not confirmed yet (offline, or just sent).
const evQueued = id => clubOps().find(o => o.type === 'event-result' && o.matchId === id);
// allow is false for a match already shown (with its buttons) in the "now" section, so no button or field appears twice.
function evMatchHTML(ev, m, org, allow = true) {
  const op = evQueued(m.id);
  const score = op ? op.score : m.score;
  const done = !!score;
  const win = done ? (score[0] > score[1] ? 0 : 1) : null;
  const line = t => `<div class="line ${win === t ? 'win' : ''}" style="--c:${TEAM_COLOR[t]}"><span class="tick"></span><span class="who">${m.teams[t] ? BK.logoHTML(ev, m.teams[t]) : ''}${esc(evTeamName(m.teams[t], ev))}<span class="vh"> ${TEAM_NAME[t]} team</span></span><span class="pts">${done ? score[t] : ''}</span></div>`;
  const entry = allow && evScreen.entry && evScreen.entry.m === m.id ? evScreen.entry : null;
  const state = op ? '<span class="tag">Saving…</span>' : done ? '<span class="tag">Final</span>' : m.ready ? '' : '<span class="tag">Waiting for earlier matches</span>';
  const actions = !allow ? '' : !done && m.ready && !entry && ev.status !== 'done' ? `<button class="btn btn-ink ev-small" data-ev="live" data-m="${esc(m.id)}">Score live</button><button class="btn btn-soft ev-small" data-ev="enter" data-m="${esc(m.id)}">Enter score</button>`
    : done && !op && org && !entry ? `<button class="link" data-ev="fix" data-m="${esc(m.id)}">Fix score</button>` : '';
  const form = entry ? `<form class="ev-entry" data-ev-form="entry" data-m="${esc(m.id)}">${[0, 1].map(t => `<label style="--c:${TEAM_COLOR[t]}"><span>${esc(evTeamName(m.teams[t], ev))}</span><input id="ev-s${t}" type="number" inputmode="numeric" min="0" max="99" data-ev-input="s${t}" value="${esc(entry.s[t])}" aria-label="${TEAM_NAME[t]} team score"></label>`).join('')}
    ${entry.error ? `<p class="err" role="alert">${esc(entry.error)}</p>` : ''}<div class="ev-actions"><button type="submit" class="btn btn-blue ev-small">${entry.fix ? 'Save the fix' : 'Save score'}</button><button type="button" class="btn btn-soft ev-small" data-ev="entry-cancel">Cancel</button></div></form>` : '';
  return `<li class="game ev-game${done ? ' done' : ''}"><div class="lines">${line(0)}${line(1)}</div>
    <div class="meta">${m.court && !done ? `<span class="tag">Court ${m.court}</span>` : m.ready && !done ? '<span class="tag">Waiting for a court</span>' : ''}${state}</div>${actions ? `<div class="ev-actions">${actions}</div>` : ''}${form}</li>`;
}
function evEditHTML(ev, ed) {
  const opts = sel => `<option value="">Pick a player</option>${ev.players.map(p => `<option value="${esc(p)}" ${sameName(p, sel || '') ? 'selected' : ''}>${esc(p)}</option>`).join('')}`;
  const matches = ed.matches.map((m, i) => `<fieldset class="ev-fs"><legend>Court ${i + 1}</legend>${[0, 1].map(t => `<div class="ev-pair" style="--c:${TEAM_COLOR[t]}">${[0, 1].map(j => `<select class="field-input" data-ev-sel="${i}-${t}-${j}" aria-label="Court ${i + 1}, ${TEAM_NAME[t]} team, player ${j + 1}">${opts(m.teams[t][j])}</select>`).join('')}</div>`).join('')}
    ${ed.matches.length > 1 ? `<button type="button" class="link" data-ev="edit-del" data-i="${i}">Remove court ${i + 1}</button>` : ''}</fieldset>`).join('');
  const used = new Set(ed.matches.flatMap(m => m.teams.flat()).filter(Boolean));
  const sit = ev.players.filter(p => !used.has(p));
  return `<form class="ev-card" data-ev-form="edit" novalidate><h3 style="margin:0">Pairings for round ${ed.round}</h3>${matches}
    ${ed.matches.length < Math.min(ev.courts, Math.floor(ev.players.length / 4)) ? '<button type="button" class="link" data-ev="edit-add">+ Add a court</button>' : ''}
    <p class="note">Sitting out: ${sit.length ? esc(sit.join(', ')) : 'nobody'}</p>${ed.error ? `<p class="err" role="alert">${esc(ed.error)}</p>` : ''}
    <div class="ev-actions"><button type="submit" class="btn btn-ink ev-small" ${evScreen.busy ? 'disabled' : ''}>${ed.draft ? 'Save and open round' : 'Save pairings'}</button><button type="button" class="btn btn-soft ev-small" data-ev="edit-cancel">Cancel</button></div></form>`;
}
function evDetailHTML(s) {
  const ev = s.event;
  if (!ev) return s.error ? `<p class="err" role="alert">${esc(s.error)}</p>` : skel(3);
  const org = canOrganize(), live = ev.status === 'live';
  const out = [];
  if (s.error) out.push(`<p class="err" role="alert">${esc(s.error)}</p>`);
  out.push(`<div class="ev-card"><div class="ev-item-head"><b>${esc(EV_FORMAT_NAME[ev.format])}</b><span class="badge ${live ? 'hot' : 'prov'}">${live ? 'Live' : 'Finished'}</span></div>
    <span class="note">${ev.partners === 'rotating' ? 'Partners rotate' : 'Fixed teams'} · ${ev.players.length} players · ${ev.courts} court${ev.courts === 1 ? '' : 's'} · to ${ev.target}, ${ev.scoring === 'rally' ? 'rally' : 'side-out'}, win by ${ev.winBy}</span>
    <span class="note">${esc(evProgress({ status: ev.status, champion: null, stage: ev.stage, round: (ev.rounds.find(r => r.status !== 'done') || ev.rounds[ev.rounds.length - 1] || { n: 1 }).n, roundsPlanned: ev.roundsPlanned }))}</span>
    ${ev.division || ev.seeding ? `<span class="note">${ev.division ? esc(ev.division.label) + ` (${ev.division.n} of ${ev.division.of}, by rating)` : ''}${ev.division && ev.seeding ? ' · ' : ''}${ev.seeding ? 'Seeded by Dink Rating' : ''}</span>` : ''}
    <div class="ev-actions"><button class="btn btn-soft ev-small" data-ev="brackets">${ICON.bracket}Brackets</button></div></div>`);
  if (ev.status === 'done' && ev.champion) out.push(`<div class="ev-champ" role="status">${BK.logoHTML(ev, ev.champion, true) || '<span class="ball"></span>'}<div><small>${ev.knockout ? 'Champions' : ev.partners === 'fixed' ? 'Top team' : 'Top player'}</small><b>${esc(BK.teamName(ev, ev.champion))}</b></div></div>`);
  if (org) out.push(evRosterHTML(s));
  // Now playing
  let nowTitle = '', now = [], byes = [], round = null;
  if (ev.knockout) {
    const ready = ev.knockout.flatMap(r => r.matches.map(m => Object.assign({ round: r.title }, m))).filter(m => m.status === 'pending' && m.ready);
    now = ready; nowTitle = ready.length ? 'Up now' : '';
  } else {
    round = ev.rounds.find(r => r.status !== 'done') || ev.rounds[ev.rounds.length - 1];
    if (round) { now = round.matches; byes = round.byes; nowTitle = round.title + (round.status === 'draft' ? ' (not open yet)' : ''); }
  }
  const nowIds = new Set(now.map(m => m.id));
  const editing = s.edit && round && s.edit.round === round.n;
  if (editing) out.push(evEditHTML(ev, s.edit));
  else if (nowTitle) {
    const canEdit = org && ev.partners === 'rotating' && round && round.status !== 'done' && round.matches.every(m => !m.score && !evQueued(m.id));
    out.push(`<section class="ev-sec" aria-labelledby="ev-now"><div class="sec-head"><h3 id="ev-now">${esc(nowTitle)}</h3>${canEdit ? `<button class="link" data-ev="edit-open" data-n="${round.n}">Change pairings</button>` : ''}</div>
      ${round && round.status === 'draft' ? `<p class="note">${org ? 'This is a suggestion. Change the pairings if you like, then open the round so scores can come in.' : 'The organizer is setting this round up.'}</p>` : ''}
      <ul class="games">${now.map(m => evMatchHTML(ev, m, org)).join('')}</ul>${byes.length ? `<p class="note">Sitting out: ${esc(byes.join(', '))}</p>` : ''}
      ${round && round.status === 'draft' && org ? `<button class="btn btn-ink block" data-ev="publish" data-n="${round.n}" ${s.busy ? 'disabled' : ''}>Open round ${round.n}</button>` : ''}</section>`);
  }
  // Organizer: next round, start the knockout
  if (org && live && ev.partners === 'rotating' && ev.stage === 'pool' && ev.rounds.length < ev.roundsPlanned && ev.rounds.every(r => r.status === 'done')) {
    out.push(`<button class="btn btn-ink block" data-ev="next-round" ${s.busy ? 'disabled' : ''}>Plan round ${ev.rounds.length + 1}${ev.rotation === 'manual' ? '' : ''}</button>`);
  }
  if (ev.format === 'pool_knockout' && ev.poolDone && !ev.knockout) {
    const maxAdv = Math.max(2, Math.min(16, ev.partners === 'fixed' ? ev.teams.length : Math.floor(ev.players.length / 2)));
    const opts = [2, 4, 8, 16].filter(v => v <= maxAdv);
    const cur = s.advance || Math.min(ev.advance, opts[opts.length - 1]);
    out.push(org ? `<div class="ev-card"><h3 style="margin:0">Pool play is finished</h3><p class="note">The top of the table plays a knockout${ev.partners === 'rotating' ? '. Players are paired best with weakest, so teams come out even.' : '.'}</p>
      <div class="field"><span class="lab">Teams in the knockout</span>${evSeg('advance-pick', opts.map(v => [v, v]), cur)}</div>
      <button class="btn btn-ink block" data-ev="knockout" ${s.busy ? 'disabled' : ''}>Start the knockout</button></div>` : '<div class="ev-card"><b>Pool play is finished</b><p class="note">The organizer starts the knockout next.</p></div>');
  }
  // Standings
  if (ev.format !== 'single_elim' && ev.format !== 'double_elim') {
    out.push(`<section class="ev-sec" aria-labelledby="ev-st"><h3 id="ev-st">${ev.format === 'pool_knockout' ? 'Pool standings' : 'Standings'}</h3><div class="ev-card" style="padding:8px 12px"><table class="ev-table"><caption class="vh">Wins, losses and point difference</caption>
      <thead><tr><th scope="col" class="who">${ev.partners === 'fixed' ? 'Team' : 'Player'}</th><th scope="col">W–L</th><th scope="col">+/−</th></tr></thead><tbody>${ev.standings.map(r => `<tr><td class="who"><span class="ev-rank ${r.rank === 1 && r.played ? 'first' : ''}">${r.rank}</span> ${BK.logoOfUrl(r.logo, r.name)}${esc(r.name)}</td><td class="num">${r.wins}–${r.losses}</td><td class="num">${r.diff > 0 ? '+' : r.diff < 0 ? '−' : ''}${Math.abs(r.diff)}</td></tr>`).join('')}</tbody></table></div>
      ${ev.partners === 'rotating' ? '<p class="note">Ranked by wins, then point difference. Sitting out a round is not a loss.</p>' : ''}</section>`);
  }
  // The rest of the schedule
  if (ev.knockout) {
    out.push(`<section class="ev-sec" aria-labelledby="ev-br"><h3 id="ev-br">Bracket</h3>${ev.knockout.map(r => `<details class="ev-more" ${r.matches.some(m => m.status === 'pending') ? 'open' : ''}><summary>${esc(r.title)}</summary><ul class="games">${r.matches.map(m => evMatchHTML(ev, m, org, !nowIds.has(m.id))).join('')}</ul></details>`).join('')}</section>`);
  }
  if (ev.rounds.length > (ev.knockout ? 0 : 1)) {
    out.push(`<section class="ev-sec" aria-labelledby="ev-rd"><h3 id="ev-rd">${ev.knockout ? 'Pool play rounds' : 'All rounds'}</h3>${ev.rounds.map(r => `<details class="ev-more"><summary>${esc(r.title)}${r.status === 'done' ? ' · done' : ''}</summary><ul class="games">${r.matches.map(m => evMatchHTML(ev, m, org, !nowIds.has(m.id))).join('')}</ul>${r.byes.length ? `<p class="note">Sitting out: ${esc(r.byes.join(', '))}</p>` : ''}</details>`).join('')}</section>`);
  }
  if (org && !live) out.push(duprHTML(ev));
  if (org) out.push(evWhoHTML(s, true));
  out.push(dssoEventHTML(ev, org));
  if (org) {
    out.push(`<div class="ev-card">${live ? `<button class="btn btn-soft block" data-ev="end">${s.armEnd ? 'Tap again to finish the event' : 'Finish the event now'}</button>` : ''}
      <button class="btn btn-line-danger block" data-ev="delete">${s.armDelete ? 'Tap again to delete the event' : 'Delete the event'}</button><p class="note">Games already played stay in the club record.</p></div>`);
  } else if (live) {
    out.push(`<p class="note">${ev.resultsBy === 'club' ? 'Anyone in the club can score a match.' : 'The players in a match can score it.'} Organizers run the rounds.${club.hasPin ? ' <button class="link" data-ev="unlock">Unlock this phone</button>' : ''}</p>`);
  }
  return out.join('\n');
}

// ---- Brackets page: the knockout drawn round by round (see BK in the bracketview script), or the pool table leading into it ----
const evShareUrl = t => `${location.origin}/b/${t}`;
function evShareHTML(s) {
  const sh = s.share, shared = !!(sh && sh.token), arm = s.arm || '';
  if (!shared) return `<div class="ev-card"><h3>Watch without the app</h3><p class="note">Make a link anyone can open to follow this ${s.event.tree ? 'bracket' : 'event'} live, on a phone or a TV. It shows names and scores only and nobody can change anything.</p>
    ${sh && sh.error ? `<p class="err" role="alert">${esc(sh.error)}</p>` : ''}<div class="ev-actions"><button class="btn btn-ink ev-small" data-ev="share-open" ${sh && sh.busy ? 'disabled' : ''}>${sh && sh.busy ? 'Making the link…' : 'Share bracket'}</button></div></div>`;
  const url = evShareUrl(sh.token);
  return `<div class="ev-card"><div class="ev-item-head"><h3>Public link</h3><button class="link" data-ev="share-hide">Hide</button></div>
    <p class="note">Anyone with this link can watch, nobody can change anything. Open the TV view on a big screen.</p>
    <input class="bk-share-url" type="text" readonly value="${esc(url)}" aria-label="Public bracket link" id="bk-url">
    ${sh.error ? `<p class="err" role="alert">${esc(sh.error)}</p>` : ''}
    <div class="ev-actions"><button class="btn btn-ink ev-small" data-ev="share-copy">Copy link</button><a class="btn btn-soft ev-small" href="${esc(url)}" target="_blank" rel="noopener">Open</a><a class="btn btn-soft ev-small" href="${esc(url)}?tv=1" target="_blank" rel="noopener">TV view</a></div>
    <div class="ev-actions"><button class="link ${arm === 'share-new' ? 'armed' : ''}" data-ev="share-new" ${sh.busy ? 'disabled' : ''}>${arm === 'share-new' ? 'Tap again: the old link stops working' : 'Make a new link'}</button><button class="link ${arm === 'share-off' ? 'armed' : ''}" data-ev="share-off" ${sh.busy ? 'disabled' : ''}>${arm === 'share-off' ? 'Tap again to stop sharing' : 'Stop sharing'}</button></div></div>`;
}
async function evShare(a) {
  const s = evScreen;
  if (!s || !s.event || (s.share && s.share.busy)) return;
  if ((a === 'share-new' || a === 'share-off') && s.arm !== a) { s.arm = a; renderEvents(true); return; }
  s.arm = '';
  s.share = Object.assign({}, s.share, { busy: true, error: '' }); renderEvents(true);
  try {
    const data = await evCall({ action: a === 'share-open' ? 'share' : a, id: s.event.id });
    s.share = data.shareToken ? { token: data.shareToken } : null;
    if (a === 'share-off') showToast('Sharing stopped. The link no longer works.', false);
  } catch (err) {
    if (err.status === 403) forgetPin();
    s.share = Object.assign({}, s.share, { busy: false, error: err.message });
  }
  renderEvents(true);
}
// Organizers only: the private DUPR reference IDs typed into an imported sheet, fetched once per event (they are not part of the event).
async function evRefsLoad(s) {
  if (s.refsFor === s.id || !s.event || !canOrganize()) return;
  s.refsFor = s.id;
  try { const data = await evCall({ action: 'refs', id: s.id }); if (evScreen === s) { s.refs = data.refs || {}; renderEvents(); } } catch {}
}
function evRosterHTML(s) {
  const ev = s.event, refs = s.refs || {}, has = Object.keys(refs).length;
  if (!(ev.teamInfo && ev.teamInfo.length) && !has) return '';
  const ref = p => (refs[p] ? ` <span class="imp-ref" title="Reference only, unverified">${esc(refs[p])}</span>` : '');
  const rows = ev.partners === 'fixed' && ev.teams ? ev.teams.map(t => `<li>${BK.logoHTML(ev, t)}<span><b>${esc(BK.teamName(ev, t))}</b><br><span class="note">${t.map(p => esc(p) + ref(p)).join(' &amp; ')}</span></span></li>`)
    : ev.players.filter(p => refs[p]).map(p => `<li><span>${esc(p)}${ref(p)}</span></li>`);
  return `<section class="ev-card" aria-labelledby="ev-ros"><h3 id="ev-ros">${ev.partners === 'fixed' ? 'Teams' : 'Players'}</h3><ul class="imp-roster">${rows.join('')}</ul>
    ${has ? '<p class="note">DUPR IDs are a private reference for organizers: unverified, not checked with DUPR, never sent to DUPR and never shown on the public page.</p>' : ''}</section>`;
}
// Who may enter results: shown to everyone, with the switch for organizers. The server enforces it either way.
function evWhoHTML(s, org) {
  const ev = s.event, any = ev.resultsBy === 'club';
  return `<div class="ev-card"><h3>Who can enter results</h3><p class="note">${any ? 'Any club member can enter a result for any match.' : 'The players in a match and organizers can enter its result. Other club members can watch but not score.'}</p>
    ${org ? `<div class="ev-actions"><button class="btn btn-soft ev-small" data-ev="results-toggle" aria-pressed="${any}" ${s.busy ? 'disabled' : ''}>${any ? 'Limit to the players and organizers' : 'Let any club member enter results'}</button></div>` : ''}</div>`;
}
function evLogosHTML(s) {
  const ev = s.event;
  if (!ev || !(ev.teamInfo || []).some(i => i.logo)) return '';
  return `<div class="ev-card"><h3>Team logos on the public page</h3><p class="note">Team names always show. Logos load from the websites in the links you imported, so anyone who opens the public page contacts those sites.</p>
    <div class="ev-actions"><button class="btn btn-soft ev-small" data-ev="logos-toggle" aria-pressed="${!!ev.publicLogos}" ${s.busy ? 'disabled' : ''}>${ev.publicLogos ? 'Showing logos. Tap to hide' : 'Logos hidden. Tap to show'}</button></div></div>`;
}
async function evCopyLink() {
  const sh = evScreen && evScreen.share;
  if (!sh || !sh.token) return;
  try { await navigator.clipboard.writeText(evShareUrl(sh.token)); showToast('Link copied', false); }
  catch { const i = $('#bk-url'); if (i) { i.focus(); i.select(); } showToast('Press and hold the link to copy it', false); }
}
function evBracketHTML(s) {
  const ev = s.event;
  if (!ev) return s.error ? `<p class="err" role="alert">${esc(s.error)}</p>` : skel(3);
  const org = canOrganize(), live = ev.status === 'live', pool = ev.format === 'pool_knockout';
  const sel = s.sel && ev.tree ? ev.tree.matches.find(m => m.id === s.sel && m.status !== 'bye') : null;
  const out = [];
  const narrow = [];
  if (s.error) narrow.push(`<p class="err" role="alert">${esc(s.error)}</p>`);
  const what = ev.tree ? (ev.tree.kind === 'double' ? 'Winners and losers brackets, then the grand final.' : 'Lose once and you are out.') : pool ? 'Pool play first, then the best teams play a knockout.' : 'A round robin: everyone plays everyone, so there is no bracket.';
  narrow.push(`<div class="ev-card"><div class="ev-item-head"><b>${esc(EV_FORMAT_NAME[ev.format])}</b><span class="badge ${live ? 'hot' : 'prov'}">${live ? 'Live' : 'Finished'}</span></div>
    <span class="note">${what}${ev.tree ? ' Tap a match to score it.' : ''}</span>
    <div class="ev-actions"><button class="btn btn-soft ev-small" data-ev="back-detail">Schedule and scoring</button>${pool ? `<button class="btn btn-soft ev-small" data-ev="jump" data-to="bk-pool">Pool standings</button><button class="btn btn-soft ev-small" data-ev="jump" data-to="bk-ko">${ev.tree ? 'Knockout bracket' : 'About the knockout'}</button>` : ''}</div></div>`);
  if (ev.status === 'done' && ev.champion) narrow.push(`<div class="ev-champ" role="status">${BK.logoHTML(ev, ev.champion, true) || '<span class="ball"></span>'}<div><small>${ev.tree ? 'Champions' : ev.partners === 'fixed' ? 'Top team' : 'Top player'}</small><b>${esc(BK.teamName(ev, ev.champion))}</b></div></div>`);
  if (!ev.tree && !pool) {
    narrow.push(`<div class="ev-card" role="status"><h3>No bracket for this format</h3><p class="note">A round robin has no knockout rounds to draw. Everyone plays everyone, and the standings decide who wins.</p>
      <button class="btn btn-ink block" data-ev="back-detail">Open the schedule and standings</button></div>`);
  }
  if (pool) {
    narrow.push(`<section class="bk-sec" id="bk-pool" aria-labelledby="bk-pool-h"><h3 id="bk-pool-h" style="margin:0;font-family:var(--display);font-weight:700;font-stretch:90%;font-size:19px">Pool standings</h3><div class="ev-card" style="padding:8px 12px">${BK.standingsHTML(ev)}</div>
      <p class="note">The top ${ev.advance} ${ev.partners === 'fixed' ? 'teams' : 'teams (players paired best with weakest)'} go into the knockout. The line marks the cut.</p>
      <button class="btn btn-soft ev-small" data-ev="jump" data-to="bk-ko" style="align-self:flex-start">${ev.tree ? 'See the knockout bracket ↓' : 'About the knockout ↓'}</button></section>`);
  }
  out.push(`<div class="ev-narrow">${narrow.join('')}</div>`);
  if (ev.tree) {
    out.push(`<section class="bk-sec" id="bk-ko" aria-labelledby="bk-ko-h"><h3 id="bk-ko-h" class="vh">${pool ? 'Knockout bracket' : 'Bracket'}</h3>${BK.bracketHTML(ev, { interactive: true, sel: s.sel, scoreOf: m => { const op = evQueued(m.id); return op ? op.score : m.score; }, saving: m => !!evQueued(m.id) })}</section>`);
  } else if (pool) {
    out.push(`<div class="ev-narrow"><section class="bk-sec" id="bk-ko" aria-labelledby="bk-ko-h"><div class="ev-card" role="status"><h3 id="bk-ko-h">The knockout is not drawn yet</h3><p class="note">${ev.poolDone ? (org ? 'Pool play is finished. Start the knockout from the event page and the bracket appears here.' : 'Pool play is finished. The organizer starts the knockout next, and the bracket appears here.') : `It appears here when pool play ends: the top ${ev.advance} ${ev.partners === 'fixed' ? 'teams' : 'teams of players'} play single elimination, best seed against the lowest.`}</p></div></section></div>`);
  }
  const tail = [];
  tail.push(evWhoHTML(s, org));
  if (org) tail.push(evShareHTML(s) + evLogosHTML(s));
  if (tail.length) out.push(`<div class="ev-narrow">${tail.join('')}</div>`);
  if (sel) {
    const r = ev.tree.rounds.find(x => x.key === sel.stage + sel.round);
    out.push(`<section class="bk-sheet" aria-label="Selected match"><div class="ev-item-head"><b>${esc(r ? r.title : 'Match')}</b><button class="link" data-ev="pick-close">Close</button></div><ul class="games">${evMatchHTML(ev, sel, org)}</ul></section>`);
  }
  return out.join('\n');
}

// Export for DUPR: finished results as a CSV (or text) an organizer can import. Logic lives in dupr-export.js; loaded on demand.
let duprMod = null;
function duprLoad() { if (!duprMod) import('./dupr-export.js').then(m => { duprMod = m; renderEvents(true); }).catch(() => {}); }
function duprHTML(ev) {
  duprLoad();
  if (!duprMod) return '';
  const { rows, skipped } = duprMod.exportRows(ev);
  return `<section class="ev-card" aria-labelledby="ev-dupr"><h3 id="ev-dupr">Export for DUPR</h3>
    <p class="note">${rows.length} match${rows.length === 1 ? '' : 'es'} ready, one row each. Download the CSV and give it to a DUPR club director to import. The columns are a generic layout, not DUPR's own template yet, so compare it with the template you download from DUPR. Player names only; DUPR IDs are not included.</p>
    ${skipped.length ? `<div role="status"><b>${skipped.length} not exported</b><ul class="note" style="margin:4px 0 0;padding-left:18px">${skipped.map(k => `<li>${esc(k.label)}: ${esc(k.reason)}</li>`).join('')}</ul></div>` : ''}
    <div class="ev-actions"><button class="btn btn-ink ev-small" data-ev="dupr-csv" ${rows.length ? '' : 'disabled'}>Export for DUPR</button><button class="btn btn-soft ev-small" data-ev="dupr-copy" ${rows.length ? '' : 'disabled'}>Copy results</button></div></section>`;
}
function duprExport(ev, copy) {
  if (!duprMod) return;
  const { rows } = duprMod.exportRows(ev);
  if (!rows.length) return;
  if (copy) {
    const text = duprMod.toText(ev, rows);
    try { navigator.clipboard.writeText(text).then(() => showToast('Results copied', false), () => showToast("Couldn't copy. Use the CSV instead.", false)); } catch { showToast("Couldn't copy. Use the CSV instead.", false); }
    return;
  }
  const url = URL.createObjectURL(new Blob([duprMod.toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = duprMod.fileName(ev, duprMod.dateOf(Date.now()));
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('CSV downloaded', false);

}
