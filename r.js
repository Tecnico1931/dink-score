// Draws the score-flow chart on the public result page (/r/<token>) from the numbers embedded in the page. The page reads fine without it.

// The score-flow chart, shared with the public result page (build.cjs pastes this block into r.js): free of app globals.
// m: { lead, sideouts, runs, best, span } as replayModel() makes it (or the server's flow()), n: rallies, names: team names.
const RC = {
chart(m, n, names, esc, controls = true) {
  const W = 320, H = 150, L = 8, R = 8, T = 10, B = 20, mid = (T + H - B) / 2;
  const x = i => L + (i / n) * (W - L - R);
  const y = v => mid - (v / m.span) * (mid - T - 2);
  const pts = (from, to) => { const o = []; for (let i = from; i <= to; i++) o.push(`${x(i).toFixed(1)},${y(m.lead[i]).toFixed(1)}`); return o.join(' '); };
  const label = `Score flow over ${n} rallies. ${m.best ? `Longest run: ${m.best.n} unanswered points by ${names[m.best.team]}. ` : 'No run of 3 or more unanswered points. '}${m.sideouts.length} side-out${m.sideouts.length === 1 ? '' : 's'}.${controls ? ' Use the replay controls to step through it.' : ''}`;
  return `<svg class="rp-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    <line class="rp-zero" x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}"/>
    <text class="rp-ax" x="${L}" y="${T + 8}">+${m.span}</text><text class="rp-ax" x="${L}" y="${H - B - 3}">+${m.span}</text>
    ${m.sideouts.map(k => `<line class="rp-so" x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${H - B + 3}" y2="${H - B + 11}"/>`).join('')}
    <polyline class="rp-line" points="${pts(0, n)}"/>
    ${m.runs.map(u => `<polyline class="rp-run t${u.team}" points="${pts(u.from - 1, u.to)}"/>`).join('')}
    <line class="rp-cur" x1="0" x2="0" y1="${T}" y2="${H - B + 11}"/><circle class="rp-dot" r="5" cx="0" cy="0"/>
  </svg>`;
}
};

(() => {
  const el = document.getElementById('rs-chart'), data = document.getElementById('rs-data');
  if (!el || !data) return;
  let f; try { f = JSON.parse(data.textContent); } catch { return; }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  el.innerHTML = RC.chart(f, f.n, ['Blue', 'Green'], esc, false);
})();
