/* ---------- Manage shop (WI-3): the organizer's sheet for this club's prices, the rewards switch and linked names ---------- */
// Organizer only (otCan). Prices are the server's: this phone shows what api/_economyprices.js returns and sends the numbers typed here to
// players.js rewards-prices|rewards-prices-save, which checks the organizer again and clamps them. Nothing here reads a score or a rating.
const rwMgCan = () => typeof otCan === 'function' && otCan();
const rwMgDone = '<button type="button" class="btn btn-soft" data-act="club-close">Done</button>';

Object.assign(Rewards, {
  manageHTML(c) {
    const head = '<h2 id="club-h" tabindex="-1">Manage shop</h2>', d = c.data;
    if (!rwMgCan()) return `${head}<p class="note">Only organizers can change the shop.</p><div class="btns">${rwMgDone}</div>`;
    if (!d) return `${head}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p><button type="button" class="btn btn-ink" data-rw="manage">Try again</button>` : skel(3)}<div class="btns">${rwMgDone}</div>`;
    const rows = d.items.map(i => {
      const v = c.draft && i.id in c.draft ? c.draft[i.id] : i.price, id = 'rw-mg-' + i.id;
      return `<div class="rw-mg-row"><label for="${esc(id)}"><b>${esc(i.name)}</b><small>${esc(i.group)}${i.price !== i.default ? ` · usually ${i.default}` : ''}</small></label><input id="${esc(id)}" class="rw-mg-in num" type="number" inputmode="numeric" min="${d.min}" max="${d.max}" step="1" value="${esc(v)}" data-rw-price="${esc(i.id)}" ${c.busy ? 'disabled' : ''}></div>`;
    }).join('');
    const linked = (c.members || []).map(m => `<li class="rw-mg-name"><span>${esc(m.name)}</span><button type="button" class="link" data-rw-mg-release="${esc(m.name)}" ${c.busy ? 'disabled' : ''}>${c.confirmRelease === m.name ? 'Tap again to release' : 'Release'}</button></li>`).join('');
    const custom = d.items.some(i => i.price !== i.default);
    return `${head}${c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : ''}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
      <label class="rw-mg-switch"><input type="checkbox" data-rw-mg-club ${d.rewards ? 'checked' : ''} ${c.busy ? 'disabled' : ''}><span>Club rewards in the shop</span></label>
      <h3 class="rw-h">Item prices (Dinks)</h3>${rows}
      <div class="rw-mg-save"><button type="button" class="btn btn-court block" data-rw-mg-save="1" ${c.busy ? 'disabled' : ''}>Save shop</button>${custom ? `<button type="button" class="btn btn-soft block" data-rw-mg-reset="1" ${c.busy ? 'disabled' : ''}>Put every price back to usual</button>` : ''}</div>
      <h3 class="rw-h">Names linked to phones</h3>${linked ? `<ul class="rw-mg-names">${linked}</ul>` : '<p class="note">No names are linked to a phone yet.</p>'}
      <p class="note">Release a name if someone changed phones or picked the wrong one. Their Dinks and items stay with the name.</p>
      <div class="btns">${rwMgDone}</div>`;
  },
  // "Boost events and gifts" (M11): the organizer's sheet to double game rewards for a while, give or take Dinks with a reason, gift an item and let
  // a player spin again. Every number is checked again by players.js (rewards-adjust | -gift | -spin-reset | -boost*); this only draws and sends.
  toolsHTML(c) {
    const head = '<h2 id="club-h" tabindex="-1">Boost events and gifts</h2>', d = c.data;
    if (!rwMgCan()) return `${head}<p class="note">Only organizers can use these.</p><div class="btns">${rwMgDone}</div>`;
    if (!d) return `${head}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p><button type="button" class="btn btn-ink" data-rw="tools">Try again</button>` : skel(3)}<div class="btns">${rwMgDone}</div>`;
    const f = c.f, b = d.boost || {}, off = c.busy ? 'disabled' : '', give = f.mode !== 'take';
    const who = (id, key, val) => `<label class="rw-goal" for="${id}"><span>Player</span><select id="${id}" data-rw-tl-f="${key}" ${off}><option value="">Pick a player</option>${d.names.map(n => `<option value="${esc(n)}"${n === val ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`;
    const live = b.active || b.upcoming;
    const boost = live
      ? `<p class="note" role="status"><b>${b.active ? 'Running' : 'Starts'}:</b> double Dinks${live.xp > 1 ? ' and double XP' : ''} ${b.active ? 'until' : 'from'} ${esc(Rewards.boostWhen(b.active ? live.until : live.from))}.</p><button type="button" class="btn btn-soft block" data-rw-tl="boost-end" ${off}>End the boost now</button>`
      : `<p class="note">Doubles what games pay and the daily limit, for everyone in the club. Days are UTC.</p><div class="rw-boost-btns">${[['today', 'Today'], ['weekend', 'This weekend'], ['1', '1 day'], ['3', '3 days'], ['7', '7 days']].map(([k, l]) => `<button type="button" class="btn btn-soft" data-rw-tl="boost" data-choice="${k}" ${off}>${l}</button>`).join('')}</div><label class="rw-mg-switch"><input type="checkbox" data-rw-tl-xp ${f.xp ? 'checked' : ''} ${off}><span>Double XP too</span></label>`;
    return `${head}${c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : ''}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
      <h3 class="rw-h">Boost event</h3>${boost}
      <h3 class="rw-h">Give or take Dinks</h3><div class="rw-tools-f">${who('rw-tl-who', 'who', f.who)}
        <label class="rw-goal" for="rw-tl-mode"><span>What</span><select id="rw-tl-mode" data-rw-tl-f="mode" ${off}><option value="give"${give ? ' selected' : ''}>Give Dinks</option><option value="take"${give ? '' : ' selected'}>Take Dinks back</option></select></label>
        <label class="rw-goal" for="rw-tl-amount"><span>How many (1 to 5000)</span><input id="rw-tl-amount" class="rw-mg-in" type="number" inputmode="numeric" min="1" max="5000" step="1" value="${esc(f.amount)}" data-rw-tl-f="amount" ${off}></label>
        <label class="rw-goal" for="rw-tl-reason"><span>Why (the player sees this)</span><input id="rw-tl-reason" class="rw-mg-in" type="text" maxlength="60" value="${esc(f.reason)}" data-rw-tl-f="reason" ${off}></label>
        <button type="button" class="btn btn-court block" data-rw-tl="adjust" ${off}>${give ? 'Give' : 'Take'} Dinks</button></div>
      <h3 class="rw-h">Gift an item</h3><div class="rw-tools-f">${who('rw-tl-gwho', 'gWho', f.gWho)}
        <label class="rw-goal" for="rw-tl-item"><span>Item</span><select id="rw-tl-item" data-rw-tl-f="gItem" ${off}><option value="">Pick an item</option>${[...new Set(d.items.map(i => i.group))].map(g => `<optgroup label="${esc(g)}">${d.items.filter(i => i.group === g).map(i => `<option value="${esc(i.id)}"${i.id === f.gItem ? ' selected' : ''}>${esc(i.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
        <button type="button" class="btn btn-court block" data-rw-tl="gift" ${off}>Gift it</button></div>
      ${d.mysteryBox ? `<h3 class="rw-h">Spin again</h3><div class="rw-tools-f">${who('rw-tl-swho', 'sWho', f.sWho)}<button type="button" class="btn btn-court block" data-rw-tl="spin" ${off}>Let them spin again today</button></div>` : ''}
      <p class="note">Everything here is logged. Give, take, gift and boost can be undone for 7 days under Members and roles.</p>
      <div class="btns">${rwMgDone}</div>`;
  },
  opId: () => 'o' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36), // one per tap: a retry after a dropped connection is the same change
  boostWhen: ms => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
  // How the organizer history words a rewards change (result-links.js falls back to this for actions it does not know). '' for anything else.
  auditText(a, t) {
    const d = a.detail || {}, n = x => `${x} ${x === 1 ? 'Dink' : 'Dinks'}`, why = d.reason ? ` (${d.reason})` : '';
    const span = { today: 'for today', weekend: 'for the weekend', 1: 'for 1 day', 3: 'for 3 days', 7: 'for 7 days' }[d.choice] || '';
    if (a.action === 'reward-give') return `gave ${n(d.amount)} to ${t}${why}`;
    if (a.action === 'reward-take') return `took ${n(d.amount)} back from ${t}${why}`;
    if (a.action === 'reward-gift') return `gifted ${d.itemName || 'an item'} to ${t}`;
    if (a.action === 'reward-spin-reset') return `let ${t} spin again`;
    if (a.action === 'boost') return `started a double rewards boost ${span}${d.xp ? ' with double XP' : ''}`.replace(/ +$/, '');
    if (a.action === 'boost-end') return 'ended the boost';
    if (a.action === 'undo' && /^(reward-|boost)/.test(d.undid || '')) return `undid ${{ 'reward-give': `giving Dinks to ${t}`, 'reward-take': `taking Dinks back from ${t}`, 'reward-gift': `the gift to ${t}`, boost: 'the boost' }[d.undid] || 'a change'}`;
    return '';
  },
  async openTools() {
    if (!rwMgCan()) return;
    const c = clubSheet = { view: 'rwtools', data: null, error: '', msg: '', busy: false, f: { who: '', mode: 'give', amount: '', reason: '', opId: '', gWho: '', gItem: '', sWho: '', xp: false } };
    renderClub();
    try {
      const [boost, prices, m] = await Promise.all(['rewards-boost', 'rewards-prices', 'members'].map(action => playerCall(Object.assign({ action }, adminCreds()))));
      if (clubSheet !== c) return;
      c.data = { boost, mysteryBox: !!prices.mysteryBox, items: prices.items.filter(i => i.id !== 'box'), names: m.members.map(x => x.name) };
    } catch (err) { if (clubSheet !== c) return; c.error = err.message || "This couldn't load."; }
    renderClub();
  },
  // Open the sheet and load the prices and the linked names (both organizer-only calls).
  async openManage() {
    if (!rwMgCan()) return;
    const c = clubSheet = { view: 'rwmanage', data: null, members: null, draft: {}, error: '', msg: '', busy: false, confirmRelease: '' };
    renderClub();
    try {
      const [d, m] = await Promise.all([
        playerCall(Object.assign({ action: 'rewards-prices' }, adminCreds())),
        playerCall(Object.assign({ action: 'members' }, adminCreds())).catch(() => null)
      ]);
      if (clubSheet !== c) return;
      c.data = d; c.members = m ? m.members.filter(x => x.claimed) : [];
    } catch (err) { if (clubSheet !== c) return; c.error = err.message || "The shop settings couldn't load."; }
    renderClub();
  }
});

async function rwMgAct(c, call, say, focus) {
  if (clubSheet !== c || c.busy) return;
  c.busy = true; c.error = ''; c.msg = ''; renderClub();
  try { await call(); if (clubSheet !== c) return; c.msg = typeof say === 'function' ? say() : say; announce(c.msg); }
  catch (err) { if (clubSheet !== c) return; c.error = err.message; announce(err.message); }
  c.busy = false; renderClub();
  const f = document.querySelector(focus); if (f) f.focus();
}

document.addEventListener('input', e => {
  const t = e.target, c = clubSheet;
  if (!t || !t.matches || !t.matches('input[data-rw-price]') || !c || c.view !== 'rwmanage') return;
  c.draft[t.dataset.rwPrice] = t.value; // kept as typed; the sheet is only redrawn after a save, so the field keeps the focus
});

document.addEventListener('change', e => {
  const t = e.target, c = clubSheet;
  if (!t || !t.matches || !t.matches('input[data-rw-mg-club]') || !c || c.view !== 'rwmanage' || !c.data || c.busy) return;
  const on = t.checked;
  rwMgAct(c, async () => {
    await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'set-rewards', on }, adminCreds())) });
    c.data.rewards = on; await refreshClub(); render();
  }, on ? 'Rewards are on for this club.' : 'Rewards are off for this club.', '[data-rw-mg-club]');
});

// Boost events and gifts sheet: remember what is typed (the sheet is only redrawn after an action, so a field keeps the focus).
document.addEventListener('input', e => {
  const t = e.target, c = clubSheet;
  if (t && t.matches && t.matches('input[data-rw-tl-f]') && c && c.view === 'rwtools') c.f[t.dataset.rwTlF] = t.value;
});
document.addEventListener('change', e => {
  const t = e.target, c = clubSheet;
  if (!t || !t.matches || !c || c.view !== 'rwtools' || !c.data || c.busy) return;
  if (t.matches('input[data-rw-tl-xp]')) { c.f.xp = t.checked; return; }
  if (!t.matches('select[data-rw-tl-f]')) return;
  c.f[t.dataset.rwTlF] = t.value;
  if (t.dataset.rwTlF === 'mode') { renderClub(); const f = document.getElementById('rw-tl-mode'); if (f) f.focus(); } // the button says Give or Take
});

const rwTl = n => `${n} ${n === 1 ? 'Dink' : 'Dinks'}`;
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-rw="manage"], [data-rw="tools"], [data-rw-tl], [data-rw-mg-save], [data-rw-mg-reset], [data-rw-mg-release]');
  if (!t) return;
  if (t.dataset.rw === 'manage') { Rewards.openManage(); return; }
  if (t.dataset.rw === 'tools') { Rewards.openTools(); return; }
  if (t.dataset.rwTl) {
    const c = clubSheet;
    if (!c || c.view !== 'rwtools' || !c.data || c.busy) return;
    const f = c.f, act = t.dataset.rwTl, bad = (msg, id) => { c.error = msg; c.msg = ''; announce(msg); renderClub(); const x = document.getElementById(id); if (x) x.focus(); };
    if (act === 'boost') { rwMgAct(c, async () => { c.data.boost = await playerCall(Object.assign({ action: 'rewards-boost-start', choice: t.dataset.choice, xp: !!f.xp }, adminCreds())); }, 'The boost is on.', '#club-h'); return; }
    if (act === 'boost-end') { rwMgAct(c, async () => { c.data.boost = await playerCall(Object.assign({ action: 'rewards-boost-end' }, adminCreds())); }, 'The boost has ended.', '#club-h'); return; }
    if (act === 'adjust') {
      const n = /^\d{1,4}$/.test(String(f.amount).trim()) ? Number(f.amount) : NaN, give = f.mode !== 'take', reason = String(f.reason).trim();
      if (!f.who) return bad('Pick a player.', 'rw-tl-who');
      if (!(n >= 1 && n <= 5000)) return bad('Enter a whole number of Dinks from 1 to 5000.', 'rw-tl-amount');
      if (!reason) return bad('Say why, in a few words. The player sees it.', 'rw-tl-reason');
      const opId = f.opId || (f.opId = Rewards.opId()), name = f.who;
      let r;
      rwMgAct(c, async () => { r = await playerCall(Object.assign({ action: 'rewards-adjust', name, mode: f.mode, amount: n, reason, opId }, adminCreds())); f.opId = ''; f.amount = ''; f.reason = ''; },
        () => `${r.replayed ? 'Already done: ' : ''}${give ? `Gave ${rwTl(n)} to` : `Took ${rwTl(n)} from`} ${r.name}. They now have ${rwTl(r.balance)}.`, '#club-h');
      return;
    }
    if (act === 'gift') {
      if (!f.gWho) return bad('Pick a player.', 'rw-tl-gwho');
      if (!f.gItem) return bad('Pick an item.', 'rw-tl-item');
      let r;
      rwMgAct(c, async () => { r = await playerCall(Object.assign({ action: 'rewards-gift', name: f.gWho, item: f.gItem }, adminCreds())); }, () => `${r.itemName} is now ${r.name}'s.`, '#club-h');
      return;
    }
    if (act === 'spin') {
      if (!f.sWho) return bad('Pick a player.', 'rw-tl-swho');
      let r;
      rwMgAct(c, async () => { r = await playerCall(Object.assign({ action: 'rewards-spin-reset', name: f.sWho }, adminCreds())); }, () => `${r.name} can spin again.`, '#club-h');
    }
    return;
  }
  const c = clubSheet;
  if (!c || c.view !== 'rwmanage' || !c.data || c.busy) return;
  if (t.dataset.rwMgSave) {
    const prices = {}, d = c.data;
    for (const i of d.items) {
      if (!(i.id in c.draft)) continue;
      const raw = String(c.draft[i.id]).trim(), n = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
      if (!(n >= d.min && n <= d.max)) { c.error = `${i.name}: enter a whole number from ${d.min} to ${d.max}.`; c.msg = ''; announce(c.error); renderClub(); const f = document.getElementById('rw-mg-' + i.id); if (f) f.focus(); return; }
      if (n !== i.price) prices[i.id] = n;
    }
    if (!Object.keys(prices).length) { c.draft = {}; c.msg = 'No prices changed.'; announce(c.msg); renderClub(); return; }
    rwMgAct(c, async () => { c.data = await playerCall(Object.assign({ action: 'rewards-prices-save', prices }, adminCreds())); c.draft = {}; }, 'Prices saved.', '#club-h');
    return;
  }
  if (t.dataset.rwMgReset) {
    rwMgAct(c, async () => { c.data = await playerCall(Object.assign({ action: 'rewards-prices-save', reset: true }, adminCreds())); c.draft = {}; }, 'Every price is back to usual.', '#club-h');
    return;
  }
  if (t.dataset.rwMgRelease) {
    const name = t.dataset.rwMgRelease;
    if (c.confirmRelease !== name) { c.confirmRelease = name; renderClub(); const f = [...document.querySelectorAll('[data-rw-mg-release]')].find(b => b.dataset.rwMgRelease === name); if (f) f.focus(); return; }
    c.confirmRelease = '';
    rwMgAct(c, async () => {
      await playerCall(Object.assign({ action: 'release', name }, adminCreds()));
      const m = await playerCall(Object.assign({ action: 'members' }, adminCreds()));
      if (clubSheet === c) c.members = m.members.filter(x => x.claimed);
    }, `${name} can now be picked on another phone.`, '#club-h');
  }
});
