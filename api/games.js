// POST   /api/games {code, games:[...]}      -> saves one or more games (uploads use up to 500 at once)
// POST   /api/games {code, restore: id}      -> brings back a deleted game (kept for 30 days)
// DELETE /api/games?code=ABC123&id=g123      -> moves a game to recently deleted
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanGame, cleanName } from './_db.js';

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://x');
    const code = cleanCode(url.searchParams.get('code'));
    await requireClub(code);
    const id = String(url.searchParams.get('id') || '');
    const rows = await sql`UPDATE games SET deleted_at = now() WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That game was already deleted.');
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const code = cleanCode(body.code);
  await requireClub(code);

  if (body.restore) {
    const rows = await sql`UPDATE games SET deleted_at = NULL WHERE club = ${code} AND id = ${String(body.restore)} RETURNING id`;
    if (!rows.length) throw fail(404, 'That game can no longer be restored.');
    return send(res, 200, { ok: true });
  }

  const list = Array.isArray(body.games) ? body.games : [];
  if (!list.length) throw fail(400, 'No games to save.');
  if (list.length > 500) throw fail(400, 'Upload at most 500 games at a time.');

  // Basic flood protection: one-at-a-time saves are capped at 300 per club per 10 minutes.
  // (A single bulk upload of up to 500 is allowed, so moving an existing record over always works.)
  if (list.length === 1) {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM games WHERE club = ${code} AND created_at > now() - interval '10 minutes'`;
    if (n >= 300) throw fail(429, 'Too many games were added just now. Wait a few minutes and try again.');
  }

  const games = list.map(cleanGame);
  const names = new Map();
  for (const g of games) {
    await sql`INSERT INTO games (club, id, data, ended_at) VALUES (${code}, ${g.id}, ${JSON.stringify(g)}::jsonb, ${g.endedAt})
              ON CONFLICT (club, id) DO NOTHING`;
    for (const p of g.teams.flat()) if (!/^Player \d+$/.test(p)) names.set(p.toLowerCase(), p);
  }
  for (const [key, name] of names) {
    await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${key}, ${cleanName(name)}) ON CONFLICT DO NOTHING`;
  }
  send(res, 200, { ok: true, saved: games.length });
});
