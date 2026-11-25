// Rewards, WI-9: titles (shown under a name) and name styles (how a name is drawn). Cosmetic only, like every shop item: no score, rating, rank or
// rule reads them, nothing random. Prices follow the upstream shop (the captain chose full parity), so a title costs a few weeks of daily play.
// Ids are `<slot>-<word>` with 3-12 lowercase letters so the phone's allow-list (rwSlotId) accepts them. The client mirrors these names for the
// club look (RW_TITLES in src/app/economy.js); test/economyitems.test.js pins the two together. Imported by _economyshop.js into CATALOGUE.
const t = (id, name, price, rarity = 'common') => Object.freeze({ id: 'title-' + id, slot: 'title', name, price, rarity });
const s = (id, name, price) => Object.freeze({ id: 'style-' + id, slot: 'style', name, price, rarity: 'rare' });

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
  t('post', 'Around the Post', 135, 'rare')
]);

export const STYLES = Object.freeze([
  s('gold', 'Gold name', 120),
  s('glowing', 'Glowing name', 150),
  s('flame', 'Flame name', 180),
  s('pickle', 'Pickle name', 120),
  s('ice', 'Ice name', 135),
  s('neon', 'Neon sign name', 165)
]);
