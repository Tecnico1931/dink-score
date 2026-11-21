const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const skel = (n = 3, card = false) => `<div class="skel-wrap" role="status" aria-busy="true"><span class="vh">Loading…</span>${Array.from({ length: n }, () => `<div class="skel${card ? ' skel-card' : ''}" aria-hidden="true"><i></i><b></b><b></b></div>`).join('')}</div>`;
const store = {
  // A stored value of the wrong kind (a null or a string where an object or list belongs) counts as missing.
  get(k, d) {
    try {
      const v = localStorage.getItem(k); if (!v) return d;
      const x = JSON.parse(v), kind = a => Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
      return d !== null && d !== undefined && kind(x) !== kind(d) ? d : x;
    } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
// Display options live on this phone only (nothing is sent to the club): theme = auto|light|dark, outdoor = high contrast, large = bigger court numbers.
