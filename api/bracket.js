// The public, read-only view of one event, for spectators and TV screens: GET /api/bracket?token=<share token>
// The token is the only thing asked for: no club code, no PIN, no cookies. What comes back is whatever publicView()
// in _share.js lists, so nothing private can leak. Every bad, revoked or unknown token gets the same 404.
import { db, handler, fail } from './_db.js';
import { isShareToken, publicView } from './_share.js';
import { servePublic } from './_resultpublic.js';

const NOT_FOUND = 'This bracket link is not active.';

export default handler(async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw fail(405, 'Method not allowed.'); }
  const q = new URL(req.url, 'http://x').searchParams;
  if (q.get('result')) return servePublic(req, res); // shared game/session pages (/r/<token>) ride on this function: the hosting plan caps their number
  const token = q.get('token');
  if (!isShareToken(token)) throw fail(404, NOT_FOUND);
  const [row] = await db()`SELECT data FROM events WHERE share_token = ${token} AND deleted_at IS NULL`;
  if (!row) throw fail(404, NOT_FOUND);
  // A few seconds of shared cache is plenty for a screen that polls, and keeps a crowd of spectators cheap.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=20');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end(JSON.stringify(publicView(row.data)));
});
