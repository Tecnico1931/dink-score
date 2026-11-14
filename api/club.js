// GET  /api/club?code=ABC123        -> club name, games (newest first), saved players, recently deleted
// POST /api/club {name}             -> creates a club, returns its code
import { db, handler, send, readBody, fail, newCode, cleanCode, requireClub } from './_db.js';

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) throw fail(400, 'Give your club a name.');
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const rows = await sql`INSERT INTO clubs (code, name) VALUES (${code}, ${name}) ON CONFLICT DO NOTHING RETURNING code, name`;
      if (rows.length) return send(res, 201, { club: rows[0] });
    }
    throw fail(500, 'Could not create a club code.');
  }
  if (req.method !== 'GET') throw fail(405, 'Method not allowed.');
  const url = new URL(req.url, 'http://x');
  const code = cleanCode(url.searchParams.get('code'));
  const club = await requireClub(code, req);
  const [games, deleted, roster] = await Promise.all([
    sql`SELECT data FROM games WHERE club = ${code} AND deleted_at IS NULL ORDER BY ended_at DESC LIMIT 2000`,
    sql`SELECT data, deleted_at FROM games WHERE club = ${code} AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC LIMIT 50`,
    sql`SELECT name FROM roster WHERE club = ${code} ORDER BY lower(name) LIMIT 300`
  ]);
  send(res, 200, {
    club,
    games: games.map(r => r.data),
    deleted: deleted.map(r => Object.assign({}, r.data, { deletedAt: new Date(r.deleted_at).getTime() })),
    roster: roster.map(r => r.name)
  });
});
