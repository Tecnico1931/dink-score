/* ---------- who you are ---------- */
// Each phone can be linked to one player name per club. The server keeps the link; the phone keeps a private key.
let me = Heal.map(store.get('pb.me', {})); // { [clubCode]: { name, token } }
const myName = () => (club && me[club.code] ? me[club.code].name : null);
const myToken = () => (club && me[club.code] ? me[club.code].token : null);
const isMe = n => !!myName() && sameName(n, myName());
const whoamiSkipped = () => !!(club && store.get('pb.whoamiSkip', {})[club.code]);
function skipWhoami() { const s = store.get('pb.whoamiSkip', {}); s[club.code] = Date.now(); store.set('pb.whoamiSkip', s); }
const clubPlayers = () => (clubData && clubData.players) || [];
const youTag = n => (isMe(n) ? '<span class="badge you">You</span>' : '');
async function playerCall(body) {
  return api('players', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code }, body)) });
}
// What this phone tells the server about who is sending a game, so it counts toward achievements, challenges and seasons.
function senderCreds(code = club && club.code) {
  if (!code) return {};
  const m = me[code] || {};
  return { playerName: m.name || '', playerToken: m.token || '', ownerToken: owners[code] || '' };
}
// This phone's best guess of how the server will mark a game it sends (the server decides; this only keeps
// previews and totals right until the next refresh).
function senderGuess(g) {
  if (!club) return {};
  const guess = { receivedAt: Date.now() };
  if (isCreator()) guess.scoredBy = 'organizer';
  else if (myName() && myToken()) guess.scoredBy = myName().trim().toLowerCase();
  return guess;
}
async function claimName(raw, confirmNew) {
  const name = String(raw || '').trim();
  if (!name) { clubSheet.error = 'Enter your name, or tap it above.'; renderClub(); return; }
  clubSheet.busy = true; clubSheet.error = ''; clubSheet.dym = null; renderClub();
  try {
    const data = await playerCall({ action: 'claim', name, confirmNew: confirmNew === true, pin: clubSheet.claimPin || pins[club.code] || '', ownerToken: owners[club.code] || '' });
    me[club.code] = { name: data.name, token: data.playerToken }; store.set('pb.me', me);
    if (!setup.names[0][0] && !setup.names[0][1] && !setup.names[1][0] && !setup.names[1][1]) { setup.names[0][0] = data.name; store.set('pb.setup', setup); }
    const after = clubSheet.afterJoin;
    clubSheet = after ? null : { view: 'club', msg: `This phone is now ${data.name}.` };
    showToast(`Welcome, ${data.name}`, false);
    await refreshClub();
    if (after) afterJoin(); else { render(); renderClub(); }
  } catch (err) {
    clubSheet.busy = false; clubSheet.error = err.message;
    if (err.status === 409 && err.data && Array.isArray(err.data.similar)) { clubSheet.error = ''; clubSheet.dym = { name, similar: err.data.similar }; }
    if (err.status === 403 && /organizer/i.test(err.message)) { clubSheet.needPinFor = name; clubSheet.claimPin = ''; }
    renderClub();
  }
}
// An organizer renamed or merged players: this phone's own name and the names in the game being set up follow them.
function followRenames(renamed) {
  if (!renamed || typeof renamed !== 'object' || !club) return;
  const to = n => { const t = renamed[String(n || '').trim().toLowerCase()]; return typeof t === 'string' && t ? t : null; };
  const m = me[club.code], mine = m && to(m.name);
  if (mine && mine !== m.name) { m.name = mine; store.set('pb.me', me); }
  let changed = false;
  for (const t of setup.names) for (let i = 0; i < t.length; i++) { const n = to(t[i]); if (n && n !== t[i]) { t[i] = n; changed = true; } }
  if (changed) store.set('pb.setup', setup);
}
// "Jose" / "José": the name with accents, case, spaces and punctuation taken away (the server's looseKey).
const looseName = n => String(n || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const similarSaved = name => { const l = looseName(name); return l ? roster.filter(r => !sameName(r, name) && looseName(r) === l) : []; };
async function nameEditSubmit(confirmNew) {
  const ed = clubSheet.nameEdit; if (!ed) return;
  const body = ed.kind === 'merge' ? { action: 'merge', name: ed.name, into: ($('#ne-into') || {}).value } : { action: 'rename', name: ed.name, newName: ($('#ne-name') || {}).value || '' };
  if (confirmNew === true) body.confirmNew = true;
  clubSheet.busy = true; clubSheet.error = ''; ed.similar = null; renderClub();
  try {
    await playerCall(Object.assign(body, adminCreds()));
    const done = ed.kind === 'merge' ? `${ed.name} was merged into ${body.into}` : `${ed.name} is now ${body.newName.trim()}`;
    clubSheet.nameEdit = null; clubSheet.busy = false;
    showToast(done, false); await refreshClub(); roster = rosterFromClub(); render(); renderClub();
  } catch (err) {
    clubSheet.busy = false; clubSheet.error = err.message;
    if (err.data && Array.isArray(err.data.similar)) ed.similar = err.data.similar;
    if (err.data && err.data.mergeInto) ed.mergeInto = err.data.mergeInto;
    renderClub();
  }
}
function whoamiHTML(c) {
  const players = clubPlayers().length ? clubPlayers() : roster.map(n => ({ name: n, claimed: false }));
  const free = players.filter(p => !p.claimed), taken = players.filter(p => p.claimed);
  return `<h2 id="club-h">Who are you?</h2>
    <p>Pick your name so your games count toward your achievements and weekly challenges. Only this phone can use it.</p>
    ${free.length ? `<div class="field" style="margin:0"><span class="lab">Tap your name</span><div class="chips">${free.map(p => `<button type="button" class="chip-btn" data-claim="${esc(p.name)}">${esc(p.name)}</button>`).join('')}</div></div>` : ''}
    ${taken.length ? `<p class="note">Already linked to a phone: ${taken.map(p => esc(p.name)).join(', ')}. Ask an organizer if one of these is you.</p>` : ''}
    <form class="club-form" data-form="whoami"><label class="lab" for="whoami-name">${free.length ? 'Not listed? Add your name' : 'Your name'}</label>
      <div class="add-player"><input id="whoami-name" autocomplete="off" maxlength="40" placeholder="Your name"><button type="submit" class="btn btn-ink" style="padding:10px 16px;border-radius:12px" ${c.busy ? 'disabled' : ''}>That's me</button></div></form>
    ${c.dym ? `<div class="field" role="alert"><span class="lab">Did you mean ${esc(c.dym.similar[0])}?</span><div class="chips">${c.dym.similar.map(n => `<button type="button" class="chip-btn" data-claim="${esc(n)}">Yes, ${esc(n)}</button>`).join('')}<button type="button" class="chip-btn" data-claim-new="${esc(c.dym.name)}">No, add ${esc(c.dym.name)}</button></div></div>` : ''}
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
    ${c.needPinFor ? `<form class="club-form" data-form="whoami-pin"><label class="lab" for="whoami-pin">Organizer PIN to confirm ${esc(c.needPinFor)}</label>
      <div class="add-player"><input id="whoami-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" placeholder="Organizer enters it"><button type="submit" class="btn btn-ink" style="padding:10px 16px;border-radius:12px" ${c.busy ? 'disabled' : ''}>Confirm</button></div></form>` : ''}
    <div class="btns"><button class="btn btn-soft" data-act="whoami-skip">Skip for now</button></div>`;
}

