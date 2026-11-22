// Rewards, slice 3+4: the Shop and opt-in club looks. Fixed-price cosmetics bought with Dinks (play money; rules in DESIGN.md "Rewards",
// guard in test/economyguard.test.js). An item only changes how a picture or a paddle thumbnail looks: it never reads or changes a score, a
// rating, a rank, a pairing or any rule, and nothing here is random (no box, no drop, no odds). By default a worn look shows only on the
// player's own phone; a player can opt in (roster.rewards_public) to show only their worn item ids to other members of the club.
//
// The catalogue below is the ONLY place a price lives. A request names an item id; the server looks the price up here and ignores any
// price, name or slot the phone sends, so a device can neither change a price nor invent an item. The spend goes through the ledger
// (_economy.js spendEntry, id `buy:<item>`, so a replay or a second device never charges twice and the balance never goes below zero);
// ownership is one row per item in reward_items (name key only, like the ledger). Called from players.js as rewards-catalog|buy|wear|share|looks.
import { loadLedger } from './_economysync.js';
import { ledgerBalance, spendEntry } from './_economy.js';

export const SLOTS = ['frame', 'paddle'];
// id, slot, name, price in Dinks. About a week of daily play pays for a cheap one; the double ring and the striped paddle take two.
export const CATALOGUE = [
  { id: 'frame-court', slot: 'frame', name: 'Court green ring', price: 6 },
  { id: 'frame-blue', slot: 'frame', name: 'Team blue ring', price: 8 },
  { id: 'frame-ink', slot: 'frame', name: 'Ink ring', price: 8 },
  { id: 'frame-double', slot: 'frame', name: 'Double ring', price: 15 },
  { id: 'paddle-court', slot: 'paddle', name: 'Court green paddle', price: 6 },
  { id: 'paddle-blue', slot: 'paddle', name: 'Team blue paddle', price: 8 },
  { id: 'paddle-ink', slot: 'paddle', name: 'Ink paddle', price: 8 },
  { id: 'paddle-stripe', slot: 'paddle', name: 'Striped paddle', price: 15 }
];
export const itemById = id => CATALOGUE.find(i => i.id === id) || null;
export const buyId = item => 'buy:' + item.id;

// What a buy would do, from the ledger and the owned ids. Pure. Throws with a plain message when it must be refused.
//   { already: true }            the player owns it (a replay or a second device): nothing is charged
//   { entry }                    the spend row to append (null when the ledger already has it)
export function planBuy(ledger, owned, id) {
  const item = itemById(id);
  if (!item) throw Object.assign(new Error('That item isn\'t in the shop.'), { status: 400 });
  if (owned.includes(item.id)) return { item, already: true };
  try { return { item, entry: spendEntry(ledger, { id: buyId(item), amount: item.price, reason: 'shop:' + item.id }) }; }
  catch (e) {
    if (/Not enough/.test(e.message)) throw Object.assign(new Error(`Not enough Dinks yet: ${item.name} costs ${item.price} and you have ${ledgerBalance(ledger)}.`), { status: 409 });
    throw e;
  }
}

export async function loadItems(sql, code, key) {
  return (await sql`SELECT item, slot, worn FROM reward_items WHERE club = ${code} AND name_key = ${key} ORDER BY at ASC, item ASC`)
    .filter(r => itemById(r.item)).map(r => ({ id: r.item, slot: r.slot, worn: !!r.worn }));
}
// The worn item per slot ({frame, paddle}, '' when none), as the phone draws it.
export const wornFrom = items => Object.fromEntries(SLOTS.map(s => [s, (items.find(i => i.slot === s && i.worn) || {}).id || '']));
export const wornOf = async (sql, code, key) => wornFrom(await loadItems(sql, code, key));

// Allow-listed worn item ids per player, for other members of a club whose rewards switch is on.
// Pure: accepts rows { name_key, slot, item }, copies ONLY known catalogue item ids in their matching slot, never balance, streak or history.
export function clubLooksFrom(rows) {
  const out = Object.create(null);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.name_key !== 'string' || !r.name_key) continue;
    const it = itemById(r.item);
    if (!it || it.slot !== r.slot || !SLOTS.includes(it.slot)) continue;
    if (!out[r.name_key]) out[r.name_key] = {};
    out[r.name_key][it.slot] = it.id;
  }
  return Object.fromEntries(Object.entries(out));
}

export async function clubLooks(sql, code) {
  const rows = await sql`SELECT ri.name_key, ri.slot, ri.item
    FROM reward_items ri
    JOIN roster r ON r.club = ri.club AND r.name_key = ri.name_key
    WHERE ri.club = ${code} AND ri.worn = true AND r.rewards_public = true AND r.blocked_at IS NULL`;
  return clubLooksFrom(rows);
}

export async function shareOf(sql, code, key) {
  const [row] = await sql`SELECT rewards_public FROM roster WHERE club = ${code} AND name_key = ${key}`;
  return !!(row && row.rewards_public);
}

export async function setShare(sql, code, key, on) {
  if (typeof on !== 'boolean') throw Object.assign(new Error('Say whether to show your look to the club.'), { status: 400 });
  await sql`UPDATE roster SET rewards_public = ${on} WHERE club = ${code} AND name_key = ${key}`;
  return shopView(sql, code, key);
}

// The shop as the phone shows it: the catalogue with the owned flag, the balance, what is worn and whether the club sees it. Prices come from the catalogue only.
export async function shopView(sql, code, key) {
  const [items, ledger, share] = await Promise.all([loadItems(sql, code, key), loadLedger(sql, code, key), shareOf(sql, code, key)]);
  return { dinks: ledgerBalance(ledger), worn: wornFrom(items), share, items: CATALOGUE.map(i => ({ ...i, owned: items.some(o => o.id === i.id) })) };
}

// Buy one item. One transaction under a per-player lock: the spend row is inserted only if the balance still covers it, then the item.
export async function buyItem(sql, code, key, id) {
  const plan = planBuy(await loadLedger(sql, code, key), (await loadItems(sql, code, key)).map(i => i.id), id);
  if (plan.already) return { ...(await shopView(sql, code, key)), bought: false };
  const { item } = plan;
  await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${code + '/' + key}))`,
    sql`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason)
      SELECT ${code}, ${key}, ${buyId(item)}, 'spend', ${-item.price}, ${'shop:' + item.id}
      WHERE NOT EXISTS (SELECT 1 FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${buyId(item)})
        AND coalesce((SELECT sum(amount) FROM reward_ledger WHERE club = ${code} AND name_key = ${key}), 0) >= ${item.price}`,
    sql`INSERT INTO reward_items (club, name_key, item, slot)
      SELECT ${code}, ${key}, ${item.id}, ${item.slot}
      WHERE EXISTS (SELECT 1 FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${buyId(item)})
      ON CONFLICT DO NOTHING`
  ]);
  const view = await shopView(sql, code, key);
  if (!view.items.find(i => i.id === item.id).owned) throw Object.assign(new Error(`Not enough Dinks yet: ${item.name} costs ${item.price} and you have ${view.dinks}.`), { status: 409 });
  return { ...view, bought: true };
}

// Wear one owned item, or none (id '' with a slot). One worn item per slot.
export async function wearItem(sql, code, key, slot, id) {
  if (!SLOTS.includes(slot)) throw Object.assign(new Error('Pick frame or paddle.'), { status: 400 });
  if (id) {
    const item = itemById(id);
    if (!item || item.slot !== slot) throw Object.assign(new Error('That item isn\'t in the shop.'), { status: 400 });
    if (!(await loadItems(sql, code, key)).some(i => i.id === id)) throw Object.assign(new Error('You don\'t own that yet.'), { status: 403 });
  }
  await sql.transaction([
    sql`UPDATE reward_items SET worn = false WHERE club = ${code} AND name_key = ${key} AND slot = ${slot}`,
    ...(id ? [sql`UPDATE reward_items SET worn = true WHERE club = ${code} AND name_key = ${key} AND item = ${id}`] : [])
  ]);
  return shopView(sql, code, key);
}
