// Rewards, WI-9: titles (shown under a name) and name styles (how a name is drawn). Cosmetic only, like every shop item: no score, rating, rank or
// rule reads them, nothing random. Prices follow the upstream shop (the captain chose full parity), so a title costs a few weeks of daily play.
// Ids are `<slot>-<word>` with 3-12 lowercase letters so the phone's allow-list (rwSlotId) accepts them. The client mirrors these names for the
// club look (RW_TITLES in src/app/economy.js); test/economyitems.test.js pins the two together. Imported by _economyshop.js into CATALOGUE.
const t = (id, name, price, rarity = 'common') => Object.freeze({ id: 'title-' + id, slot: 'title', name, price, rarity });
const s = (id, name, price, rarity = 'rare') => Object.freeze({ id: 'style-' + id, slot: 'style', name, price, rarity });
const f = (id, name, price, rarity) => Object.freeze({ id: 'frame-' + id, slot: 'frame', name, price, rarity });
const v = (id, name, price, rarity) => Object.freeze({ id: 'sound-' + id, slot: 'sound', name, price, rarity });

export const TITLES = Object.freeze([
  t('kitchen', 'Kitchen King', 75),
  t('dink', 'Dink Master', 75),
  t('banger', 'Banger', 60),
  t('lob', 'Lob Legend', 90),
  t('third', 'Third-Shot Wizard', 105),
  t('erne', 'Erne Artist', 120, 'rare'),
  t('soft', 'Soft Hands', 60),
  t('ninja', 'Net Ninja', 75),
  t('dropshot', 'Drop Shot Doctor', 90),
  t('speedup', 'Speed-Up Specialist', 105),
  t('post', 'Around the Post', 135, 'rare'),
  // WI-13: Legendary and Mythic titles at upstream prices. They sit on their own shelves, never in the box or the pass.
  t('overlord', 'Erne Overlord', 600, 'legendary'),
  t('ruler', 'Ruler of the Kitchen', 720, 'legendary'),
  t('unbeaten', 'The Unbeatable', 660, 'legendary'),
  t('eager', 'Gain Eager', 660, 'legendary'),
  t('finalboss', 'The Final Boss', 2800, 'mythic')
]);

export const STYLES = Object.freeze([
  s('gold', 'Gold name', 120),
  s('glowing', 'Glowing name', 150),
  s('flame', 'Flame name', 180),
  s('pickle', 'Pickle name', 120),
  s('ice', 'Ice name', 135),
  s('neon', 'Neon sign name', 165),
  s('holo', 'Holographic name', 780, 'legendary'),
  s('molten', 'Molten gold name', 840, 'legendary'),
  s('starforged', 'Starforged name', 3600, 'mythic')
]);

// Legendary and Mythic rings and victory sounds (WI-13). Imported by _economyshop.js into CATALOGUE after the common ones.
export const TOP_FRAMES = Object.freeze([
  f('rainbow', 'Spinning rainbow', 660, 'legendary'),
  f('orbit', 'Orbiting ball', 720, 'legendary'),
  f('crown', 'Champion\'s crown', 960, 'legendary'),
  f('horizon', 'Event horizon', 3600, 'mythic')
]);
export const TOP_SOUNDS = Object.freeze([
  v('fanfare', 'Royal fanfare', 720, 'legendary'),
  v('ascension', 'Ascension', 3000, 'mythic')
]);
// The two top shelves are drawn from this: every item whose rarity is one of these (pets included, see _economypets.js).
export const TOP_RARITIES = Object.freeze(['mythic', 'legendary']);
