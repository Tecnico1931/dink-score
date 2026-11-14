// POST /api/shop — everything about players' names and the Dinks shop. Body: {code, action, ...}
//   claim    {name, pin?|ownerToken?}                 -> links a player name to this phone, returns {playerToken}
//                                                       (a name that already has Dinks needs an organizer to confirm)
//   buy      {name, playerToken, itemId}             -> spends Dinks on a catalog item or a club reward
//   equip    {name, playerToken, slot, itemId|null}  -> wears an owned item (or takes it off)
//   settings {pin|ownerToken, rewardsEnabled?, prices?, rewards?} -> organizer: change prices, toggle and edit rewards
//   given    {pin|ownerToken, purchaseId}            -> organizer: mark a club reward as handed over
//   refund   {pin|ownerToken, purchaseId}            -> organizer: undo a purchase and return the Dinks
//   release  {pin|ownerToken, name}                  -> organizer: free a claimed name (new phone, or a mistake)
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanName, requireOrganizer, newOwnerToken, hashToken, tokenMatches } from './_db.js';
import { computeDinks, CATALOG, SLOTS, shopSettings } from './_dinks.js';

async function requirePlayer(sql, code, name, token) {
  const k = cleanName(name).toLowerCase();
  const [row] = await sql`SELECT name, name_key, claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
  if (!row || !row.claim_hash || !tokenMatches(row.claim_hash, token)) throw fail(403, 'This phone isn\'t linked to that player. Pick your name in the club first.');
  return row;
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
    // A name that has already earned Dinks (from games played as a guest) could be claimed by anyone with the club
    // code and spent. So taking one of those needs an organizer: the PIN, or the club creator's phone.
    const earned = existing ? (computeDinks(await clubGames(sql, code)).get(k) || { earned: 0 }).earned : 0;
    const [{ bought }] = existing ? await sql`SELECT count(*)::int AS bought FROM purchases WHERE club = ${code} AND name_key = ${k}` : [{ bought: 0 }];
    if (earned > 0 || bought > 0) {
      if (!body.pin && !body.ownerToken) throw fail(403, `${name} already has ${earned} Dinks, so an organizer needs to confirm it's you. Ask them to enter the organizer PIN on this phone.`);
      await requireOrganizer(club, body.pin, req, body.ownerToken);
    }
    const token = newOwnerToken();
    await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${k}, ${name}) ON CONFLICT DO NOTHING`;
    // Atomic: only one phone can claim a name, even if two try at once.
    const rows = await sql`UPDATE roster SET claim_hash = ${hashToken(token)} WHERE club = ${code} AND name_key = ${k} AND claim_hash IS NULL RETURNING name`;
    if (!rows.length) throw fail(409, `${name} was just claimed by another phone.`);
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
    const earned = (computeDinks(await clubGames(sql, code)).get(player.name_key) || { earned: 0 }).earned;
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
