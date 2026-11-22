/* ---------- rewards: a daily play streak and free Dinks (L16 slice 1; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// Play money only: no purchase path, nothing is sold, nothing converts to anything. Off until an organizer switches it on for the club
// (clubs.rewards via club.js set-rewards); each player can hide it all on their own phone. Slice 2: the balance and streak are the server's
// append-only ledger (api/_economy.js, players.js rewards-sync), worked out from the games this phone's linked name saved; this phone only
// keeps the last synced value (localStorage pb.rewards, by club) so the card works offline. It never reads or changes a score, a rating, a
// rank or a pairing.
const RW_BONUS = [[3, 2], [7, 5], [14, 10], [30, 25]]; // streak day -> bonus Dinks; after day 30, every 30th day pays the day-30 bonus again
const rwDayKey = d => { const x = d instanceof Date ? d : new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const rwDayNum = k => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }; // calendar days, so a clock change never adds or drops one
const rwClean = s => { const n = v => (Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 1e6) : 0); s = s && typeof s === 'object' ? s : {};
  return { streak: n(s.streak), best: n(s.best), dinks: n(s.dinks), last: typeof s.last === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.last) ? s.last : '' }; };
const rwBonusFor = day => { const hit = RW_BONUS.find(b => b[0] === day); return hit ? hit[1] : day > 30 && day % 30 === 0 ? RW_BONUS[RW_BONUS.length - 1][1] : 0; };
// The streak as it stands on `today`: a run that missed yesterday and today is broken (0). Playing today or yesterday keeps it.
const rwStreak = (s, today) => (s.last && rwDayNum(today) - rwDayNum(s.last) <= 1 ? s.streak : 0);
// The next bonus ahead of `day`: { day, bonus, in } (days to go).
const rwNext = day => { let d = day + 1; while (!rwBonusFor(d)) d++; return { day: d, bonus: rwBonusFor(d), in: d - day }; };
// The last synced value per club. Slice 1 kept one flat state here (counted on this phone, so not trusted): it shows only until this club's
// first sync, which replaces it with the server's ledger.
const rwAll = () => { const a = store.get('pb.rewards', {}); return a && typeof a === 'object' && !('dinks' in a) && !('streak' in a) ? a : { _legacy: a }; };
let rwState = rwClean({}), rwCode = null;
const rwCur = () => { const c = club && club.code; if (c !== rwCode) { rwCode = c; const all = rwAll(); rwState = rwClean(all[c] || all._legacy); } return rwState; };
const rwHidden = () => !!store.get('pb.rewardsHide', false);
const rwClubOn = () => !!(club && club.rewards);
const rwShown = () => rwClubOn() && !rwHidden();
const rwFlame = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12.5 2.5c.4 3-1.3 4.6-2.9 6.4C8 10.7 6.5 12.6 6.5 15.2a5.5 5.5 0 0 0 11 0c0-2.2-1-3.9-2.2-5.2-.2 1.2-.7 2-1.5 2.5.5-3.5-.2-7.3-1.3-10z"/></svg>';

let rwBusy = false, rwAt = 0;
const Rewards = {
  // Ask the server for the balance (it first adds what the games this name saved have earned). After a game reaches the server, and when the
  // club is opened (at most every 5 minutes). Needs the club switch on and a name linked to this phone; offline, the last value stays.
  async sync(force) {
    const code = club && club.code;
    if (!rwClubOn() || rwBusy || !myName() || !myToken() || (!force && Date.now() - rwAt < 3e5)) return;
    rwBusy = true; rwAt = Date.now();
    try {
      const d = await playerCall({ action: 'rewards-sync', name: myName(), playerToken: myToken(), tz: -new Date().getTimezoneOffset() });
      if (!club || club.code !== code || !d || typeof d.dinks !== 'number') return;
      const next = rwClean(d), changed = JSON.stringify(next) !== JSON.stringify(rwCur());
      const all = rwAll(); delete all._legacy; all[code] = next; store.set('pb.rewards', all); rwState = next;
      if (d.gained > 0 && !rwHidden()) announce(`${d.gained} ${d.gained === 1 ? 'Dink' : 'Dinks'} added. Day ${next.streak} of your streak.`);
      if (changed && !rwHidden()) render();
    } catch { /* offline or off: keep the last value */ } finally { rwBusy = false; }
  },
  // The small flame on the avatar: the streak when it is 2 or more days.
  flameHTML() {
    const n = rwShown() ? rwStreak(rwCur(), rwDayKey(Date.now())) : 0;
    return n >= 2 ? `<span class="rw-flame" aria-hidden="true">${rwFlame}<b>${n}</b></span>` : '';
  },
  label() { const n = rwShown() ? rwStreak(rwCur(), rwDayKey(Date.now())) : 0; return n >= 2 ? `. ${n} day play streak` : ''; },
  // "Your Dink" card on the Play tab.
  cardHTML() {
    if (!rwShown()) return '';
    const st = rwCur(), today = rwDayKey(Date.now()), day = rwStreak(st, today), done = st.last === today, nx = rwNext(day);
    const line = !myName() || !myToken() ? 'Pick your name in the club to start earning Dinks.' : done ? `Played today. ${nx.in === 1 ? 'Play tomorrow' : `Play ${nx.in} days in a row`} for +${nx.bonus} Dinks on day ${nx.day}.` : day ? `Play today to keep your ${day} day streak.` : 'Play a game today to start a streak.';
    return `<section class="card rw-card" aria-label="Your Dink"><div class="rw-top"><span class="rw-day">${rwFlame}<span><b>${day}</b><small>${day === 1 ? 'Day' : 'Days'}</small></span></span><span class="rw-bal"><b>${st.dinks}</b><small>Dinks</small></span></div><p class="rw-line">${esc(line)}</p><p class="rw-fine">Free play money. It can't be bought or cashed out, and it never changes a game or a rating.</p><button type="button" class="rw-hide" data-rw="hide">Hide this</button></section>`;
  },
  // The "You" sheet row: the one switch on this phone (shown only where the club has rewards on).
  youRowHTML() {
    if (!rwClubOn()) return '';
    return `<button type="button" class="you-row" data-rw="${rwHidden() ? 'show' : 'hide'}"><span><b>${rwHidden() ? 'Show my daily streak' : 'Hide my daily streak'}</b><small>${rwHidden() ? 'Your Dink card and flame come back' : 'Hides the streak, the flame and Dinks on this phone'}</small></span><span class="chev" aria-hidden="true">›</span></button>`;
  }
};

async function rwSetClub(on) {
  try { await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'set-rewards', on }, adminCreds())) }); await refreshClub(); renderClub(); render(); announce(on ? 'Rewards are on for this club.' : 'Rewards are off for this club.'); }
  catch (err) { showToast(err.message, false); }
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-rw]');
  if (!b) return;
  const a = b.dataset.rw;
  if (a === 'club') { rwSetClub(!rwClubOn()); return; }
  if (a === 'hide' || a === 'show') { store.set('pb.rewardsHide', a === 'hide'); render(); if (typeof clubSheet !== 'undefined' && clubSheet) renderClub(); announce(a === 'hide' ? 'Daily streak hidden on this phone.' : 'Daily streak shown.'); }
});
