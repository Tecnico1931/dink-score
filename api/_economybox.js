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
import { CATALOGUE, itemById, shopView } from './_economyshop.js';
import { dayKey } from './_economy.js';

export const BOX_PRICE = 7;            // free Dinks to open one mystery box
export const BOX_DUPLICATE_REFUND = 4; // free Dinks returned right away if the drawn item is already owned
export const BOX_DAILY_LIMIT = 3;      // maximum boxes a player may open per UTC day

// Integer percentage weights summing to 100. Every item belongs to CATALOGUE.
export const BOX_TIERS = Object.freeze([
  Object.freeze({
    id: 'common',
    label: 'Common',
    chance: 55,
    items: Object.freeze(['frame-court', 'paddle-court'])
  }),
  Object.freeze({
    id: 'uncommon',
    label: 'Uncommon',
    chance: 30,
    items: Object.freeze(['frame-blue', 'frame-ink', 'paddle-blue', 'paddle-ink'])
  }),
  Object.freeze({
    id: 'rare',
    label: 'Rare',
    chance: 15,
    items: Object.freeze(['frame-double', 'paddle-stripe'])
  })
]);

export const boxSpendId = openId => 'box:' + openId;
export const boxRefundId = openId => 'boxref:' + openId;

export function cleanOpenId(raw) {
  const s = String(raw || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,40}$/.test(s)) throw Object.assign(new Error('Opening a box needs a valid request id.'), { status: 400 });
  return s;
}

export function tierOfItem(id) {
  const t = BOX_TIERS.find(x => x.items.includes(id));
  return t ? { id: t.id, label: t.label, chance: t.chance } : null;
}

// Public odds payload taken directly from the draw constants so UI and draw can never diverge.
export function boxOdds() {
  return {
    price: BOX_PRICE,
    duplicateRefund: BOX_DUPLICATE_REFUND,
    dailyLimit: BOX_DAILY_LIMIT,
    tiers: BOX_TIERS.map(t => ({
      id: t.id,
      label: t.label,
      chance: t.chance,
      items: t.items.map(id => {
        const it = itemById(id);
        return { id: it.id, name: it.name, slot: it.slot, price: it.price };
      })
    }))
  };
}

// Pure draw function. `randInt(max)` returns a uniform integer in [0, max).
// Production uses node:crypto randomInt; tests inject a deterministic source.
export function drawBoxItem(randInt = randomInt) {
  const total = BOX_TIERS.reduce((sum, t) => sum + t.chance, 0);
  if (total !== 100) throw new Error('Mystery box odds must sum to 100.');
  const roll = randInt(total);
  if (!Number.isInteger(roll) || roll < 0 || roll >= total) throw new Error('Random source out of range.');
  let acc = 0;
  let chosen = BOX_TIERS[BOX_TIERS.length - 1];
  for (const t of BOX_TIERS) {
    acc += t.chance;
    if (roll < acc) { chosen = t; break; }
  }
  const pick = randInt(chosen.items.length);
  if (!Number.isInteger(pick) || pick < 0 || pick >= chosen.items.length) throw new Error('Random source out of range.');
  const item = itemById(chosen.items[pick]);
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
  return { ...boxOdds(), openedToday: await opensToday(sql, code, key, now) };
}

// Open one mystery box atomically: spend, grant (or refund on duplicate), and read back authoritative result in one transaction.
export async function openBox(sql, code, key, rawOpenId, { now = Date.now(), randInt = randomInt } = {}) {
  const openId = cleanOpenId(rawOpenId);
  const today = dayKey(now, 0);
  const spendId = boxSpendId(openId);
  const refundId = boxRefundId(openId);
  const drawn = drawBoxItem(randInt);

  const [, cteRows, ledgerRows, statRows] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${code + '/' + key}))`,
    sql`WITH spend AS (
        INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason, day, streak)
        SELECT ${code}, ${key}, ${spendId}, 'spend', ${-BOX_PRICE}, ${'box:' + drawn.item.id}, ${today}, NULL
        WHERE NOT EXISTS (SELECT 1 FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${spendId})
          AND coalesce((SELECT sum(amount) FROM reward_ledger WHERE club = ${code} AND name_key = ${key}), 0) >= ${BOX_PRICE}
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
    throw Object.assign(new Error(`Not enough Dinks yet: a mystery box costs ${BOX_PRICE} and you have ${balance}.`), { status: 409 });
  }

  const replayed = Number(cteRows[0] ? cteRows[0].spent : 0) === 0;
  const itemId = String(spendRow.reason || '').replace(/^box:/, '');
  const item = itemById(itemId);
  const tier = tierOfItem(itemId);
  if (!item || !tier) throw Object.assign(new Error('Could not read the mystery box result.'), { status: 500 });
  const refundRow = ledgerRows.find(r => r.id === refundId);
  const duplicate = !!refundRow;
  const refund = refundRow ? Number(refundRow.amount) : 0;

  const view = await shopView(sql, code, key);
  return {
    ...view,
    box: { ...boxOdds(), openedToday },
    result: {
      openId,
      item,
      tier,
      duplicate,
      refund,
      cost: BOX_PRICE,
      replayed
    }
  };
}
