// POST   /api/roster {code, name}            -> adds a saved player to the club
// DELETE /api/roster?code=ABC123&name=Ana    -> removes a saved player (their games stay). In a club with a PIN this
//                                                needs the PIN (X-Club-PIN) or the creating phone's token (X-Club-Owner).
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanName, nameKey, similarNames, requirePin, pinFrom, ownerFrom } from './_db.js';

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://x');
    const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
    const code = club.code; // the club's permanent key, even when an old club code was used
    await requirePin(club, pinFrom(req), req, ownerFrom(req));
    const name = cleanName(url.searchParams.get('name'));
    // A name someone has claimed holds their picture and DUPR number, so it stays until an organizer releases it.
    const rows = await sql`DELETE FROM roster WHERE club = ${code} AND name_key = ${nameKey(name)} AND claim_hash IS NULL RETURNING name`;
    if (!rows.length) {
      const [claimed] = await sql`SELECT 1 FROM roster WHERE club = ${code} AND name_key = ${nameKey(name)}`;
      if (claimed) throw fail(409, `${name} is linked to a player's phone, so it can't be removed. An organizer can release it first.`);
    }
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used
  const name = cleanName(body.name);
  if (!name) throw fail(400, 'Enter a name.');
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM roster WHERE club = ${code}`;
  if (n >= 300) throw fail(400, 'A club can save up to 300 players.');
  // A new name that looks like a saved one ("Jose" / "José") is held back until the caller confirms it is a different person.
  if (body.confirmNew !== true) {
    const saved = await sql`SELECT name, name_key FROM roster WHERE club = ${code}`;
    if (!saved.some(r => r.name_key === nameKey(name))) {
      const similar = similarNames(name, saved.map(r => r.name));
      if (similar.length) throw Object.assign(fail(409, `Did you mean ${similar[0]}? Add ${name} only if they are a different person.`), { extra: { similar } });
    }
  }
  await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${nameKey(name)}, ${name}) ON CONFLICT DO NOTHING`;
  send(res, 200, { ok: true });
});
