/* ---------- rewards: a daily play streak and free Dinks (L16 slice 1; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// Play money only: no purchase path, nothing is sold, nothing converts to anything. Off until an organizer switches it on for the club
// (clubs.rewards via club.js set-rewards); each player can hide it all on their own phone. Slice 2: the balance and streak are the server's
// append-only ledger (api/_economy.js, players.js rewards-sync), worked out from the games this phone's linked name saved; this phone only
// keeps the last synced value (localStorage pb.rewards, by club) so the card works offline. It never reads or changes a score, a rating, a
// rank or a pairing.
const RW_BONUS = [[3, 2], [7, 5], [14, 10], [30, 25]]; // streak day -> bonus Dinks; after day 30, every 30th day pays the day-30 bonus again
// The rules card quotes these numbers; test/economyrules.test.js pins each to the server constant it copies (DAY_PAY, BOX_*, PASS_TIERS).
const RW_DAY_PAY = 1, RW_BOX = { cost: 300, refund: 4, limit: 3 }, RW_PASS_TIERS = 10;
const rwDinks = n => `${n} ${n === 1 ? 'Dink' : 'Dinks'}`; // "1 Dink", "2 Dinks": the one place a count and its word are joined
const rwDayKey = d => { const x = d instanceof Date ? d : new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const rwDayNum = k => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }; // calendar days, so a clock change never adds or drops one
const rwId = v => (typeof v === 'string' && /^[a-z]{3,8}-[a-z]{3,12}$/.test(v) ? v : ''); // a worn item id, 'frame-court'
const rwLook = id => String(id || '').replace(/^[a-z]+-/, ''); // 'frame-court' -> 'court': the name the stylesheet draws
// The worn paddle colour as one small upright pickleball paddle (rounded face, edge, holes, handle), coloured only by the --rw-pad-* tokens of
// the [data-rw-skin] it sits in, so it follows both themes. Decorative: callers carry the text. The stripe shows only for the striped skin.
const rwPaddleSvg = () => '<svg class="rw-pdl" viewBox="0 0 18 26" aria-hidden="true" focusable="false"><rect class="rw-pdl-grip" x="7.2" y="16" width="3.6" height="9.2" rx="1.6"/><rect class="rw-pdl-face" x="2" y="1" width="14" height="17.5" rx="6.4"/><rect class="rw-pdl-stripe" x="7" y="1.7" width="4" height="16.1"/><g class="rw-pdl-holes"><circle cx="6.2" cy="6" r="1"/><circle cx="9" cy="6" r="1"/><circle cx="11.8" cy="6" r="1"/><circle cx="6.2" cy="9.6" r="1"/><circle cx="9" cy="9.6" r="1"/><circle cx="11.8" cy="9.6" r="1"/><circle cx="6.2" cy="13.2" r="1"/><circle cx="9" cy="13.2" r="1"/><circle cx="11.8" cy="13.2" r="1"/></g></svg>';
const rwKey = n => String(n || '').trim().replace(/\s+/g, ' ').normalize('NFC').toLowerCase();
// Slots the server knows (mirror of SLOT_META in api/_economyshop.js). frame, paddle and pet are always present in a look; the newer ones only when set.
// A sound is never in a club look: it stays on its owner's phone.
const RW_EXTRA_SLOTS = ['title', 'style'];
// Title ids -> the words shown under a name (mirror of TITLES in api/_economyitems.js; test/economyitems.test.js pins them together).
const RW_TITLES = { kitchen: 'Kitchen King', dink: 'Dink Master', banger: 'Banger', lob: 'Lob Legend', third: 'Third-Shot Wizard', erne: 'Erne Artist', soft: 'Soft Hands', ninja: 'Net Ninja', dropshot: 'Drop Shot Doctor', speedup: 'Speed-Up Specialist', post: 'Around the Post' };
const RW_STYLES = ['gold', 'glowing', 'flame', 'pickle', 'ice', 'neon'];
const rwSlotId = (slot, v) => (typeof v === 'string' && new RegExp(`^${slot}-[a-z]{3,12}$`).test(v) ? v : '');
// {title, style} ids that are set and well formed, nothing else.
const rwExtras = v => Object.fromEntries(RW_EXTRA_SLOTS.map(s => [s, rwSlotId(s, v && v[s])]).filter(e => e[1]));
const rwCleanLooks = raw => {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = rwKey(k);
    if (!key || !v || typeof v !== 'object') continue;
    const frame = rwSlotId('frame', v.frame), paddle = rwSlotId('paddle', v.paddle), pet = rwSlotId('pet', v.pet);
    const extra = rwExtras(v);
    if (!frame && !paddle && !pet && !Object.keys(extra).length) continue;
    const entry = { frame, paddle, ...extra };
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
  const worn = { frame: rwId(w.frame), paddle: rwId(w.paddle), pet: rwId(w.pet), ...Object.fromEntries(['title', 'style', 'sound'].map(k => [k, rwId(w[k])]).filter(e => e[1])) };
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

// Season pass tiers that are unlocked but not claimed yet, for the club on this phone. Learned from the pass answer (rewards-pass, or a claim) and never
// stored: it is a nudge on the Your Dink card and the You sheet, so a stale value only costs one tap. In memory only.
const rwReady = { code: null, n: 0, at: 0, busy: false };
const rwReadyN = () => (rwShown() && club && rwReady.code === club.code ? rwReady.n : 0);
const rwReadyTag = n => (n > 0 ? `<span class="rw-ready">${n} ready</span>` : '');
function rwSetReady(n, code = club && club.code) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  const known = rwReady.code === code && rwReady.at > 0, grew = known && n > rwReady.n, changed = rwReady.code !== code || rwReady.n !== n;
  rwReady.code = code; rwReady.n = n; rwReady.at = Date.now();
  if (!changed || !club || club.code !== code || !rwShown()) return;
  if (grew) announce(`${n} season pass ${n === 1 ? 'reward is' : 'rewards are'} ready to claim.`);
  rwRedrawClub();
  if (typeof clubSheet !== 'undefined' && clubSheet && !/^rw/.test(clubSheet.view) && typeof renderClub === 'function') renderClub();
}
let rwBusy = false, rwAt = 0, rwLooksBusy = false, rwLooksAt = 0, rwLooksCode = null;
const rwLooksByClub = Object.create(null);
const rwClubLooks = () => (club && club.code && rwLooksByClub[club.code]) || null;
const rwSetOwnLook = (name, worn, share, petInfo) => {
  const code = club && club.code, key = rwKey(name);
  if (!code || !key) return;
  const map = rwLooksByClub[code] || (rwLooksByClub[code] = Object.create(null));
  const frame = share ? rwSlotId('frame', worn && worn.frame) : '', paddle = share ? rwSlotId('paddle', worn && worn.paddle) : '', pet = share ? rwSlotId('pet', worn && worn.pet) : '';
  const extra = share ? rwExtras(worn) : {};
  if (frame || paddle || pet || Object.keys(extra).length) {
    const entry = { frame, paddle, ...extra };
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
      Rewards.syncReady(true);
    } catch { /* offline or off: keep the last value */ } finally { rwBusy = false; }
  },
  // Ask the server how many pass tiers are ready to claim (after a sync, so a game just saved counts). Off, hidden or offline: the last value stays.
  async syncReady(force) {
    const code = club && club.code;
    if (!rwShown() || !code || !myName() || !myToken() || rwReady.busy || (!force && rwReady.code === code && Date.now() - rwReady.at < 3e5)) return;
    rwReady.busy = true;
    try {
      const d = await playerCall({ action: 'rewards-pass', name: myName(), playerToken: myToken() });
      if (club && club.code === code && d && Array.isArray(d.tiers)) rwSetReady(d.tiers.filter(t => t.unlocked && !t.claimed).length, code);
    } catch { /* offline or off: keep the last value */ } finally { rwReady.busy = false; }
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
    const extra = Object.fromEntries(RW_EXTRA_SLOTS.map(s => [s, rwLook(hit[s])]).filter(e => e[1]));
    if (!frame && !paddle && !pet && !Object.keys(extra).length) return null;
    return pet ? { frame, paddle, ...extra, pet, petStage: hit.petStage === 2 || hit.petStage === 3 ? hit.petStage : 1, petShiny: !!hit.petShiny } : { frame, paddle, ...extra };
  },
  // A name as text, drawn in the worn name style when this phone may show one (the style is a stylesheet colour, never an image or a rule).
  nameHTML(name) {
    const l = Rewards.lookOf(name);
    return l && RW_STYLES.includes(l.style) ? `<span class="rw-nm" data-rw-style="${l.style}">${esc(name)}</span>` : esc(name);
  },
  // The worn title as a small line under the name, or nothing.
  titleHTML(name) {
    const l = Rewards.lookOf(name), t = l && Object.hasOwn(RW_TITLES, l.title) ? RW_TITLES[l.title] : '';
    return t ? `<span class="rw-title">${esc(t)}</span>` : '';
  },
  frameAttr(name) { const l = Rewards.lookOf(name); return l && l.frame ? ` data-rw-frame="${esc(l.frame)}"` : ''; },
  paddleBadgeHTML(name) {
    const l = Rewards.lookOf(name);
    return l && l.paddle ? `<span class="rw-pad" data-rw-skin="${esc(l.paddle)}" aria-hidden="true">${rwPaddleSvg()}</span>` : '';
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
      const pd = l.paddle ? `<span class="rw-pad sm" data-rw-skin="${esc(l.paddle)}" aria-hidden="true">${rwPaddleSvg()}</span>` : '';
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
  // The "N Dinks" chip beside your name on your own profile. Never another player's balance, and gone when rewards are hidden or off.
  chipHTML(name) { return rwShown() && isMe(name) && myName() && myToken() ? `<span class="badge rw-bal">${rwDinks(rwCur().dinks)}</span>` : ''; },
  // "Your Dink" card on the Play tab.
  // The small "Your Dinks" tile beside Top player on Play: balance and streak only (the card below keeps the actions).
  tileHTML() {
    if (!rwShown()) return '';
    const st = rwCur(), day = rwStreak(st, rwDayKey(Date.now()));
    return `<section class="tile rw-tile" aria-label="Your Dinks"><span class="t-k">Your Dinks</span><span class="rw-tile-day">${rwFlame}<span>${day ? `Day ${day} streak` : 'No streak yet'}</span></span><span class="t-big">${st.dinks}</span></section>`;
  },
  cardHTML() {
    if (!rwShown()) return '';
    const st = rwCur(), today = rwDayKey(Date.now()), day = rwStreak(st, today), done = st.last === today, nx = rwNext(day);
    const line = !myName() || !myToken() ? 'Pick your name in the club to start earning Dinks.' : done ? `Played today. ${nx.in === 1 ? 'Play tomorrow' : `Play ${nx.in} days in a row`} for +${nx.bonus} Dinks on day ${nx.day}.` : day ? `Play today to keep your ${day} day streak.` : 'Play a game today to start a streak.';
    const pet = typeof rwPetCardHTML === 'function' ? rwPetCardHTML(st) : '', ready = rwReadyN();
    return `<section class="card rw-card" aria-label="Your Dink"><div class="rw-top"><span class="rw-day">${rwFlame}<span><b>${day}</b><small>${day === 1 ? 'Day' : 'Days'}</small></span></span><span class="rw-bal"><b>${st.dinks}</b><small>${st.dinks === 1 ? 'Dink' : 'Dinks'}</small></span></div>${pet}<p class="rw-line">${esc(line)}</p><p class="rw-fine">Free play money. It can't be bought with real money or cashed out, and it never changes a game or a rating.</p><div class="rw-acts">${myName() && myToken() ? `<button type="button" class="rw-hide" data-rw="pass" aria-label="Season pass${ready ? `, ${ready} ready to claim` : ''}">Pass${rwReadyTag(ready)}</button><button type="button" class="rw-hide" data-rw="store">Shop</button><button type="button" class="rw-hide" data-rw="activity" aria-label="Dinks activity">Activity</button>` : ''}<button type="button" class="rw-hide" data-rw="hide" aria-label="Hide this">Hide</button></div></section>`;
  },
  // Rules tab: the "Earning Dinks" card, written from the same constants the ledger, box and pass use. Nothing draws where rewards are off or hidden.
  rulesJump() { return rwShown() ? [['rules-earning', 'Earning']] : []; },
  rulesHTML() {
    if (!rwShown()) return '';
    const lad = RW_BONUS.map(([d, b]) => `+${b} on day ${d}`).join(', '), top = RW_BONUS[RW_BONUS.length - 1];
    const box = rwBoxOn() ? `<li><b>Mystery box:</b> opens a random item you don't own yet for ${rwDinks(RW_BOX.cost)}, up to ${RW_BOX.limit} a day. If you already own it, ${rwDinks(RW_BOX.refund)} come back. The odds are shown before you open one.</li>` : '';
    return `<div class="rule" id="rules-earning"><h3>Earning Dinks</h3><p>Where your club has rewards on, playing earns free Dinks to spend in the shop. They are play money with no cash value, and they can't be bought.</p><ul><li><b>+${RW_DAY_PAY}</b> for the first game you play each day. A logged result counts the same as one scored live.</li><li><b>Daily streak:</b> play on days in a row for a bonus: ${lad}, then +${top[1]} every ${top[0]}th day after that. Miss a day and the streak starts again.</li><li>Only games saved from your own linked name count. Winning, losing or the score never changes what you earn.</li>${box}<li><b>Season pass:</b> a free track of ${RW_PASS_TIERS} rewards that unlock as you play games this season. Games count, never results.</li><li>Shop items are looks only, so nothing you get changes a rating. Hide it all any time under <b>You</b>.</li></ul></div>`;
  },
  // The "You" rows (shown only where the club has rewards on): the way into the Shop and Season pass, and the one switch on this phone.
  youRowHTML() {
    if (!rwClubOn()) return '';
    const n = rwReadyN();
    const way = rwShown() && myName() && myToken()
      ? `<button type="button" class="you-row" data-rw="pass"><span><b>Shop &amp; season pass</b><small>${n ? `${n === 1 ? '1 reward is' : `${n} rewards are`} ready to claim` : 'Claim rewards and spend your Dinks'}</small></span>${rwReadyTag(n)}<span class="chev" aria-hidden="true">›</span></button>` : '';
    return `${way}<button type="button" class="you-row" data-rw="${rwHidden() ? 'show' : 'hide'}"><span><b>${rwHidden() ? 'Show rewards and streak' : 'Hide rewards and streak'}</b><small>${rwHidden() ? 'Your Dink card, flame and Shop come back' : 'Hides the streak, the flame, Dinks and the Shop on this phone'}</small></span><span class="chev" aria-hidden="true">›</span></button>`;
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
