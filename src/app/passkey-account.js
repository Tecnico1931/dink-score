// Optional account (see api/account.js): a passkey keeps your clubs and history across phones. Nothing else depends on it.
let acct = null; // the last answer from /api/account: { account, identities } once loaded
const passkeysOk = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
const toBuf = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0)).buffer;
const fromBuf = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let emailAvail = false; // the server's `config.email`, kept apart because some answers (claim, restore) carry no config
const seeConfig = d => { if (d && d.config) emailAvail = !!d.config.email; return d; };
const acctPost = async body => seeConfig(await api('account', { method: 'POST', body: JSON.stringify(body) }));
function credJson(c) {
  const r = c.response, response = { clientDataJSON: fromBuf(r.clientDataJSON) };
  if (r.attestationObject) { response.attestationObject = fromBuf(r.attestationObject); response.transports = r.getTransports ? r.getTransports() : []; }
  else { response.authenticatorData = fromBuf(r.authenticatorData); response.signature = fromBuf(r.signature); if (r.userHandle) response.userHandle = fromBuf(r.userHandle); }
  return { id: c.id, rawId: fromBuf(c.rawId), type: c.type, response };
}
async function passkeyCreate(o) {
  const pk = Object.assign({}, o, { challenge: toBuf(o.challenge), user: Object.assign({}, o.user, { id: toBuf(o.user.id) }), excludeCredentials: (o.excludeCredentials || []).map(x => Object.assign({}, x, { id: toBuf(x.id) })) });
  return credJson(await navigator.credentials.create({ publicKey: pk }));
}
async function passkeyGet(o) { return credJson(await navigator.credentials.get({ publicKey: Object.assign({}, o, { challenge: toBuf(o.challenge) }) })); }
async function acctLoad() { try { acct = seeConfig(await api('account')); } catch { acct = null; } }
const acctMsg = err => err && (err.name === 'NotAllowedError' || err.name === 'AbortError') ? 'The passkey step was cancelled. Try again when you are ready.' : err.message;
// Hands the server this phone's own tokens, once, so the account can bring the same clubs and names to another phone.
async function acctClaim(only) { // `only`: just that club code
  const items = clubs.filter(c => !only || c.code === only).map(c => ({ code: c.code, ownerToken: owners[c.code] || '', playerName: (me[c.code] || {}).name || '', playerToken: (me[c.code] || {}).token || '' })).filter(i => i.ownerToken || i.playerToken);
  let linked = 0;
  for (let i = 0; i < items.length; i += 30) { const d = await acctPost({ action: 'claim', items: items.slice(i, i + 30) }); linked += d.linked.length; acct = d; }
  return linked;
}
// Brings back identities the account holds that this phone does not (a new phone). A phone that already holds one keeps it.
const acctIn = () => !!(acct && acct.account);
const acctLive = () => ((acct && acct.identities) || []).filter(i => !i.stale);
const acctClubs = () => new Set(acctLive().map(i => i.code)); // club codes on the account
// (a co-organizer's credential in owners[] doesn't count as the creator token)
const acctMissing = () => acctLive().filter(i => i.kind === 'organizer' ? !creatorTok(i.code) : !(me[i.code] && me[i.code].token));
// Clubs whose creator token or claimed name this phone holds but the account does not list yet.
function acctUnlinked() {
  const live = acctLive();
  return clubs.filter(c => {
    const m = me[c.code], nk = m && m.name ? String(m.name).trim().toLowerCase() : '';
    return (creatorTok(c.code) && !live.some(i => i.code === c.code && i.kind === 'organizer'))
      || (m && m.token && nk && !live.some(i => i.code === c.code && i.kind === 'player' && String(i.name || '').trim().toLowerCase() === nk));
  });
}
// Signed in: a club made or a name claimed here joins the account at once, so keeping it needs no later step.
async function acctAutoLink(code) { if (acctIn()) { try { await acctClaim(code); } catch {} } }
// `only` limits it to one club; `force` also re-fetches a club this phone still holds a (possibly replaced) token for.
async function acctRestore(only, force) {
  const want = (force ? acctLive() : acctMissing()).filter(i => !only || i.code === only);
  let n = 0;
  for (let i = 0; i < want.length; i += 30) {
    const d = await acctPost({ action: 'restore', items: want.slice(i, i + 30).map(w => ({ code: w.code, kind: w.kind, name: w.name })) });
    for (const r of d.restored) {
      if (!clubs.some(c => c.code === r.code)) clubs.push({ code: r.code, name: String(r.club || r.code).slice(0, 60) });
      if (r.kind === 'organizer') owners[r.code] = r.token; else me[r.code] = { name: r.name, token: r.token };
      n++;
    }
  }
  if (n) { adoptMoved(); const first = club || clubs[0]; if (first) await joinClub(first.code, first.name); }
  return n;
}
async function acctRun(fn, done, land) { // `land`: finish on the club screen when there is a club (the add-a-club screen started it)
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try { const msg = await fn(); clubSheet = { view: land && club ? 'club' : 'account', msg: msg || done || '' }; }
  catch (err) { clubSheet.busy = false; clubSheet.error = acctMsg(err); }
  renderClub();
}
const acctSyncMsg = (restored, linked) => `Signed in${acctIn() ? ` as ${acct.account.name}` : ''}. ${restored ? `Brought ${restored} club name${restored === 1 ? '' : 's'} to this phone. ` : ''}${linked ? `Linked ${linked} from this phone. ` : ''}${!restored && !linked && !acctClubs().size ? "This account has no clubs yet. On the phone that made your club, open Your account and tap Add this phone's clubs to my account." : ''}`.trim();
const acctBring = land => acctRun(async () => { const n = await acctRestore(); return n ? `Brought ${n} club name${n === 1 ? '' : 's'} to this phone.` : 'Everything on your account is already on this phone.'; }, '', land);
function acctSignUp(name) {
  return acctRun(async () => {
    const o = await acctPost({ action: 'register-options', name });
    const d = await acctPost({ action: 'register', challengeId: o.challengeId, credential: await passkeyCreate(o.options), name });
    acct = d;
    const linked = await acctClaim();
    return `Account created. ${linked ? `Linked ${linked} club name${linked === 1 ? '' : 's'} from this phone.` : 'Nothing on this phone to link yet.'}`;
  });
}
function acctSignIn(land) {
  return acctRun(async () => {
    const o = await acctPost({ action: 'login-options' });
    acct = await acctPost({ action: 'login', challengeId: o.challengeId, credential: await passkeyGet(o.options) });
    const restored = await acctRestore();
    return acctSyncMsg(restored, await acctClaim());
  }, '', land);
}
function acctHandoffCode() {
  return acctRun(async () => { const d = await acctPost({ action: 'passkey-code' }); return `Code ${d.code.slice(0, 5)}-${d.code.slice(5)}. On the other address open Account, choose "Have a code from another address", and enter it within 5 minutes.`; });
}
function acctHandoffJoin(code) {
  return acctRun(async () => {
    const o = await acctPost({ action: 'handoff-options', code });
    acct = await acctPost({ action: 'handoff-add', challengeId: o.challengeId, credential: await passkeyCreate(o.options) });
    const restored = await acctRestore();
    return acctSyncMsg(restored, await acctClaim());
  });
}
function acctOut() { return acctRun(async () => { await acctPost({ action: 'logout' }); acct = null; return 'Signed out. Your clubs on this phone still work.'; }); }
function acctAddPasskey() {
  return acctRun(async () => {
    const o = await acctPost({ action: 'passkey-options' });
    acct = await acctPost({ action: 'passkey-add', challengeId: o.challengeId, credential: await passkeyCreate(o.options) });
    return 'Passkey added.';
  });
}
function acctDelete() { return acctRun(async () => { await acctPost({ action: 'delete-account' }); acct = null; return 'Account deleted. Your clubs and games were not touched.'; }); }
// Email sign-in link (only when the server has a mail key: `config.email`). The link opens the page with #signin=<token>; the token
// stays in this variable and is traded on a tap, so a mail scanner that merely fetches the link can't use it up.
let pendingSignin = '';
const emailOk = () => emailAvail;
const acctEmailSend = email => acctRun(async () => (await acctPost({ action: 'email-start', email: String(email || '').trim() })).message);
const acctEmailRemove = email => acctRun(async () => { acct = Object.assign({}, acct, await acctPost({ action: 'email-remove', email })); return 'Email address removed.'; });
function acctEmailFinish() {
  return acctRun(async () => {
    acct = await acctPost({ action: 'email-finish', token: pendingSignin });
    pendingSignin = '';
    const restored = await acctRestore();
    return acctSyncMsg(restored, await acctClaim());
  });
}
async function acctFromLink(token) {
  pendingSignin = token;
  await acctOpen();
}
function emailFormHTML(c, label, btn, hint) {
  return `<form class="club-form" data-form="acct-email"><label class="lab" for="acct-email">${label}</label>
    <div class="add-player"><input id="acct-email" type="email" inputmode="email" placeholder="you@example.com" autocomplete="email" maxlength="254" required><button type="submit" class="btn btn-soft" style="padding:10px 16px;border-radius:12px" ${c.busy ? 'disabled' : ''}>${btn}</button></div>
    <p class="note">${hint}</p></form>`;
}
async function acctOpen() {
  clubSheet = { view: 'account', busy: true }; renderClub();
  await acctLoad();
  if (clubSheet && clubSheet.view === 'account') { clubSheet.busy = false; renderClub(); }
}
// One quiet sign-in row after join and create on the no-club and join screens, so the code box stays the first thing a new member sees.
function addAcctHTML(c) {
  if (!passkeysOk()) return '';
  const off = c.busy ? 'disabled' : '';
  if (acctIn()) {
    const missing = new Set(acctMissing().map(i => i.code)).size;
    return `<div class="field"><p class="note" role="status">Signed in as <b>${esc(acct.account.name)}</b>.</p>${missing ? `<button class="btn btn-soft block" data-act="acct-restore-add" ${off}>Bring my clubs to this phone (${missing})</button>` : ''}</div>`;
  }
  return `<div class="field"><button class="btn btn-soft block" data-act="acct-in-add" ${off}>Already have clubs? Sign in with a passkey</button><p class="note">Brings the clubs and player names on your account to this phone. The Home Screen app is a separate copy from Safari, so sign in there too.</p></div>`;
}
// A phone whose token was replaced (your account was restored on another phone) can take its access back.
const lostToken = msg => /phone isn't linked to that player|only the phone that created/i.test(msg || '');
function restoreOfferHTML(c) {
  if (!c.error || !club || !acctIn() || !lostToken(c.error) || !acctLive().some(i => i.code === club.code)) return '';
  return `<div class="field"><p class="note">Another phone may have taken this over when it signed in to your account. Restoring here gives it back to this phone and stops the other one.</p><button class="btn btn-ink block" data-act="acct-restore-here" ${c.busy ? 'disabled' : ''}>Restore access with your account</button></div>`;
}
function accountHTML(c) {
  const err = c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : '';
  const back = `<div class="btns"><button class="btn btn-soft" data-act="acct-close">Done</button></div>`;
  const what = `<p>An account is optional. Without one, Dink Score works exactly as before. With one, you keep your clubs, player names and organizer access across phones, and a lost phone no longer loses them. There is no password: you sign in with a passkey, the fingerprint, face or screen lock you already use on this phone.</p>`;
  const note = (c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : '')
    + (pendingSignin ? `<div class="field"><p><b>Finish signing in.</b> Tap to sign in with the link from your email.</p><button class="btn btn-ink block" data-act="acct-email-finish" ${c.busy ? 'disabled' : ''}>Finish signing in</button></div>` : '');
  if (!passkeysOk()) return `<h2 id="club-h">Account (optional)</h2>${what}<p class="err">This browser can't make passkeys, so accounts aren't available here. Everything else works.</p>${back}`;
  if (acct && acct.account) {
    const ids = acct.identities || [], unlinked = acctUnlinked();
    return `<h2 id="club-h">Your account</h2>${note}${err}
      <p>Signed in as <b>${esc(acct.account.name)}</b>. ${acct.account.passkeys} passkey${acct.account.passkeys === 1 ? '' : 's'}.</p>
      <p class="note">A passkey works only on the web address it was made on${acct.account.host ? ` (this one is ${esc(acct.account.host)})` : ''}. Your account and clubs are the same on every address, but you sign in with a passkey made on the address you are using.${acct.account.passkeysHere === 0 ? ' You have no passkey for this address yet.' : ''}</p>
      ${emailOk() || (acct.account.emails || []).length ? `<div class="field"><span class="lab">Email sign-in</span>${(acct.account.emails || []).length ? `<ul class="deleted">${acct.account.emails.map(e => `<li><span>${esc(e)}</span><button class="link" style="min-height:44px;padding-inline:8px" data-act="acct-email-rm" data-email="${esc(e)}" ${c.busy ? 'disabled' : ''}>Remove</button></li>`).join('')}</ul>` : '<p class="note">No email address yet.</p>'}${emailOk() ? emailFormHTML(c, 'Add an email address', 'Send link', 'We email a link that works once, for 15 minutes. Opening it adds the address, so you can sign in from it later.') : ''}</div>` : ''}
      <button class="btn btn-ink block" data-act="acct-restore" ${c.busy ? 'disabled' : ''}>Bring my clubs to this phone</button>
      <p class="note">Gets the clubs and names on your account that this phone does not have yet. Each one moves to this phone, so a phone that had it before loses it until you bring it back there.</p>
      <div class="field"><span class="lab">Linked to your account</span>${ids.length ? `<ul class="deleted">${ids.map(i => `<li><span>${esc(i.club)}: ${i.kind === 'organizer' ? 'organizer access (club creator)' : esc(i.name || 'player name')}${i.stale ? ' (no longer valid)' : ''}</span></li>`).join('')}</ul>` : '<p class="note">Nothing yet.</p>'}</div>
      ${unlinked.length ? `<div class="field"><span class="lab">On this phone, not on your account yet</span><ul class="deleted">${unlinked.map(u => `<li><span>${esc(u.name)}</span><button class="link" style="min-height:44px;padding-inline:8px" data-act="acct-link-one" data-code="${esc(u.code)}" ${c.busy ? 'disabled' : ''}>Add to my account</button></li>`).join('')}</ul></div>` : ''}
      <button class="btn btn-soft block" data-act="acct-claim" ${c.busy ? 'disabled' : ''}>Add this phone's clubs to my account</button>
      <p class="note">Adds the club names and organizer access this phone holds, so they come back on a new phone when you sign in. Clubs you start or names you claim while signed in are added for you. The Home Screen app and Safari are separate copies on one phone: sign in in each.</p>
      <button class="btn btn-soft block" data-act="acct-passkey" ${c.busy ? 'disabled' : ''}>${acct.account.passkeysHere === 0 ? 'Add a passkey on this address' : 'Add another passkey'}</button>
      <button class="btn btn-soft block" data-act="acct-code" ${c.busy ? 'disabled' : ''}>Get a code to add a passkey on another address</button>
      <button class="btn btn-soft block" data-act="acct-out" ${c.busy ? 'disabled' : ''}>Sign out</button>
      <button class="btn btn-line-danger block" data-act="acct-delete" ${c.busy ? 'disabled' : ''}>${c.confirmDelete ? 'Tap again to delete the account' : 'Delete account'}</button>
      <p class="note">Deleting removes the account and its passkeys. Clubs, games and ratings stay where they are.</p>${back}`;
  }
  return `<h2 id="club-h">Account (optional)</h2>${what}${note}${err}
    <span class="lab">Already have an account?</span>
    <button class="btn btn-ink block" data-act="acct-in" ${c.busy ? 'disabled' : ''}>Sign in with a passkey</button>
    <p class="note">A passkey works only on the web address it was made on${acct && acct.config ? ` (this one is ${esc(acct.config.rpId)})` : ''}. If your account has no passkey for this address yet, get a code from the address where you are signed in. The Home Screen app is a separate copy from Safari, so sign in there too.</p>
    ${emailOk() ? emailFormHTML(c, 'Or get a sign-in link by email', 'Send link', 'Works for a new account too. We email a link that works once, for 15 minutes; there is no password. Open it on this phone.') : ''}
    <div class="or"><span>or</span></div>
    <form class="club-form" data-form="acct-up"><label class="lab" for="acct-name">New here? Create an account</label>
      <div class="add-player"><input id="acct-name" placeholder="Your name" autocomplete="name" maxlength="40"><button type="submit" class="btn btn-blue" style="padding:10px 16px;border-radius:12px" ${c.busy ? 'disabled' : ''}>Create</button></div>
      <p class="note">Your clubs and names on this phone are linked to it.</p></form>
    <form class="club-form" data-form="acct-join"><label class="lab" for="acct-code">Have a code from another address?</label>
      <div class="add-player"><input id="acct-code" placeholder="Code" autocomplete="off" autocapitalize="characters" maxlength="12"><button type="submit" class="btn btn-soft" style="padding:10px 16px;border-radius:12px" ${c.busy ? 'disabled' : ''}>Add passkey here</button></div></form>${back}`;
}
