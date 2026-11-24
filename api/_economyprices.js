// Rewards, Manage shop (WI-3): an organizer sets this club's price for each shop item and the mystery box. Called from players.js as
// rewards-prices | rewards-prices-save, behind requireOrganizer (the creating phone or the PIN; a co-organizer too), so a player's phone can
// never set a price. The catalogue price (_economyshop.js) stays the default; a row in club_shop_prices overrides it for this club only and
// is dropped again when set back to the default. Play money only, no names stored, every save is written to club_audit.
import { CATALOGUE, BOX_ITEM, loadPrices } from './_economyshop.js';
import { SEASONAL, EVENT_ITEMS } from './_economyseason.js';
import { BOX_PRICE } from './_economybox.js';
import { audit } from './_members.js';
import { fail } from './_db.js';

export const MIN_PRICE = 1;
export const MAX_PRICE = 99999;
const GROUPS = { frame: 'Rings', paddle: 'Paddle colours', pet: 'Pets', title: 'Titles', style: 'Name styles' };

// Every priced thing, with its default: the box first, then the catalogue, then this and other seasons' items.
const priceable = () => [
  { id: BOX_ITEM, name: 'Mystery box', group: 'Random item', price: BOX_PRICE },
  ...CATALOGUE.map(i => ({ id: i.id, name: i.name, group: GROUPS[i.slot] || i.slot, price: i.price })),
  ...SEASONAL.map(i => ({ id: i.id, name: i.name, group: 'Seasonal', price: i.price })),
  ...EVENT_ITEMS.map(i => ({ id: i.id, name: i.name, group: 'Events', price: i.price }))
];

export async function pricesView(sql, club) {
  const prices = await loadPrices(sql, club.code);
  return {
    rewards: !!club.rewards, mysteryBox: !!club.mystery_box, min: MIN_PRICE, max: MAX_PRICE,
    items: priceable().map(i => ({ id: i.id, name: i.name, group: i.group, default: i.price, price: prices[i.id] || i.price }))
  };
}

// body: { prices: { <item id>: whole Dinks } } (ids left out keep their price) or { reset: true } (every item back to its default).
export async function savePrices(sql, club, actor, body) {
  const code = club.code, all = new Map(priceable().map(i => [i.id, i]));
  if (body.reset === true) {
    const gone = await sql`DELETE FROM club_shop_prices WHERE club = ${code} RETURNING item`;
    if (gone.length) await audit(sql, code, actor, 'cost-change', null, { reset: true, changed: gone.length });
    return pricesView(sql, club);
  }
  const given = body.prices;
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw fail(400, 'Send the prices to save.');
  const ids = Object.keys(given);
  if (ids.length > all.size) throw fail(400, 'Too many prices.');
  const before = await loadPrices(sql, code), writes = [];
  let changed = 0;
  for (const id of ids) {
    const item = all.get(id);
    if (!item) throw fail(400, 'That item isn\'t in the shop.');
    const raw = given[id], n = typeof raw === 'number' ? raw : /^\d{1,6}$/.test(String(raw).trim()) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < MIN_PRICE || n > MAX_PRICE) throw fail(400, `${item.name}: enter a whole number of Dinks from ${MIN_PRICE} to ${MAX_PRICE}.`);
    if (n === (before[id] || item.price)) continue;
    changed++;
    writes.push(n === item.price
      ? sql`DELETE FROM club_shop_prices WHERE club = ${code} AND item = ${id}`
      : sql`INSERT INTO club_shop_prices (club, item, price) VALUES (${code}, ${id}, ${n}) ON CONFLICT (club, item) DO UPDATE SET price = EXCLUDED.price`);
  }
  if (writes.length) {
    await sql.transaction(writes);
    await audit(sql, code, actor, 'cost-change', null, { changed });
  }
  return pricesView(sql, club);
}
