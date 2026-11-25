/* ---------- rewards season pass: free XP track per club season (L16 slice 5, XP in WI-14; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// Progress and tiers are derived on the server (api/_economypass.js, players.js rewards-pass|rewards-pass-claim) from the XP of games saved by this
// player's verified phone in the current club season. Free only: no paid tier, no real money, no countdown, no randomness, no motion
// or sound, and never changes a score, rating, rank or pairing. Reachable from the Your Dink card (so the one-tap hide removes it).
const rwPassRewardText = t => {
  if (t.item && t.item.owned && !t.claimed) return `+${rwDinks(t.payoutDinks)}`;
  if (t.item) return `${t.item.name} + ${rwDinks(t.dinks)}`;
  return `+${rwDinks(t.dinks)}`;
};
const rwPassMaxXp = p => (p && p.maxXp > 0 ? p.maxXp : 1);

// The Season pass card on top of the shop (under the wallet, after Daily spin and Mystery box): season name, what is ready, one way into the full pass.
// Reads only the shop answer and the ready count already on the phone; the tiers load when it is opened.
function rwPassCardHTML(c, s) {
  const se = s && s.season, n = typeof rwReadyN === 'function' ? rwReadyN() : 0;
  const line = n > 0 ? `${n} ${n === 1 ? 'reward is' : 'rewards are'} ready to claim.` : 'Free XP track: 8 tiers, earned by playing this season.';
  return `<h3 class="rw-h">Season pass</h3><section class="rw-passcard" aria-label="Season pass"><div class="rw-pass-top"><b class="rw-box-title">${esc(se && se.name ? se.name : 'This season')}</b>${rwReadyTag(n) || '<span class="rw-pass-free">Free track</span>'}</div><p class="rw-box-rates">${esc(line)}</p><button type="button" class="btn ${n > 0 ? 'btn-court' : 'btn-soft'} block" data-rw="pass"${c.busy ? ' disabled' : ''}>${n > 0 ? 'Claim rewards' : 'View season pass'}</button></section>`;
}

Object.assign(Rewards, {
  passHTML(c) {
    const p = c.pass, done = '<div class="btns"><button type="button" class="btn btn-soft" data-rw="store">Shop</button><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>';
    const head = '<h2 id="club-h" tabindex="-1">Season pass</h2>';
    if (!rwShown()) return `${head}<p class="note">Rewards are hidden on this phone.</p><div class="btns"><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>`;
    if (!p) return `${head}${c.error ? `<p class="err" role="alert">${esc(c.error)}</p><button type="button" class="btn btn-ink" data-rw="pass">Try again</button>` : skel(3)}<div class="btns"><button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>`;
    const maxG = rwPassMaxXp(p), pct = Math.min(100, Math.round((Math.min(p.xp, maxG) / maxG) * 100));
    const nextT = p.tiers.find(t => !t.unlocked), toNext = nextT ? nextT.xp - p.xp : 0;
    const summary = `<section class="rw-pass-head" aria-label="Season pass progress">
      <div class="rw-pass-top"><span class="rw-pass-season">${esc(p.season.name)}</span><span class="rw-pass-free">Free track</span></div>
      <div class="rw-top">
        <span class="rw-day"><span><b>${p.xp}</b><small>/ ${maxG} season XP</small></span></span>
        <span class="rw-bal"><b>${p.dinks}</b><small>${p.dinks === 1 ? 'Dink' : 'Dinks'}</small></span>
      </div>
      <div class="rw-bar" role="progressbar" aria-label="Season pass progress" aria-valuemin="0" aria-valuemax="${maxG}" aria-valuenow="${Math.min(p.xp, maxG)}"><span style="width:${pct}%"></span></div>
      <p class="rw-fine">${nextT ? `${toNext} XP to tier ${nextT.tier}. ` : 'Every tier is unlocked. '}Season XP is the same XP as your level, from this season's games. These items can't be bought, and they're yours to keep in your inventory. No paid tier, no real money, and it never changes a game, a rating or a rank.</p>
    </section>`;
    const rows = p.tiers.map(t => {
      const stateCls = t.claimed ? ' is-done' : t.unlocked ? ' is-ready' : '';
      const sw = t.item ? rwSwatch(t.item) : '';
      const label = rwPassRewardText(t);
      const ownedNote = t.item && t.item.owned && !t.claimed ? `You already own ${t.item.name} — Dinks instead. ` : '';
      const need = !t.unlocked ? ` · ${t.xp - p.xp} more` : '';
      const sub = `${ownedNote}${t.xp} XP${need}`;
      const right = t.claimed
        ? '<span class="rw-pill is-done">Claimed</span>'
        : t.unlocked
          ? `<button type="button" class="btn btn-ink rw-claim" data-rw-claim="${t.tier}" aria-label="Claim tier ${t.tier}: ${esc(label)}" ${c.busy ? 'disabled' : ''}>Claim</button>`
          : `<span class="rw-pill">${Math.min(p.xp, t.xp)}/${t.xp}</span>`;
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
    try { const d = await playerCall({ action: 'rewards-pass', name: myName(), playerToken: myToken() }); if (clubSheet !== c) return; c.pass = d; rwSetLevel(d.level); rwSetReady(d.claimable); rwStoreSynced(d); }
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
    c.pass = d; rwSetLevel(d.level); rwSetReady(d.claimable);
    if (!d.claimed) c.msg = `Tier ${tier} was already claimed.`;
    else if (d.granted) c.msg = `Tier ${tier} claimed: ${d.granted.name} and +${rwDinks(d.gained)}. Wear it in the Shop.`;
    else if (itemBefore && itemBefore.item && itemBefore.item.owned) c.msg = `Tier ${tier} claimed: +${rwDinks(d.gained)} (you already own ${itemBefore.item.name}).`;
    else c.msg = `Tier ${tier} claimed: +${rwDinks(d.gained)}. You now have ${rwDinks(d.dinks)}.`;
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
