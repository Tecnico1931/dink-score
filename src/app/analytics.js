/* ---------- organizer analytics (api/_analytics.js via GET api/club?analytics=1; totals only, organizers only) ---------- */
async function loadAnalytics() {
  const c = clubSheet;
  let tz = 'UTC'; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* UTC */ }
  try {
    const d = await api('club?code=' + encodeURIComponent(club.code) + '&analytics=1&tz=' + encodeURIComponent(tz), { headers: { 'Content-Type': 'application/json', 'x-club-pin': pins[club.code] || '', 'x-club-owner': owners[club.code] || '' } });
    if (clubSheet === c) { c.data = d; c.error = ''; renderClub(); }
  } catch (err) { if (clubSheet === c) { c.error = err.message; renderClub(); } }
}
function analyticsHTML(c) {
  const d = c.data, back = '<div class="btns"><button class="btn btn-soft" data-act="club-back">Back</button><button class="btn btn-soft" data-act="club-close">Done</button></div>';
  const head = '<h2 id="club-h">Attendance and busiest hours</h2>';
  if (c.error) return `${head}<p class="err" role="alert">${esc(c.error)}</p>${back}`;
  if (!d) return `${head}<p class="note">Loading…</p>${back}`;
  if (!d.games) return `${head}<p class="note">No games in the last ${d.weeksShown} weeks yet.</p>${back}`;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const hr = h => (h % 12 || 12) + (h < 12 ? ' am' : ' pm');
  const maxP = Math.max(1, ...d.weeks.map(w => w.players));
  const weeks = d.weeks.map(w => `<div class="an-week"><span>${esc(new Date(w.start + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }))}</span><span class="an-bar" aria-hidden="true"><i style="width:${100 * w.returning / maxP}%"></i><i style="width:${100 * w.newPlayers / maxP}%"></i></span><span>${w.players} player${w.players === 1 ? '' : 's'}, ${w.games} game${w.games === 1 ? '' : 's'}${w.newPlayers ? `, ${w.newPlayers} new` : ''}</span></div>`).join('');
  const peak = Math.max(1, ...d.busiest.grid.flat());
  const heat = `<table class="an-heat" aria-hidden="true">${d.busiest.grid.map((row, i) => `<tr><th>${DAYS[i]}</th>${row.slice(6, 23).map(n => `<td style="${n ? `background:color-mix(in srgb, var(--blue) ${Math.max(15, Math.round(100 * n / peak))}%, var(--line))` : ''}"></td>`).join('')}</tr>`).join('')}<tr><th></th><td colspan="17" style="background:none;text-align:left">6 am to 10 pm</td></tr></table>`;
  const r = d.retention;
  return `${head}<p class="note">Totals from the games your club has saved, for organizers only. No player is listed. Times are in this phone's time zone (${esc(d.tz)}).</p>
    <div class="an-stats">
      <div class="an-stat"><b>${d.games}</b><span>games, last ${d.weeksShown} weeks</span></div>
      <div class="an-stat"><b>${d.avgPlayersPerDay}</b><span>players per play day (${d.playDays} days)</span></div>
      <div class="an-stat"><b>${r.rate == null ? 'n/a' : r.rate + '%'}</b><span>came back for another week${r.cohort ? ` (${r.cameBack} of ${r.cohort})` : ''}</span></div>
      <div class="an-stat"><b>${r.active}</b><span>played in the last ${d.activeWeeks} weeks${r.lapsed ? `; ${r.lapsed} did not return after the ${d.activeWeeks} before` : ''}</span></div>
      ${d.avgMinutes ? `<div class="an-stat"><b>${d.avgMinutes} min</b><span>average live game</span></div>` : ''}
    </div>
    <h3 class="lab">Players each week</h3>${weeks}
    <p class="note">Blue: players who had played before. Green: new to the club that week.</p>
    <h3 class="lab" style="margin-top:16px">Busiest hours</h3>${heat}
    <ol class="mem-list">${d.busiest.top.map(t => `<li class="mem-row"><span class="mem-text"><span class="mem-name">${FULL[t.day]}, ${hr(t.hour)}</span><span class="mem-meta">${t.games} game${t.games === 1 ? '' : 's'} started</span></span></li>`).join('')}</ol>${back}`;
}
