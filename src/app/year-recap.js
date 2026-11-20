/* ---------- year-in-review recap on every player profile ---------- */
/*YEARRECAP-START*/
// Pure calendar-year summary for one player, built from rated games and the Dink Rating engine.
// No app globals, so test/recap.test.js can load this block directly alongside DR.
const YearRecap = {
  isDefault: n => /^Player \d+$/.test(String(n || '').trim()),
  validGame: g => !!(g && !g.hold && Array.isArray(g.teams) && g.teams.length === 2 && g.teams.every(Array.isArray) && Array.isArray(g.score) && g.score.length === 2 && Number.isFinite(g.endedAt)),
  yearOf: ms => new Date(ms).getFullYear(),
  years(DR, name, games, { yearOf = YearRecap.yearOf } = {}) {
    const k = DR.key(name || '');
    if (!k) return [];
    const set = new Set();
    for (const g of games || []) {
      if (!YearRecap.validGame(g)) continue;
      if (g.teams.some(t => t.some(n => DR.key(n) === k))) set.add(yearOf(g.endedAt));
    }
    return [...set].sort((a, b) => b - a);
  },
  compute(DR, name, games, year = null, { yearOf = YearRecap.yearOf } = {}) {
    const rawName = String(name || '').trim();
    const k = DR.key(rawName);
    const valid = (games || []).filter(YearRecap.validGame).sort((a, b) => a.endedAt - b.endedAt);
    const years = YearRecap.years(DR, rawName, valid, { yearOf });
    const targetYear = Number.isInteger(year) ? year : (years[0] ?? yearOf(Date.now()));
    const empty = {
      name: rawName, year: targetYear, years,
      games: 0, wins: 0, losses: 0, winRate: 0,
      bestRating: null, bestRatingMode: null, bestRatingAt: null,
      doublesGames: 0, singlesGames: 0, pointsFor: 0, pointsAgainst: 0,
      favouritePartner: null, biggestRival: null
    };
    if (!k || !valid.length) return empty;
    // Replay the full rated history so ratings carry across year boundaries; peak rating only considers games in targetYear.
    const { after } = DR.compute(valid);
    const partners = new Map(), opponents = new Map();
    const tally = (map, n, won, decided, at) => {
      const ok = DR.key(n);
      const e = map.get(ok) || { name: String(n).trim(), games: 0, wins: 0, losses: 0, last: 0 };
      e.name = String(n).trim();
      e.games++;
      if (decided) { if (won) e.wins++; else e.losses++; }
      e.last = Math.max(e.last, at);
      map.set(ok, e);
    };
    let displayName = rawName, total = 0, wins = 0, losses = 0, doublesGames = 0, singlesGames = 0, pointsFor = 0, pointsAgainst = 0;
    let bestRating = null, bestRatingMode = null, bestRatingAt = null;
    for (const g of valid) {
      if (yearOf(g.endedAt) !== targetYear) continue;
      const side = g.teams[0].some(n => DR.key(n) === k) ? 0 : g.teams[1].some(n => DR.key(n) === k) ? 1 : -1;
      if (side < 0) continue;
      const mine = g.teams[side].find(n => DR.key(n) === k);
      if (mine && String(mine).trim()) displayName = String(mine).trim();
      const mode = g.mode === 'singles' ? 'singles' : 'doubles';
      const sFor = Number(g.score[side]) || 0, sAgainst = Number(g.score[1 - side]) || 0;
      const hasWinner = g.winner === 0 || g.winner === 1;
      const decided = hasWinner || sFor !== sAgainst;
      const won = hasWinner ? g.winner === side : sFor > sAgainst;
      total++;
      if (decided) { if (won) wins++; else losses++; }
      if (mode === 'singles') singlesGames++; else doublesGames++;
      pointsFor += sFor; pointsAgainst += sAgainst;
      const r = after[g.id] && after[g.id][k];
      if (typeof r === 'number' && (bestRating === null || r > bestRating)) {
        bestRating = r; bestRatingMode = mode; bestRatingAt = g.endedAt;
      }
      if (mode === 'doubles') {
        for (const n of g.teams[side]) {
          if (DR.key(n) !== k && !YearRecap.isDefault(n)) tally(partners, n, won, decided, g.endedAt);
        }
      }
      for (const n of g.teams[1 - side]) {
        if (DR.key(n) !== k && !YearRecap.isDefault(n)) tally(opponents, n, won, decided, g.endedAt);
      }
    }
    const fp = [...partners.values()].sort((a, b) => b.games - a.games || b.wins - a.wins || b.last - a.last || a.name.localeCompare(b.name))[0] || null;
    const rv = [...opponents.values()].sort((a, b) => b.games - a.games || Math.abs(a.wins - a.losses) - Math.abs(b.wins - b.losses) || b.last - a.last || a.name.localeCompare(b.name))[0] || null;
    const attachRate = e => e ? Object.assign({}, e, { winRate: e.games ? Math.round(100 * e.wins / e.games) : 0 }) : null;
    return {
      name: displayName, year: targetYear, years,
      games: total, wins, losses, winRate: total ? Math.round(100 * wins / total) : 0,
      bestRating, bestRatingMode, bestRatingAt,
      doublesGames, singlesGames, pointsFor, pointsAgainst,
      favouritePartner: attachRate(fp), biggestRival: attachRate(rv)
    };
  }
};
/*YEARRECAP-END*/

function recapFormatLabel(r) {
  if (r.doublesGames && r.singlesGames) return 'Doubles & singles';
  if (r.singlesGames) return 'Singles';
  if (r.doublesGames) return 'Doubles';
  return 'Year in review';
}

// Entry card shown on every player profile when that player has rated games in at least one year.
function recapBannerHTML(name, rated) {
  const ys = YearRecap.years(DR, name, rated);
  if (!ys.length) return '';
  const r = YearRecap.compute(DR, name, rated, ys[0]);
  const bits = [`${r.games} game${r.games === 1 ? '' : 's'}`, `${r.wins}–${r.losses}`];
  if (r.bestRating !== null) bits.push(`Best ${r2(r.bestRating)}`);
  return `<button type="button" class="recap-cta" data-act="recap-open">
    <span class="recap-cta-text"><b>${r.year} in review</b><small>${esc(bits.join(' · '))}${ys.length > 1 ? ` · ${ys.length} years` : ''}</small></span>
    <span class="recap-cta-go" aria-hidden="true">Recap ›</span>
  </button>`;
}

// Full Year-in-review view rendered inside the profile sheet (#sheet4).
function recapViewHTML(name, year, rated) {
  const r = YearRecap.compute(DR, name, rated, year);
  const diff = r.pointsFor - r.pointsAgainst;
  const yearNav = r.years.length > 1
    ? (r.years.length <= 4
      ? seg('data-recap-year', r.years.map(y => [y, String(y)]), r.year, 'sm')
      : `<div class="recap-years" role="group" aria-label="Year">${r.years.map(y => `<button type="button" class="chip-btn" data-recap-year="${y}" aria-pressed="${y === r.year}">${y}</button>`).join('')}</div>`)
    : '';
  let content;
  if (!r.games) {
    content = `<div class="empty" style="box-shadow:none;background:var(--surface-2)"><p>No rated games in ${r.year} for ${esc(r.name)}.</p></div>`;
  } else {
    const fp = r.favouritePartner;
    const rv = r.biggestRival;
    const fpHTML = fp
      ? `<button type="button" class="rival recap-hl" data-player="${esc(fp.name)}"><span class="avatar-mini">${avatarInner(fp.name)}</span>
          <span class="rv-text"><b>${esc(fp.name)}</b><small>Favourite partner · ${fp.games} game${fp.games === 1 ? '' : 's'} together (${fp.winRate}%)</small></span>
          <span class="rv-score">${fp.wins}–${fp.losses}</span></button>`
      : `<div class="recap-empty-row"><b>Favourite partner</b><small>${r.singlesGames && !r.doublesGames ? `Singles only in ${r.year} — no doubles partner yet.` : `No named doubles partner in ${r.year}.`}</small></div>`;
    let rvHTML;
    if (rv) {
      const lead = rv.wins > rv.losses ? 'leads' : rv.wins < rv.losses ? 'trails' : 'tied';
      const first = r.name.split(' ')[0];
      const h2h = lead === 'tied' ? `All square at ${rv.wins}–${rv.losses}` : `${first} ${lead} ${Math.max(rv.wins, rv.losses)}–${Math.min(rv.wins, rv.losses)}`;
      rvHTML = `<button type="button" class="rival recap-hl ${lead}" data-player="${esc(rv.name)}"><span class="avatar-mini">${avatarInner(rv.name)}</span>
        <span class="rv-text"><b>${esc(rv.name)}</b><small>Biggest rival · ${esc(h2h)} (${rv.games} game${rv.games === 1 ? '' : 's'})</small></span>
        <span class="rv-score">${rv.wins}–${rv.losses}</span></button>`;
    } else {
      rvHTML = `<div class="recap-empty-row"><b>Biggest rival</b><small>No named opponents in ${r.year}.</small></div>`;
    }
    const peakSub = r.bestRatingMode ? `${r.bestRatingMode === 'singles' ? 'Singles' : 'Doubles'} peak` : 'Peak rating';
    content = `<div class="recap-hero">
        <div class="recap-hero-meta"><span class="recap-k">Best Dink Rating</span><small>${esc(peakSub)}</small></div>
        <span class="rt">${r.bestRating !== null ? r2(r.bestRating) : '–'}</span>
      </div>
      <div class="pf-stats">
        <div><b>${r.games}</b><small>Games</small></div>
        <div><b>${r.wins}–${r.losses}</b><small>Won–lost</small></div>
        <div><b>${r.winRate}%</b><small>Win rate</small></div>
        <div><b>${diff > 0 ? '+' : ''}${diff}</b><small>Points +/−</small></div>
      </div>
      <div class="field" style="margin:0"><span class="lab">Highlights</span><div class="rivals">${fpHTML}${rvHTML}</div></div>
      <button type="button" class="btn btn-ink block recap-share-btn" data-act="recap-share">${ICON.share}Share ${r.year} recap image</button>`;
  }
  return `<div class="sheet-bg top"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pf-h"><span class="grip"></span>
    <div class="pf-head">
      <button type="button" class="x" data-act="recap-back" aria-label="Back to profile">${ICON.back}</button>
      <h2 id="pf-h" tabindex="-1">${r.year} in review</h2>
      <button type="button" class="x" data-act="profile-close" aria-label="Close">✕</button>
    </div>
    <div class="recap-sub"><span class="avatar-mini">${avatarInner(r.name)}</span><span><b>${esc(r.name)}${youTag(r.name)}</b><small>${esc(recapFormatLabel(r))}</small></span></div>
    ${yearNav}
    ${content}
  </div></div>`;
}

// Privacy-safe payload for the canvas share card (no club codes, tokens, or private identifiers).
function recapCardData(r) {
  return {
    name: r.name,
    avatar: avatarOf(r.name),
    year: r.year,
    games: r.games,
    wins: r.wins,
    losses: r.losses,
    winRate: r.winRate,
    bestRating: r.bestRating,
    bestRatingMode: r.bestRatingMode,
    doublesGames: r.doublesGames,
    singlesGames: r.singlesGames,
    pointsDiff: r.pointsFor - r.pointsAgainst,
    formatLabel: recapFormatLabel(r),
    favouritePartner: r.favouritePartner ? {
      name: r.favouritePartner.name, avatar: avatarOf(r.favouritePartner.name),
      games: r.favouritePartner.games, wins: r.favouritePartner.wins, losses: r.favouritePartner.losses, winRate: r.favouritePartner.winRate
    } : null,
    biggestRival: r.biggestRival ? {
      name: r.biggestRival.name, avatar: avatarOf(r.biggestRival.name),
      games: r.biggestRival.games, wins: r.biggestRival.wins, losses: r.biggestRival.losses, winRate: r.biggestRival.winRate
    } : null,
    club: club ? club.name : null
  };
}
