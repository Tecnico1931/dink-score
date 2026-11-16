// POST /api/report {message, stack, source, line, col, page}: the browser's window.onerror / unhandledrejection reports.
// Forwarded to ERROR_REPORT_URL when set (see api/_report.js); otherwise accepted and dropped. Never touches the database.
import { readBody, send, fail, clientIp } from './_db.js';
import { reportError, reportingOn } from './_report.js';

const seen = new Map(); // address -> {n, t}: 10 reports per minute per address, per server instance
export default async function (req, res) {
  try {
    if (req.method !== 'POST') throw fail(405, 'Use POST.');
    if (!reportingOn()) { res.statusCode = 204; return res.end(); }
    const ip = clientIp(req), now = Date.now();
    const s = seen.get(ip) && now - seen.get(ip).t < 60000 ? seen.get(ip) : { n: 0, t: now };
    seen.set(ip, s);
    if (seen.size > 5000) seen.clear();
    if (++s.n > 10) { res.statusCode = 204; return res.end(); }
    const body = await readBody(req);
    await reportError('client', body && typeof body === 'object' ? body : {});
    res.statusCode = 204; res.end();
  } catch (err) { send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.' }); }
}
