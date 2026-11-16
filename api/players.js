// POST /api/players — a club's saved players: linking a name to a phone, pictures, levels and self-reported DUPR numbers.
// Body: {code, action, ...}
//   claim    {name, pin?|ownerToken?}                 -> links a player name to this phone, returns {playerToken}
//   prestige {name, playerToken}                     -> a maxed-out player starts their level again and keeps a star
//   avatar   {name, playerToken, avatar}              -> sets your picture: {type: emoji|icon|photo, value} or {type: initials}
//   clear-avatar {pin|ownerToken, name}               -> organizer: put a player back to initials
//   dupr     {name, rating, playerToken|pin|ownerToken} -> sets or clears (empty rating) a self-reported DUPR number: that
//                                                       name's phone or an organizer only. Display only.
//   release  {pin|ownerToken, name}                  -> organizer: free a claimed name (new phone, or a mistake)
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanName, requireOrganizer, newOwnerToken, hashToken, tokenMatches, clientIp, MAX_PHOTOS } from './_db.js';
import { cleanDupr } from './_dupr.js';
import { computeXP, levelFrom } from './_progress.js';

const MAX_CLAIMS_PER_DAY = 3; // names one network can link to phones per club per day without an organizer

async function requirePlayer(sql, code, name, token) {
  const k = cleanName(name).toLowerCase();
  const [row] = await sql`SELECT name, name_key, claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
  if (!row || !row.claim_hash || !tokenMatches(row.claim_hash, token)) throw fail(403, 'This phone isn\'t linked to that player. Pick your name in the club first.');
  return row;
}
// Avatars: only these shapes are stored, so nothing else can reach other people's screens.
export const AVATAR_ICONS = ['paddle', 'ball', 'paddles', 'net', 'court', 'trophy', 'pickle', 'lightning', 'flame', 'target'];
const MAX_PHOTO = 60000; // characters of base64: a 160px JPEG is usually 6-15 KB
function cleanAvatar(a) {
  if (!a || typeof a !== 'object' || a.type === 'initials') return null;
  const value = String(a.value || '');
  if (a.type === 'icon') {
    if (!AVATAR_ICONS.includes(value)) throw fail(400, 'Pick one of the icons.');
    return { type: 'icon', value };
  }
  if (a.type === 'emoji') {
    // One emoji (it may be several code points, like a flag or skin tone), and nothing else.
    const ok = value.length > 0 && value.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value)
      && !/[\p{L}\p{N}\s<>&"'`]/u.test(value.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, ''));
    const graphemes = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length : 1;
    if (!ok || graphemes !== 1) throw fail(400, 'Pick a single emoji.');
    return { type: 'emoji', value };
  }
  if (a.type === 'photo') {
    if (!/^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)) throw fail(400, 'That photo could not be used. Try a different picture.');
    if (value.length > MAX_PHOTO) throw fail(400, 'That photo is too large. Try a different picture.');
    return { type: 'photo', value };
  }
  throw fail(400, 'Unknown avatar type.');
}
async function clubGames(sql, code) {
  return (await sql`SELECT data FROM games WHERE club = ${code} AND deleted_at IS NULL`).map(r => r.data);
}

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const sql = db();
  const body = await readBody(req);
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used

  if (body.action === 'claim') {
    const name = cleanName(body.name);
    if (!name || /^Player \d+$/.test(name)) throw fail(400, 'Enter your name.');
    const k = name.toLowerCase();
    const [{ players }] = await sql`SELECT count(*)::int AS players FROM roster WHERE club = ${code}`;
    const [existing] = await sql`SELECT claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
    if (!existing && players >= 300) throw fail(400, 'This club already has 300 saved players.');
    if (existing && existing.claim_hash) throw fail(409, `${name} is already linked to another phone. Ask an organizer to release it.`);
    // A network that has already linked 3 names to phones today needs an organizer to confirm the next one, so one
    // person can't set up a crowd of names to vouch for made-up games.
    const claimKey = 'claim:' + code + ':' + clientIp(req);
    const [{ recent }] = await sql`SELECT count(*)::int AS recent FROM lookup_fails WHERE ip = ${claimKey} AND at > now() - interval '1 day'`;
    const reason = recent >= MAX_CLAIMS_PER_DAY ? `This network has already linked ${MAX_CLAIMS_PER_DAY} names today, so an organizer needs to confirm this one.` : null;
    if (reason) {
      if (!body.pin && !body.ownerToken) throw fail(403, reason + ' Ask them to enter the organizer PIN on this phone.');
      await requireOrganizer(club, body.pin, req, body.ownerToken);
    }
    const token = newOwnerToken();
    await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${k}, ${name}) ON CONFLICT DO NOTHING`;
    // Atomic: only one phone can claim a name, even if two try at once.
    const rows = await sql`UPDATE roster SET claim_hash = ${hashToken(token)} WHERE club = ${code} AND name_key = ${k} AND claim_hash IS NULL RETURNING name`;
    if (!rows.length) throw fail(409, `${name} was just claimed by another phone.`);
    await sql`INSERT INTO lookup_fails (ip) VALUES (${claimKey})`;
    return send(res, 200, { ok: true, name: rows[0].name, playerToken: token });
  }

  if (body.action === 'prestige') {
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    const xp = computeXP(await clubGames(sql, code)).get(player.name_key) || 0;
    const [row] = await sql`SELECT prestige FROM roster WHERE club = ${code} AND name_key = ${player.name_key}`;
    const cur = (row && row.prestige) || {};
    const count = Math.max(0, Math.trunc(Number(cur.count)) || 0), xpAt = Math.max(0, Math.trunc(Number(cur.xpAt)) || 0);
    if (!levelFrom(xp - xpAt).maxed) throw fail(409, 'Reach the top level first.');
    const next = { count: count + 1, xpAt: xp };
    // Moves on only from the prestige this check read, so a double tap can't prestige twice.
    const [, updated] = await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(hashtext(${code + ':' + player.name_key}))`,
      sql`UPDATE roster SET prestige = ${JSON.stringify(next)}::jsonb
          WHERE club = ${code} AND name_key = ${player.name_key} AND coalesce((prestige ->> 'count')::int, 0) = ${count}
          RETURNING name`
    ]);
    if (!updated.length) throw fail(409, 'You just prestiged. Refresh to see it.');
    return send(res, 200, { ok: true, prestige: next });
  }

  if (body.action === 'avatar') {
    // A player sets their own picture: an emoji, one of the app's pickleball icons, a small photo, or back to initials.
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    const avatar = cleanAvatar(body.avatar);
    if (avatar && avatar.type === 'photo') {
      // A club keeps at most MAX_PHOTOS photos; replacing your own photo is always fine.
      const [{ photos, mine }] = await sql`SELECT count(*)::int AS photos, count(*) FILTER (WHERE name_key = ${player.name_key})::int AS mine FROM roster WHERE club = ${code} AND avatar->>'type' = 'photo'`;
      if (!Number(mine) && Number(photos) >= MAX_PHOTOS) throw fail(409, `This club already has ${MAX_PHOTOS} photo pictures. Pick an emoji or icon instead, or ask an organizer to remove an old photo.`);
    }
    await sql`UPDATE roster SET avatar = ${avatar ? JSON.stringify(avatar) : null}::jsonb WHERE club = ${code} AND name_key = ${player.name_key}`;
    return send(res, 200, { ok: true, avatar });
  }

  if (body.action === 'dupr') {
    // The phone that linked this name, or an organizer (the only way to set one on a guest name). Nobody else.
    const k = cleanName(body.name).toLowerCase();
    const [row] = await sql`SELECT claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
    if (!row) throw fail(404, 'No saved player has that name.');
    const own = !!row.claim_hash && tokenMatches(row.claim_hash, body.playerToken);
    if (!own) await requireOrganizer(club, body.pin, req, body.ownerToken);
    let rating;
    try { rating = cleanDupr(body.rating); } catch (e) { throw fail(400, e.message); }
    await sql`UPDATE roster SET dupr_rating = ${rating}, dupr_set_at = ${rating === null ? null : new Date().toISOString()} WHERE club = ${code} AND name_key = ${k}`;
    return send(res, 200, { ok: true, dupr: rating });
  }

  // Everything below is for organizers.
  await requireOrganizer(club, body.pin, req, body.ownerToken);

  if (body.action === 'clear-avatar') {
    // Organizer: put someone back to initials (for example a photo that shouldn't be there).
    const rows = await sql`UPDATE roster SET avatar = NULL WHERE club = ${code} AND name_key = ${cleanName(body.name).toLowerCase()} RETURNING name`;
    if (!rows.length) throw fail(404, 'No saved player has that name.');
    return send(res, 200, { ok: true });
  }

  if (body.action === 'release') {
    const k = cleanName(body.name).toLowerCase();
    const rows = await sql`UPDATE roster SET claim_hash = NULL, dupr_rating = NULL, dupr_set_at = NULL WHERE club = ${code} AND name_key = ${k} AND claim_hash IS NOT NULL RETURNING name`;
    if (!rows.length) throw fail(404, 'That name isn\'t linked to a phone.');
    return send(res, 200, { ok: true });
  }

  throw fail(400, 'Unknown action.');
});
