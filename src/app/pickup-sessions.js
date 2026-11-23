/* ---------- pickup sessions ---------- */
// A 24-hour session with its own code and QR, for playing with people outside your club (api/_sessions.js). While this phone is in
// one, finished games go to the session and nowhere else: not the open club, not this phone's saved players. "Save to a club"
// (a member's own choice) is the only way results leave the session. The server deletes a session 24 hours after it was made.
/*PICKUP-START*/
// Pure helpers, so test/pickup.test.js can load this block alone.
const Pickup = {
  clean: raw => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
  isCode: raw => /^[A-Z0-9]{8}$/.test(Pickup.clean(raw)),
  // Milliseconds left by the server's clock. skew is how far ahead of this phone's clock the server was at its last answer.
  left: (p, now) => p.expiresAt - (now + (p.skew || 0)),
  leftText(ms) {
    if (ms <= 0) return 'Ended';
    const m = Math.max(1, Math.ceil(ms / 60000));
    return (m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min') + ' left';
  },
  // Wins, losses and point difference per player, best first. Names that differ only in case or spacing are one player.
  standings(games) {
    const by = new Map();
    for (const g of games) for (const t of [0, 1]) for (const raw of g.teams[t]) {
      const key = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
      const r = by.get(key) || { name: raw, w: 0, l: 0, diff: 0 };
      if (g.score[t] > g.score[1 - t]) r.w++; else r.l++;
      r.diff += g.score[t] - g.score[1 - t];
      by.set(key, r);
    }
    return [...by.values()].sort((a, b) => b.w - a.w || b.diff - a.diff || a.l - b.l || a.name.localeCompare(b.name));
  }
};
/*PICKUP-END*/
let pickup = API_OK ? Heal.pickup(store.get('pb.pickup', null)) : null; // { code, name, expiresAt, skew, host (the starting phone's key, or ''), players, games, pending, saved }
if (pickup && Pickup.left(pickup, Date.now()) <= 0) pickup = null; // over while this phone was away
store.set('pb.pickup', pickup);
let pickupSaveAfter = false, pickupFlushing = false;
const rosterNames = () => (pickup ? pickup.players : roster); // who the name pickers offer
const savePickup = () => store.set('pb.pickup', pickup);
const pickupPost = body => api('live', { method: 'POST', body: JSON.stringify(body) });
// The session's games as this phone sees them: the server's plus ones still waiting to be sent, newest first.
function pickupGames() {
  const have = new Set(pickup.games.map(g => g.id));
  return pickup.pending.filter(g => !have.has(g.id)).concat(pickup.games).sort((a, b) => b.endedAt - a.endedAt);
}
// Takes in what the server says the session looks like now.
function pickupAdopt(v) {
  if (!pickup || !v || !v.session || v.session.code !== pickup.code) return;
  pickup.expiresAt = v.session.expiresAt; pickup.skew = v.session.now - Date.now(); pickup.name = v.session.name || '';
  pickup.players = (v.players || []).slice(0, 30); pickup.games = (v.games || []).slice(0, 100);
  savePickup(); pickupRedraw();
}
function pickupRedraw() {
  const b = $('#pk-banner'); if (b) b.outerHTML = pickupBannerHTML();
  if (clubSheet && clubSheet.view === 'pickup') renderClub();
}
function pickupEnded(msg) {
  pickup = null; savePickup();
  if (clubSheet && clubSheet.view === 'pickup') clubSheet = null;
  showToast(msg || 'Your pickup session ended. Its results are deleted unless they were saved to a club.', false);
  render(); renderClub();
}
function pickupBegin(v, host) {
  pickup = Heal.pickup({ code: v.session.code, name: v.session.name, expiresAt: v.session.expiresAt, skew: v.session.now - Date.now(), host, players: v.players, games: v.games, pending: [], saved: {} });
  rosterEdit = false; savePickup();
}
// Names typed on this phone join the session's list, and the server's answer is the list from then on.
function pickupAddNames(names) {
  for (const raw of names) {
    const n = String(raw || '').trim().slice(0, 40);
    if (!n || isDefaultName(n) || pickup.players.some(r => sameName(r, n)) || pickup.players.length >= 30) continue;
    pickup.players.push(n);
    pickupPost({ action: 'session-join', code: pickup.code, name: n }).then(pickupAdopt, err => { if (err.status === 404) pickupEnded(); });
  }
  pickup.players.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })); savePickup();
}
function pickupSave(rec) {
  const { rallyLog, ...g } = rec; // a session keeps results, not replays
  pickup.pending = pickup.pending.filter(x => x.id !== g.id).concat(g); savePickup();
  pickupFlush(); pickupRedraw();
}
// Sends waiting games in order. No signal, server trouble or a rate limit: they wait and are tried again. A refusal is told to the person, not retried.
async function pickupFlush() {
  if (!pickup || pickupFlushing || !pickup.pending.length) return;
  pickupFlushing = true;
  try {
    while (pickup && pickup.pending.length) {
      const g = pickup.pending[0];
      try {
        const v = await pickupPost({ action: 'session-game', code: pickup.code, game: g });
        if (!pickup) return;
        pickup.pending = pickup.pending.filter(x => x.id !== g.id); pickupAdopt(v);
      } catch (err) {
        if (err.status === 404) { pickupEnded('Your pickup session ended before the last game was added.'); return; }
        if (err.offline || err.status >= 500 || err.status === 429) break;
        pickup.pending = pickup.pending.filter(x => x.id !== g.id); savePickup();
        showToast('A game was not added to the session: ' + err.message, false);
      }
    }
  } finally { pickupFlushing = false; }
  if (pickup) { savePickup(); pickupRedraw(); }
}
async function pickupRefresh() {
  if (!pickup) return;
  if (Pickup.left(pickup, Date.now()) <= 0) { pickupEnded(); return; }
  try { pickupAdopt(await api('live?session=' + pickup.code)); }
  catch (err) { if (err.status === 404) pickupEnded(); }
}
function pickupBannerHTML() {
  if (!pickup) return '';
  const n = pickupGames().length;
  return `<button type="button" class="pk-banner" id="pk-banner" data-act="pk-open"><span><b>${esc(pickup.name || 'Pickup session')}</b> <span class="pk-code">${esc(pickup.code)}</span></span><span>${esc(Pickup.leftText(Pickup.left(pickup, Date.now())))} · ${n} game${n === 1 ? '' : 's'}</span></button>`;
}
async function pickupStart(rawName, rawMe) {
  const name = String(rawName || '').trim(), me = String(rawMe || '').trim();
  if (gameInProgress()) { clubSheet.error = 'Finish or end the game in progress first.'; renderClub(); return; }
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    let v = await pickupPost({ action: 'session-create', name });
    const host = v.hostToken;
    if (me) { try { v = await pickupPost({ action: 'session-join', code: v.session.code, name: me }); } catch {} }
    pickupBegin(v, host);
    clubSheet = { view: 'pickup' }; showToast('Pickup session started', false);
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; }
  render(); renderClub();
}
async function pickupJoinCode(raw, rawName) {
  const code = Pickup.clean(raw), name = String(rawName || '').trim();
  if (!Pickup.isCode(code)) { clubSheet.error = 'Session codes are 8 letters and numbers.'; renderClub(); return; }
  if (gameInProgress()) { clubSheet.error = 'Finish or end the game in progress first.'; renderClub(); return; }
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    const v = name ? await pickupPost({ action: 'session-join', code, name }) : await api('live?session=' + code);
    pickupBegin(v, '');
    clubSheet = { view: 'pickup' }; showToast('Joined the pickup session', false);
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; }
  render(); renderClub();
}
// Puts every game of the session into the open club through the normal games route (the same game ids, so saving twice adds nothing twice).
async function pickupSaveToClub() {
  if (!pickup) return;
  if (!club) { pickupSaveAfter = true; clubSheet = { view: 'add', reason: 'pickup' }; renderClub(); return; }
  const c = clubSheet && clubSheet.view === 'pickup' ? clubSheet : (clubSheet = { view: 'pickup' });
  const games = pickupGames(), to = { code: club.code, name: club.name };
  if (!games.length) { c.msg = 'No games to save yet.'; renderClub(); return; }
  c.busy = true; c.error = ''; c.msg = ''; renderClub();
  try {
    let saved = 0;
    for (let i = 0; i < games.length; i += 400) saved += (await api('games', { method: 'POST', body: JSON.stringify(Object.assign({ code: to.code, games: games.slice(i, i + 400) }, senderCreds(to.code))) })).saved || 0;
    if (pickup) { pickup.saved[to.code] = Date.now(); savePickup(); }
    c.msg = saved ? `Saved ${saved} game${saved === 1 ? '' : 's'} to ${to.name}.` : `${to.name} already has these games.`;
    if (club && club.code === to.code) await refreshClub();
  } catch (err) { c.error = err.message; }
  c.busy = false; renderClub();
}
function pickupSheetHTML(c) {
  const err = c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : '';
  if (!pickup) {
    return `<h2 id="club-h">${c.joinName ? 'Join ' + esc(c.joinName) + '?' : 'Pickup session'}</h2>
      <p>Playing with people you don't know? A pickup session is a shared space with its own code and QR code. Everyone who joins can add games and see the results. It lasts 24 hours, then it is deleted. It is not part of any club unless someone saves it to one.</p>${err}
      <form class="club-form" data-form="pk-join"><label class="lab" for="pk-code">Join with a code</label>
        <input id="pk-code" class="field-input" placeholder="8-character code" autocomplete="off" autocapitalize="characters" maxlength="10" value="${esc(c.joinCode || '')}">
        <label class="lab" for="pk-join-me">Your name (optional)</label>
        <div class="add-player"><input id="pk-join-me" placeholder="So others can pick you" autocomplete="off" maxlength="40"><button type="submit" class="btn btn-ink" style="padding:10px 16px;border-radius:12px" ${c.busy ? 'disabled' : ''}>Join</button></div></form>
      <div class="or"><span>or</span></div>
      <form class="club-form" data-form="pk-start"><label class="lab" for="pk-name">Start a new session</label>
        <input id="pk-name" class="field-input" placeholder="Name, like Saturday morning (optional)" autocomplete="off" maxlength="40">
        <input id="pk-me" class="field-input" placeholder="Your name (optional)" autocomplete="off" maxlength="40" aria-label="Your name (optional)">
        <button type="submit" class="btn btn-blue" ${c.busy ? 'disabled' : ''}>Start a session</button></form>
      <div class="btns"><button class="btn btn-soft" data-act="club-close">Not now</button></div>`;
  }
  const link = ShareLink.session(location.origin, pickup.code);
  let qr = ''; try { qr = ShareLink.qrSvg(qrcode, link); } catch {}
  const games = pickupGames(), table = Pickup.standings(games), host = !!pickup.host, waiting = pickup.pending.length;
  const row = g => `<li><span>${esc(teamLabel(g.teams[0]))} <b>${Number(g.score[0])}–${Number(g.score[1])}</b> ${esc(teamLabel(g.teams[1]))}</span>${host ? `<button type="button" class="link" data-act="pk-del" data-id="${esc(g.id)}" aria-label="Remove this game from the session">Remove</button>` : ''}</li>`;
  return `<h2 id="club-h">${esc(pickup.name || 'Pickup session')}</h2>
    <div class="code-card share-card"><span class="lab">Session code</span><span class="code">${esc(pickup.code)}</span>
      ${qr ? `<div class="share-qr" role="img" aria-label="QR code for the pickup session link">${qr}</div>` : ''}
      <p><b>${esc(Pickup.leftText(Pickup.left(pickup, Date.now())))}.</b> Then the session and its results are deleted. Anyone with the code can join and add games. It is not part of a club.</p>
      <div class="invite"><input id="pk-link" readonly value="${esc(link)}" aria-label="Session link"><button class="btn btn-ink" data-act="pk-copy" style="padding:10px 14px;border-radius:12px;font-size:14px">${c.copied ? 'Copied' : 'Copy link'}</button></div>
      ${navigator.share ? '<button class="btn btn-blue block" data-act="pk-native-share">Share…</button>' : ''}</div>
    ${c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : ''}${err}
    <button class="btn btn-ink block" data-act="pk-play" style="margin-top:10px">Start a game</button>
    <h3 class="pk-h">Results</h3>
    ${games.length ? `<ul class="pk-list">${games.map(row).join('')}</ul>` : '<p class="note">No games yet. Games finished on any phone in this session show up here.</p>'}
    ${waiting ? `<p class="note" role="status">${waiting} game${waiting === 1 ? '' : 's'} on this phone will be added when there is signal.</p>` : ''}
    ${table.length ? `<h3 class="pk-h">Standings</h3><table class="pk-table"><thead><tr><th scope="col">Player</th><th scope="col">W</th><th scope="col">L</th><th scope="col">+/−</th></tr></thead><tbody>${table.map(r => `<tr><td>${esc(r.name)}</td><td>${r.w}</td><td>${r.l}</td><td>${r.diff > 0 ? '+' : ''}${r.diff}</td></tr>`).join('')}</tbody></table>` : ''}
    ${pickup.players.length ? `<h3 class="pk-h">Players (${pickup.players.length})</h3><p class="note">${esc(pickup.players.join(', '))}</p>` : ''}
    <div class="upload-card" style="margin-top:14px"><b>Keep these results</b>
      <p>${club ? `Add ${games.length === 1 ? 'this game' : 'these ' + games.length + ' games'} to ${esc(club.name)}. The players' names join the club's saved players, and the games count in its record.${pickup.saved[club.code] ? ' Saved here before: saving again adds nothing twice.' : ''}` : 'Results are deleted when the session ends. Join or start a club to keep them.'}</p>
      <button class="btn btn-blue" data-act="pk-save" ${c.busy || !games.length ? 'disabled' : ''}>${club ? 'Save to ' + esc(club.name) : 'Save to a club'}</button></div>
    <div class="btns">${host ? `<button class="btn ${c.confirmEnd ? 'btn-line-danger' : 'btn-soft'}" data-act="pk-end">${c.confirmEnd ? 'Tap again to end it for everyone' : 'End session now'}</button>` : ''}
      <button class="btn ${c.confirmLeave ? 'btn-line-danger' : 'btn-soft'}" data-act="pk-leave">${c.confirmLeave ? 'Tap again to leave' : 'Leave session'}</button>
      <button class="btn btn-ink" data-act="club-close">Done</button></div>`;
}
function pickupClick(ds) {
  const a = ds.act, c = clubSheet;
  if (a === 'pk-open') { clubSheet = { view: 'pickup' }; renderClub(); pickupRefresh(); return; }
  if (!c || c.view !== 'pickup' || !pickup) return;
  if (a === 'pk-copy') {
    const link = ShareLink.session(location.origin, pickup.code);
    const done = () => { c.copied = true; renderClub(); setTimeout(() => { if (clubSheet === c) { c.copied = false; renderClub(); } }, 2000); };
    try { navigator.clipboard.writeText(link).then(done, () => { const i = $('#pk-link'); if (i) i.select(); }); } catch { const i = $('#pk-link'); if (i) i.select(); }
    return;
  }
  if (a === 'pk-native-share') { try { navigator.share({ title: pickup.name || 'Pickup session', text: `Join our pickup games on Dink Score. Code ${pickup.code}`, url: ShareLink.session(location.origin, pickup.code) }).catch(() => {}); } catch {} return; }
  if (a === 'pk-play') { clubSheet = null; tab = 'play'; store.set('pb.tab', tab); render(); renderClub(); try { document.body.scrollTo(0, 0); } catch {} return; }
  if (a === 'pk-save') { pickupSaveToClub(); return; }
  if (a === 'pk-del' && pickup.host) {
    pickupPost({ action: 'session-game-delete', code: pickup.code, id: ds.id, hostToken: pickup.host }).then(pickupAdopt, err => { if (err.status === 404) pickupEnded(); else { c.error = err.message; renderClub(); } });
    return;
  }
  if (a === 'pk-leave') {
    if (!c.confirmLeave) { c.confirmLeave = true; c.msg = `${pickup.host ? 'You started this session, so this phone is the only one that can end it early. ' : ''}${pickup.pending.length ? 'Games not sent yet will be lost. ' : ''}Tap again to leave. The session goes on for everyone else until it ends.`; renderClub(); return; }
    pickup = null; savePickup(); clubSheet = null; render(); renderClub(); showToast('Left the pickup session', false); return;
  }
  if (a === 'pk-end' && pickup.host) {
    if (!c.confirmEnd) { c.confirmEnd = true; c.msg = 'This deletes the session and its results for everyone. Save them to a club first to keep them. Tap again to end it.'; renderClub(); return; }
    pickupPost({ action: 'session-end', code: pickup.code, hostToken: pickup.host }).then(() => true, err => err.status === 404 ? true : (c.error = err.message, c.confirmEnd = false, renderClub(), false)).then(done => {
      if (!done) return;
      pickup = null; savePickup(); clubSheet = null; render(); renderClub(); showToast('Pickup session ended', false);
    });
  }
}
function inviteLink() { return ShareLink.join(location.origin, club && club.code); }
// Keep the address bar on the open club's join link, so copying the URL shares it. Waits for checkInvite to read a link first.
let urlReady = false;
function syncUrl() {
  try {
    if (!urlReady || !API_OK || new URLSearchParams(location.search).has('display')) return;
    const want = location.pathname + (club ? '?club=' + club.code : '') + location.hash;
    if (location.pathname + location.search + location.hash !== want) history.replaceState(null, '', want);
  } catch {}
}
// The share sheet for the live game. Joining a club is what shares a game: games end up in the club's record, and anyone with the code can join and score.
function shareSheetHTML(c) {
  const watchBtn = live && live.state && live.state.winner === null ? '<button type="button" class="btn btn-soft block" data-act="watch-court">Link a watch to this game</button>' : '';
  if (!club) return `<h2 id="club-h">Share this game</h2>
    <p>This game is only on this phone, and it stays here unless you save it to a club. Start a club or join one and other players can join it with a code or QR code. You can also share the result card when the game ends.</p>
    <div class="btns"><button class="btn btn-blue" data-act="club-open">Join or start a club</button>${watchBtn}<button class="btn btn-soft" data-act="club-close">Not now</button></div>`;
  const link = inviteLink();
  let qr = '';
  try { qr = ShareLink.qrSvg(qrcode, link); } catch {}
  return `<h2 id="club-h">Invite players to ${esc(club.name)}</h2>
    <div class="code-card share-card"><span class="lab">Club code</span><span class="code">${esc(club.code)}</span>
      ${qr ? `<div class="share-qr" role="img" aria-label="QR code for the club join link">${qr}</div>` : ''}
      <p>Scan with another phone's camera, or send the link. They join ${esc(club.name)} and can see its games and add scores. Games you score here are saved to the club when they end. Anyone with the code can join.</p>
      <div class="invite"><input id="invite-link" readonly value="${esc(link)}" aria-label="Join link"><button class="btn btn-ink" data-act="club-copy" style="padding:10px 14px;border-radius:12px;font-size:14px">${c.copied ? 'Copied' : 'Copy link'}</button></div>
      ${navigator.share ? '<button class="btn btn-blue block" data-act="club-native-share">Share…</button>' : ''}</div>
    <div class="btns">${watchBtn}<button class="btn btn-soft" data-act="club-close">Done</button></div>`;
}
// Opens a club on this phone (joining it if it's new), keeping every other club this phone is in.
async function joinClub(code, name) {
  stashClubCache();
  const known = clubs.find(c => c.code === code);
  club = Object.assign({}, known || {}, { code, name: name || (known && known.name) || code });
  saveClubs();
  clubData = cachedClub(code); store.set('pb.clubCache', clubData);
  roster = rosterFromClub();
  askedWhoami = false;
  render();
  await refreshClub();
}
// A game in progress belongs to the club that was open when it started, so switching waits until it's over.
const gameInProgress = () => !!(live && live.state && live.state.winner === null);
function switchClub(code) {
  if (!club || club.code === code) return;
  if (gameInProgress()) { showToast('Finish or end the game in progress before switching clubs.', false); return; }
  const c = clubs.find(x => x.code === code);
  if (!c) return;
  clubSheet = null;
  joinClub(c.code, c.name).then(() => showToast(`Switched to ${c.name}`, false));
}
// Takes the open club off this phone. Its games stay in the club. Another club this phone is in opens instead, if any.
function leaveClub() {
  if (!club) return;
  const code = club.code;
  clubs = clubs.filter(c => c.code !== code);
  outbox = outbox.filter(o => o.code !== code || o.failed); store.set('pb.outbox', outbox); // refused changes stay on the phone
  const all = store.get('pb.clubCaches', {}); delete all[code]; store.set('pb.clubCaches', all);
  club = null; clubData = null; store.set('pb.clubCache', null);
  if (clubs.length) { const next = clubs[0]; club = Object.assign({}, next); saveClubs(); clubData = cachedClub(club.code); store.set('pb.clubCache', clubData); roster = rosterFromClub(); render(); refreshClub(); return; }
  saveClubs();
  roster = store.get('pb.roster', []);
  render();
}
function uploadedHere() { return club && store.get('pb.uploaded', {})[club.code]; }
/*DEVICEGAMES-START*/
// Games kept on this phone with no club. Pure, so test/devicegames.test.js can load this block alone.
const DeviceGames = {
  // ids: just those games ("save this game to a club"); omitted: every game on the phone
  select: (games, ids) => (ids ? games.filter(g => ids.includes(g.id)) : games.slice())
};
/*DEVICEGAMES-END*/
/*MYGAMES-START*/
// My games across clubs: this phone's own games from every club it is linked to a player in, read from the copies already kept on the phone (no new server call).
// Pure, so test/mygames.test.js can load this block with the rating engine. Pickup sessions are not read: their games count once saved to a club.
const MyGames = {
  same: (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase(),
  // clubs: [{ code, name }]; me: { [code]: { name } }; gamesOf(code): that club's games, or null when none are kept on this phone yet.
  collect(DR, clubs, me, gamesOf) {
    const out = [];
    for (const c of clubs) {
      const player = me[c.code] && me[c.code].name;
      if (!player) continue; // not linked to a player in this club: nothing here is yours
      const all = gamesOf(c.code);
      const res = { code: c.code, club: c.name, player, loaded: !!all, rows: [], rating: { doubles: null, singles: null }, wins: 0, losses: 0 };
      out.push(res);
      if (!all) continue;
      const ok = all.filter(g => g && Array.isArray(g.teams) && g.teams.length === 2 && g.teams.every(Array.isArray) && Array.isArray(g.score) && Number.isFinite(g.endedAt));
      const { tables, changes } = DR.compute(ok.filter(g => !g.hold));
      for (const mode of ['doubles', 'singles']) { const p = DR.lookup(tables, mode, player); if (p) res.rating[mode] = { rating: p.rating, games: p.games }; }
      for (const g of ok) {
        const side = g.teams.findIndex(t => t.some(n => MyGames.same(n, player)));
        if (side < 0) continue;
        const won = g.score[0] === g.score[1] ? null : g.score[side] > g.score[1 - side];
        const ch = (changes[g.id] || { list: [] }).list.find(x => MyGames.same(x.name, player));
        res.rows.push({ id: g.id, at: g.endedAt, mode: g.mode === 'singles' ? 'singles' : 'doubles', partner: g.teams[side].filter(n => !MyGames.same(n, player)).join(' & '), against: g.teams[1 - side].join(' & '), mine: g.score[side], theirs: g.score[1 - side], won, after: ch ? ch.after : null, hold: !!g.hold });
        if (!g.hold && won === true) res.wins++;
        if (!g.hold && won === false) res.losses++;
      }
      res.rows.sort((a, b) => b.at - a.at);
    }
    return out;
  },
  flat: results => results.flatMap(r => r.rows.map(x => Object.assign({ club: r.club, player: r.player }, x))).sort((a, b) => b.at - a.at),
  date: ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },
  // [header, value(row)] for toCsv in dupr-export.js, which neutralises = + - @ at the start of a cell
  COLUMNS: [
    ['Club', r => r.club], ['Date', r => MyGames.date(r.at)], ['Format', r => r.mode], ['Player', r => r.player],
    ['Partner', r => r.partner], ['Opponents', r => r.against], ['Score for', r => r.mine], ['Score against', r => r.theirs],
    ['Result', r => (r.won === null ? 'Tie' : r.won ? 'Win' : 'Loss')], ['Rating after', r => (r.after === null ? '' : r.after.toFixed(2))],
    ['Counts toward rating', r => (r.hold ? 'No, waiting for confirmation' : 'Yes')]
  ]
};
/*MYGAMES-END*/
function myGamesData() {
  return MyGames.collect(DR, clubs, me, code => {
    if (club && code === club.code) return clubGames();
    const d = cachedClub(code); return d ? d.games : null;
  });
}
function myGamesHTML(c) {
  const res = myGamesData(), total = res.reduce((s, r) => s + r.rows.length, 0);
  const cards = res.map(r => {
    const rt = ['doubles', 'singles'].filter(m => r.rating[m]).map(m => `${m === 'doubles' ? 'Doubles' : 'Singles'} <b>${r2(r.rating[m].rating)}</b> (${r.rating[m].games})`).join(' · ');
    const shown = (c.all || {})[r.code] ? r.rows : r.rows.slice(0, 8);
    return `<div class="org-card"><div class="org-head"><span class="lab">${esc(r.club)}</span></div>
      <p>You are <b>${esc(r.player)}</b> here.${r.loaded ? '' : ' Open this club once on this phone to load its games.'}</p>
      ${r.loaded ? `<p>${rt ? `Rating: ${rt}. ` : ''}${r.wins} won, ${r.losses} lost.</p>` : ''}
      ${shown.length ? `<ul class="club-list">${shown.map(x => `<li><span><b>${x.mine}–${x.theirs} ${x.won === null ? 'tie' : x.won ? 'win' : 'loss'}</b><small>${esc(new Date(x.at).toLocaleDateString([], { dateStyle: 'medium' }))} · ${esc(x.partner ? 'with ' + x.partner + ' ' : '')}vs ${esc(x.against)}${x.hold ? ' · waiting for confirmation' : ''}</small></span></li>`).join('')}</ul>` : r.loaded ? '<p class="note">No games of yours here yet.</p>' : ''}
      ${r.rows.length > 8 && !(c.all || {})[r.code] ? `<button class="link" data-act="club-mine-more" data-code="${esc(r.code)}">Show all ${r.rows.length}</button>` : ''}</div>`;
  }).join('');
  return `<h2 id="club-h">My games</h2>
    <p class="note">Your own games from every club this phone is linked to a player in, from the copy kept on this phone. Pickup sessions show up once saved to a club. Nobody else's games are shown.</p>
    ${res.length ? cards : '<p>This phone isn\'t linked to a player in any club yet. Open a club and choose your name.</p>'}
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
    <div class="btns"><button class="btn btn-soft" data-act="club-back">Back</button>${total ? '<button class="btn btn-ink" data-act="club-mine-csv">Download CSV</button>' : ''}</div>`;
}
async function myGamesCsv() {
  try {
    const m = await import('./dupr-export.js');
    saveFile(m.toCsv(MyGames.flat(myGamesData()), MyGames.COLUMNS), `dink-score-my-games-${MyGames.date(Date.now())}.csv`, 'text/csv;charset=utf-8');
  } catch { clubSheet.error = 'Could not make the file. Try again.'; renderClub(); }
}
async function uploadLocalGames(ids) {
  if (!club || uploading) return;
  const games = DeviceGames.select(store.get('pb.games', []), ids);
  if (!games.length) return;
  const names = store.get('pb.roster', []);
  uploading = true; clubSheet && (clubSheet.msg = 'Uploading…'); renderClub();
  try {
    for (let i = 0; i < games.length; i += 400) await api('games', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, games: games.slice(i, i + 400) }, senderCreds())) });
    for (const n of names) { try { await api('roster', { method: 'POST', body: JSON.stringify({ code: club.code, name: n }) }); } catch {} }
    if (!ids) { const up = store.get('pb.uploaded', {}); up[club.code] = Date.now(); store.set('pb.uploaded', up); }
    if (clubSheet) clubSheet.msg = `Uploaded ${games.length} game${games.length === 1 ? '' : 's'} to ${club.name}.`;
    await refreshClub();
  } catch (err) { if (clubSheet) clubSheet.msg = err.message; }
  uploading = false; renderClub();
}

/* Organizer PIN: a phone that has entered the right PIN remembers it, per club, until it's locked again. */
let pins = Heal.map(store.get('pb.pins', {}));
// The phone that creates a club gets a private creator token; only it can set the club's first PIN.
let owners = Heal.map(store.get('pb.owners', {}));
function rememberOwner(code, token) { if (token) { owners[code] = token; store.set('pb.owners', owners); } }
const canSetFirstPin = () => !!club && !club.hasPin && (!!owners[club.code] || !!club.openClaim);
function rememberPin(code, pin) { pins[code] = pin; store.set('pb.pins', pins); }
function forgetPin() { if (club) { delete pins[club.code]; store.set('pb.pins', pins); } }
// owners[code] is the creating phone's 48-hex token, or, on a co-organizer's phone, "<player token>:<name>" (kept in step with
// the member's role by syncCoOrg). Only the first is the creator; both let the phone do organizer actions.
const creatorTok = code => /^[0-9a-f]{48}$/.test(owners[code] || '');
const isCreator = () => !!club && creatorTok(club.code);
const isCoOrganizer = () => !!club && !!owners[club.code] && !creatorTok(club.code);
const hasOrganizer = () => !!club && (!club.hasPin || !!pins[club.code] || !!owners[club.code]);
function syncCoOrg() {
  if (!club || creatorTok(club.code)) return;
  const mine = myName() && myToken() && clubPlayers().find(p => p.claimed && sameName(p.name, myName()));
  const want = mine && mine.role === 'organizer' ? myToken() + ':' + mine.name : '';
  if (want ? owners[club.code] !== want : owners[club.code]) { if (want) owners[club.code] = want; else delete owners[club.code]; store.set('pb.owners', owners); }
}
// Runs a delete or restore, asking for the PIN first when the club has one and this phone isn't unlocked.
// The phone that created the club sends its creator key instead, so it's never asked and never locked out.
function withPin(op) {
  if (!club) return;
  if (club.hasPin && !hasOrganizer()) { clubSheet = { view: 'unlock', pending: op, back: clubSheet ? clubSheet.view : null }; renderClub(); return; }
  queueOp(Object.assign({}, op, club.hasPin ? { pin: pins[club.code] || '', ownerToken: owners[club.code] || '' } : {}));
  if (op.type === 'restore' && clubSheet) clubSheet.msg = 'Game restored.';
  if (op.type === 'edit') showToast('Result updated', false);
  render();
}
async function pinUnlock(raw) {
  const pin = String(raw || '').trim();
  if (!/^\d{6,8}$/.test(pin)) { clubSheet.error = 'Organizer PINs are 6 to 8 digits.'; renderClub(); return; }
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    const ver = await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'verify-pin', pin, device: true }, odWho())) });
    // The phone's own key replaces the PIN, so removing this phone ends its access and it keeps working if others guess wrong.
    rememberPin(club.code, ver.organizerKey ? ':' + ver.organizerKey : ver.deviceKey ? pin + ':' + ver.deviceKey : pin);
    club.shortPin = !!ver.shortPin; saveClubs();
    const { pending, back } = clubSheet;
    clubSheet = back === 'club' ? { view: 'club' } : null;
    if (pending) withPin(pending); else render();
    if (clubSheet && !pending) clubSheet.msg = 'This phone is unlocked for organizer actions.';
    renderClub();
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; renderClub(); }
}
// The organizer's pinned note and how-to-pay link, shown to every member. Both come from the server as plain text: always escaped here,
// and the link is only offered as a link when it is https.
function clubInfoHTML() {
  if (!club || (!club.note && !club.payLink)) return '';
  const link = /^https:\/\//i.test(club.payLink || '') ? club.payLink : '';
  return `<div class="org-card club-info">${club.note ? `<span class="lab">Pinned note</span><p style="white-space:pre-line;overflow-wrap:anywhere">${esc(club.note)}</p>` : ''}${link ? `<a class="btn btn-soft block" href="${esc(link)}" target="_blank" rel="noopener noreferrer">How to pay</a><p class="note" style="overflow-wrap:anywhere">Opens ${esc(new URL(link).host)}. Dink Score does not take payments.</p>` : ''}</div>`;
}
async function saveClubInfo(note, link) {
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'set-note', note }, adminCreds())) });
    await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'set-pay-link', link }, adminCreds())) });
    await refreshClub();
    clubSheet = { view: 'club', msg: 'Saved.' }; render();
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; renderClub(); }
}
async function codeRotate(grace) {
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    const old = club.code;
    const data = await api('club', { method: 'POST', body: JSON.stringify({ code: old, action: 'rotate-code', graceMinutes: Number(grace), pin: pins[old] || '', ownerToken: owners[old] || '' }) });
    adoptClubCode(old, data.club.code);
    const until = Number(grace) ? ` The old code ${old} works until ${new Date(data.oldCodeUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ` The old code ${old} no longer works.`;
    clubSheet = { view: 'club', msg: `The new club code is ${data.club.code}.${until} Share the new code or invite link.` };
    render();
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; renderClub(); }
}
// Data rights (api/players.js export/anonymise, api/club.js export/delete-club): see privacy.html.
function saveFile(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function rightsRun(fn) {
  clubSheet.busy = true; clubSheet.error = ''; clubSheet.msg = ''; renderClub();
  try { const msg = await fn(); clubSheet = clubSheet && clubSheet.view === 'rights' ? { view: 'rights', msg: msg || '' } : clubSheet; }
  catch (err) { clubSheet.busy = false; clubSheet.error = err.message; }
  if (clubSheet) renderClub();
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'club';
const rightsPlayerExport = () => rightsRun(async () => {
  const d = await playerCall({ action: 'export', name: myName(), playerToken: myToken() });
  saveFile(JSON.stringify(d, null, 2), `dink-score-${slug(myName())}.json`, 'application/json');
  return 'Your data was downloaded.';
});
const rightsAnonymise = () => rightsRun(async () => {
  const d = await playerCall({ action: 'anonymise', name: myName(), playerToken: myToken() });
  delete me[club.code]; store.set('pb.me', me);
  await refreshClub();
  return `Done. In ${club.name} you are now "${d.label}". Your games stay, so other people's ratings don't change.`;
});
