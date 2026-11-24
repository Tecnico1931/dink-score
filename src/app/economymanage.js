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
  try { await call(); if (clubSheet !== c) return; c.msg = say; announce(say); }
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

document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-rw="manage"], [data-rw-mg-save], [data-rw-mg-reset], [data-rw-mg-release]');
  if (!t) return;
  if (t.dataset.rw === 'manage') { Rewards.openManage(); return; }
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
