// GET  /api/club?code=ABC123                         -> club name, whether it has a PIN, games (newest first), saved players, recently deleted
// POST /api/club {name, pin?}                        -> creates a club (optionally with an organizer PIN), returns its code
// POST /api/club {code, action: 'verify-pin', pin}   -> checks an organizer PIN
// POST /api/club {code, action: 'set-pin', pin, oldPin?, ownerToken?} -> sets the organizer PIN (the first needs the creator token; changing needs the current PIN)
import { db, handler, send, readBody, fail, newCode, cleanCode, requireClub, publicClub, cleanPin, hashPin, requirePin, newOwnerToken, hashToken, tokenMatches, cleanName } from './_db.js';
import { CATALOG, EARN, shopSettings, computeProgress, ACHIEVEMENTS, CHALLENGES, challengesFor, weekOf, seasonOf, SEASON_PRIZES, SEASON_MIN_GAMES } from './_dinks.js';

// Achievements, this week's challenges, trophies and Dinks (base + bonuses) for every player, as the server counts them.
function progressFor(games) {
  const now = Date.now(), week = weekOf(now), season = seasonOf(now);
  const players = {};
  for (const [k, p] of computeProgress(games, now)) {
    players[k] = { name: p.name, earned: p.earned, base: p.base, bonus: p.bonus, achievements: p.achievements, trophies: p.trophies, week: p.weeks[week.id] || null };
  }
  return {
    players,
    achievements: ACHIEVEMENTS,
    week: { id: week.id, end: week.end, challenges: challengesFor(week.id) },
    challenges: CHALLENGES,
    season: Object.assign({}, season, { prizes: SEASON_PRIZES, minGames: SEASON_MIN_GAMES })
  };
}

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
      const pin = cleanPin(body.pin);
      if (club.pin_hash) {
        // Changing a PIN needs the current one.
        await requirePin(club, body.oldPin, req, body.ownerToken); // the creating phone can reset a forgotten PIN
        await sql`UPDATE clubs SET pin_hash = ${hashPin(pin)} WHERE code = ${code}`;
        return send(res, 200, { ok: true, club: { code, name: club.name, hasPin: true, openClaim: false } });
      }
      // The first PIN: only the phone that created the club (it holds the creator token) may set it.
      // Older clubs made before creator tokens existed can be claimed once by any member, who then becomes the creator.
      let ownerToken = null;
      if (club.owner_hash) {
        if (!tokenMatches(club.owner_hash, body.ownerToken)) throw fail(403, 'Only the phone that created this club can set its first organizer PIN.');
      } else {
        ownerToken = newOwnerToken();
      }
      // Atomic: succeeds only while the club still has no PIN, so two people can't both set the first one.
      const rows = ownerToken
        ? await sql`UPDATE clubs SET pin_hash = ${hashPin(pin)}, owner_hash = ${hashToken(ownerToken)} WHERE code = ${code} AND pin_hash IS NULL AND owner_hash IS NULL RETURNING code`
        : await sql`UPDATE clubs SET pin_hash = ${hashPin(pin)} WHERE code = ${code} AND pin_hash IS NULL RETURNING code`;
      if (!rows.length) throw fail(409, 'Someone just set a PIN for this club. Ask your organizer for it.');
      return send(res, 200, { ok: true, club: { code, name: club.name, hasPin: true, openClaim: false }, ...(ownerToken ? { ownerToken } : {}) });
    }
    const name = cleanName(body.name); // same cleanup as player names: no control or invisible characters
    if (!name) throw fail(400, 'Give your club a name.');
    const pinHash = body.pin ? hashPin(cleanPin(body.pin)) : null;
    const ownerToken = newOwnerToken();
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const rows = await sql`INSERT INTO clubs (code, name, pin_hash, owner_hash) VALUES (${code}, ${name}, ${pinHash}, ${hashToken(ownerToken)}) ON CONFLICT DO NOTHING RETURNING code, name, pin_hash, owner_hash`;
      if (rows.length) return send(res, 201, { club: publicClub(rows[0]), ownerToken });
    }
    throw fail(500, 'Could not create a club code.');
  }
  if (req.method !== 'GET') throw fail(405, 'Method not allowed.');
  const url = new URL(req.url, 'http://x');
  const code = cleanCode(url.searchParams.get('code'));
  const club = await requireClub(code, req);
  const [games, deleted, roster, purchases, [shopRow]] = await Promise.all([
    sql`SELECT data FROM games WHERE club = ${code} AND deleted_at IS NULL ORDER BY ended_at DESC LIMIT 2000`,
    sql`SELECT data, deleted_at FROM games WHERE club = ${code} AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC LIMIT 50`,
    sql`SELECT name, claim_hash IS NOT NULL AS claimed, equipped, avatar FROM roster WHERE club = ${code} ORDER BY lower(name) LIMIT 300`,
    sql`SELECT id, name_key, item_id, item_name, price, is_reward, given_at, created_at FROM purchases WHERE club = ${code} ORDER BY id LIMIT 5000`,
    sql`SELECT shop FROM clubs WHERE code = ${code}`
  ]);
  send(res, 200, {
    club: publicClub(club),
    games: games.map(r => r.data),
    deleted: deleted.map(r => Object.assign({}, r.data, { deletedAt: new Date(r.deleted_at).getTime() })),
    roster: roster.map(r => r.name),
    // Shop: who has claimed a name (never the claim itself), what everyone wears and has bought, and the club's settings.
    players: roster.map(r => ({ name: r.name, claimed: r.claimed, equipped: r.equipped || {}, avatar: r.avatar || null })),
    purchases: purchases.map(p => ({ id: Number(p.id), player: p.name_key, itemId: p.item_id, itemName: p.item_name, price: p.price, reward: p.is_reward, givenAt: p.given_at ? new Date(p.given_at).getTime() : null, at: new Date(p.created_at).getTime() })),
    shop: Object.assign({ catalog: CATALOG, earn: EARN }, shopSettings(shopRow && shopRow.shop)),
    progress: progressFor(games.map(r => r.data))
  });
});
