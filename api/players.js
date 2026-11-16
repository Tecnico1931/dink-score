// POST /api/players — a club's saved players: linking a name to a phone, pictures and self-reported DUPR numbers.
// Body: {code, action, ...}
//   claim    {name, pin?|ownerToken?}                 -> links a player name to this phone, returns {playerToken}
//   avatar   {name, playerToken, avatar}              -> sets your picture: {type: emoji|icon|photo, value} or {type: initials}
//   clear-avatar {pin|ownerToken, name}               -> organizer: put a player back to initials
//   dupr     {name, rating, playerToken|pin|ownerToken} -> sets or clears (empty rating) a self-reported DUPR number: that
//                                                       name's phone or an organizer only. Display only.
//   release  {pin|ownerToken, name}                  -> organizer: free a claimed name (new phone, or a mistake)
//   rename   {pin|ownerToken, name, newName}         -> organizer: changes a player's name everywhere (games, events, purchases, links)
//   merge    {pin|ownerToken, name, into}            -> organizer: folds the player `name` into `into`; games, links, picture, DUPR follow
// A claim for a new name that looks like a saved one ("Jose" / "José") answers 409 with a `similar` list of those names
// until the caller repeats it with confirmNew: true. Rename does the same for its new name.
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanName, nameKey, similarNames, requireOrganizer, newOwnerToken, hashToken, tokenMatches, clientIp, MAX_PHOTOS } from './_db.js';
import { cleanDupr } from './_dupr.js';
import { renamePlayer, renameWrites } from './_rename.js';

const didYouMean = (name, similar) => Object.assign(fail(409, `Did you mean ${similar[0]}? Use ${name} only if they are a different person.`), { extra: { similar } });

const MAX_CLAIMS_PER_DAY = 3; // names one network can link to phones per club per day without an organizer

async function requirePlayer(sql, code, name, token) {
  const k = nameKey(name);
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

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const sql = db();
  const body = await readBody(req);
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used

  if (body.action === 'claim') {
    const name = cleanName(body.name);
    if (!name || /^Player \d+$/.test(name)) throw fail(400, 'Enter your name.');
    const k = nameKey(name);
    const saved = await sql`SELECT name, name_key, claim_hash FROM roster WHERE club = ${code}`;
    const existing = saved.find(r => r.name_key === k);
    if (!existing && saved.length >= 300) throw fail(400, 'This club already has 300 saved players.');
    if (!existing && body.confirmNew !== true) {
      const similar = similarNames(name, saved.map(r => r.name));
      if (similar.length) throw didYouMean(name, similar);
    }
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
    const k = nameKey(body.name);
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
    const rows = await sql`UPDATE roster SET avatar = NULL WHERE club = ${code} AND name_key = ${nameKey(body.name)} RETURNING name`;
    if (!rows.length) throw fail(404, 'No saved player has that name.');
    return send(res, 200, { ok: true });
  }

  if (body.action === 'release') {
    const k = nameKey(body.name);
    const rows = await sql`UPDATE roster SET claim_hash = NULL, dupr_rating = NULL, dupr_set_at = NULL WHERE club = ${code} AND name_key = ${k} AND claim_hash IS NOT NULL RETURNING name`;
    if (!rows.length) throw fail(404, 'That name isn\'t linked to a phone.');
    return send(res, 200, { ok: true });
  }

  if (body.action === 'rename' || body.action === 'merge') {
    const merge = body.action === 'merge';
    const [from] = await sql`SELECT * FROM roster WHERE club = ${code} AND name_key = ${nameKey(body.name)}`;
    if (!from) throw fail(404, 'No saved player has that name.');
    let into = null, toName;
    if (merge) {
      [into] = await sql`SELECT * FROM roster WHERE club = ${code} AND name_key = ${nameKey(body.into)}`;
      if (!into) throw fail(404, 'No saved player has that name to merge into.');
      if (into.name_key === from.name_key) throw fail(400, 'Pick two different players to merge.');
      toName = into.name;
    } else {
      toName = cleanName(body.newName);
      if (!toName || /^Player \d+$/.test(toName)) throw fail(400, 'Enter the new name.');
      if (nameKey(toName) !== from.name_key) {
        const others = await sql`SELECT name, name_key FROM roster WHERE club = ${code} AND name_key <> ${from.name_key}`;
        const clash = others.find(r => r.name_key === nameKey(toName));
        if (clash) throw Object.assign(fail(409, `${clash.name} is already a saved player. Merge the two players instead.`), { extra: { mergeInto: clash.name } });
        const similar = similarNames(toName, others.map(r => r.name));
        if (similar.length && body.confirmNew !== true) throw didYouMean(toName, similar);
      }
    }
    if (merge) {
      if (from.claim_hash && into.claim_hash) throw fail(409, `${from.name} and ${into.name} are both linked to phones. Release one of them first, then merge.`);
      if (from.dupr_id && into.dupr_id) throw fail(409, `${from.name} and ${into.name} are both connected to DUPR. Disconnect one of them first, then merge.`);
    }
    const plan = await renamePlayer(sql, code, from, toName, into);
    // Phones that held the old name look it up here to follow the player (see `renamed` in GET /api/club).
    const extra = [sql`INSERT INTO name_changes (club, old_key, new_name) VALUES (${code}, ${from.name_key}, ${toName}) ON CONFLICT (club, old_key) DO UPDATE SET new_name = EXCLUDED.new_name, at = now()`,
      sql`DELETE FROM name_changes WHERE club = ${code} AND old_key = ${plan.toKey} AND old_key <> ${from.name_key}`];
    if (!merge) {
      extra.push(sql`UPDATE roster SET name_key = ${plan.toKey}, name = ${toName} WHERE club = ${code} AND name_key = ${from.name_key}`);
      if (plan.toKey !== from.name_key) extra.push(sql`UPDATE account_identities SET name_key = ${plan.toKey} WHERE club = ${code} AND kind = 'player' AND name_key = ${from.name_key}
        AND NOT EXISTS (SELECT 1 FROM account_identities x WHERE x.club = ${code} AND x.kind = 'player' AND x.name_key = ${plan.toKey})`);
    } else {
      // The kept player takes whatever the other one had that it lacks: the phone link, picture and DUPR details.
      extra.push(sql`DELETE FROM roster WHERE club = ${code} AND name_key = ${from.name_key}`);
      extra.push(sql`UPDATE roster SET claim_hash = ${into.claim_hash || from.claim_hash || null},
        avatar = ${JSON.stringify(into.avatar || from.avatar || null)}::jsonb,
        dupr_rating = ${into.dupr_rating ?? from.dupr_rating ?? null}, dupr_set_at = ${into.dupr_rating != null ? into.dupr_set_at : from.dupr_set_at ?? null}
        WHERE club = ${code} AND name_key = ${into.name_key}`);
      if ('dupr_id' in from && from.dupr_id) extra.push(sql`UPDATE roster SET dupr_id = ${from.dupr_id}, dupr_linked_at = ${from.dupr_linked_at}, dupr_snapshot = ${JSON.stringify(from.dupr_snapshot ?? null)}::jsonb WHERE club = ${code} AND name_key = ${into.name_key}`);
      if (from.claim_hash && !into.claim_hash) {
        extra.push(sql`INSERT INTO account_identities (account_id, club, kind, name_key, proof) SELECT account_id, club, kind, ${into.name_key}, proof FROM account_identities WHERE club = ${code} AND kind = 'player' AND name_key = ${from.name_key}
          ON CONFLICT (club, kind, name_key) DO UPDATE SET account_id = EXCLUDED.account_id, proof = EXCLUDED.proof`);
      }
      extra.push(sql`DELETE FROM account_identities WHERE club = ${code} AND kind = 'player' AND name_key = ${from.name_key}`);
    }
    try { await sql.transaction(renameWrites(sql, code, plan, extra)); }
    catch (e) { if (e && e.code === '23505') throw fail(409, 'Someone changed this player at the same time. Try again.'); throw e; }
    return send(res, 200, { ok: true, name: toName, games: plan.games.length, events: plan.events.length });
  }

  throw fail(400, 'Unknown action.');
});
