// POST   /api/roster {code, name}            -> adds a saved player to the club
// DELETE /api/roster?code=ABC123&name=Ana    -> removes a saved player (their games stay)
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanName } from './_db.js';

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://x');
    const code = cleanCode(url.searchParams.get('code'));
    await requireClub(code, req);
    const name = cleanName(url.searchParams.get('name'));
    // A name someone has claimed holds their shop items and equipped looks, so it stays until an organizer releases it.
    const rows = await sql`DELETE FROM roster WHERE club = ${code} AND name_key = ${name.toLowerCase()} AND claim_hash IS NULL RETURNING name`;
    if (!rows.length) {
      const [claimed] = await sql`SELECT 1 FROM roster WHERE club = ${code} AND name_key = ${name.toLowerCase()}`;
      if (claimed) throw fail(409, `${name} is linked to a player's phone, so it can't be removed. An organizer can release it first.`);
    }
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const code = cleanCode(body.code);
  await requireClub(code, req);
  const name = cleanName(body.name);
  if (!name) throw fail(400, 'Enter a name.');
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM roster WHERE club = ${code}`;
  if (n >= 300) throw fail(400, 'A club can save up to 300 players.');
  await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${name.toLowerCase()}, ${name}) ON CONFLICT DO NOTHING`;
  send(res, 200, { ok: true });
});
