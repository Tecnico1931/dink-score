// Optional error reporting. Off unless ERROR_REPORT_URL (an https endpoint that accepts a JSON POST) is set in the
// environment; no vendor SDK or key lives in the repo. Reports carry no club codes, names or request bodies.
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

// Shape one report from untrusted input (the browser) or a server Error. Pure, so it is tested without a network.
export function cleanReport(kind, raw = {}) {
  return {
    kind: kind === 'client' ? 'client' : 'server',
    message: clip(raw.message, 500),
    stack: clip(raw.stack, 2000),
    source: clip(String(raw.source || '').split(/[?#]/)[0], 200), // never the query: it can hold a club code
    line: Number.isFinite(+raw.line) ? +raw.line : 0,
    col: Number.isFinite(+raw.col) ? +raw.col : 0,
    page: clip(String(raw.page || '').split(/[?#]/)[0], 200),
    at: new Date().toISOString()
  };
}

export const reportingOn = () => /^https:\/\//.test(process.env.ERROR_REPORT_URL || '');

let sent = 0, windowStart = 0;
const MAX_PER_MINUTE = 30; // per server instance: a crash loop must not flood the endpoint

export async function reportError(kind, raw) {
  if (!reportingOn()) return false;
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; sent = 0; }
  if (++sent > MAX_PER_MINUTE) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    await fetch(process.env.ERROR_REPORT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cleanReport(kind, raw)), signal: ctl.signal });
    clearTimeout(t);
    return true;
  } catch { return false; } // reporting must never break a request
}
