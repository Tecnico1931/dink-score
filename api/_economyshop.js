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
import { ledgerBalance, spendEntry, paceFrom, totals } from './_economy.js';
import { PETS, shinyWeekFor, petById, petStateFor, cleanPetLook, shinyItemId, shinyPetOf, shinyPriceOf } from './_economypets.js';
import { loadPlays, loadClubPlays, petXpOf, PETXP_FROM_DAY } from './_economypetxp.js';
import { SEASONAL, EVENT_ITEMS, seasonFor, eventFor, isAvailable, closedMessage } from './_economyseason.js';
import { TITLES, STYLES, TOP_FRAMES, TOP_SOUNDS, TOP_THEMES, TOP_CELEBRATIONS, TOP_RARITIES } from './_economyitems.js';
import { PASS_ITEMS } from './_economyxp.js';
import { loadBoosts, boostState } from './_economyboost.js';

// One place that says which slots exist. `club`: a worn item in the slot may be shown to the club (opt-in look); a sound is only ever heard on the
// player's own phone. Order = the order the shop lists them. Adding a slot here (plus its items) is all the server needs: wear, buy and the club
// allow-list read this table. `reward_items.slot` is free text, so there is no schema change.
export const SLOT_META = Object.freeze([
  { id: 'frame', label: 'Avatar rings', note: 'A ring around your picture.', club: true },
  { id: 'paddle', label: 'Paddles', note: 'Paddle thumbnails.', club: true },
  { id: 'pet', label: 'Pets', note: 'A companion that grows as you play.', club: true },
  { id: 'title', label: 'Titles', note: 'Shown under your name.', club: true },
  { id: 'style', label: 'Name styles', note: 'How your name looks on the leaderboard.', club: true },
  { id: 'theme', label: 'Court themes', note: 'Your scoring screen on this phone.', club: false },
  { id: 'celebrate', label: 'Win celebrations', note: 'Plays on your scoring phone when a game ends.', club: false },
  { id: 'sound', label: 'Victory sounds', note: 'Plays on your phone when you win, if you turn sound on.', club: false }
].map(Object.freeze));
export const SLOTS = SLOT_META.map(s => s.id);
const CLUB_SLOTS = SLOT_META.filter(s => s.club).map(s => s.id);
// Rarity is a label for the badge on a shop card (never odds, never a rule). `common` is the default; seasonal items are common.
export const RARITIES = ['common', 'rare', 'legendary', 'mythic'];
// id, slot, name, price in Dinks, rarity. Rings and pets follow the upstream shop's list and prices (WI-11, the captain's call: parity wins over the old
// 1-a-day scale). Ids never change once sold (owned rows and worn looks key on them), so older rings keep their id under their upstream name:
// court = Forest, blue = Cobalt, double = Prism, ball = Optic. Ink ring and the paddles have no upstream twin and keep their own names.
export const CATALOGUE = [
  { id: 'frame-ball', slot: 'frame', name: 'Optic ring', price: 45, rarity: 'common' },
  { id: 'frame-blue', slot: 'frame', name: 'Cobalt ring', price: 45, rarity: 'common' },
  { id: 'frame-court', slot: 'frame', name: 'Forest ring', price: 45, rarity: 'common' },
  { id: 'frame-sunset', slot: 'frame', name: 'Sunset ring', price: 90, rarity: 'common' },
  { id: 'frame-double', slot: 'frame', name: 'Prism ring', price: 135, rarity: 'rare' },
  { id: 'frame-pickle', slot: 'frame', name: 'Pickle ring', price: 45, rarity: 'common' },
  { id: 'frame-ice', slot: 'frame', name: 'Ice ring', price: 60, rarity: 'common' },
  { id: 'frame-lava', slot: 'frame', name: 'Lava ring', price: 90, rarity: 'common' },
  { id: 'frame-ink', slot: 'frame', name: 'Ink ring', price: 45, rarity: 'common' },
  { id: 'paddle-court', slot: 'paddle', name: 'Court green paddle', price: 6, rarity: 'common' },
  { id: 'paddle-blue', slot: 'paddle', name: 'Team blue paddle', price: 8, rarity: 'common' },
  { id: 'paddle-ink', slot: 'paddle', name: 'Ink paddle', price: 8, rarity: 'common' },
  { id: 'paddle-stripe', slot: 'paddle', name: 'Striped paddle', price: 15, rarity: 'rare' },
  { id: 'paddle-ball', slot: 'paddle', name: 'Ball paddle', price: 25, rarity: 'common' },
  ...PETS,
  // Victory sounds (WI-10): short tones the phone makes itself (src/app/economysound.js, no audio files); prices as upstream. Never in the box or the pass.
  { id: 'sound-bell', slot: 'sound', name: 'Bell ding', price: 60, rarity: 'common' },
  { id: 'sound-horn', slot: 'sound', name: 'Air horn', price: 90, rarity: 'common' },
  { id: 'sound-8bit', slot: 'sound', name: '8-bit win', price: 105, rarity: 'common' },
  { id: 'sound-drum', slot: 'sound', name: 'Drum roll', price: 135, rarity: 'rare' },
  { id: 'sound-crowd', slot: 'sound', name: 'Crowd roar', price: 150, rarity: 'rare' },
  ...TOP_SOUNDS,
  ...TOP_FRAMES,
  // Court themes (WI-16): extra `data-palette` values (`t-<id>`) on this phone's own scoring screen, layered over the six free palettes, which stay free.
  // Looks only, never in the box or the pass, never shown to the club. Prices as upstream.
  { id: 'theme-sunset', slot: 'theme', name: 'Sunset court', price: 150, rarity: 'rare' },
  { id: 'theme-clay', slot: 'theme', name: 'Clay court', price: 150, rarity: 'rare' },
  { id: 'theme-grass', slot: 'theme', name: 'Grass court', price: 150, rarity: 'rare' },
  { id: 'theme-neon', slot: 'theme', name: 'Neon court', price: 210, rarity: 'rare' },
  { id: 'theme-beach', slot: 'theme', name: 'Beach court', price: 150, rarity: 'rare' },
  { id: 'theme-ice', slot: 'theme', name: 'Ice rink', price: 150, rarity: 'rare' },
  { id: 'theme-midnight', slot: 'theme', name: 'Midnight court', price: 150, rarity: 'rare' },
  { id: 'theme-arcade', slot: 'theme', name: 'Retro arcade', price: 210, rarity: 'rare' },
  ...TOP_THEMES,
  // Win celebrations (WI-16): one short CSS effect on the scoring phone when a game ends (src/app/economycelebrate.js); needs Win celebration on in Settings.
  { id: 'celebrate-confetti', slot: 'celebrate', name: 'Confetti', price: 120, rarity: 'rare' },
  { id: 'celebrate-balls', slot: 'celebrate', name: 'Ball burst', price: 120, rarity: 'rare' },
  { id: 'celebrate-pickles', slot: 'celebrate', name: 'Pickle rain', price: 150, rarity: 'rare' },
  { id: 'celebrate-paddles', slot: 'celebrate', name: 'Flying paddles', price: 150, rarity: 'rare' },
  { id: 'celebrate-hearts', slot: 'celebrate', name: 'Heart burst', price: 120, rarity: 'rare' },
  ...TOP_CELEBRATIONS,
  ...TITLES,
  ...STYLES
];
// Seasonal cosmetics (_economyseason.js) are looked up here too, so an owned one stays owned, wearable and visible after its window closes;
// they are NOT in CATALOGUE, which keeps them out of the mystery box and the pass. Only buying is limited to the season.
export const itemById = id => CATALOGUE.find(i => i.id === id) || SEASONAL.find(i => i.id === id) || EVENT_ITEMS.find(i => i.id === id) || PASS_ITEMS.find(i => i.id === id) || null;
export const buyId = item => 'buy:' + item.id;

// Manage shop (WI-3): an organizer may set a club's own price for an item or the mystery box. Only `club_shop_prices` rows (set by
// _economyprices.js behind requireOrganizer) change a price; the catalogue price stays the default, and the phone still never sends one.
export const BOX_ITEM = 'box';
export async function loadPrices(sql, code) {
  const rows = await sql`SELECT item, price FROM club_shop_prices WHERE club = ${code}`;
  return Object.fromEntries(rows.map(r => [r.item, Number(r.price)]));
}
export const priceOf = (item, prices) => (prices && prices[item.id]) || item.price;
const priced = (item, prices) => { const price = priceOf(item, prices); return price === item.price ? item : { ...item, price }; };

// What a buy would do, from the ledger and the owned ids. Pure. Throws with a plain message when it must be refused.
//   { already: true }            the player owns it (a replay or a second device): nothing is charged
//   { entry }                    the spend row to append (null when the ledger already has it)
export function planBuy(ledger, owned, id, now = Date.now(), prices = null) {
  const base = itemById(id);
  const item = base && priced(base, prices);
  if (!item) throw Object.assign(new Error('That item isn\'t in the shop.'), { status: 400 });
  if (owned.includes(item.id)) return { item, already: true };
  if (item.pass) throw Object.assign(new Error(`${item.name} comes from the season pass and can't be bought.`), { status: 409 });
  if (!isAvailable(item, now)) throw Object.assign(new Error(closedMessage(item, now)), { status: 409 });
  try { return { item, entry: spendEntry(ledger, { id: buyId(item), amount: item.price, reason: 'shop:' + item.id }) }; }
  catch (e) {
    if (/Not enough/.test(e.message)) throw Object.assign(new Error(`Not enough Dinks yet: ${item.name} costs ${item.price} and you have ${ledgerBalance(ledger)}.`), { status: 409 });
    throw e;
  }
}

// Mythic items: how many players in this club own each (a number per item, never a name). Drawn as "Nobody here has one yet" on the card.
export async function loadOwnerCounts(sql, code) {
  const rows = await sql`SELECT ri.item, count(*)::int AS n FROM reward_items ri
    JOIN roster r ON r.club = ri.club AND r.name_key = ri.name_key
    WHERE ri.club = ${code} AND r.blocked_at IS NULL GROUP BY ri.item`;
  return Object.fromEntries(rows.map(r => [r.item, Number(r.n)]));
}
export const isTop = item => TOP_RARITIES.includes(item.rarity);

export async function loadItems(sql, code, key) {
  return (await sql`SELECT item, slot, worn, shiny, shiny_owned, at FROM reward_items WHERE club = ${code} AND name_key = ${key} ORDER BY at ASC, item ASC`)
    .filter(r => itemById(r.item)).map(r => ({ id: r.item, slot: r.slot, worn: !!r.worn, shiny: !!r.shiny, shinyOwned: !!(r.shiny_owned || r.shiny), at: r.at }));
}
// The worn item per slot ('' when none), as the phone draws it. A slot is listed once the shop sells something in it, so the answer
// does not grow before WI-9/10 add titles, name styles and sounds.
const hasItems = s => CATALOGUE.some(i => i.slot === s) || SEASONAL.some(i => i.slot === s) || EVENT_ITEMS.some(i => i.slot === s) || PASS_ITEMS.some(i => i.slot === s);
export const wornFrom = items => Object.fromEntries(SLOTS.filter(hasItems).map(s => [s, (items.find(i => i.slot === s && i.worn) || {}).id || '']));
export const wornOf = async (sql, code, key) => wornFrom(await loadItems(sql, code, key));

// Worn slot ids plus the active pet's derived stage and weekly shiny flag (or null if no pet is worn).
export async function wornSummaryOf(sql, code, key, now = Date.now()) {
  const items = await loadItems(sql, code, key);
  const worn = wornFrom(items);
  const petRow = items.find(i => i.slot === 'pet' && i.worn);
  const pet = petRow ? petStateFor(petRow, await loadLedger(sql, code, key), now, await loadPlays(sql, code, key)) : null;
  return { worn, pet };
}

// Allow-listed worn item ids per player, for other members of a club whose rewards switch is on.
// Pure: accepts rows { name_key, slot, item, shiny?, play_days? }, copies ONLY known catalogue item ids in their matching slot
// (plus petStage and petShiny for a worn pet), never balance, streak, pet XP or level, or history.
export function clubLooksFrom(rows, now = Date.now()) {
  const out = Object.create(null);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.name_key !== 'string' || !r.name_key) continue;
    const it = itemById(r.item);
    if (!it || it.slot !== r.slot || !CLUB_SLOTS.includes(it.slot)) continue;
    if (it.slot === 'pet') {
      const petLook = cleanPetLook(r, now);
      if (!petLook) continue;
      if (!out[r.name_key]) out[r.name_key] = {};
      Object.assign(out[r.name_key], petLook);
      continue;
    }
    if (!out[r.name_key]) out[r.name_key] = {};
    out[r.name_key][it.slot] = it.id;
  }
  return Object.fromEntries(Object.entries(out));
}

export async function clubLooks(sql, code, now = Date.now()) {
  const rows = await sql`SELECT ri.name_key, ri.slot, ri.item, ri.shiny, ri.at,
    CASE WHEN ri.slot = 'pet' THEN (
      SELECT count(DISTINCT rl.day)::int
      FROM reward_ledger rl
      WHERE rl.club = ri.club AND rl.name_key = ri.name_key
        AND rl.kind = 'earn' AND rl.day IS NOT NULL
        AND rl.day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND rl.day >= to_char(ri.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AND rl.day < ${PETXP_FROM_DAY}
    ) ELSE NULL END AS play_days
    FROM reward_items ri
    JOIN roster r ON r.club = ri.club AND r.name_key = ri.name_key
    WHERE ri.club = ${code} AND ri.worn = true AND r.rewards_public = true AND r.blocked_at IS NULL`;
  const pets = rows.filter(r => r.slot === 'pet');
  const plays = await loadClubPlays(sql, code, [...new Set(pets.map(r => r.name_key))]);
  for (const r of pets) r.pet_xp = petXpOf(plays.get(r.name_key), new Date(r.at).getTime(), 0);
  return clubLooksFrom(rows, now);
}

export async function shareOf(sql, code, key) {
  const [row] = await sql`SELECT rewards_public FROM roster WHERE club = ${code} AND name_key = ${key}`;
  return !!(row && row.rewards_public);
}

export async function setShare(sql, code, key, on, now = Date.now()) {
  if (typeof on !== 'boolean') throw Object.assign(new Error('Say whether to show your look to the club.'), { status: 400 });
  await sql`UPDATE roster SET rewards_public = ${on} WHERE club = ${code} AND name_key = ${key}`;
  return shopView(sql, code, key, now);
}

// The shop as the phone shows it: the catalogue with the owned flag, the balance, what is worn, pet stage/weekly shiny state, and whether the club sees it. Prices come from the catalogue only.
export async function shopView(sql, code, key, now = Date.now()) {
  const [items, ledger, share, prices, owners, plays, boosts] = await Promise.all([loadItems(sql, code, key), loadLedger(sql, code, key), shareOf(sql, code, key), loadPrices(sql, code), loadOwnerCounts(sql, code), loadPlays(sql, code, key), loadBoosts(sql, code)]);
  const ownedById = new Map(items.map(i => [i.id, i]));
  const shinyWeek = shinyWeekFor(now);
  const season = seasonFor(now);
  // This season's items, plus any seasonal item the player already owns (so it stays in What you wear); other seasons are not listed.
  const seasonal = SEASONAL.filter(i => i.season === season.id || ownedById.has(i.id)).map(i => ({ ...priced(i, prices), rarity: 'common', seasonal: true, owned: ownedById.has(i.id), available: i.season === season.id }));
  // The dated event shelf (Christmas...): its items while it is on, plus any event item the player owns. Not `seasonal`: the phone draws it as its own shelf.
  const event = eventFor(now);
  const eventItems = EVENT_ITEMS.filter(i => (event && i.event === event.id) || ownedById.has(i.id)).map(i => ({ ...priced(i, prices), owned: ownedById.has(i.id), available: !!event && i.event === event.id }));
  const viewItems = CATALOGUE.map(base => {
    const i = base.rarity === 'mythic' ? { ...priced(base, prices), owners: owners[base.id] || 0 } : priced(base, prices);
    const row = ownedById.get(i.id);
    if (i.slot !== 'pet') return { ...i, owned: !!row };
    const featuredShiny = shinyWeek.petId === i.id;
    if (!row) return { ...i, owned: false, featuredShiny };
    const ps = petStateFor(row, ledger, now, plays);
    return { ...i, owned: true, featuredShiny, stage: ps.stage, stageLabel: ps.stageLabel, level: ps.level, xp: ps.xp, levelXp: ps.levelXp, nextXp: ps.nextXp, shiny: ps.shiny, shinyOwned: ps.shinyOwned };
  });
  const wornPetRow = items.find(i => i.slot === 'pet' && i.worn);
  const pet = wornPetRow ? petStateFor(wornPetRow, ledger, now, plays) : null;
  const { id: seasonId, name: seasonName, dates, returns, startsOn, endsOn } = season;
  // The week's shiny coat: its price for this club, and whether this player already owns it (bought once, by the pet's owner).
  const shinyOffer = { ...shinyWeek, price: shinyPriceOf(petById(shinyWeek.petId), prices), owned: !!(ownedById.get(shinyWeek.petId) || {}).shinyOwned };
  return { dinks: ledgerBalance(ledger), ...totals(ledger), boost: boostState(boosts, now), pace: paceFrom(ledger, now), worn: wornFrom(items), pet, shinyWeek: shinyOffer, share, season: { id: seasonId, name: seasonName, dates, returns, startsOn, endsOn }, event: event && { id: event.id, name: event.name, dates: event.dates, note: event.note, startsOn: event.startsOn, endsOn: event.endsOn }, items: viewItems.concat(seasonal, eventItems, PASS_ITEMS.filter(i => ownedById.has(i.id)).map(i => ({ ...i, owned: true }))) };
}

// Buy one item. One transaction under a per-player lock: the spend row is inserted only if the balance still covers it, then the item.
export async function buyItem(sql, code, key, id, now = Date.now()) {
  if (shinyPetOf(id)) return buyShiny(sql, code, key, shinyPetOf(id), now);
  const plan = planBuy(await loadLedger(sql, code, key), (await loadItems(sql, code, key)).map(i => i.id), id, now, await loadPrices(sql, code));
  if (plan.already) return { ...(await shopView(sql, code, key, now)), bought: false };
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
  const view = await shopView(sql, code, key, now);
  if (!view.items.find(i => i.id === item.id).owned) throw Object.assign(new Error(`Not enough Dinks yet: ${item.name} costs ${item.price} and you have ${view.dinks}.`), { status: 409 });
  return { ...view, bought: true };
}

// Buy this week's shiny coat for a pet the player owns (`buy:shiny-<pet>`, the club's Manage shop price or the default). Same guarantees as buyItem:
// one transaction under the player lock, charged once, never below zero. The pet keeps its level; the coat stays owned after the week ends.
export async function buyShiny(sql, code, key, pet, now = Date.now()) {
  const sid = shinyItemId(pet.id), id = 'buy:' + sid;
  const [items, ledger, prices] = await Promise.all([loadItems(sql, code, key), loadLedger(sql, code, key), loadPrices(sql, code)]);
  const row = items.find(i => i.id === pet.id);
  if (!row) throw Object.assign(new Error(`Get the ${pet.name.toLowerCase()} first: the shiny coat is for its owner.`), { status: 403 });
  if (row.shinyOwned) return { ...(await shopView(sql, code, key, now)), bought: false };
  const wk = shinyWeekFor(now);
  if (wk.petId !== pet.id) throw Object.assign(new Error(`The shiny ${pet.name.toLowerCase()} isn't on sale this week. This week's shiny is the ${wk.petName.toLowerCase()}.`), { status: 409 });
  const price = shinyPriceOf(pet, prices), name = 'Shiny ' + pet.name.toLowerCase();
  try { spendEntry(ledger, { id, amount: price, reason: 'shop:' + sid }); }
  catch (e) {
    if (/Not enough/.test(e.message)) throw Object.assign(new Error(`Not enough Dinks yet: ${name} costs ${price} and you have ${ledgerBalance(ledger)}.`), { status: 409 });
    throw e;
  }
  await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${code + '/' + key}))`,
    sql`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason)
      SELECT ${code}, ${key}, ${id}, 'spend', ${-price}, ${'shop:' + sid}
      WHERE NOT EXISTS (SELECT 1 FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${id})
        AND coalesce((SELECT sum(amount) FROM reward_ledger WHERE club = ${code} AND name_key = ${key}), 0) >= ${price}`,
    sql`UPDATE reward_items SET shiny_owned = true WHERE club = ${code} AND name_key = ${key} AND item = ${pet.id}
      AND EXISTS (SELECT 1 FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${id})`
  ]);
  const view = await shopView(sql, code, key, now);
  if (!view.shinyWeek.owned) throw Object.assign(new Error(`Not enough Dinks yet: ${name} costs ${price} and you have ${view.dinks}.`), { status: 409 });
  return { ...view, bought: true };
}

// Wear one owned item, or none (id '' with a slot). One worn item per slot.
// For slot 'pet', optional boolean `shiny` puts the pet's bought shiny coat on or off (refused with 403 until the player owns that coat).
export async function wearItem(sql, code, key, slot, id, { shiny, now = Date.now() } = {}) {
  if (!SLOTS.includes(slot)) throw Object.assign(new Error('Pick ' + SLOTS.slice(0, -1).join(', ') + ' or ' + SLOTS[SLOTS.length - 1] + '.'), { status: 400 });
  if (shiny !== undefined && typeof shiny !== 'boolean') throw Object.assign(new Error('Say whether to use the weekly shiny coat.'), { status: 400 });
  if (shiny === true && (slot !== 'pet' || !id)) throw Object.assign(new Error('The weekly shiny coat is only for a worn court pet.'), { status: 400 });
  if (id) {
    const item = itemById(id);
    if (!item || item.slot !== slot) throw Object.assign(new Error('That item isn\'t in the shop.'), { status: 400 });
    const mine = (await loadItems(sql, code, key)).find(i => i.id === id);
    if (!mine) throw Object.assign(new Error('You don\'t own that yet.'), { status: 403 });
    if (shiny === true && !mine.shinyOwned) throw Object.assign(new Error(`You don't own the shiny ${item.name.toLowerCase()} yet. Its owner can buy it in its featured week.`), { status: 403 });
  }
  if (!id) {
    await sql.transaction([
      sql`UPDATE reward_items SET worn = false, shiny = false WHERE club = ${code} AND name_key = ${key} AND slot = ${slot}`
    ]);
  } else {
    await sql.transaction([
      sql`UPDATE reward_items SET worn = false, shiny = false WHERE club = ${code} AND name_key = ${key} AND slot = ${slot} AND item <> ${id}`,
      shiny === undefined
        ? sql`UPDATE reward_items SET worn = true WHERE club = ${code} AND name_key = ${key} AND item = ${id}`
        : sql`UPDATE reward_items SET worn = true, shiny = ${shiny} WHERE club = ${code} AND name_key = ${key} AND item = ${id}`
    ]);
  }
  return shopView(sql, code, key, now);
}
