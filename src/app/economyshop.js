/* ---------- rewards shop: fixed-price cosmetics and optional mystery box bought with Dinks (L16, #107; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// The catalogue, every price, mystery box odds and what you own are the server's (api/_economyshop.js, api/_economybox.js, players.js
// rewards-catalog|buy|wear|share|box-odds|box-open); this phone draws what it is told and never sets a price or draws a random item.
// Cosmetic only: a ring around your picture and a colour on your paddle thumbnails. Nothing here animates or makes a sound, and it never
// reads or changes a score, a rating, a rank or a pairing. Opened from the Your Dink card (so the one-tap hide removes it too).
const RW_SLOTS = [['frame', 'Ring around your picture'], ['paddle', 'Paddle thumbnails'], ['pet', 'Court pet']];
const rwSwatch = it => it.slot === 'frame'
  ? `<span class="rw-sw" data-rw-frame="${esc(rwLook(it.id))}" aria-hidden="true">${esc(initials(myName() || '?'))}</span>`
  : it.slot === 'pet'
    ? `<span class="rw-sw" aria-hidden="true">${esc(initials(it.name))}</span>`
    : `<span class="rw-sw pad" data-rw-skin="${esc(rwLook(it.id))}" aria-hidden="true">${iconSvg('paddle')}</span>`;
const rwShort = (n, price) => `Not enough Dinks yet: ${n} costs ${price} and you have `;
let rwBoxSeq = 0;
// Idempotency key for one box-open request only; the server chooses the item with its own cryptographic random source.
const rwBoxOpenId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID().replace(/-/g, '')
  : 'b' + Date.now().toString(36) + '_' + (++rwBoxSeq).toString(36) + '00000000').slice(0, 32);

function rwBoxHTML(c, s) {
  if (typeof rwBoxOn !== 'function' || !rwBoxOn() || !s.box || !Array.isArray(s.box.tiers) || !s.box.tiers.length) return '';
  const b = s.box, opened = Number(b.openedToday) || 0, limit = Number(b.dailyLimit) || 3, atLimit = opened >= limit;
  const need = Math.max(0, b.price - s.dinks), r = c.boxResult;
  const tiers = b.tiers.map(t => `<li class="rw-tier"><div class="rw-tier-top"><b>${esc(t.label)}</b><span class="rw-pct num">${t.chance}% (${t.chance} in 100)</span></div><p class="rw-tier-items">${esc((t.items || []).map(i => i.name).join(', '))}</p></li>`).join('');
  const res = r && r.item ? `<div class="rw-box-res" role="status">${rwSwatch(r.item)}<span><b>${esc(r.item.name)}${r.duplicate ? ' (already owned)' : ''}</b><small>${esc(r.tier && r.tier.label ? `${r.tier.label} (${r.tier.chance}%). ` : '')}${r.duplicate ? `${r.refund} Dinks returned to your balance.` : 'Added to What you wear.'}</small></span></div>` : '';
  const btnLabel = atLimit ? `Daily limit reached (${opened} of ${limit} today)` : `Open mystery box (${b.price} Dinks)`;
  return `<h3 class="rw-h">Mystery box</h3><section class="rw-box" aria-label="Mystery box">
    <div class="rw-box-top"><span class="rw-box-cost"><b class="num">${b.price}</b> Dinks</span><span class="rw-box-cap">${opened} of ${limit} opened today</span></div>
    <p class="rw-box-note">Grants one cosmetic look from the shop, chosen at random on the server. Free play money only — never bought with real money, and never changes a game, a rating, a rank or who plays.</p>
    <div class="rw-rates"><p class="rw-rates-h">Odds before you open</p><ul class="rw-tier-list">${tiers}</ul>
    <p class="rw-box-fine">Duplicate refund: if you already own the item drawn, ${b.duplicateRefund} Dinks are returned to your balance right away. Limit: ${limit} per day (UTC). No pity timer, countdown or streak bonus.</p></div>
    ${res}
    <button type="button" class="btn btn-court block" data-rw-box-open="1" ${c.busy || atLimit ? 'disabled' : ''}>${esc(btnLabel)}</button>
    ${!atLimit && need > 0 ? `<p class="rw-box-fine">You need ${need} more ${need === 1 ? 'Dink' : 'Dinks'} to open a mystery box.</p>` : ''}
  </section>`;
}

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
    const box = rwBoxHTML(c, s);
    return `${head}<p class="rw-bal-line"><b>${s.dinks}</b> Dinks</p>
      <p class="note">Fixed prices, looks only. An item never changes a game, a rating, a rank or who plays, and Dinks can't be bought with real money.</p>
      ${c.msg ? `<p class="note">${esc(c.msg)}</p>` : ''}${c.error ? `<p class="err">${esc(c.error)}</p>` : ''}
      ${wear ? `<h3 class="rw-h">What you wear</h3>${wear}` : ''}${share}${box}
      <h3 class="rw-h">In the shop</h3>${rows || '<p class="note">You have everything in the shop.</p>'}${done}`;
  },
  // Open the shop sheet and load it. The sheet is the app's own club sheet (see renderClub).
  async openStore() {
    if (!rwShown() || !myName() || !myToken()) return;
    const c = clubSheet = { view: 'rwstore', store: null, msg: '', error: '', busy: false, boxResult: null, pendingOpenId: '' };
    renderClub();
    try { const d = await playerCall({ action: 'rewards-catalog', name: myName(), playerToken: myToken() }); if (clubSheet !== c) return; c.store = d; rwStoreSynced(d); }
    catch (err) { if (clubSheet !== c) return; c.error = err.message || "The shop couldn't load."; }
    renderClub();
  }
});

// The card, the ring, the paddle colour, the court pet and the club looks map follow the server's answer.
function rwStoreSynced(d) { rwSave(rwClean(Object.assign({}, rwCur(), { dinks: d.dinks, worn: d.worn }))); if (typeof rwSetOwnLook === 'function') rwSetOwnLook(myName(), d.worn, !!d.share, d.pet); rwRedrawClub(); }

async function rwStoreAct(body, say, focus) {
  const c = clubSheet;
  if (!c || c.view !== 'rwstore' || !c.store || c.busy) return;
  c.busy = true; c.error = ''; c.msg = ''; renderClub();
  try {
    const d = await playerCall(Object.assign({ name: myName(), playerToken: myToken() }, body));
    if (clubSheet !== c) return;
    c.store = d;
    if (body.action === 'rewards-box-open') { c.pendingOpenId = ''; c.boxResult = d.result || null; }
    c.msg = say(d);
    rwStoreSynced(d);
    announce(c.msg);
  } catch (err) {
    if (clubSheet !== c) return;
    if (body.action === 'rewards-box-open' && !err.offline) c.pendingOpenId = '';
    c.error = err.message;
    announce(err.message);
  }
  c.busy = false; renderClub();
  const f = document.querySelector(focus); if (f) f.focus(); // the sheet is redrawn, so put the focus back where the person was
}

document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-rw="store"], [data-rw-buy], [data-rw-wear], [data-rw-share], [data-rw-box-open]');
  if (!t) return;
  if (t.dataset.rw === 'store') { Rewards.openStore(); return; }
  const c = clubSheet;
  if (!c || c.view !== 'rwstore' || !c.store) return;
  if (t.dataset.rwBoxOpen) {
    const b = c.store.box;
    if (typeof rwBoxOn !== 'function' || !rwBoxOn() || !b || c.busy) return;
    if ((Number(b.openedToday) || 0) >= (Number(b.dailyLimit) || 3)) {
      c.error = `Daily limit reached: you have opened ${b.dailyLimit} mystery boxes today. Try again tomorrow.`; c.msg = ''; announce(c.error); renderClub(); return;
    }
    if (c.store.dinks < b.price) {
      c.error = rwShort('a mystery box', b.price) + c.store.dinks + '.'; c.msg = ''; announce(c.error); renderClub(); return;
    }
    if (!c.pendingOpenId) c.pendingOpenId = rwBoxOpenId();
    rwStoreAct({ action: 'rewards-box-open', openId: c.pendingOpenId }, d => {
      const r = d && d.result;
      if (!r || !r.item) return 'Mystery box opened.';
      const tLabel = r.tier && r.tier.label ? ` (${r.tier.label})` : '';
      return r.duplicate
        ? `Mystery box: ${r.item.name}${tLabel}, already owned. ${r.refund} Dinks returned to your balance.`
        : `Mystery box: ${r.item.name}${tLabel}. Added to What you wear.`;
    }, '#club-h');
    return;
  }
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
  rwStoreAct({ action: 'rewards-wear', slot, item: id }, () => (it ? `Now wearing ${it.name}.` : slot === 'frame' ? 'No ring around your picture.' : slot === 'paddle' ? 'Paddle thumbnails back to plain.' : 'No court pet worn.'), `[data-rw-wear="${slot}:${id}"]`);
});
