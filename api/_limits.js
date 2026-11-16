// Pure helpers for rate limits (no database), so `npm test` covers them without an install.

// The key address limits are counted on. IPv4 is used as is; IPv6 collapses to its /64, because one customer
// normally owns a whole /64 (2^64 addresses) and could otherwise dodge every per-address limit by rotating.
export function netKey(raw) {
  let s = String(raw || 'unknown').trim().toLowerCase().split('%')[0];
  if (!s.includes(':')) return s.slice(0, 64);
  const mapped = s.match(/^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/); // IPv4-mapped IPv6 is still an IPv4 address
  if (mapped) return mapped[1];
  // A trailing dotted quad is two hex groups.
  s = s.replace(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, (_, a, b, c, d) => ((+a << 8) | +b).toString(16) + ':' + ((+c << 8) | +d).toString(16));
  const halves = s.split('::');
  if (halves.length > 2) return s.slice(0, 64);
  const head = halves[0] ? halves[0].split(':') : [], tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = head.concat(Array(Math.max(0, fill)).fill('0'), tail);
  if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return s.slice(0, 64);
  return groups.slice(0, 4).map(g => g.padStart(4, '0')).join(':') + '::/64';
}

// Escalating backoff: the first `free` wrong tries cost nothing, then each further one doubles the wait
// (base, 2 x base, 4 x base ...) up to `cap` seconds. `before` is the number of earlier tries in the window.
export function lockSeconds(before, free, base, cap) {
  if (before < free) return 0;
  return Math.min(cap, base * 2 ** Math.min(30, before - free));
}

export function waitText(seconds) {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return s + ' seconds';
  if (s < 5400) return Math.ceil(s / 60) + ' minutes';
  return Math.ceil(s / 3600) + ' hours';
}
