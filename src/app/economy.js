/* ---------- rewards: a daily play streak and free Dinks (L16 slice 1; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// Play money only: no purchase path, nothing is sold, nothing converts to anything. Off until an organizer switches it on for the club
// (clubs.rewards via club.js set-rewards); each player can hide it all on their own phone. Slice 2: the balance and streak are the server's
// append-only ledger (api/_economy.js, players.js rewards-sync), worked out from the games this phone's linked name saved; this phone only
// keeps the last synced value (localStorage pb.rewards, by club) so the card works offline. It never reads or changes a score, a rating, a
// rank or a pairing.
const RW_BONUS = [[3, 2], [7, 5], [14, 10], [30, 25]]; // streak day -> bonus Dinks; after day 30, every 30th day pays the day-30 bonus again
const rwDinks = n => `${n} ${n === 1 ? 'Dink' : 'Dinks'}`; // "1 Dink", "2 Dinks": the one place a count and its word are joined
const rwDayKey = d => { const x = d instanceof Date ? d : new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const rwDayNum = k => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }; // calendar days, so a clock change never adds or drops one
const rwId = v => (typeof v === 'string' && /^[a-z]{3,8}-[a-z]{3,12}$/.test(v) ? v : ''); // a worn item id, 'frame-court'
const rwLook = id => String(id || '').replace(/^[a-z]+-/, ''); // 'frame-court' -> 'court': the name the stylesheet draws
const rwKey = n => String(n || '').trim().replace(/\s+/g, ' ').normalize('NFC').toLowerCase();
const rwSlotId = (slot, v) => (typeof v === 'string' && new RegExp(`^${slot}-[a-z]{3,12}$`).test(v) ? v : '');
const rwCleanLooks = raw => {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = rwKey(k);
    if (!key || !v || typeof v !== 'object') continue;
    const frame = rwSlotId('frame', v.frame), paddle = rwSlotId('paddle', v.paddle), pet = rwSlotId('pet', v.pet);
    if (!frame && !paddle && !pet) continue;
    const entry = { frame, paddle };
    if (pet) {
      entry.pet = pet;
      entry.petStage = v.petStage === 2 || v.petStage === 3 ? v.petStage : 1;
      entry.petShiny = !!v.petShiny;
    }
    out[key] = entry;
  }
  return out;
};
const rwCleanPet = (p, wornPet) => {
  if (!p || typeof p !== 'object') return null;
  const id = rwSlotId('pet', p.id);
  if (!id || (wornPet && id !== wornPet)) return null;
  const stage = p.stage === 2 || p.stage === 3 ? p.stage : 1;
  const days = Number.isFinite(p.playDays) && p.playDays > 0 ? Math.min(Math.floor(p.playDays), 1e5) : 0;
  const next = p.nextStageDays === 5 || p.nextStageDays === 15 ? p.nextStageDays : null;
  return { id, stage, playDays: days, nextStageDays: next, shiny: !!p.shiny, featuredShiny: !!p.featuredShiny };
};
const rwClean = s => { const n = v => (Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 1e6) : 0); s = s && typeof s === 'object' ? s : {}; const w = s.worn && typeof s.worn === 'object' ? s.worn : {};
  const worn = { frame: rwId(w.frame), paddle: rwId(w.paddle), pet: rwId(w.pet) };
  const pet = rwCleanPet(s.pet, worn.pet);
  const out = { streak: n(s.streak), best: n(s.best), dinks: n(s.dinks), last: typeof s.last === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.last) ? s.last : '', worn };
  if (pet) out.pet = pet;
  return out; };
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
const rwBoxOn = () => rwClubOn() && !!(club && club.mysteryBox);
const rwShown = () => rwClubOn() && !rwHidden();
// Keep the synced state (and this phone's worn items) in one place. The worn ring and paddle colour are two attributes on <html> that the
// stylesheet draws, set only while rewards are shown here, so the one-tap hide and a club with rewards off remove them.
const rwSave = (next, code = club && club.code) => { const all = rwAll(); delete all._legacy; all[code] = next; store.set('pb.rewards', all); rwState = next; rwApplyLook(); };
function rwApplyLook() {
  const r = document.documentElement; if (!r) return;
  const w = rwShown() ? rwCur().worn : {};
  for (const [slot, attr] of [['frame', 'data-rw-frame'], ['paddle', 'data-rw-skin']]) { const v = rwLook(w[slot]); if (v) r.setAttribute(attr, v); else r.removeAttribute(attr); }
}
const rwFlame = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12.5 2.5c.4 3-1.3 4.6-2.9 6.4C8 10.7 6.5 12.6 6.5 15.2a5.5 5.5 0 0 0 11 0c0-2.2-1-3.9-2.2-5.2-.2 1.2-.7 2-1.5 2.5.5-3.5-.2-7.3-1.3-10z"/></svg>';

let rwBusy = false, rwAt = 0, rwLooksBusy = false, rwLooksAt = 0, rwLooksCode = null;
const rwLooksByClub = Object.create(null);
const rwClubLooks = () => (club && club.code && rwLooksByClub[club.code]) || null;
const rwSetOwnLook = (name, worn, share, petInfo) => {
  const code = club && club.code, key = rwKey(name);
  if (!code || !key) return;
  const map = rwLooksByClub[code] || (rwLooksByClub[code] = Object.create(null));
  const frame = share ? rwSlotId('frame', worn && worn.frame) : '', paddle = share ? rwSlotId('paddle', worn && worn.paddle) : '', pet = share ? rwSlotId('pet', worn && worn.pet) : '';
  if (frame || paddle || pet) {
    const entry = { frame, paddle };
    if (pet) {
      entry.pet = pet;
      entry.petStage = petInfo && (petInfo.stage === 2 || petInfo.stage === 3) ? petInfo.stage : 1;
      entry.petShiny = !!(petInfo && petInfo.shiny);
    }
    map[key] = entry;
  } else delete map[key];
};
const rwRedrawClub = () => {
  render();
  if (typeof renderProfile === 'function') renderProfile();
  if (typeof clubSheet !== 'undefined' && clubSheet && clubSheet.view === 'members' && typeof renderClub === 'function') renderClub();
};
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
      rwSave(next, code);
      if (d.gained > 0 && !rwHidden()) announce(`${rwDinks(d.gained)} added. Day ${next.streak} of your streak.`);
      if (changed && !rwHidden()) render();
    } catch { /* offline or off: keep the last value */ } finally { rwBusy = false; }
  },
  // Fetch the club's opt-in worn looks (allow-listed item ids only; never balance, streak or history). Skipped when rewards are off or hidden.
  async syncLooks(force) {
    const code = club && club.code;
    if (!rwShown() || !code || rwLooksBusy || (!force && rwLooksCode === code && Date.now() - rwLooksAt < 3e4)) return;
    rwLooksBusy = true; rwLooksAt = Date.now(); rwLooksCode = code;
    try {
      const d = await playerCall({ action: 'rewards-looks' });
      if (!club || club.code !== code || !d || !d.looks) return;
      const next = rwCleanLooks(d.looks), prev = rwLooksByClub[code] || {};
      if (JSON.stringify(next) !== JSON.stringify(prev)) { rwLooksByClub[code] = next; if (rwShown()) rwRedrawClub(); }
    } catch { /* offline or off: keep the last value */ } finally { rwLooksBusy = false; }
  },
  // One member's shared worn look ({frame, paddle, pet?, petStage?, petShiny?} with prefix stripped), or null when rewards are off, hidden, or unshared.
  lookOf(name) {
    if (!rwShown() || !name) return null;
    const map = rwClubLooks(), hit = map && map[rwKey(name)];
    if (!hit) return null;
    const frame = rwLook(hit.frame), paddle = rwLook(hit.paddle), pet = rwLook(hit.pet);
    if (!frame && !paddle && !pet) return null;
    return pet ? { frame, paddle, pet, petStage: hit.petStage === 2 || hit.petStage === 3 ? hit.petStage : 1, petShiny: !!hit.petShiny } : { frame, paddle };
  },
  frameAttr(name) { const l = Rewards.lookOf(name); return l && l.frame ? ` data-rw-frame="${esc(l.frame)}"` : ''; },
  paddleBadgeHTML(name) {
    const l = Rewards.lookOf(name);
    return l && l.paddle && typeof iconSvg === 'function' ? `<span class="rw-pad" data-rw-skin="${esc(l.paddle)}" aria-hidden="true">${iconSvg('paddle')}</span>` : '';
  },
  // The worn pet next to a name on Leaderboard, Roster and Profile only (never game cards): pet id, growth stage and shiny flag from the allow-list, nothing else.
  petBadgeHTML(name) {
    const l = Rewards.lookOf(name);
    if (!l || !l.pet || typeof rwPetBadgeHTML !== 'function') return '';
    const b = rwPetBadgeHTML(l.pet, { stage: l.petStage, shiny: l.petShiny, decorative: false, size: 20 });
    return b.replace('class="rw-pet sm"', 'class="rw-pet sm rw-pet-club"');
  },
  // Team names on a game card: plain text unless a player in this team shares a worn ring or paddle colour (pets never appear on game cards).
  teamHTML(players) {
    const list = Array.isArray(players) ? players : [];
    const fallback = () => (typeof teamLabel === 'function' ? esc(teamLabel(list)) : list.map(esc).join(' &amp; '));
    const cardLook = n => { const l = Rewards.lookOf(n); return l && (l.frame || l.paddle) ? l : null; };
    if (!rwShown() || !list.some(cardLook)) return fallback();
    return list.map(n => {
      const l = cardLook(n);
      if (!l) return esc(n);
      const av = l.frame && typeof avatarInner === 'function' ? `<span class="rw-g-av" data-rw-frame="${esc(l.frame)}" aria-hidden="true">${avatarInner(n)}</span>` : '';
      const pd = l.paddle && typeof iconSvg === 'function' ? `<span class="rw-pad sm" data-rw-skin="${esc(l.paddle)}" aria-hidden="true">${iconSvg('paddle')}</span>` : '';
      return `<span class="rw-g-p">${av}${esc(n)}${pd}</span>`;
    }).join(' &amp; ');
  },
  // The small flame on the avatar: the streak when it is 2 or more days.
  flameHTML() {
    rwApplyLook(); // the header is drawn on every tab and after every change, so the worn ring is always current
    const n = rwShown() ? rwStreak(rwCur(), rwDayKey(Date.now())) : 0;
    return n >= 2 ? `<span class="rw-flame" aria-hidden="true">${rwFlame}<b>${n}</b></span>` : '';
  },
  label() { const n = rwShown() ? rwStreak(rwCur(), rwDayKey(Date.now())) : 0; return n >= 2 ? `. ${n} day play streak` : ''; },
  // "Your Dink" card on the Play tab.
  cardHTML() {
    if (!rwShown()) return '';
    const st = rwCur(), today = rwDayKey(Date.now()), day = rwStreak(st, today), done = st.last === today, nx = rwNext(day);
    const line = !myName() || !myToken() ? 'Pick your name in the club to start earning Dinks.' : done ? `Played today. ${nx.in === 1 ? 'Play tomorrow' : `Play ${nx.in} days in a row`} for +${nx.bonus} Dinks on day ${nx.day}.` : day ? `Play today to keep your ${day} day streak.` : 'Play a game today to start a streak.';
    const pet = typeof rwPetCardHTML === 'function' ? rwPetCardHTML(st) : '';
    return `<section class="card rw-card" aria-label="Your Dink"><div class="rw-top"><span class="rw-day">${rwFlame}<span><b>${day}</b><small>${day === 1 ? 'Day' : 'Days'}</small></span></span><span class="rw-bal"><b>${st.dinks}</b><small>${st.dinks === 1 ? 'Dink' : 'Dinks'}</small></span></div>${pet}<p class="rw-line">${esc(line)}</p><p class="rw-fine">Free play money. It can't be bought with real money or cashed out, and it never changes a game or a rating.</p><div class="rw-acts">${myName() && myToken() ? '<button type="button" class="rw-hide" data-rw="pass">Season pass</button><button type="button" class="rw-hide" data-rw="store">Shop</button><button type="button" class="rw-hide" data-rw="activity">Dinks activity</button>' : ''}<button type="button" class="rw-hide" data-rw="hide">Hide this</button></div></section>`;
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
async function rwSetBox(on) {
  try { await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'set-mystery-box', on }, adminCreds())) }); await refreshClub(); renderClub(); render(); announce(on ? 'Mystery box is on for this club.' : 'Mystery box is off for this club.'); }
  catch (err) { showToast(err.message, false); }
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-rw]');
  if (!b) return;
  const a = b.dataset.rw;
  if (a === 'club') { rwSetClub(!rwClubOn()); return; }
  if (a === 'box') { rwSetBox(!(club && club.mysteryBox)); return; }
  if (a === 'hide' || a === 'show') { store.set('pb.rewardsHide', a === 'hide'); rwApplyLook(); rwRedrawClub(); if (typeof clubSheet !== 'undefined' && clubSheet && clubSheet.view !== 'members' && typeof renderClub === 'function') renderClub(); if (a === 'show') Rewards.syncLooks(true); announce(a === 'hide' ? 'Daily streak hidden on this phone.' : 'Daily streak shown.'); }
});
