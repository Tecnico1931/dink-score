/* ---------- who you are ---------- */
// Each phone can be linked to one player name per club. The server keeps the link; the phone keeps a private key.
let me = Heal.map(store.get('pb.me', {})); // { [clubCode]: { name, token } }
const myName = () => (club && me[club.code] ? me[club.code].name : null);
const myToken = () => (club && me[club.code] ? me[club.code].token : null);
const linkedPlayerName = () => myName() || (acctIn() && acct.account.name) || '';
/*GREETING-START*/
const Greeting = (() => {
  function firstName(raw) {
    const parts = String(raw || '').trim().split(/\s+/);
    for (const p of parts) {
      const clean = p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (clean) return clean;
    }
    return '';
  }
  function bucket(date = new Date()) {
    const h = date instanceof Date ? date.getHours() : Number(date);
    if (!Number.isFinite(h)) return 'Hello';
    if (h >= 5 && h < 12) return 'Good morning';
    if (h >= 12 && h < 17) return 'Good afternoon';
    return 'Good evening';
  }
  function text(raw, date = new Date()) {
    const name = firstName(raw);
    return name ? `${bucket(date)}, ${name}` : '';
  }
  return { firstName, bucket, text };
})();
/*GREETING-END*/
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
// Ask an organizer to approve instead of typing the PIN (api/_approvals.js). This phone makes up its own key and sends it; approving
// makes it the name's link, so the key is saved here until the answer comes back (a few minutes at most).
let askTimer = 0;
const asks = () => (club && store.get('pb.asks', {})[club.code]) || null;
function setAsk(a) { const all = store.get('pb.asks', {}); if (a) all[club.code] = a; else delete all[club.code]; store.set('pb.asks', all); }
async function askOrganizer(name) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    const d = await playerCall({ action: 'approval-request', name, playerToken: token });
    setAsk({ id: d.id, name, token, expiresAt: d.expiresAt });
    clubSheet.busy = false; clubSheet.needPinFor = null; renderClub(); pollAsk();
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; renderClub(); }
}
function askCancel() { clearTimeout(askTimer); askTimer = 0; setAsk(null); renderClub(); }
function pollAsk() {
  clearTimeout(askTimer);
  const a = asks(), code = club && club.code;
  if (!a) { askTimer = 0; return; }
  askTimer = setTimeout(async () => {
    askTimer = 0;
    if (!club || club.code !== code) return;
    try {
      const d = await playerCall({ action: 'approval-status', id: a.id, playerToken: a.token });
      if (d.status === 'pending') pollAsk(); else askDone(a, d.status);
    } catch (err) { if (err.status === 404) askDone(a, 'expired'); else pollAsk(); }
  }, 5000);
}
async function askDone(a, status) {
  setAsk(null);
  if (status === 'approved') {
    me[club.code] = { name: a.name, token: a.token }; store.set('pb.me', me);
    clubSheet = { view: 'club', msg: `An organizer approved it. This phone is now ${a.name}.` };
    showToast(`Welcome, ${a.name}`, false);
    await refreshClub(); render(); renderClub(); return;
  }
  if (clubSheet) { clubSheet.error = status === 'denied' ? 'An organizer said no to that request.' : 'The request ran out of time. Ask again, or ask an organizer in person.'; renderClub(); }
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
  let ask = asks();
  if (ask && ask.expiresAt < Date.now()) { setAsk(null); ask = null; }
  if (ask && !askTimer) pollAsk();
  return `<h2 id="club-h">Who are you?</h2>
    <p>Pick your name to RSVP to game nights, get alerts when you're up, and have your games count toward your stats, achievements and weekly challenges. Only this phone can use it.</p>
    ${free.length ? `<div class="field" style="margin:0"><span class="lab">Tap your name</span><div class="chips">${free.map(p => `<button type="button" class="chip-btn" data-claim="${esc(p.name)}">${esc(p.name)}</button>`).join('')}</div></div>` : ''}
    ${ask ? `<div class="field" role="status"><span class="lab">Waiting for an organizer</span><p class="note">You asked to be ${esc(ask.name)}. An organizer can approve it from their own phone. This runs out after a few minutes.</p><div class="btns"><button type="button" class="btn btn-soft" data-act="ask-cancel">Cancel the request</button></div></div>` : ''}
    ${taken.length && !ask ? `<div class="field" style="margin:0"><span class="lab">Already linked to a phone. Is one of these you?</span><div class="chips">${taken.map(p => `<button type="button" class="chip-btn" data-ask="${esc(p.name)}" ${c.busy ? 'disabled' : ''}>Ask an organizer: ${esc(p.name)}</button>`).join('')}</div></div>` : ''}
    <form class="club-form" data-form="whoami"><label class="lab" for="whoami-name">${free.length ? 'Not listed? Add your name' : 'Your name'}</label>
      <div class="add-player"><input id="whoami-name" autocomplete="off" maxlength="40" placeholder="Your name"><button type="submit" class="btn btn-ink" style="padding:10px 16px;border-radius:12px" ${c.busy ? 'disabled' : ''}>That's me</button></div></form>
    ${c.dym ? `<div class="field" role="alert"><span class="lab">Did you mean ${esc(c.dym.similar[0])}?</span><div class="chips">${c.dym.similar.map(n => `<button type="button" class="chip-btn" data-claim="${esc(n)}">Yes, ${esc(n)}</button>`).join('')}<button type="button" class="chip-btn" data-claim-new="${esc(c.dym.name)}">No, add ${esc(c.dym.name)}</button></div></div>` : ''}
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
    ${c.needPinFor ? `<form class="club-form" data-form="whoami-pin"><label class="lab" for="whoami-pin">Organizer PIN to confirm ${esc(c.needPinFor)}</label>
      <div class="add-player"><input id="whoami-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" placeholder="Organizer enters it"><button type="submit" class="btn btn-ink" style="padding:10px 16px;border-radius:12px" ${c.busy ? 'disabled' : ''}>Confirm</button></div></form>
      <div class="btns"><button type="button" class="btn btn-soft" data-ask="${esc(c.needPinFor)}" ${c.busy ? 'disabled' : ''}>Or ask an organizer to approve</button></div>` : ''}
    <div class="btns"><button class="btn btn-soft" data-act="whoami-skip">Skip for now</button></div>`;
}

