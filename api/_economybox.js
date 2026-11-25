// Rewards, mystery box (L16, #107; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js).
// Optional per-club cosmetic mystery box: off unless BOTH clubs.rewards AND clubs.mystery_box are on.
// Play money only (free Dinks, never purchasable with real money, never changes a score, rating, rank or pairing).
//
// Single source of truth: BOX_PRICE, BOX_DUPLICATE_REFUND, BOX_DAILY_LIMIT and BOX_TIERS drive BOTH the odds endpoint
// (rewards-box-odds, plus the box field in rewards-catalog) AND the server-side draw (drawBoxItem / openBox), so the
// odds shown before opening can never differ from what is drawn. Draws happen only here on the server with node:crypto
// randomInt (CSPRNG); no pity timers, streak boosts, or countdown pressure.
//
// Spend, item grant and any duplicate refund run in one Postgres transaction under a per-player advisory lock, keyed by
// the request's idempotent openId (`box:<openId>` spend, optional `boxref:<openId>` refund with day=null so streaks are
// untouched). Balance never goes below zero; replaying the same openId returns the exact same result without charging again.
import { randomInt } from 'node:crypto';
import { CATALOGUE, BOX_ITEM, itemById, shopView, loadPrices, loadItems, priceOf } from './_economyshop.js';
import { dayKey } from './_economy.js';

export const BOX_PRICE = 300;          // free Dinks to open one mystery box (upstream parity price; an organizer can change it in Manage shop)
export const BOX_DUPLICATE_REFUND = 4; // free Dinks returned right away if the drawn item is already owned
export const BOX_DAILY_LIMIT = 3;      // maximum boxes a player may open per UTC day

// Three groups with integer percentage weights summing to 100 (upstream parity: regular 82, pet 17, legendary 1). The pool is every item
// of CATALOGUE the player does not own yet, except Mythic ones (the seasonal, event and pass shelves are not in CATALOGUE, and a shiny coat is
// a flag, not an item). A group with nothing left to give hands its weight to the first group that still has items, so the odds shown are
// always the odds drawn and still sum to 100.
const isTop = i => i.rarity === 'legendary' || i.rarity === 'mythic';
export const BOX_TIERS = Object.freeze([
  Object.freeze({ id: 'regular', label: 'Regular', chance: 82, has: i => i.slot !== 'pet' && !isTop(i) }),
  Object.freeze({ id: 'pet', label: 'Pet', chance: 17, has: i => i.slot === 'pet' && !isTop(i) }),
  Object.freeze({ id: 'legendary', label: 'Legendary', chance: 1, has: i => i.rarity === 'legendary' })
]);
export const boxEligible = item => item.rarity !== 'mythic' && BOX_TIERS.some(t => t.has(item));

// The tiers a player can draw from right now: `owned` is an iterable of item ids (null = owns nothing). Empty tiers are left out.
export function boxTiers(owned = null) {
  const have = new Set(owned || []);
  const pool = BOX_TIERS.map(t => ({ ...t, items: CATALOGUE.filter(i => !have.has(i.id) && boxEligible(i) && t.has(i)) }));
  const live = pool.filter(t => t.items.length);
  return live.map((t, n) => ({
    id: t.id, label: t.label, items: t.items,
    chance: t.chance + (n === 0 ? pool.filter(x => !x.items.length).reduce((s, x) => s + x.chance, 0) : 0)
  }));
}

export const boxSpendId = openId => 'box:' + openId;
export const boxRefundId = openId => 'boxref:' + openId;

export function cleanOpenId(raw) {
  const s = String(raw || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,40}$/.test(s)) throw Object.assign(new Error('Opening a box needs a valid request id.'), { status: 400 });
  return s;
}

export function tierOfItem(id) {
  const item = itemById(id);
  const t = item && boxEligible(item) ? BOX_TIERS.find(x => x.has(item)) : null;
  return t ? { id: t.id, label: t.label, chance: t.chance } : null;
}

// Public odds payload taken directly from the draw rules so UI and draw can never diverge.
// `prices`: the club's own prices from Manage shop (loadPrices); none = the defaults. `owned`: the player's item ids (none = a full pool).
export const boxPriceOf = prices => (prices && prices[BOX_ITEM]) || BOX_PRICE;
export function boxOdds(prices = null, owned = null) {
  return {
    price: boxPriceOf(prices),
    duplicateRefund: BOX_DUPLICATE_REFUND,
    dailyLimit: BOX_DAILY_LIMIT,
    tiers: boxTiers(owned).map(t => ({
      id: t.id,
      label: t.label,
      chance: t.chance,
      items: t.items.map(it => ({ id: it.id, name: it.name, slot: it.slot, price: priceOf(it, prices) }))
    }))
  };
}

// Pure draw function. `randInt(max)` returns a uniform integer in [0, max).
// Production uses node:crypto randomInt; tests inject a deterministic source. Returns null when the player owns every possible prize.
export function drawBoxItem(randInt = randomInt, owned = null) {
  const tiers = boxTiers(owned);
  if (!tiers.length) return null;
  const total = tiers.reduce((sum, t) => sum + t.chance, 0);
  if (total !== 100) throw new Error('Mystery box odds must sum to 100.');
  const roll = randInt(total);
  if (!Number.isInteger(roll) || roll < 0 || roll >= total) throw new Error('Random source out of range.');
  let acc = 0;
  let chosen = tiers[tiers.length - 1];
  for (const t of tiers) {
    acc += t.chance;
    if (roll < acc) { chosen = t; break; }
  }
  const pick = randInt(chosen.items.length);
  if (!Number.isInteger(pick) || pick < 0 || pick >= chosen.items.length) throw new Error('Random source out of range.');
  const item = chosen.items[pick];
  if (!item || !CATALOGUE.some(c => c.id === item.id)) throw new Error('Mystery box item missing from catalogue.');
  return { tier: { id: chosen.id, label: chosen.label, chance: chosen.chance }, item };
}

export async function opensToday(sql, code, key, now = Date.now()) {
  const today = dayKey(now, 0);
  const [row] = await sql`SELECT count(*)::int AS n FROM reward_ledger
    WHERE club = ${code} AND name_key = ${key} AND kind = 'spend' AND reason LIKE 'box:%' AND day = ${today}`;
  return Number(row ? row.n : 0);
}

export async function boxStatus(sql, code, key, now = Date.now()) {
  return { ...boxOdds(await loadPrices(sql, code), (await loadItems(sql, code, key)).map(i => i.id)), openedToday: await opensToday(sql, code, key, now) };
}

// Open one mystery box atomically: spend, grant (or refund on duplicate), and read back authoritative result in one transaction.
// `owned` (tests only) overrides the ids read from the database, to stand in for a draw made before another box landed.
export async function openBox(sql, code, key, rawOpenId, { now = Date.now(), randInt = randomInt, owned = null } = {}) {
  const openId = cleanOpenId(rawOpenId);
  const today = dayKey(now, 0);
  const spendId = boxSpendId(openId);
  const refundId = boxRefundId(openId);
  const prices = await loadPrices(sql, code);
  const BOX_COST = boxPriceOf(prices);
  const ownedIds = owned || (await loadItems(sql, code, key)).map(i => i.id);
  let drawn = drawBoxItem(randInt, ownedIds);
  if (!drawn) {
    // Nothing left to give: only a replay of an open that already happened may continue (its spend row wins, this draw is unused).
    const [seen] = await sql`SELECT 1 AS n FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${spendId}`;
    if (!seen) throw Object.assign(new Error('You already own everything the mystery box can give.'), { status: 409 });
    drawn = drawBoxItem(randInt, null);
  }

  const [, cteRows, ledgerRows, statRows] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${code + '/' + key}))`,
    sql`WITH spend AS (
        INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason, day, streak)
        SELECT ${code}, ${key}, ${spendId}, 'spend', ${-BOX_COST}, ${'box:' + drawn.item.id}, ${today}, NULL
        WHERE NOT EXISTS (SELECT 1 FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${spendId})
          AND coalesce((SELECT sum(amount) FROM reward_ledger WHERE club = ${code} AND name_key = ${key}), 0) >= ${BOX_COST}
          AND (SELECT count(*)::int FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND kind = 'spend' AND reason LIKE 'box:%' AND day = ${today}) < ${BOX_DAILY_LIMIT}
        RETURNING id
      ),
      grant_item AS (
        INSERT INTO reward_items (club, name_key, item, slot)
        SELECT ${code}, ${key}, ${drawn.item.id}, ${drawn.item.slot}
        FROM spend
        ON CONFLICT DO NOTHING
        RETURNING item
      ),
      refund AS (
        INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason, day, streak)
        SELECT ${code}, ${key}, ${refundId}, 'earn', ${BOX_DUPLICATE_REFUND}, ${'boxref:' + drawn.item.id}, NULL, NULL
        FROM spend
        WHERE NOT EXISTS (SELECT 1 FROM grant_item)
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      SELECT
        (SELECT count(*)::int FROM spend) AS spent,
        (SELECT count(*)::int FROM grant_item) AS granted,
        (SELECT count(*)::int FROM refund) AS refunded`,
    sql`SELECT id, amount, reason FROM reward_ledger
      WHERE club = ${code} AND name_key = ${key} AND id IN (${spendId}, ${refundId})`,
    sql`SELECT
        coalesce(sum(amount), 0)::int AS balance,
        count(*) FILTER (WHERE kind = 'spend' AND reason LIKE 'box:%' AND day = ${today})::int AS opened_today
      FROM reward_ledger
      WHERE club = ${code} AND name_key = ${key}`
  ]);

  const spendRow = ledgerRows.find(r => r.id === spendId);
  const stats = statRows[0] || { balance: 0, opened_today: 0 };
  const balance = Number(stats.balance);
  const openedToday = Number(stats.opened_today);

  if (!spendRow) {
    if (openedToday >= BOX_DAILY_LIMIT) {
      throw Object.assign(new Error(`Daily limit reached: you have opened ${BOX_DAILY_LIMIT} mystery boxes today. Try again tomorrow.`), { status: 429 });
    }
    throw Object.assign(new Error(`Not enough Dinks yet: a mystery box costs ${BOX_COST} and you have ${balance}.`), { status: 409 });
  }

  const replayed = Number(cteRows[0] ? cteRows[0].spent : 0) === 0;
  const itemId = String(spendRow.reason || '').replace(/^box:/, '');
  const item = itemById(itemId);
  const tier = replayed ? tierOfItem(itemId) : drawn.tier;
  if (!item || !tier) throw Object.assign(new Error('Could not read the mystery box result.'), { status: 500 });
  const refundRow = ledgerRows.find(r => r.id === refundId);
  const duplicate = !!refundRow;
  const refund = refundRow ? Number(refundRow.amount) : 0;

  const view = await shopView(sql, code, key);
  return {
    ...view,
    box: { ...boxOdds(prices, view.items.filter(i => i.owned).map(i => i.id)), openedToday },
    result: {
      openId,
      item,
      tier,
      duplicate,
      refund,
      cost: BOX_COST,
      replayed
    }
  };
}
