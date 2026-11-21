/* ---------- paddle tracker (L14: players.js paddles-get / paddles-set, rules in api/_paddles.js) ---------- */
// A player's own paddles, each with an optional photo (shrunk by photoToAvatar, so the limits are the avatar's), the one chosen for a
// game, and the record with each. Private to the phone linked to the name: it never rides in the club payload.
const PADDLE_MAX = 6, PADDLE_USED_MAX = 1000;
let paddleDocs = store.get('pb.paddles', {}); // club code -> {list: [{id, name, photo?}], used: {gameId: paddleId}}
let paddleChoice = store.get('pb.paddleNow', {}); // club code -> the paddle picked for the next game
const paddleAsked = new Set();
const paddleDoc = () => (club && myName() ? paddleDocs[club.code] || null : null);
const paddleList = () => (paddleDoc() ? paddleDoc().list : []);
function paddleCache() { store.set('pb.paddles', paddleDocs); store.set('pb.paddleNow', paddleChoice); }
// Fetches your paddles once per club per visit; the app works from the saved copy meanwhile.
async function paddleLoad() {
  if (!club || !myName() || !myToken()) return;
  const code = club.code;
  if (paddleAsked.has(code)) return;
  paddleAsked.add(code);
  try {
    const d = await playerCall({ action: 'paddles-get', name: myName(), playerToken: myToken() });
    if (!club || club.code !== code || !d.paddles) return;
    paddleDocs[code] = { list: d.paddles.list || [], used: d.paddles.used || {} };
    paddleCache(); render(); renderProfile();
  } catch { paddleAsked.delete(code); }
}
async function paddleSave(doc) {
  const d = await playerCall({ action: 'paddles-set', name: myName(), playerToken: myToken(), paddles: doc });
  paddleDocs[club.code] = d.paddles;
  if (paddleChoice[club.code] && !d.paddles.list.some(p => p.id === paddleChoice[club.code])) delete paddleChoice[club.code];
  paddleCache();
}
const paddleNewId = () => Math.random().toString(36).slice(2, 10).padEnd(4, 'x');

// Your record with each paddle, from the rated games you were in. A game with no paddle chosen counts for none of them.
function paddleTally(name, games) {
  const doc = paddleDoc();
  const rows = new Map(paddleList().map(p => [p.id, { p, w: 0, l: 0 }]));
  for (const g of doc ? games : []) {
    const row = rows.get(doc.used[g.id]);
    if (!row) continue;
    const t = g.teams[0].some(n => sameName(n, name)) ? 0 : g.teams[1].some(n => sameName(n, name)) ? 1 : -1;
    if (t < 0) continue;
    if (g.winner === t) row.w++; else row.l++;
  }
  return [...rows.values()];
}
const paddleThumb = p => (p.photo && /^data:image\/(jpeg|webp);base64,/.test(p.photo) ? `<img class="av-img" src="${esc(p.photo)}" alt="">` : `<span class="av-icon">${iconSvg('paddle')}</span>`);

// The row of paddles on your own profile, with the record for each.
function paddlesProfileHTML(name, games) {
  if (!club || !isMe(name)) return '';
  paddleLoad();
  const rows = paddleTally(name, games);
  const list = rows.length ? `<div class="pf-list">${rows.map(({ p, w, l }) => `<div class="pf-row pd-row"><span class="who"><span class="av pd-thumb">${paddleThumb(p)}</span><span>${esc(p.name)}</span></span><span class="n">${w + l ? w + '–' + l : 'No games'}</span><span class="pct">${w + l ? Math.round(100 * w / (w + l)) + '%' : ''}</span></div>`).join('')}</div>`
    : '<p class="note">Save your paddles, pick one when you start a game, and see how you do with each.</p>';
  return `<div class="field" style="margin:0"><span class="lab">Paddles</span>${list}<button class="link" data-act="paddle-open" style="align-self:flex-start">${rows.length ? 'Manage paddles' : 'Add a paddle'}</button></div>`;
}

// "Paddle" on the New game card: only for a linked player who has saved at least one.
function paddlePickHTML() {
  if (!club || !myName()) return '';
  paddleLoad();
  const list = paddleList();
  if (!list.length) return '';
  const cur = paddleChoice[club.code] || 'none';
  return `<div class="field"><span class="lab">Your paddle</span><div class="seg" role="group">${[['none', 'None'], ...list.map(p => [p.id, esc(p.name)])].map(([v, l]) => `<button type="button" data-paddle-pick="${v}" aria-pressed="${v === cur}">${l}</button>`).join('')}</div></div>`;
}
function paddlePick(id) {
  if (!club) return;
  if (id === 'none') delete paddleChoice[club.code]; else if (paddleList().some(p => p.id === id)) paddleChoice[club.code] = id;
  paddleCache(); render();
  const b = document.querySelector(`[data-paddle-pick="${id}"]`);
  if (b) b.focus({ preventScroll: true });
}
// Called when a game is finished and saved: remembers which paddle this player used for it. Best effort; the choice stays on the
// phone and goes up with the next successful save.
async function paddleTag(gameId) {
  const doc = paddleDoc(), id = club && paddleChoice[club.code];
  if (!doc || !id || !doc.list.some(p => p.id === id) || !myToken()) return;
  const used = Object.assign({}, doc.used, { [gameId]: id });
  for (const k of Object.keys(used).slice(0, Math.max(0, Object.keys(used).length - PADDLE_USED_MAX))) delete used[k];
  doc.used = used;
  paddleCache();
  try { await paddleSave({ list: doc.list, used }); } catch {}
}

// The sheet where paddles are added and removed.
function paddleSheetHTML(c) {
  const list = paddleList();
  const d = c.draft || (c.draft = { name: '', photo: '' });
  const rows = list.map(p => `<div class="pd-edit"><span class="av pd-thumb">${paddleThumb(p)}</span><span class="pd-name">${esc(p.name)}</span><button type="button" class="link armed" data-paddle-del="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">Remove</button></div>`).join('');
  const add = list.length >= PADDLE_MAX ? `<p class="note">You can save up to ${PADDLE_MAX} paddles. Remove one to add another.</p>`
    : `<form class="club-form" data-form="paddle-add"><label class="lab" for="pd-name">Paddle name</label><input id="pd-name" class="field-input" maxlength="40" autocomplete="off" placeholder="Selkirk Vanguard" value="${esc(d.name)}">
      <label class="photo-drop" for="pd-file"><span>${d.photo ? 'Choose a different photo' : 'Add a photo (optional)'}</span><small>It's cropped to a square and shrunk before it's saved. Only you can see it.</small><input id="pd-file" type="file" accept="image/*" hidden></label>
      ${d.photo ? `<div class="pd-edit"><span class="av pd-thumb"><img class="av-img" src="${esc(d.photo)}" alt=""></span><span class="pd-name">Photo ready</span><button type="button" class="link" data-paddle-nophoto="1">Remove photo</button></div>` : ''}
      <button type="submit" class="btn btn-ink" ${c.busy ? 'disabled' : ''}>Save paddle</button></form>`;
  return `<h2 id="club-h">Your paddles</h2>
    <p class="note">Only you can see your paddles and photos. Pick one on the New game card to see your record with it.</p>
    ${rows}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}${add}
    <div class="btns"><button class="btn btn-soft" data-act="club-close">Done</button></div>`;
}
async function paddleSubmit() {
  const c = clubSheet, doc = paddleDoc();
  if (!c || !doc || c.busy) return;
  const name = (document.getElementById('pd-name').value || '').trim();
  c.draft.name = name;
  if (!name) { c.error = 'Give the paddle a name.'; renderClub(); return; }
  c.busy = true; c.error = ''; renderClub();
  try {
    await paddleSave({ list: [...doc.list, Object.assign({ id: paddleNewId(), name }, c.draft.photo ? { photo: c.draft.photo } : {})], used: doc.used });
    c.draft = { name: '', photo: '' };
  } catch (err) { c.error = err.message; }
  c.busy = false; renderClub();
}
async function paddleRemove(id) {
  const c = clubSheet, doc = paddleDoc();
  if (!c || !doc || c.busy) return;
  c.busy = true; c.error = ''; renderClub();
  try { await paddleSave({ list: doc.list.filter(p => p.id !== id), used: doc.used }); }
  catch (err) { c.error = err.message; }
  c.busy = false; renderClub();
}
