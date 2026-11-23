/* ---------- rewards season pass: free play track per club season (L16 slice 5; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// Progress and tiers are derived on the server (api/_economypass.js, players.js rewards-pass|rewards-pass-claim) from games saved by this
// player's verified phone in the current club season. Free only: no paid tier, no real money, no countdown pressure, no randomness, no motion
// or sound, and never reads or changes a score, rating, rank or pairing. Reachable from the Your Dink card (so the one-tap hide removes it).
const rwPassRewardText = t => {
  if (t.item && t.item.owned && !t.claimed) return `+${t.payoutDinks} Dinks`;
  if (t.item) return `${t.item.name} + ${t.dinks} Dinks`;
  return `+${t.dinks} Dinks`;
};
const rwPassMaxGames = p => (p && Array.isArray(p.tiers) && p.tiers.length ? p.tiers[p.tiers.length - 1].games : 1);

Object.assign(Rewards, {
  passHTML(c) {
    const p = c.pass, done = '<div class="btns"><button type="button" class="btn btn-soft" data-rw="store">Shop</button><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>';
    const head = '<h2 id="club-h" tabindex="-1">Season pass</h2>';
    if (!rwShown()) return `${head}<p class="note">Rewards are hidden on this phone.</p><div class="btns"><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>`;
    if (!p) return `${head}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p><button type="button" class="btn btn-ink" data-rw="pass">Try again</button>` : skel(3)}<div class="btns"><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>`;
    const maxG = rwPassMaxGames(p), pct = Math.min(100, Math.round((Math.min(p.games, maxG) / maxG) * 100));
    const summary = `<section class="rw-pass-head" aria-label="Season pass progress">
      <div class="rw-pass-top"><span class="rw-pass-season">${esc(p.season.name)}</span><span class="rw-pass-free">Free track</span></div>
      <div class="rw-top">
        <span class="rw-day"><span><b>${p.games}</b><small>${p.games === 1 ? 'Game this season' : 'Games this season'}</small></span></span>
        <span class="rw-bal"><b>${p.dinks}</b><small>Dinks</small></span>
      </div>
      <div class="rw-bar" role="progressbar" aria-label="Season pass progress" aria-valuemin="0" aria-valuemax="${maxG}" aria-valuenow="${Math.min(p.games, maxG)}"><span style="width:${pct}%"></span></div>
      <p class="rw-fine">Free reward track filled by games you save this season. No paid tier, no real money, and it never changes a game, a rating or a rank.</p>
    </section>`;
    const rows = p.tiers.map(t => {
      const stateCls = t.claimed ? ' is-done' : t.unlocked ? ' is-ready' : '';
      const sw = t.item ? rwSwatch(t.item) : '';
      const label = rwPassRewardText(t);
      const ownedNote = t.item && t.item.owned && !t.claimed ? `You already own ${t.item.name} — Dinks instead. ` : '';
      const need = !t.unlocked ? ` · ${t.games - p.games} more` : '';
      const sub = `${ownedNote}${t.games} ${t.games === 1 ? 'game' : 'games'}${need}`;
      const right = t.claimed
        ? '<span class="rw-pill is-done">Claimed</span>'
        : t.unlocked
          ? `<button type="button" class="btn btn-ink rw-claim" data-rw-claim="${t.tier}" aria-label="Claim tier ${t.tier}: ${esc(label)}" ${c.busy ? 'disabled' : ''}>Claim</button>`
          : `<span class="rw-pill">${p.games}/${t.games}</span>`;
      return `<li class="rw-ptier${stateCls}"><span class="rw-tnum">Tier ${t.tier}</span>${sw}<span class="rw-name"><b>${esc(label)}</b><small>${esc(sub)}</small></span>${right}</li>`;
    }).join('');
    return `${head}${summary}
      ${c.msg ? `<p class="note">${esc(c.msg)}</p>` : ''}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
      <ol class="rw-ptiers">${rows}</ol>${done}`;
  },
  async openPass() {
    if (!rwShown() || !myName() || !myToken()) return;
    const c = clubSheet = { view: 'rwpass', pass: null, msg: '', error: '', busy: false };
    renderClub();
    try { const d = await playerCall({ action: 'rewards-pass', name: myName(), playerToken: myToken() }); if (clubSheet !== c) return; c.pass = d; rwStoreSynced(d); }
    catch (err) { if (clubSheet !== c) return; c.error = err.message || "The season pass couldn't load."; }
    renderClub();
  }
});

async function rwPassClaim(tier) {
  const c = clubSheet;
  if (!c || c.view !== 'rwpass' || !c.pass || c.busy) return;
  const itemBefore = c.pass.tiers.find(t => t.tier === tier);
  c.busy = true; c.error = ''; c.msg = ''; renderClub();
  try {
    const d = await playerCall({ action: 'rewards-pass-claim', name: myName(), playerToken: myToken(), tier, seasonId: c.pass.season.id });
    if (clubSheet !== c) return;
    c.pass = d;
    if (!d.claimed) c.msg = `Tier ${tier} was already claimed.`;
    else if (d.granted) c.msg = `Tier ${tier} claimed: ${d.granted.name} and +${d.gained} Dinks. Wear it in the Shop.`;
    else if (itemBefore && itemBefore.item && itemBefore.item.owned) c.msg = `Tier ${tier} claimed: +${d.gained} Dinks (you already own ${itemBefore.item.name}).`;
    else c.msg = `Tier ${tier} claimed: +${d.gained} Dinks. You now have ${d.dinks} Dinks.`;
    rwStoreSynced(d);
    announce(c.msg);
  } catch (err) {
    if (clubSheet !== c) return;
    c.error = err.message || "Couldn't claim that tier.";
    announce(c.error);
  }
  c.busy = false; renderClub();
  const h = document.querySelector('#club-h'); if (h) h.focus();
}

document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-rw="pass"], [data-rw-claim]');
  if (!t) return;
  if (t.dataset.rw === 'pass') { Rewards.openPass(); return; }
  const tier = Number(t.dataset.rwClaim);
  if (Number.isInteger(tier) && tier > 0) rwPassClaim(tier);
});
