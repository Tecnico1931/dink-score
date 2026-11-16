// The public, read-only page for one shared game or session, for anyone holding the link: no club code, no PIN, no cookies.
//   GET /api/result?token=<token>            -> JSON (publicView of the game or session)
//   GET /api/result?token=<token>&fmt=html   -> the page, with Open Graph / Twitter preview tags (served at /r/<token>)
//   GET /api/result?token=<token>&fmt=png    -> the 1200x630 result card (served at /r/<token>/card.png)
// Everything comes from _result.js, which copies fields one by one. A bad, revoked or unknown token, a club with sharing
// turned off, a club waiting to be deleted, a deleted game, or a game held for confirmation all get the same 404.
// Limited to 60 requests a minute per network, and cached at the edge for 20 seconds (so a revoked link may still load for that long).
import { db, handler, fail, send, clientIp, purgeMarks } from './_db.js';
import { isShareToken } from './_share.js';
import { gameView, sessionView, pageHTML, deadHTML, preview, cardModel, safeOrigin } from './_result.js';
import { gameCard, sessionCard } from './_card.js';

const MAX_PER_MINUTE = 60;

async function throttle(sql, req) {
  await purgeMarks(sql);
  const key = 'res:' + clientIp(req);
  const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '1 minute'`;
  if (Number(n) > MAX_PER_MINUTE) { await sql`DELETE FROM lookup_fails WHERE id = ${id}`; throw fail(429, 'Too many requests. Try again in a minute.'); }
}

export async function load(sql, token) {
  const [s] = await sql`SELECT s.club, s.kind, s.game, s.from_ms, s.to_ms, c.require_confirmation FROM result_shares s JOIN clubs c ON c.code = s.club
    WHERE s.token = ${token} AND c.public_results AND c.delete_at IS NULL`;
  if (!s) return null;
  if (s.kind === 'game') {
    const [g] = await sql`SELECT data, rally_log, confirmed_by FROM games WHERE club = ${s.club} AND id = ${s.game} AND deleted_at IS NULL`;
    if (!g || (s.require_confirmation && !g.confirmed_by)) return null;
    return gameView(g.data, g.rally_log);
  }
  const rows = await sql`SELECT data FROM games WHERE club = ${s.club} AND deleted_at IS NULL AND ended_at >= ${Number(s.from_ms)} AND ended_at < ${Number(s.to_ms)}
    AND (${!s.require_confirmation} OR confirmed_by IS NOT NULL) ORDER BY ended_at ASC LIMIT 60`;
  return rows.length ? sessionView(rows.map(r => r.data), Number(s.from_ms), Number(s.to_ms)) : null;
}

export default handler(async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw fail(405, 'Method not allowed.'); }
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token'), fmt = url.searchParams.get('fmt') || 'json';
  const sql = db();
  await throttle(sql, req);
  const v = isShareToken(token) ? await load(sql, token) : null;
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!v) {
    if (fmt === 'html') { res.statusCode = 404; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10'); return res.end(deadHTML()); }
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10');
    throw fail(404, 'This link is not active.');
  }
  res.statusCode = 200;
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20');
  if (fmt === 'html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(pageHTML(v, token, safeOrigin(req))); }
  if (fmt === 'png') { res.setHeader('Content-Type', 'image/png'); return res.end((v.kind === 'game' ? gameCard : sessionCard)(cardModel(v))); }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ...v, title: preview(v).title }));
});
