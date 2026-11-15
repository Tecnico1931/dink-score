// POST /api/shop — everything about players' names and the Dinks shop. Body: {code, action, ...}
//   claim    {name, pin?|ownerToken?}                 -> links a player name to this phone, returns {playerToken}
//                                                       (a name that already has Dinks needs an organizer to confirm)
//   buy      {name, playerToken, itemId}             -> spends Dinks on a catalog item or a club reward
//   equip    {name, playerToken, slot, itemId|null}  -> wears an owned item (or takes it off)
//   spin     {name, playerToken}                     -> the daily wheel: once per UTC day, returns {index, amount}
//   prestige {name, playerToken}                     -> a maxed-out player starts their level again for a star and Dinks
//   avatar   {name, playerToken, avatar}              -> sets your picture: {type: emoji|icon|photo, value} or {type: initials}
//   clear-avatar {pin|ownerToken, name}               -> organizer: put a player back to initials
//   settings {pin|ownerToken, rewardsEnabled?, prices?, rewards?} -> organizer: change prices, toggle and edit rewards
//   given    {pin|ownerToken, purchaseId}            -> organizer: mark a club reward as handed over
//   refund   {pin|ownerToken, purchaseId}            -> organizer: undo a purchase and return the Dinks
//   release  {pin|ownerToken, name}                  -> organizer: free a claimed name (new phone, or a mistake)
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanName, requireOrganizer, newOwnerToken, hashToken, tokenMatches, clientIp } from './_db.js';
import { computeDinks, computeProgress, CATALOG, SLOTS, shopSettings, SPIN_ID, SPIN_WHEEL, SPIN_WEIGHTS, computeXP, levelFrom, PRESTIGE_ID, PRESTIGE_DINKS } from './_dinks.js';

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
  const code = cleanCode(body.code);
  const club = await requireClub(code, req);
  const [{ shop: rawShop }] = await sql`SELECT shop FROM clubs WHERE code = ${code}`;
  const settings = shopSettings(rawShop);

  if (body.action === 'claim') {
    const name = cleanName(body.name);
    if (!name || /^Player \d+$/.test(name)) throw fail(400, 'Enter your name.');
    const k = name.toLowerCase();
    const [{ players }] = await sql`SELECT count(*)::int AS players FROM roster WHERE club = ${code}`;
    const [existing] = await sql`SELECT claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
    if (!existing && players >= 300) throw fail(400, 'This club already has 300 saved players.');
    if (existing && existing.claim_hash) throw fail(409, `${name} is already linked to another phone. Ask an organizer to release it.`);
    // Two cases need an organizer (the PIN, or the club creator's phone) to confirm a claim:
    // - The name already has Dinks or purchases (from games played as a guest), so a stranger can't take and spend
    //   them. Checked from the games and purchases themselves, so removing the saved name first doesn't get around it.
    // - This network has already linked 3 names to phones today, so one person can't set up a crowd of names to
    //   vouch for made-up games.
    const earned = (computeDinks(await clubGames(sql, code)).get(k) || { earned: 0 }).earned;
    const [{ bought }] = await sql`SELECT count(*)::int AS bought FROM purchases WHERE club = ${code} AND name_key = ${k}`;
    const claimKey = 'claim:' + code + ':' + clientIp(req);
    const [{ recent }] = await sql`SELECT count(*)::int AS recent FROM lookup_fails WHERE ip = ${claimKey} AND at > now() - interval '1 day'`;
    const reason = earned > 0 || bought > 0 ? `${name} already has ${earned} Dinks, so an organizer needs to confirm it's you.`
      : recent >= MAX_CLAIMS_PER_DAY ? `This network has already linked ${MAX_CLAIMS_PER_DAY} names today, so an organizer needs to confirm this one.` : null;
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

  if (body.action === 'buy') {
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    const itemId = String(body.itemId || '');
    const catalogItem = CATALOG.find(i => i.id === itemId);
    const reward = !catalogItem && settings.rewardsEnabled ? settings.rewards.find(r => r.id === itemId) : null;
    if (!catalogItem && !reward) throw fail(404, settings.rewardsEnabled ? 'That item isn\'t in the shop.' : 'That item isn\'t in the shop, or club rewards are turned off.');
    const price = catalogItem ? settings.prices[itemId] : Math.max(0, Math.trunc(Number(reward.price)) || 0);
    const itemName = catalogItem ? catalogItem.name : String(reward.name).slice(0, 60);
    const earned = (computeProgress(await clubGames(sql, code)).get(player.name_key) || { earned: 0 }).earned;
    // One transaction, locked per player, so two purchases at once can't overspend.
    const lockKey = code + ':' + player.name_key;
    const [, inserted] = await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
      sql`INSERT INTO purchases (club, name_key, item_id, item_name, price, is_reward)
          SELECT ${code}, ${player.name_key}, ${itemId}, ${itemName}, ${price}, ${!!reward}
          WHERE ${earned}::int - (SELECT coalesce(sum(price), 0)::int FROM purchases WHERE club = ${code} AND name_key = ${player.name_key}) >= ${price}::int
            AND (${!!reward} OR NOT EXISTS (SELECT 1 FROM purchases WHERE club = ${code} AND name_key = ${player.name_key} AND item_id = ${itemId}))
          RETURNING id`
    ]);
    if (!inserted.length) {
      const [{ spent }] = await sql`SELECT coalesce(sum(price), 0)::int AS spent FROM purchases WHERE club = ${code} AND name_key = ${player.name_key}`;
      const owned = !reward && (await sql`SELECT 1 FROM purchases WHERE club = ${code} AND name_key = ${player.name_key} AND item_id = ${itemId}`).length;
      if (owned) throw fail(409, 'You already own that.');
      throw fail(402, `You need ${price} Dinks and have ${earned - spent}. Win more games to earn Dinks.`);
    }
    return send(res, 200, { ok: true, purchaseId: inserted[0].id });
  }

  if (body.action === 'spin') {
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    // The server picks the result, weighted, so the app can't choose a big win.
    let r = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * SPIN_WEIGHTS.reduce((a, b) => a + b, 0), index = 0;
    while (r >= SPIN_WEIGHTS[index]) r -= SPIN_WEIGHTS[index++];
    const amount = SPIN_WHEEL[index];
    const lockKey = code + ':' + player.name_key;
    const [, inserted] = await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
      sql`INSERT INTO purchases (club, name_key, item_id, item_name, price, is_reward)
          SELECT ${code}, ${player.name_key}, ${SPIN_ID}, ${'Daily spin'}, ${-amount}, false
          WHERE NOT EXISTS (SELECT 1 FROM purchases WHERE club = ${code} AND name_key = ${player.name_key} AND item_id = ${SPIN_ID}
            AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          RETURNING id`
    ]);
    if (!inserted.length) throw fail(409, 'You already spun today. Come back tomorrow.');
    return send(res, 200, { ok: true, index, amount });
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
    await sql`INSERT INTO purchases (club, name_key, item_id, item_name, price, is_reward)
              VALUES (${code}, ${player.name_key}, ${PRESTIGE_ID}, ${'Prestige ' + next.count}, ${-PRESTIGE_DINKS}, false)`;
    return send(res, 200, { ok: true, prestige: next, dinks: PRESTIGE_DINKS });
  }

  if (body.action === 'avatar') {
    // A player sets their own picture: an emoji, one of the app's pickleball icons, a small photo, or back to initials.
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    const avatar = cleanAvatar(body.avatar);
    await sql`UPDATE roster SET avatar = ${avatar ? JSON.stringify(avatar) : null}::jsonb WHERE club = ${code} AND name_key = ${player.name_key}`;
    return send(res, 200, { ok: true, avatar });
  }

  if (body.action === 'equip') {
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    const slot = String(body.slot || '');
    if (!SLOTS.includes(slot)) throw fail(400, 'Unknown item type.');
    const itemId = body.itemId == null ? null : String(body.itemId);
    if (itemId) {
      const item = CATALOG.find(i => i.id === itemId && i.slot === slot);
      if (!item) throw fail(400, 'That item doesn\'t go there.');
      const owned = await sql`SELECT 1 FROM purchases WHERE club = ${code} AND name_key = ${player.name_key} AND item_id = ${itemId}`;
      if (!owned.length) throw fail(403, 'Buy it first.');
    }
    await sql`UPDATE roster SET equipped = jsonb_set(equipped, ${[slot]}::text[], ${JSON.stringify(itemId)}::jsonb) WHERE club = ${code} AND name_key = ${player.name_key}`;
    return send(res, 200, { ok: true });
  }

  // Everything below is for organizers.
  await requireOrganizer(club, body.pin, req, body.ownerToken);

  if (body.action === 'settings') {
    const next = { rewardsEnabled: settings.rewardsEnabled, prices: {}, rewards: settings.rewards };
    if (typeof body.rewardsEnabled === 'boolean') next.rewardsEnabled = body.rewardsEnabled;
    const incoming = body.prices && typeof body.prices === 'object' ? body.prices : {};
    for (const item of CATALOG) {
      const v = item.id in incoming ? Math.trunc(Number(incoming[item.id])) : settings.prices[item.id];
      if (!Number.isFinite(v) || v < 0 || v > 9999) throw fail(400, `Prices must be whole numbers from 0 to 9999 (check ${item.name}).`);
      if (v !== item.price) next.prices[item.id] = v;
    }
    if (Array.isArray(body.rewards)) {
      if (body.rewards.length > 20) throw fail(400, 'A club can offer up to 20 rewards.');
      next.rewards = body.rewards.map((r, i) => {
        const name = String(r && r.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        const price = Math.trunc(Number(r && r.price));
        if (!name) throw fail(400, `Reward ${i + 1} needs a name.`);
        if (!Number.isFinite(price) || price < 0 || price > 9999) throw fail(400, `Give ${name} a price from 0 to 9999.`);
        const id = /^reward-[a-z0-9-]{1,40}$/.test(String(r.id || '')) ? r.id : 'reward-' + Date.now().toString(36) + '-' + i;
        return { id, name, price };
      });
    }
    await sql`UPDATE clubs SET shop = ${JSON.stringify(next)}::jsonb WHERE code = ${code}`;
    return send(res, 200, { ok: true, settings: shopSettings(next) });
  }

  if (body.action === 'given') {
    const rows = await sql`UPDATE purchases SET given_at = now() WHERE club = ${code} AND id = ${Math.trunc(Number(body.purchaseId)) || 0} AND is_reward AND given_at IS NULL RETURNING id`;
    if (!rows.length) throw fail(404, 'That reward was already marked as given.');
    return send(res, 200, { ok: true });
  }

  if (body.action === 'clear-avatar') {
    // Organizer: put someone back to initials (for example a photo that shouldn't be there).
    const rows = await sql`UPDATE roster SET avatar = NULL WHERE club = ${code} AND name_key = ${cleanName(body.name).toLowerCase()} RETURNING name`;
    if (!rows.length) throw fail(404, 'No saved player has that name.');
    return send(res, 200, { ok: true });
  }

  if (body.action === 'refund') {
    // Undo a purchase (for example one made after someone claimed a name that wasn't theirs). The Dinks go back.
    const [p] = await sql`DELETE FROM purchases WHERE club = ${code} AND id = ${Math.trunc(Number(body.purchaseId)) || 0} RETURNING name_key, item_id`;
    if (!p) throw fail(404, 'That purchase was already refunded.');
    // Take it off if it was being worn.
    for (const slot of SLOTS) {
      await sql`UPDATE roster SET equipped = equipped - ${slot} WHERE club = ${code} AND name_key = ${p.name_key} AND equipped ->> ${slot} = ${p.item_id}`;
    }
    return send(res, 200, { ok: true });
  }

  if (body.action === 'release') {
    const k = cleanName(body.name).toLowerCase();
    const rows = await sql`UPDATE roster SET claim_hash = NULL WHERE club = ${code} AND name_key = ${k} AND claim_hash IS NOT NULL RETURNING name`;
    if (!rows.length) throw fail(404, 'That name isn\'t linked to a phone.');
    return send(res, 200, { ok: true });
  }

  throw fail(400, 'Unknown shop action.');
});
