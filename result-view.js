// Draws the score-flow chart on the public result page (/r/<token>) from the numbers embedded in the page. The page reads fine without it.
/*@REPLAYCHART*/
(() => {
  const el = document.getElementById('rs-chart'), data = document.getElementById('rs-data');
  if (!el || !data) return;
  let f; try { f = JSON.parse(data.textContent); } catch { return; }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  el.innerHTML = RC.chart(f, f.n, ['Blue', 'Green'], esc, false);
})();
