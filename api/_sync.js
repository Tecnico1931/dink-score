// Sync v2: conditional requests for the answers phones and displays poll. Not a route (files starting with "_").
// An answer carries an ETag; a poller that sends it back in If-None-Match gets an empty 304 when nothing changed, which is
// nearly every poll. Callers always pass the club's permanent key as `scope`, and the tag is a hash that includes it, so a tag
// from one club never matches another's answer. Answers stay `Cache-Control: no-store` (no shared cache may keep club data);
// the app sends If-None-Match itself. A client that sends no tag gets the same full answer as before.
import { createHash } from 'node:crypto';

export const SYNC_V = 3; // bump when an answer's shape changes, so every held tag stops matching
export const BUCKET_MS = 10 * 60 * 1000; // answers that depend on the clock (ratings reliability) are refreshed at least this often

export const tagOf = (scope, text) => 'W/"' + createHash('sha256').update(`${SYNC_V}|${scope}|${text}`).digest('base64url').slice(0, 24) + '"';

export function sameTag(req, tag) {
  const h = (req.headers || {})['if-none-match'];
  return typeof h === 'string' && h.split(',').some(t => t.trim() === tag);
}

// 304 with no body. `cache` is the Cache-Control to send (default: never stored).
export function notModified(res, tag, cache = 'no-store') {
  res.statusCode = 304;
  res.setHeader('ETag', tag);
  res.setHeader('Cache-Control', cache);
  res.end();
}

// Sends `body` as JSON with an ETag made from it, or a 304 when the caller already holds exactly this answer.
export function replyTagged(req, res, scope, body) {
  const text = JSON.stringify(body), tag = tagOf(scope, text);
  if (sameTag(req, tag)) return notModified(res, tag);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('ETag', tag);
  res.end(text);
}

// The club answer's change digest, worked out inside the database so a poll that finds nothing new moves no rows to the
// server. It covers exactly what GET /api/club sends: the same game, deleted, roster and rename sets (same limits).
export async function clubDigest(sql, code) {
  const [r] = await sql`SELECT md5(concat_ws('#',
    (SELECT coalesce(string_agg(h, ',' ORDER BY ended_at DESC, id), '') FROM (SELECT ended_at, id, md5(concat_ws('|', data::text, rally_log IS NOT NULL, confirmed_by, confirmed_at::text, dup_ok)) AS h
      FROM games WHERE club = ${code} AND deleted_at IS NULL ORDER BY ended_at DESC, id LIMIT 2000) g),
    (SELECT coalesce(string_agg(h, ',' ORDER BY deleted_at DESC, id), '') FROM (SELECT id, deleted_at, md5(concat_ws('|', data::text, deleted_at::text)) AS h
      FROM games WHERE club = ${code} AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC, id LIMIT 50) d),
    (SELECT coalesce(string_agg(h, ',' ORDER BY lower(name)), '') FROM (SELECT name, md5(concat_ws('|', name, claim_hash IS NOT NULL, role, CASE WHEN avatar->>'type' = 'photo' THEN md5(avatar->>'value') ELSE avatar::text END, dupr_rating::text)) AS h
      FROM roster WHERE club = ${code} ORDER BY lower(name) LIMIT 300) r),
    (SELECT coalesce(string_agg(h, ',' ORDER BY at DESC, old_key), '') FROM (SELECT old_key, at, md5(concat_ws('|', old_key, new_name)) AS h
      FROM name_changes WHERE club = ${code} AND at > now() - interval '90 days' ORDER BY at DESC, old_key LIMIT 100) n),
    (SELECT coalesce(string_agg(h, ',' ORDER BY game_id, reaction, name_key), '') FROM (SELECT r.game_id, r.reaction, r.name_key, md5(concat_ws('|', r.game_id, r.reaction, r.name)) AS h
      FROM game_reactions r JOIN (SELECT id FROM games WHERE club = ${code} AND deleted_at IS NULL ORDER BY ended_at DESC, id LIMIT 2000) g ON g.id = r.game_id WHERE r.club = ${code}) rx)
  )) AS d`;
  return r.d;
}
