/* ---------- achievements, weekly challenges, seasons, rivalries ---------- */
// The server works these out (so they can't be faked); the app shows what it sends.
const progressInfo = () => (clubData && clubData.progress) || null;
function progressOf(name) {
  const p = progressInfo();
  return p && name ? p.players[String(name).trim().toLowerCase()] || null : null;
}
const ACH_ICON = { 'first-win': '🎉', 'games-10': '🏓', 'games-50': '🐀', 'games-100': '💯', 'streak-5': '🔥', 'streak-10': '☄️', 'shutout': '🧱',
  'marathon': '⏱️', 'giant-killer': '🗡️', 'partners-5': '🦋', 'rating-4': '📈', 'rating-45': '👑' };
const PLACE = ['Champion', 'Runner-up', 'Third place'];
const MEDAL = ['🥇', '🥈', '🥉'];
const daysLeft = end => Math.max(0, Math.ceil((end - Date.now()) / DAY));

// Weekly challenges, half-width tile beside Top player on the home screen.
function challengesTile() {
  const info = progressInfo();
  if (!club || !info || !myName()) return '';
  const mine = (progressOf(myName()) || {}).week || [];
  const items = info.week.challenges.map(c => {
    const st = mine.find(x => x.id === c.id) || { progress: 0, done: false };
    return `<li class="${st.done ? 'done' : ''}"><b>${st.done ? '✓ ' : ''}${esc(c.name)}</b><span class="ch-bar" aria-hidden="true"><i style="width:${Math.round(100 * st.progress / c.goal)}%"></i></span></li>`;
  }).join('');
  const d = daysLeft(info.week.end);
  return `<section class="tile ch-tile" aria-label="This week's challenges"><span class="t-k">This week's challenges</span><ul>${items}</ul><span class="t-foot">${d <= 1 ? 'New ones tomorrow' : `New ones in ${d} days`}</span></section>`;
}

// Tell the player when something new unlocks (checked after each refresh from the server).
function announceUnlocks() {
  if (!club || !myName()) return;
  const p = progressOf(myName()), info = progressInfo();
  if (!p || !info) return;
  const seenAll = store.get('pb.seenProgress', {});
  const seenKey = club.code + '|' + myName().toLowerCase();
  const seen = seenAll[seenKey];
  const now = { ach: p.achievements.map(a => a.id), ch: (p.week || []).filter(x => x.done).map(x => info.week.id + ':' + x.id), tr: p.trophies.map(t => t.season + t.mode) };
  seenAll[seenKey] = now; store.set('pb.seenProgress', seenAll);
  if (!seen) return; // first time on this phone: don't replay old unlocks
  const msgs = [];
  for (const id of now.ach) if (!seen.ach.includes(id)) { const a = info.achievements.find(x => x.id === id); if (a) msgs.push(`${ACH_ICON[id] || '🏅'} Achievement: ${a.name}!`); }
  for (const k of now.ch) if (!(seen.ch || []).includes(k)) { const c = info.week.challenges.find(x => k.endsWith(':' + x.id)); if (c) msgs.push(`✓ Challenge done: ${c.name}`); }
  for (const k of now.tr) if (!(seen.tr || []).includes(k)) { const t = p.trophies.find(x => x.season + x.mode === k); if (t) msgs.push(`${MEDAL[t.place - 1]} ${t.name} ${t.mode} ${PLACE[t.place - 1]}!`); }
  msgs.slice(0, 3).forEach((m, i) => setTimeout(() => showToast(m, false), i * 3200));
}

// Self-reported DUPR rating (display only, never used for the Dink Rating or order). Everyone in the club sees it.
const DUPR_TIP = 'Self-reported by the player or an organizer. Not verified by DUPR.';
const duprOf = name => { const p = club && clubPlayers().find(x => sameName(x.name, name)); return p && p.dupr ? p.dupr : null; };
const duprChip = name => { const v = duprOf(name); return v ? `<span class="dupr" title="${DUPR_TIP}" aria-label="DUPR ${v.toFixed(2)}, self-reported, not verified">DUPR ${v.toFixed(2)}<small>self-reported</small></span>` : ''; };
// That name's own phone, or an organizer (the only one who can set it on a guest name).
const canSetDupr = name => !!club && !!clubData && clubPlayers().some(x => sameName(x.name, name)) && (isMe(name) || (club.hasPin ? hasOrganizer() : isCreator()));
let duprEdit = null; // { name, value, error, busy } while the DUPR box in a profile or the Your DUPR card is being edited
const refreshDupr = () => { if (profile) renderProfile(); if (clubSheet) renderClub(); };
function selfDuprHTML(name) {
  if (!club || !clubData) return '';
  const v = duprOf(name), can = canSetDupr(name);
  if (!v && !can) return '';
  const e = duprEdit && sameName(duprEdit.name, name) ? duprEdit : null;
  const live = e && $('#dupr-in');
  const liveVal = live && !e.busy ? live.value : e ? e.value : '';
  if (e) return `<div class="dupr-box"><label class="lab" for="dupr-in">DUPR rating</label><div class="dupr-form"><input id="dupr-in" type="text" inputmode="decimal" autocomplete="off" maxlength="6" placeholder="e.g. 3.52" value="${esc(liveVal)}"${e.busy ? ' disabled' : ''}><button type="button" class="btn btn-blue" data-act="dupr-save"${e.busy ? ' disabled' : ''}>${e.busy ? 'Saving…' : 'Save'}</button><button type="button" class="btn btn-soft" data-act="dupr-cancel">Cancel</button></div>${e.error ? `<p class="err" role="alert">${esc(e.error)}</p>` : ''}<p class="note">Optional, for reference only. Not sent to DUPR. Not verified. Everyone in ${esc(club.name)} can see it. Leave it empty and save to clear it.</p></div>`;
  return `<div class="dupr-box"><div class="dupr-row">${v ? duprChip(name) : '<span class="note">No DUPR rating set</span>'}${can ? `<button type="button" class="link" data-act="dupr-edit">${v ? 'Edit' : 'Set DUPR rating'}</button>${v ? '<button type="button" class="link" data-act="dupr-clear">Clear</button>' : ''}` : ''}</div>${can && !v ? '<p class="note">Optional, for reference only. Not sent to DUPR. Not verified. Everyone in the club can see it.</p>' : ''}</div>`;
}
async function saveDupr(clear) {
  const e = duprEdit; if (!e || e.busy) return;
  const raw = clear ? '' : String(($('#dupr-in') || {}).value || '');
  e.value = raw; e.error = ''; e.busy = true; refreshDupr();
  try {
    const d = await playerCall(Object.assign({ action: 'dupr', name: e.name, rating: raw, playerToken: isMe(e.name) ? myToken() : '' }, adminCreds()));
    const p = clubPlayers().find(x => sameName(x.name, e.name)); if (p) p.dupr = d.dupr;
    duprEdit = null; showToast(d.dupr ? 'DUPR rating saved' : 'DUPR rating cleared', false); refreshDupr(); render();
  } catch (err) { e.busy = false; e.error = err.message; refreshDupr(); }
}
// Profile: achievements, trophies and rivalries.
function achievementsHTML(name) {
  const info = progressInfo(), p = progressOf(name);
  if (!info) return '';
  const got = new Map(((p && p.achievements) || []).map(a => [a.id, a.at]));
  return `<div class="field" style="margin:0"><span class="lab">Achievements ${got.size}/${info.achievements.length}</span>
    <div class="ach-grid">${info.achievements.map(a => { const at = got.get(a.id); return `<div class="ach ${at ? 'got' : ''}" title="${esc(a.desc)}"><span class="ach-ic">${ACH_ICON[a.id] || '🏅'}</span><b>${esc(a.name)}</b><small>${at ? new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : esc(a.desc)}</small></div>`; }).join('')}</div></div>`;
}
function trophiesHTML(name) {
  const p = progressOf(name);
  if (!p || !p.trophies.length) return '';
  return `<div class="field" style="margin:0"><span class="lab">Trophies</span><div class="trophies">${p.trophies.slice().reverse().map(t => `<div class="trophy-chip p${t.place}"><span>${MEDAL[t.place - 1]}</span><div><b>${esc(t.name)}</b><small>${t.mode === 'singles' ? 'Singles' : 'Doubles'} ${PLACE[t.place - 1].toLowerCase()}, ${Number(t.rating).toFixed(2)}</small></div></div>`).join('')}</div></div>`;
}
function rivalriesHTML(name, mode) {
  const k = name.trim().toLowerCase();
  const opp = new Map();
  for (const g of allGames()) {
    if ((g.mode === 'singles' ? 'singles' : 'doubles') !== mode) continue;
    const t = g.teams[0].some(n => n.trim().toLowerCase() === k) ? 0 : g.teams[1].some(n => n.trim().toLowerCase() === k) ? 1 : -1;
    if (t < 0) continue;
    for (const n of g.teams[1 - t]) {
      if (isDefaultName(n)) continue;
      const ok = n.trim().toLowerCase();
      const e = opp.get(ok) || { name: n.trim(), w: 0, l: 0, last: 0 };
      if (g.winner === t) e.w++; else e.l++;
      e.last = Math.max(e.last, g.endedAt);
      opp.set(ok, e);
    }
  }
  const rivals = [...opp.values()].filter(e => e.w + e.l >= 3).sort((a, b) => (b.w + b.l) - (a.w + a.l) || b.last - a.last).slice(0, 3);
  if (!rivals.length) return '';
  return `<div class="field" style="margin:0"><span class="lab">Rivalries</span><div class="rivals">${rivals.map((e, i) => {
    const lead = e.w > e.l ? 'leads' : e.w < e.l ? 'trails' : 'tied';
    return `<button class="rival ${lead}" data-player="${esc(e.name)}"><span class="avatar-mini"${typeof Rewards !== 'undefined' ? Rewards.frameAttr(e.name) : ''}>${avatarInner(e.name)}</span>
      <span class="rv-text"><b>${i === 0 ? 'Top rival: ' : ''}${esc(e.name)}</b><small>${lead === 'tied' ? `All square at ${e.w}–${e.l}` : `${esc(name.split(' ')[0])} ${lead} ${Math.max(e.w, e.l)}–${Math.min(e.w, e.l)}`}</small></span>
      <span class="rv-score">${e.w}–${e.l}</span></button>`;
  }).join('')}</div></div>`;
}

// Season leaderboard: the current season's (a calendar quarter, or one an organizer started early) verified games only, everyone starting at 2.00 (same as the server).
function seasonRows(mode) {
  const info = progressInfo();
  if (!info) return [];
  const s = info.season;
  const games = ratedGames().filter(g => g.scoredBy && (g.receivedAt || g.endedAt) >= s.start && (g.receivedAt || g.endedAt) < s.end && (g.mode === 'singles' ? 'singles' : 'doubles') === mode);
  const { tables } = DR.compute(games);
  return [...tables[mode].values()].filter(p => !isDefaultName(p.name)).sort((a, b) => b.rating - a.rating || b.games - a.games);
}
function pastChampionsHTML(mode) {
  const info = progressInfo();
  if (!info) return '';
  const bySeason = new Map();
  for (const p of Object.values(info.players)) for (const t of p.trophies) if (t.mode === mode) {
    const e = bySeason.get(t.season) || { name: t.name, start: t.start || 0, places: [] };
    e.places[t.place - 1] = p.name; bySeason.set(t.season, e);
  }
  if (!bySeason.size) return '';
  return `<section><h2 style="font-size:22px">Past champions</h2><div class="champs">${[...bySeason.entries()].sort((a, b) => b[1].start - a[1].start || b[0].localeCompare(a[0])).map(([, e]) => `<div class="champ"><b>${esc(e.name)}</b>${e.places.map((n, i) => n ? `<span>${MEDAL[i]} ${esc(n)}</span>` : '').join('')}</div>`).join('')}</div></section>`;
}

