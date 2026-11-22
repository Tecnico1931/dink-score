/* ---------- rewards shop: fixed-price cosmetics bought with Dinks (L16 slice 3; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// The catalogue, every price and what you own are the server's (api/_economyshop.js, players.js rewards-catalog|buy|wear); this phone draws what
// it is told and asks by item id, never by price. Cosmetic only: a ring around your picture and a colour on your paddle thumbnails, on this
// phone. Nothing here is random, nothing moves or makes a sound, and it never reads or changes a score, a rating, a rank or a pairing.
// Opened from the Your Dink card (so the one-tap hide removes it too). Needs a name linked to this phone.
const RW_SLOTS = [['frame', 'Ring around your picture'], ['paddle', 'Paddle thumbnails']];
const rwSwatch = it => it.slot === 'frame'
  ? `<span class="rw-sw" data-rw-frame="${esc(rwLook(it.id))}" aria-hidden="true">${esc(initials(myName() || '?'))}</span>`
  : `<span class="rw-sw pad" data-rw-skin="${esc(rwLook(it.id))}" aria-hidden="true">${iconSvg('paddle')}</span>`;
const rwShort = (n, price) => `Not enough Dinks yet: ${n} costs ${price} and you have `;

Object.assign(Rewards, {
  storeHTML(c) {
    const s = c.store, done = '<div class="btns"><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>';
    const head = '<h2 id="club-h" tabindex="-1">Shop</h2>';
    if (!rwShown()) return `${head}<p class="note">Rewards are hidden on this phone.</p>${done}`;
    if (!s) return `${head}${c.error ? `<p class="err">${esc(c.error)}</p><button type="button" class="btn btn-ink" data-rw="store">Try again</button>` : skel(2)}${done}`;
    const mine = s.items.filter(i => i.owned), toBuy = s.items.filter(i => !i.owned);
    const wear = RW_SLOTS.map(([slot, label]) => {
      const own = mine.filter(i => i.slot === slot);
      if (!own.length) return '';
      const opt = (id, name, sw) => `<button type="button" class="rw-opt" data-rw-wear="${slot}:${esc(id)}" aria-pressed="${s.worn[slot] === id}" ${c.busy ? 'disabled' : ''}>${sw}<span>${esc(name)}</span></button>`;
      return `<fieldset class="rw-pick"><legend>${esc(label)}</legend>${opt('', 'None', '')}${own.map(i => opt(i.id, i.name, rwSwatch(i))).join('')}</fieldset>`;
    }).join('');
    const rows = toBuy.map(i => `<div class="rw-item">${rwSwatch(i)}<span class="rw-name"><b>${esc(i.name)}</b><small>${i.price} Dinks${s.dinks < i.price ? `. You need ${i.price - s.dinks} more.` : ''}</small></span><button type="button" class="btn btn-ink" data-rw-buy="${esc(i.id)}" aria-label="Get ${esc(i.name)} for ${i.price} Dinks" ${c.busy ? 'disabled' : ''}>Get</button></div>`).join('');
    const share = `<button type="button" class="rw-share" data-rw-share="${s.share ? '0' : '1'}" aria-pressed="${!!s.share}" ${c.busy ? 'disabled' : ''}><span><b>Show my look to the club</b><small>${s.share ? 'Other members see your worn ring and paddle colour — never your Dinks, streak or history.' : 'Off by default: only you see your ring and paddle colour on this phone.'}</small></span><span class="rw-pill" aria-hidden="true">${s.share ? 'On' : 'Off'}</span></button>`;
    return `${head}<p class="rw-bal-line"><b>${s.dinks}</b> Dinks</p>
      <p class="note">Fixed prices, looks only. An item never changes a game, a rating, a rank or who plays, and Dinks can't be bought with real money.</p>
      ${c.msg ? `<p class="note">${esc(c.msg)}</p>` : ''}${c.error ? `<p class="err">${esc(c.error)}</p>` : ''}
      ${wear ? `<h3 class="rw-h">What you wear</h3>${wear}` : ''}${share}
      <h3 class="rw-h">In the shop</h3>${rows || '<p class="note">You have everything in the shop.</p>'}${done}`;
  },
  // Open the shop sheet and load it. The sheet is the app's own club sheet (see renderClub).
  async openStore() {
    if (!rwShown() || !myName() || !myToken()) return;
    const c = clubSheet = { view: 'rwstore', store: null, msg: '', error: '', busy: false };
    renderClub();
    try { const d = await playerCall({ action: 'rewards-catalog', name: myName(), playerToken: myToken() }); if (clubSheet !== c) return; c.store = d; rwStoreSynced(d); }
    catch (err) { if (clubSheet !== c) return; c.error = err.message || "The shop couldn't load."; }
    renderClub();
  }
});

// The card, the ring, the paddle colour and the club looks map follow the server's answer.
function rwStoreSynced(d) { rwSave(rwClean(Object.assign({}, rwCur(), { dinks: d.dinks, worn: d.worn }))); if (typeof rwSetOwnLook === 'function') rwSetOwnLook(myName(), d.worn, !!d.share); rwRedrawClub(); }

async function rwStoreAct(body, say, focus) {
  const c = clubSheet;
  if (!c || c.view !== 'rwstore' || !c.store || c.busy) return;
  c.busy = true; c.error = ''; c.msg = ''; renderClub();
  try { const d = await playerCall(Object.assign({ name: myName(), playerToken: myToken() }, body)); if (clubSheet !== c) return; c.store = d; c.msg = say(d); rwStoreSynced(d); announce(c.msg); }
  catch (err) { if (clubSheet !== c) return; c.error = err.message; announce(err.message); }
  c.busy = false; renderClub();
  const f = document.querySelector(focus); if (f) f.focus(); // the sheet is redrawn, so put the focus back where the person was
}

document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-rw="store"], [data-rw-buy], [data-rw-wear], [data-rw-share]');
  if (!t) return;
  if (t.dataset.rw === 'store') { Rewards.openStore(); return; }
  const c = clubSheet;
  if (!c || c.view !== 'rwstore' || !c.store) return;
  if (t.dataset.rwShare !== undefined) {
    const share = t.dataset.rwShare === '1';
    rwStoreAct({ action: 'rewards-share', share }, d => (d.share ? 'Your worn look is now shown to the club.' : 'Your worn look is now hidden from the club.'), '[data-rw-share]');
    return;
  }
  if (t.dataset.rwBuy) {
    const it = c.store.items.find(i => i.id === t.dataset.rwBuy);
    if (!it || it.owned) return;
    // The server decides; this only saves a trip when the balance obviously doesn't reach.
    if (c.store.dinks < it.price) { c.error = rwShort(it.name, it.price) + c.store.dinks + '.'; c.msg = ''; announce(c.error); renderClub(); return; }
    rwStoreAct({ action: 'rewards-buy', item: it.id }, () => `${it.name} is yours for ${it.price} Dinks. Choose it under What you wear.`, '#club-h');
    return;
  }
  const [slot, id] = t.dataset.rwWear.split(':');
  const it = c.store.items.find(i => i.id === id);
  rwStoreAct({ action: 'rewards-wear', slot, item: id }, () => (it ? `Now wearing ${it.name}.` : slot === 'frame' ? 'No ring around your picture.' : 'Paddle thumbnails back to plain.'), `[data-rw-wear="${slot}:${id}"]`);
});
