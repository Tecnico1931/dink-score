function evMatchOf(id) {
  const ev = evScreen && evScreen.event;
  if (!ev) return null;
  for (const r of ev.rounds) for (const m of r.matches) if (m.id === id) return m;
  for (const r of ev.knockout || []) for (const m of r.matches) if (m.id === id) return m;
  return null;
}
// Starts the usual scoring screen for an event match. Finishing it sends the result to the event, not the club record directly.
function evScoreLive(id) {
  const ev = evScreen.event, m = evMatchOf(id);
  if (!m || !m.ready) return;
  if (live && live.event && live.event.matchId === id && live.state.winner === null) { live.open = true; persistLive(); keepAwake(true); render(); return; } // pick the paused game back up
  if (live && live.state.winner === null) { showToast('Finish or end the game in progress first.', false); return; }
  startGame({ mode: 'doubles', scoring: ev.scoring, target: ev.target, winBy: ev.winBy, first: 0, teams: [m.teams[0].slice(), m.teams[1].slice()] });
  live.event = { id: ev.id, matchId: m.id, name: ev.name, code: club.code };
  persistLive(); renderCourt();
}
function finishEventMatch(s) {
  const e = live.event;
  queueOp({ type: 'event-result', eventId: e.id, matchId: e.matchId, score: s.score.slice(), startedAt: s.startedAt, endedAt: s.endedAt, rallies: s.rallies, rallyLog: Scoring.logOf(live), live: true });
  live = null; persistLive(); keepAwake(false); render();
  showToast('Result saved', false);
  if (evScreen && evScreen.id === e.id) renderEvents(true); else evShow(e.id);
}
async function evOrg(body, ok) {
  const s = evScreen;
  if (!s || s.busy) return;
  s.busy = true; s.error = ''; renderEvents(true);
  try {
    const data = await evCall(body);
    if (data.event && evScreen === s) { s.event = data.event; s.id = data.event.id; }
    s.edit = null; s.armEnd = s.armDelete = false;
    if (ok) showToast(ok, false);
  } catch (err) {
    if (err.status === 403) forgetPin();
    s.error = err.message;
  }
  s.busy = false; renderEvents(true);
}
async function evSeedPreview(f) {
  if (f.busy) return;
  f.busy = true; f.error = ''; renderEvents(true);
  try { f.seedPv = await evCall({ action: 'seed-preview', players: f.players, divisions: f.divisions || undefined, partners: evRotating(f) ? 'rotating' : 'fixed', format: f.format }); }
  catch (err) { if (err.status === 403) forgetPin(); f.error = err.message; }
  f.busy = false; renderEvents(true);
}
async function evCreate() {
  const s = evScreen, f = s.form;
  if (f.busy) return;
  const rotating = evRotating(f);
  // A sheet that was read and checked: its players (and, where the format uses them, its teams) replace the picked players.
  let imp = null;
  if (f.imp && f.imp.draft && imMod) {
    if (!imMod.validate(f.imp.draft, evImpOpts(f)).ok) { f.error = 'Fix the problems in the import first.'; renderEvents(true); return; }
    imp = imMod.toEventInput(f.imp.draft, evImpOpts(f));
  }
  const players = imp ? imp.players : f.players;
  const body = { action: 'create', event: { name: f.name, format: f.format, partners: rotating ? 'rotating' : 'fixed', rotation: imp && imp.rotation || f.rotation, courts: f.courts, rounds: rotating ? (f.rounds || evDefaultRounds(players.length)) : undefined,
    advance: f.advance, target: f.target, scoring: f.scoring, winBy: f.winBy, resultsBy: f.resultsAny ? 'club' : 'players', players } };
  if (imp && imp.teams) { Object.assign(body.event, { teams: imp.teams, teamMeta: imp.teamMeta, publicLogos: !!f.imp.publicLogos }); }
  else if (!rotating && f.rotation === 'manual') body.event.teams = Array.from({ length: Math.floor(players.length / 2) }, (_, i) => [players[2 * i], players[2 * i + 1]]);
  if (imp && Object.keys(imp.refs).length) body.event.refs = imp.refs; // private reference only; the server keeps it apart from the event
  if (!imp && f.seeding && (f.format === 'single_elim' || f.format === 'double_elim')) body.event.seeding = 'rating';
  if (!imp && f.divisions && (rotating || f.rotation !== 'manual')) body.event.divisions = f.divisions; // the server reads the ratings itself (balanced teams and seeds too), never from this phone
  f.busy = true; f.error = ''; renderEvents(true);
  try {
    const data = await evCall(body);
    evScreen = data.events && data.events.length > 1 ? { view: 'list', list: null, error: '' } : { view: 'detail', id: data.event.id, event: data.event, list: null, error: '' };
    showToast(data.events && data.events.length > 1 ? `${data.events.length} division events started` : 'Event started', false);
    if (evScreen.view === 'list') evLoadList();
    evSummaryRefresh();
    evRefsLoad(evScreen);
  } catch (err) {
    if (err.status === 403) forgetPin();
    f.busy = false; f.error = err.message;
  }
  renderEvents(true);
}
function evSaveEntry(form) {
  const s = evScreen, en = s.entry, m = evMatchOf(en.m);
  const sc = en.s.map(v => parseInt(v, 10));
  const err = msg => { en.error = msg; renderEvents(true); };
  if (sc.some(v => !Number.isFinite(v) || v < 0 || v > 99)) return err('Enter both scores, from 0 to 99.');
  if (sc[0] === sc[1]) return err("Scores can't be tied. Pickleball games need a winner.");
  if (en.fix) {
    s.entry = null;
    evOrg({ action: 'correct', id: s.event.id, matchId: en.m, score: sc }, 'Score fixed');
    return;
  }
  s.entry = null;
  queueOp({ type: 'event-result', eventId: s.event.id, matchId: m.id, score: sc, startedAt: Date.now(), endedAt: Date.now(), rallies: 0, live: false });
  renderEvents(true);
}
function evAct(a, d) {
  const s = evScreen;
  if (a === 'open-list') { evOpenList(); return; }
  if (a === 'more') { evLoadMore(); return; }
  if (a === 'tab-open') { evShow(d.id); evScreen.fromTab = true; return; }
  if (a === 'tab-tv') { evTabTv('event', d.id); return; }
  if (a === 'tab-new') { evScreen = { view: 'new', list: null, error: '', form: evNewForm() }; renderEvents(true); return; }
  if (!s) return;
  if (a === 'back' && s.view === 'detail' && s.fromTab) {
    evScreen = null; evTab.at = 0; renderEvents(true); safeRender();
    const t = document.querySelector(`[data-ev="tab-open"][data-id="${CSS.escape(s.id)}"]`); if (t) t.focus({ preventScroll: true });
    return;
  }
  if (a === 'back' && s.view !== 'bracket') {
    if (s.view === 'list') { evScreen = null; renderEvents(true); safeRender(); const t = document.querySelector('[data-ev="open-list"]'); if (t) t.focus({ preventScroll: true }); return; }
    if (s.view === 'detail' && s.list === null) { evOpenList(); return; }
    s.view = 'list'; s.event = null; s.entry = s.edit = null; s.error = ''; renderEvents(true); evLoadList(); return;
  }
  if (a === 'unlock') { clubSheet = { view: 'unlock', back: null }; renderClub(); return; }
  if (a === 'new') { s.view = 'new'; s.form = evNewForm(); renderEvents(true); return; }
  if (a === 'brackets' && s.view === 'detail') { s.view = 'bracket'; s.sel = s.entry = null; renderEvents(true); const t = $('#events .ev-screen'); if (t) t.scrollTop = 0; return; }
  if (s.view === 'bracket' && (a === 'back' || a === 'back-detail')) { s.view = 'detail'; s.sel = s.entry = s.share = null; renderEvents(true); const t = $('#events .ev-screen'); if (t) t.scrollTop = 0; return; }
  if (a === 'open') { evShow(d.id); return; }
  if (s.view === 'new') {
    const f = s.form;
    if (evImpAct(a, d, f)) return;
    if (a === 'set') {
      const num = ['courts', 'rounds', 'advance', 'target', 'winBy', 'divisions'].includes(d.k);
      f[d.k] = num ? +d.v : d.v;
      if (d.k === 'format' && (d.v === 'single_elim' || d.v === 'double_elim')) f.partners = 'fixed';
      f.error = ''; f.seedPv = null;
    }
    if (a === 'seed-pv') { evSeedPreview(f); return; }
    if (a === 'step') {
      const cur = d.k === 'rounds' ? (f.rounds || evDefaultRounds(f.players.length || 8)) : f[d.k];
      const lim = { courts: [1, 8], rounds: [1, 30], advance: [2, 16] }[d.k];
      f[d.k] = Math.min(lim[1], Math.max(lim[0], cur + (+d.d)));
    }
    if (a === 'pick') {
      f.seedPv = null;
      const i = f.players.findIndex(x => sameName(x, d.pl));
      if (i >= 0) f.players.splice(i, 1); else f.players.push(d.pl);
    }
    if (a === 'pick-all') f.players = roster.slice(0, 32);
    if (a === 'pick-none') f.players = [];
    if (a === 'guest') {
      const inp = $('#ev-guest'), name = cleanPlayer(inp ? inp.value : '');
      if (name && !isDefaultName(name)) { addToRoster([name]); if (!f.players.some(x => sameName(x, name)) && f.players.length < 32) f.players.push(roster.find(r => sameName(r, name)) || name); }
    }
    renderEvents(true);
    return;
  }
  if ((s.view !== 'detail' && s.view !== 'bracket') || !s.event) return;
  const ev = s.event;
  if (a === 'pick') { s.sel = s.sel === d.m ? null : d.m; s.entry = null; renderEvents(true); }
  else if (a === 'pick-close') { const was = s.sel; s.sel = s.entry = null; renderEvents(true); const b = was && $(`#events [data-ev="pick"][data-m="${CSS.escape(was)}"]`); if (b) b.focus({ preventScroll: true }); }
  else if (a === 'jump') { const el = document.getElementById(d.to); if (el) el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
  else if (a === 'share-open' || a === 'share-new' || a === 'share-off') evShare(a);
  else if (a === 'share-hide') { s.share = null; s.arm = ''; renderEvents(true); }
  else if (a === 'share-copy') evCopyLink();
  else if (a === 'results-toggle') evOrg({ action: 'results-by', id: ev.id, who: ev.resultsBy === 'club' ? 'players' : 'club' }, ev.resultsBy === 'club' ? 'Only the players and organizers can enter results' : 'Any club member can enter results');
  else if (a === 'logos-toggle') evOrg({ action: 'public-logos', id: ev.id, on: !ev.publicLogos }, ev.publicLogos ? 'Logos hidden on the public page' : 'Logos shown on the public page');
  else if (a === 'live') evScoreLive(d.m);
  else if (a === 'enter' || a === 'fix') {
    const m = evMatchOf(d.m);
    s.entry = { m: d.m, fix: a === 'fix', s: m && m.score ? [String(m.score[0]), String(m.score[1])] : ['', ''], error: '' };
    renderEvents(true);
    const f = $('#ev-s0'); if (f) f.focus();
  } else if (a === 'entry-cancel') { s.entry = null; renderEvents(true); }
  else if (a === 'dupr-csv' || a === 'dupr-copy') duprExport(ev, a === 'dupr-copy');
  else if (a === 'next-round') evOrg({ action: 'next-round', id: ev.id }, 'Round planned');
  else if (a === 'publish') evOrg({ action: 'publish-round', id: ev.id, round: +d.n }, 'Round open');
  else if (a === 'advance-pick-set' || (a === 'set' && d.k === 'advance-pick')) { s.advance = +d.v; renderEvents(true); }
  else if (a === 'knockout') evOrg({ action: 'start-knockout', id: ev.id, advance: s.advance || undefined }, 'Knockout started');
  else if (a === 'edit-open') {
    const r = ev.rounds.find(x => x.n === +d.n);
    s.edit = { round: r.n, draft: r.status === 'draft', error: '', matches: r.matches.map(m => ({ teams: [m.teams[0].slice(), m.teams[1].slice()] })) };
    renderEvents(true);
  } else if (a === 'edit-cancel') { s.edit = null; renderEvents(true); }
  else if (a === 'edit-add') { s.edit.matches.push({ teams: [['', ''], ['', '']] }); renderEvents(true); }
  else if (a === 'edit-del') { s.edit.matches.splice(+d.i, 1); renderEvents(true); }
  else if (a === 'end') { if (!s.armEnd) { s.armEnd = true; s.armDelete = false; renderEvents(true); return; } evOrg({ action: 'end', id: ev.id }, 'Event finished'); }
  else if (a === 'delete') {
    if (!s.armDelete) { s.armDelete = true; s.armEnd = false; renderEvents(true); return; }
    s.busy = true; renderEvents(true);
    evCall({ action: 'delete', id: ev.id }).then(() => { showToast('Event deleted', false); evSummary = evSummary.filter(e => e.id !== ev.id); evScreen = { view: 'list', list: null, error: '' }; renderEvents(true); evLoadList(); safeRender(); })
      .catch(err => { if (err.status === 403) forgetPin(); s.busy = false; s.error = err.message; renderEvents(true); });
  }
}
function evSaveEdit() {
  const s = evScreen, ed = s.edit;
  const all = ed.matches.flatMap(m => m.teams.flat());
  if (all.some(p => !p)) { ed.error = 'Pick all four players for every court.'; renderEvents(true); return; }
  if (new Set(all.map(p => p.toLowerCase())).size !== all.length) { ed.error = 'Each player can only be on one court.'; renderEvents(true); return; }
  const open = ed.draft, id = s.event.id, round = ed.round;
  evOrg({ action: 'set-round', id, round, matches: ed.matches }, open ? null : 'Pairings saved').then(() => {
    if (open && evScreen === s && !s.error) evOrg({ action: 'publish-round', id, round }, 'Round open');
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('button[data-ev]');
  if (b) evAct(b.dataset.ev, b.dataset);
});
// Enter in the sheet link, or in a field of the import preview, must not submit the whole new-event form.
document.addEventListener('keydown', e => {
  const t = e.target;
  if (e.key !== 'Enter' || !evScreen || !t.dataset || t.tagName !== 'INPUT') return;
  if (t.dataset.evInput === 'imp-link') { e.preventDefault(); evImpRead(); }
  else if (t.dataset.evDraft) e.preventDefault();
});
document.addEventListener('submit', e => {
  const f = e.target.closest && e.target.closest('[data-ev-form]');
  if (!f || !evScreen) return;
  e.preventDefault();
  const k = f.dataset.evForm;
  if (k === 'create') evCreate(); else if (k === 'entry') evSaveEntry(f); else if (k === 'edit') evSaveEdit();
});
document.addEventListener('input', e => {
  const t = e.target, k = t.dataset && t.dataset.evInput;
  if (t.dataset && t.dataset.evDraft && evScreen) { const [at, field] = t.dataset.evDraft.split(':'); evImpSet(at, field, t.value); return; }
  if (!k || !evScreen) return;
  if (k === 'name' && evScreen.form) evScreen.form.name = t.value;
  const im = evScreen.form && evScreen.form.imp;
  if (im && k === 'imp-link') im.link = t.value;
  if (im && k === 'imp-text') im.text = t.value;
  if (im && k === 'imp-publiclogos') im.publicLogos = t.checked;
  if ((k === 's0' || k === 's1') && evScreen.entry) evScreen.entry.s[+k[1]] = t.value;
});
document.addEventListener('change', e => {
  if (e.target.dataset && e.target.dataset.evFile === 'imp' && evScreen) { evImpFile(e.target); return; }
  if (e.target.dataset && e.target.dataset.evInput === 'seeding' && evScreen && evScreen.form) { evScreen.form.seeding = e.target.checked; evScreen.form.seedPv = null; renderEvents(true); return; }
  if (e.target.dataset && e.target.dataset.evInput === 'results-any' && evScreen && evScreen.form) { evScreen.form.resultsAny = e.target.checked; renderEvents(true); return; }
  if (e.target.dataset && e.target.dataset.evInput === 'imp-publiclogos' && evScreen && evScreen.form && evScreen.form.imp) evScreen.form.imp.publicLogos = e.target.checked;
  const t = e.target, sel = t.dataset && t.dataset.evSel;
  if (!sel || !evScreen || !evScreen.edit) return;
  const [i, tm, j] = sel.split('-').map(Number);
  evScreen.edit.matches[i].teams[tm][j] = t.value; evScreen.edit.error = '';
  renderEvents(true);
});
