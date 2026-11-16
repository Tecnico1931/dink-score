// GET  /api/club?code=ABC123                         -> club name, whether it has a PIN, games (newest first), saved players, recently deleted
// POST /api/club {name, pin?}                        -> creates a club with an organizer PIN (the one given, or a generated 8-digit organizer code returned once as organizerCode), returns its code
// POST /api/club {code, action: 'rotate-code', pin?, ownerToken?, graceMinutes?} -> organizer only: gives the club a new code; the old one keeps working for graceMinutes (default 60, at most 1440), then stops
// POST /api/club {code, action: 'verify-pin', pin}   -> checks an organizer PIN
// POST /api/club {code, action: 'reset-allowance', pin|ownerToken} -> organizer: ends a "too many games just now" pause
// GET  /api/club?code=ABC123&avatars=1               -> the photo avatars, kept out of the main response: {photos: {name: {v, value}}}
// POST /api/club {code, action: 'set-pin', pin, oldPin?, ownerToken?} -> sets the organizer PIN (the first needs the creator token; changing needs the current PIN)
import { db, handler, send, readBody, fail, newCode, cleanCode, requireClub, publicClub, codeTaken, requireOrganizer, cleanPin, hashPin, requirePin, deviceKey, throttleClubCreate, resetAllowance, MAX_LIVE_GAMES, MAX_PHOTOS, newOwnerToken, hashToken, tokenMatches, cleanName } from './_db.js';
import { randomInt } from 'node:crypto';
import { duprFrom } from './_dupr.js';
import { XP, LEVEL_MAX, PRESTIGE_DINKS, CATALOG, EARN, SPIN_WHEEL, shopSettings, computeProgress, ACHIEVEMENTS, CHALLENGES, challengesFor, weekOf, seasonOf, SEASON_PRIZES, SEASON_MIN_GAMES } from './_dinks.js';

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
    season: Object.assign({}, season, { prizes: SEASON_PRIZES, minGames: SEASON_MIN_GAMES }),
    levels: { xp: XP, max: LEVEL_MAX, prestigeDinks: PRESTIGE_DINKS }
  };
}

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'reset-allowance') {
      const club = await requireClub(cleanCode(body.code), req);
      await requireOrganizer(club, body.pin, req, body.ownerToken);
      await resetAllowance(club.code);
      const [n] = await sql`SELECT count(*)::int AS live FROM games WHERE club = ${club.code} AND deleted_at IS NULL`;
      return send(res, 200, { ok: true, games: Number(n.live), limit: MAX_LIVE_GAMES });
    }
    if (body.action === 'verify-pin' || body.action === 'set-pin' || body.action === 'rotate-code') {
      const club = await requireClub(cleanCode(body.code), req);
      const code = club.code; // permanent key
      if (body.action === 'verify-pin') {
        if (!club.pin_hash) throw fail(400, "This club doesn't have an organizer PIN yet.");
        await requirePin(club, body.pin, req);
        // deviceKey: lets this phone keep working when others guess wrong (see requirePin). shortPin: this PIN predates
        // the 6-digit minimum, so the app asks the organizer to change it.
        return send(res, 200, { ok: true, deviceKey: deviceKey(club), shortPin: String(body.pin).split(':')[0].length < 6 });
      }
      if (body.action === 'rotate-code') {
        await requireOrganizer(club, body.pin, req, body.ownerToken);
        const grace = body.graceMinutes === undefined ? 60 : Math.trunc(Number(body.graceMinutes));
        if (!Number.isFinite(grace) || grace < 0 || grace > 1440) throw fail(400, 'The overlap must be between 0 and 1,440 minutes.');
        const current = club.public_code || club.code;
        let fresh = null;
        for (let i = 0; i < 8 && !fresh; i++) { const c = newCode(); if (!(await codeTaken(sql, c))) fresh = c; }
        if (!fresh) throw fail(500, 'Could not create a club code.');
        // Retire the old code first, then switch: a failure in between leaves the club on its old code.
        const until = await sql`INSERT INTO club_aliases (code, club, expires_at) VALUES (${current}, ${code}, now() + ${grace + ' minutes'}::interval) ON CONFLICT (code) DO UPDATE SET expires_at = EXCLUDED.expires_at RETURNING expires_at`;
        const rows = await sql`UPDATE clubs SET public_code = ${fresh} WHERE code = ${code} AND coalesce(public_code, code) = ${current} RETURNING code, name, pin_hash, owner_hash, public_code`;
        if (!rows.length) throw fail(409, 'The club code was just changed by someone else. Reload and check the new code.');
        return send(res, 200, { ok: true, club: publicClub(rows[0]), oldCode: current, oldCodeUntil: new Date(until[0].expires_at).getTime() });
      }
      const pin = cleanPin(body.pin);
      if (club.pin_hash) {
        // Changing a PIN needs the current one.
        await requirePin(club, body.oldPin, req, body.ownerToken); // the creating phone can reset a forgotten PIN
        const pinHash = hashPin(pin);
        await sql`UPDATE clubs SET pin_hash = ${pinHash} WHERE code = ${code}`;
        return send(res, 200, { ok: true, club: Object.assign(publicClub(club), { hasPin: true, openClaim: false }), deviceKey: deviceKey({ code, pin_hash: pinHash }) });
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
      const pinHash = hashPin(pin);
      const rows = ownerToken
        ? await sql`UPDATE clubs SET pin_hash = ${pinHash}, owner_hash = ${hashToken(ownerToken)} WHERE code = ${code} AND pin_hash IS NULL AND owner_hash IS NULL RETURNING code`
        : await sql`UPDATE clubs SET pin_hash = ${pinHash} WHERE code = ${code} AND pin_hash IS NULL RETURNING code`;
      if (!rows.length) throw fail(409, 'Someone just set a PIN for this club. Ask your organizer for it.');
      return send(res, 200, { ok: true, club: Object.assign(publicClub(club), { hasPin: true, openClaim: false }), deviceKey: deviceKey({ code, pin_hash: pinHash }), ...(ownerToken ? { ownerToken } : {}) });
    }
    const name = cleanName(body.name); // same cleanup as player names: no control or invisible characters
    if (!name) throw fail(400, 'Give your club a name.');
    // Every new club has an organizer credential: the PIN given, or a generated 8-digit organizer code shown once.
    const organizerCode = body.pin ? null : String(randomInt(0, 1e8)).padStart(8, '0');
    const pinPlain = organizerCode || cleanPin(body.pin); // a bad PIN is refused before it uses up a creation
    await throttleClubCreate(req);
    const pinHash = hashPin(pinPlain);
    const ownerToken = newOwnerToken();
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      if (await codeTaken(sql, code)) continue;
      const rows = await sql`INSERT INTO clubs (code, name, pin_hash, owner_hash) VALUES (${code}, ${name}, ${pinHash}, ${hashToken(ownerToken)}) ON CONFLICT DO NOTHING RETURNING code, name, pin_hash, owner_hash, public_code`;
      if (rows.length) return send(res, 201, { club: publicClub(rows[0]), ownerToken, ...(organizerCode ? { organizerCode } : {}) });
    }
    throw fail(500, 'Could not create a club code.');
  }
  if (req.method !== 'GET') throw fail(405, 'Method not allowed.');
  const url = new URL(req.url, 'http://x');
  const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
  const code = club.code;
  if (url.searchParams.get('avatars')) {
    // Photos are the only large part of a player, so they come separately; `v` is a short fingerprint the app compares
    // with the one in the main response to know when a cached photo is stale.
    const rows = await sql`SELECT name, left(md5(avatar->>'value'), 8) AS v, avatar->>'value' AS value FROM roster WHERE club = ${code} AND avatar->>'type' = 'photo' LIMIT ${MAX_PHOTOS}`;
    return send(res, 200, { photos: Object.fromEntries(rows.map(r => [r.name, { v: r.v, value: r.value }])) });
  }
  const [games, deleted, roster, purchases, [shopRow]] = await Promise.all([
    sql`SELECT data FROM games WHERE club = ${code} AND deleted_at IS NULL ORDER BY ended_at DESC LIMIT 2000`,
    sql`SELECT data, deleted_at FROM games WHERE club = ${code} AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC LIMIT 50`,
    sql`SELECT name, claim_hash IS NOT NULL AS claimed, equipped, CASE WHEN avatar->>'type' = 'photo' THEN jsonb_build_object('type', 'photo', 'v', left(md5(avatar->>'value'), 8)) ELSE avatar END AS avatar, prestige, dupr_rating FROM roster WHERE club = ${code} ORDER BY lower(name) LIMIT 300`,
    sql`SELECT id, name_key, item_id, item_name, price, is_reward, given_at, created_at FROM purchases WHERE club = ${code} ORDER BY id LIMIT 5000`,
    sql`SELECT shop FROM clubs WHERE code = ${code}`
  ]);
  send(res, 200, {
    club: publicClub(club),
    games: games.map(r => r.data),
    deleted: deleted.map(r => Object.assign({}, r.data, { deletedAt: new Date(r.deleted_at).getTime() })),
    roster: roster.map(r => r.name),
    // Shop: who has claimed a name (never the claim itself), what everyone wears and has bought, and the club's settings.
    players: roster.map(r => ({ name: r.name, claimed: r.claimed, equipped: r.equipped || {}, avatar: r.avatar || null, prestige: r.prestige || null, dupr: duprFrom(r.dupr_rating) })),
    purchases: purchases.map(p => ({ id: Number(p.id), player: p.name_key, itemId: p.item_id, itemName: p.item_name, price: p.price, reward: p.is_reward, givenAt: p.given_at ? new Date(p.given_at).getTime() : null, at: new Date(p.created_at).getTime() })),
    shop: Object.assign({ catalog: CATALOG, earn: EARN, spinWheel: SPIN_WHEEL }, shopSettings(shopRow && shopRow.shop), { configured: !!(shopRow && shopRow.shop) }),
    progress: progressFor(games.map(r => r.data))
  });
});
