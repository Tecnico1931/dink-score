// GET  /api/club?code=ABC123                         -> club name, whether it has a PIN, games (newest first), saved players, recently deleted
// POST /api/club {name, pin?}                        -> creates a club (optionally with an organizer PIN), returns its code
// POST /api/club {code, action: 'verify-pin', pin}   -> checks an organizer PIN
// POST /api/club {code, action: 'set-pin', pin, oldPin?} -> sets the organizer PIN (the current PIN is needed to change one)
import { db, handler, send, readBody, fail, newCode, cleanCode, requireClub, publicClub, cleanPin, hashPin, requirePin } from './_db.js';

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'verify-pin' || body.action === 'set-pin') {
      const code = cleanCode(body.code);
      const club = await requireClub(code, req);
      if (body.action === 'verify-pin') {
        if (!club.pin_hash) throw fail(400, "This club doesn't have an organizer PIN yet.");
        await requirePin(club, body.pin, req);
        return send(res, 200, { ok: true });
      }
      await requirePin(club, body.oldPin, req); // no-op when the club has no PIN yet
      const pin = cleanPin(body.pin);
      await sql`UPDATE clubs SET pin_hash = ${hashPin(pin)} WHERE code = ${code}`;
      return send(res, 200, { ok: true, club: { code, name: club.name, hasPin: true } });
    }
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) throw fail(400, 'Give your club a name.');
    const pinHash = body.pin ? hashPin(cleanPin(body.pin)) : null;
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const rows = await sql`INSERT INTO clubs (code, name, pin_hash) VALUES (${code}, ${name}, ${pinHash}) ON CONFLICT DO NOTHING RETURNING code, name, pin_hash`;
      if (rows.length) return send(res, 201, { club: publicClub(rows[0]) });
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
    club: publicClub(club),
    games: games.map(r => r.data),
    deleted: deleted.map(r => Object.assign({}, r.data, { deletedAt: new Date(r.deleted_at).getTime() })),
    roster: roster.map(r => r.name)
  });
});
