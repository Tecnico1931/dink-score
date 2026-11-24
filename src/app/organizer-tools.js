/* ---------- organizer tools: one sheet for what only organizers can do, with what is waiting on them first ----------
   No new endpoint: it reuses the club payload (held games, duplicates, game nights), the members call (approval requests) and the
   existing handlers of every screen it points to. Shown only where the club screen already shows organizer buttons. */
const otCan = () => !!club && (isCreator() || (club.hasPin && hasOrganizer()));
/*OT-PURE-START*/
// s: { requests, held, dupes, nights, liveEvents, players, undoable, requireConfirmation, hasPin } -> the hub's rows. Rows with something
// waiting (n > 0) come first, the rest keep their listed order. `go` is the data attribute the row's button carries (null: nothing to tap).
function otItems(s) {
  const num = v => Math.max(0, Number(v) || 0), plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const q = num(s.requests), h = num(s.held), d = num(s.dupes), u = num(s.undoable), nn = num(s.nights), ev = num(s.liveEvents), pl = num(s.players);
  const rows = [
    { id: 'requests', title: 'Requests', n: q, go: null, hint: q ? `${plural(q, 'phone wants', 'phones want')} to link to a player` : 'Nobody is waiting to link a phone' },
    { id: 'approve', title: 'Approve games', n: h, go: null, hint: h ? `${plural(h, 'game is', 'games are')} held out of ratings until approved` : s.requireConfirmation ? 'No games are waiting' : 'Every game counts now' },
    { id: 'dupes', title: 'Possible duplicates', n: d, go: null, hint: d ? `${plural(d, 'game looks', 'games look')} like it was recorded twice` : 'No games look recorded twice' },
    { id: 'members', title: 'Members and roles', go: 'data-act="members-open"', hint: `${plural(pl, 'player', 'players')}, who is an organizer, removals` },
    { id: 'undo', title: 'Undo a change', go: 'data-act="members-open"', hint: u ? `${plural(u, 'change', 'changes')} you can undo` : 'Role changes and renames, for 7 days' },
    { id: 'history', title: 'Game history', go: 'data-act="audit-open"', hint: 'Who changed or deleted what' },
    { id: 'nights', title: 'Game nights', go: 'data-gn="open" data-gn-from="club"', hint: nn ? `${nn} upcoming` : 'Schedule one and see who is coming' },
    { id: 'events', title: 'Events and leagues', go: 'data-act="ot-events"', hint: ev ? `${plural(ev, 'event is', 'events are')} live` : 'Tournaments, round robins and leagues' },
    { id: 'pin', title: s.hasPin ? 'Organizer PIN' : 'Set an organizer PIN', go: 'data-act="pin-set-open"', hint: s.hasPin ? 'Change it, or lock this phone from the club screen' : 'Without one, anyone with the club code can delete games' },
    { id: 'code', title: 'Change club code', go: 'data-act="code-rotate-open"', hint: 'The old code keeps working for a while' },
    { id: 'rewards', title: 'Rewards', go: 'data-rw="club"', hint: s.rewards ? 'On. Players see a daily play streak and can hide it. Tap to turn off' : 'Off. Tap to add a daily play streak with free points' },
    ...(s.rewards ? [{ id: 'mysteryBox', title: 'Mystery box', go: 'data-rw="box"', hint: s.mysteryBox ? 'On. Players can open a random look box with stated chances. Tap to turn off' : 'Off. Tap to add a mystery box with stated chances' }] : []),
    ...(s.rewards ? [{ id: 'costs', title: 'Item costs', go: 'data-rw="manage"', hint: 'Set what each look and the mystery box cost here, and release linked names' }] : []),
    { id: 'links', title: 'Public result links', go: 'data-act="links-open"', hint: 'Share results without sharing the club' },
    { id: 'note', title: 'Pinned note and how to pay', go: 'data-act="info-open"', hint: 'Court times, rules, a payment link' },
    { id: 'analytics', title: 'Attendance and busiest hours', go: 'data-act="analytics-open"', hint: 'Totals only, no player is listed' },
    { id: 'rights', title: 'Your data', go: 'data-act="rights-open"', hint: 'Export, anonymise, delete the club' }
  ];
  return rows.map((r, i) => Object.assign({ n: 0, i }, r)).sort((a, b) => (b.n > 0) - (a.n > 0) || a.i - b.i);
}
// Everything that is waiting on this organizer, for the badge on the club screen.
const otPendingTotal = s => ['requests', 'held', 'dupes'].reduce((t, k) => t + (Math.max(0, Number(s[k]) || 0)), 0);
/*OT-PURE-END*/

let otReq = { code: '', n: 0, undoable: 0, at: 0 }; // last count of approval requests, from the members call
const otHeld = () => allGames().filter(g => g.hold && !g.confirmed && !g.event);
function otState(c) {
  const md = c && c.membersData, known = otReq.code === club.code;
  return {
    requests: md ? (md.requests || []).length : known ? otReq.n : 0,
    held: otHeld().length,
    dupes: ((clubData && clubData.dupes) || []).length,
    nights: gnUpcoming().length,
    liveEvents: evSummary.filter(e => e.status === 'live').length,
    players: clubPlayers().length,
    undoable: md ? (md.audit || []).filter(a => a.undoable && !a.undone).length : known ? otReq.undoable : 0,
    requireConfirmation: !!club.requireConfirmation, rewards: !!club.rewards, mysteryBox: !!club.mysteryBox,
    hasPin: !!club.hasPin
  };
}
// Ask the server how many requests wait, at most once a minute, so the badge on the club screen is honest without a poll of its own.
async function otPoll() {
  if (!otCan() || (otReq.code === club.code && Date.now() - otReq.at < 60000)) return;
  const code = club.code; otReq = { code, n: otReq.code === code ? otReq.n : 0, undoable: otReq.code === code ? otReq.undoable : 0, at: Date.now() };
  try {
    const d = await playerCall(Object.assign({ action: 'members' }, adminCreds()));
    if (!club || club.code !== code) return;
    const n = (d.requests || []).length, undoable = (d.audit || []).filter(a => a.undoable && !a.undone).length, was = otReq.n;
    otReq = { code, n, undoable, at: Date.now() };
    if (n !== was && clubSheet && (clubSheet.view === 'club' || clubSheet.view === 'orgtools')) renderClub();
  } catch (e) { /* the badge just leaves requests out */ }
}
function otEntryHTML() {
  otPoll();
  const n = otPendingTotal(otState(clubSheet));
  return `<button class="btn btn-soft block ot-row ot-entry" data-act="ot-open"><span class="ot-t"><b>Organizer tools</b><small>${n ? `${n} waiting for you` : 'Requests, approvals, members, game nights and more'}</small></span>${n ? `<span class="ot-n">${n}<span class="vh"> waiting</span></span>` : '<span class="ot-chev" aria-hidden="true">›</span>'}</button>`;
}
function otRequestsHTML(c) {
  const list = (c.membersData && c.membersData.requests) || [];
  if (!c.membersData) return skel(1);
  return `<ul class="mem-list">${list.map(r => `<li class="mem-row"><span class="mem-text"><span class="mem-name">${esc(r.name)}</span>
    <span class="mem-meta">${r.linked ? 'Linked to another phone. Approve only if you know it is them.' : 'Wants to link this name to their phone.'} Asked ${esc(new Date(r.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}.</span></span>
    <span class="mem-acts"><button class="btn btn-ink" data-decide="${esc(r.id)}" data-verdict="approve" data-who="${esc(r.name)}">Approve</button><button class="btn btn-soft" data-decide="${esc(r.id)}" data-verdict="deny" data-who="${esc(r.name)}">Deny</button></span></li>`).join('')}</ul>`;
}
function otHeldHTML() {
  const list = otHeld().slice(0, 8), more = otHeld().length - list.length;
  return `${list.length ? `<ul class="mem-list">${list.map(g => `<li class="mem-row"><span class="mem-text"><span class="mem-name">${esc(teamLabel(g.teams[0]))} ${Number(g.score[0])}–${Number(g.score[1])} ${esc(teamLabel(g.teams[1]))}</span>
    <span class="mem-meta">${esc(new Date(g.endedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}, ${esc(new Date(g.endedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</span></span>
    <span class="mem-acts"><button class="btn btn-ink" data-ot-confirm="${esc(g.id)}">Approve</button></span></li>`).join('')}</ul>` : ''}
    ${more > 0 ? `<p class="note">${more} more in the Record. <button type="button" class="link" data-act="ot-record">Open the Record</button></p>` : ''}`;
}
function otDupesHTML() {
  const by = new Map(allGames().map(g => [g.id, g]));
  const pairs = ((clubData && clubData.dupes) || []).filter(p => p.every(id => by.has(id))).slice(0, 5);
  const one = g => `${esc(teamLabel(g.teams[0]))} ${Number(g.score[0])}–${Number(g.score[1])} ${esc(teamLabel(g.teams[1]))}, ${esc(new Date(g.endedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}`;
  return `<ul class="mem-list">${pairs.map(([a, b]) => `<li class="mem-row"><span class="mem-text"><span class="mem-meta">${one(by.get(a))}</span><span class="mem-meta">${one(by.get(b))}</span></span>
    <span class="mem-acts"><button class="btn btn-soft" data-ot-keep="${esc(a)}|${esc(b)}">Keep both</button></span></li>`).join('')}</ul>
    <p class="note">To delete one of them, <button type="button" class="link" data-act="ot-record">open the Record</button>.</p>`;
}
function otHTML(c) {
  const s = otState(c);
  const rows = otItems(s).map(it => {
    const hint = `<small>${esc(it.hint)}</small>`;
    const inline = it.id === 'requests' ? otRequestsHTML(c) : it.id === 'approve' ? otHeldHTML() : it.id === 'dupes' ? otDupesHTML() : '';
    if (it.id === 'approve') return `<section class="ot-card"><div class="ot-head"><h3>${esc(it.title)}</h3>${it.n ? `<span class="ot-n">${it.n}<span class="vh"> waiting</span></span>` : ''}</div><p class="note">${esc(it.hint)}</p>${inline}
      <p class="note">${club.requireConfirmation ? 'Only approved games count toward ratings, the leaderboard and achievements.' : 'Turn this on to keep new games out of ratings until someone approves them.'}</p>
      <button class="btn btn-soft block" data-act="confirm-setting">${club.requireConfirmation ? 'Count unconfirmed games again' : 'Count only confirmed games'}</button></section>`;
    if (it.n > 0) return `<section class="ot-card"><div class="ot-head"><h3>${esc(it.title)}</h3><span class="ot-n">${it.n}<span class="vh"> waiting</span></span></div><p class="note">${esc(it.hint)}</p>${inline}</section>`;
    if (!it.go) return `<div class="ot-row ot-idle"><span class="ot-t"><b>${esc(it.title)}</b>${hint}</span></div>`;
    return `<button class="btn btn-soft block ot-row" ${it.go}><span class="ot-t"><b>${esc(it.title)}</b>${hint}</span><span class="ot-chev" aria-hidden="true">›</span></button>`;
  }).join('');
  return `<h2 id="club-h">Organizer tools</h2><p class="note">What only organizers can do for ${esc(club.name)}. Anything waiting on you comes first.</p>
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}${rows}
    <div class="btns"><button class="btn btn-soft" data-act="club-back">Back</button><button class="btn btn-soft" data-act="club-close">Done</button></div>`;
}
// Click handler for the data attributes above; true when it took the click.
function otHandle(ds) {
  if (ds.act === 'ot-open') { clubSheet = { view: 'orgtools' }; renderClub(); loadMembers(); return true; }
  if (ds.act === 'ot-events' || ds.act === 'ot-record') {
    tab = ds.act === 'ot-events' ? 'events' : 'history'; store.set('pb.tab', tab); clubSheet = null; render(); renderClub(); try { document.body.scrollTo(0, 0); } catch {}
    return true;
  }
  if (ds.otConfirm) { confirmGame(ds.otConfirm).then(() => renderClub()); return true; }
  if (ds.otKeep) { const [a, b] = ds.otKeep.split('|'); keepBoth(a, b).then(() => renderClub()); return true; }
  return false;
}
