/* ---------- opt-in "you're up" notifications (api/_push.js) ---------- */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64uBytes = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
const pushCreds = extra => Object.assign({ playerName: myName() || '', playerToken: myToken() || '' }, extra);
// Push actions are answered by /api/live (live.js dispatches PUSH_ACTIONS), not /api/players.
const pushCall = body => api('live', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code }, body)) });
async function pushEndpoint() {
  if (!pushSupported()) return '';
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  return sub ? sub.endpoint : '';
}
async function notifyOpen() {
  const from = inboxOpen ? 'inbox' : null;
  if (inboxOpen) { inboxOpen = false; inboxNew = new Set(); inboxOpener = null; renderInbox(); }
  const focusHead = () => { const hd = $('#club-h'); if (hd) { hd.tabIndex = -1; hd.focus({ preventScroll: true }); } };
  clubSheet = { view: 'notify', loading: true, from }; renderClub(); focusHead();
  let next;
  try { next = { view: 'notify', from, st: await pushCall(pushCreds({ action: 'push-status', endpoint: await pushEndpoint(), ownerToken: owners[club.code] || '' })) }; }
  catch (err) { next = { view: 'notify', from, error: err.message }; }
  if (clubSheet && clubSheet.view === 'notify') {
    clubSheet = next; renderClub();
    const root = $('#sheet3');
    if (!root || typeof document === 'undefined' || !root.contains(document.activeElement)) focusHead();
  }
}
async function notifyToggle(on) {
  clubSheet.busy = true; clubSheet.error = ''; clubSheet.msg = ''; renderClub();
  let msg = '';
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (on) {
      if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for Dink Score. Allow them in your phone or browser settings, then try again.');
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(clubSheet.st.publicKey) });
      await pushCall(pushCreds({ action: 'push-subscribe', subscription: sub.toJSON(), ownerToken: owners[club.code] || '' }));
      msg = "Notifications are on for this phone in this club.";
    } else {
      if (sub) { await pushCall(pushCreds({ action: 'push-unsubscribe', endpoint: sub.endpoint })); await sub.unsubscribe(); }
      msg = 'Notifications are off for this phone.';
    }
    if (clubSheet && clubSheet.view === 'notify') clubSheet = { view: 'notify', from: clubSheet.from || null, msg, st: Object.assign({}, clubSheet.st, { subscribed: on }) };
  } catch (err) { if (clubSheet) { clubSheet.busy = false; clubSheet.error = err.message; } }
  if (clubSheet) renderClub();
}
const PUSH_CATS = [['nights', 'Game nights', 'A new game night, and reminders from an organizer.'], ['events', 'Events and courts', 'Your court when a round opens, and when a court is free and you are next.'], ['league', 'League', 'Your match day and court, a moved match, and when a result is in.']];
async function notifyCategory(cat, on) {
  if (!clubSheet || clubSheet.view !== 'notify' || !clubSheet.st || clubSheet.busy) return;
  const shown = PUSH_CATS.map(c => c[0]);
  const had = clubSheet.st.categories || shown.concat('confirm'); // preserve server default for unshipped categories
  const next = shown.filter(k => k === cat ? on : had.includes(k)).concat(had.filter(k => !shown.includes(k)));
  clubSheet.busy = true; clubSheet.error = ''; clubSheet.msg = ''; clubSheet.st = Object.assign({}, clubSheet.st, { categories: next }); renderClub();
  try {
    await pushCall(pushCreds({ action: 'push-categories', endpoint: await pushEndpoint(), categories: next }));
    announce(`${PUSH_CATS.find(c => c[0] === cat)[1]} notifications ${on ? 'on' : 'off'}.`);
  } catch (err) { if (clubSheet && clubSheet.view === 'notify') { clubSheet.st = Object.assign({}, clubSheet.st, { categories: had }); clubSheet.error = err.message; } }
  if (clubSheet && clubSheet.view === 'notify') { clubSheet.busy = false; renderClub(); }
}
