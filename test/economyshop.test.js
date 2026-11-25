import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CATALOGUE, RARITIES, SLOTS, itemById, planBuy, wornFrom, buyId, clubLooksFrom } from '../api/_economyshop.js';
import { DAY_PAY, BONUS, ledgerBalance } from '../api/_economy.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const earn = n => ({ id: 'day:2026-01-' + String(n).padStart(2, '0'), kind: 'earn', amount: n, reason: 'day', day: null, streak: 1 });

test('the catalogue is fixed-price and cosmetic-only', () => {
  assert.ok(CATALOGUE.length >= 10 && CATALOGUE.length <= 80);
  assert.equal(new Set(CATALOGUE.map(i => i.id)).size, CATALOGUE.length, 'ids are unique');
  // Only these keys: nothing here can carry a rule, a score effect or a random draw.
  for (const i of CATALOGUE) {
    assert.deepEqual(Object.keys(i).sort(), ['id', 'name', 'price', 'rarity', 'slot']);
    assert.ok(SLOTS.includes(i.slot) && i.id.startsWith(i.slot + '-'));
    // Rings and pets carry the upstream shop's prices (WI-11, the captain's call: parity wins over the old 1-a-day scale), so the old
    // "any item within two weeks of play" ceiling is gone; the paddles keep their small prices.
    assert.ok(Number.isInteger(i.price) && i.price >= 1 && i.price <= (i.rarity === 'mythic' ? 5000 : i.rarity === 'legendary' ? 1200 : i.slot === 'sound' ? 150 : 1000)); // victory sounds carry upstream's prices (WI-10)
    assert.match(buyId(i), /^[a-z0-9:_-]{4,64}$/, 'the ledger id is valid for spendEntry');
  }
  // The upstream rings, by their upstream prices; the older ids keep their place under their upstream names.
  const ring = id => itemById(id);
  assert.deepEqual(['frame-ball', 'frame-blue', 'frame-court', 'frame-sunset', 'frame-double', 'frame-pickle', 'frame-ice', 'frame-lava'].map(id => [ring(id).name, ring(id).price]),
    [['Optic ring', 45], ['Cobalt ring', 45], ['Forest ring', 45], ['Sunset ring', 90], ['Prism ring', 135], ['Pickle ring', 45], ['Ice ring', 60], ['Lava ring', 90]]);
  assert.equal(ring('frame-double').rarity, 'rare', 'Prism is the rare ring');
  assert.ok(Math.min(...CATALOGUE.map(i => i.price)) <= 10 && DAY_PAY >= 1 && BONUS.length > 0, 'the cheapest paddle is still within a week of daily play');
});

test('planBuy: a club price (Manage shop) replaces the catalogue price for that club only; none means the catalogue', () => {
  const frame = itemById('frame-court');
  assert.equal(planBuy([earn(99)], [], 'frame-court', Date.now(), { 'frame-court': 3 }).entry.amount, -3);
  assert.equal(planBuy([earn(99)], [], 'frame-court', Date.now(), {}).entry.amount, -frame.price);
  assert.equal(planBuy([earn(99)], [], 'frame-court', Date.now(), { 'paddle-ink': 1 }).entry.amount, -frame.price, 'another item\'s price is not used');
  assert.throws(() => planBuy([earn(2)], [], 'frame-court', Date.now(), { 'frame-court': 3 }), e => e.status === 409 && /costs 3 and you have 2/.test(e.message));
  assert.equal(itemById('frame-court').price, frame.price, 'the catalogue itself is never mutated');
  assert.deepEqual(planBuy([earn(99)], ['frame-court'], 'frame-court', Date.now(), { 'frame-court': 3 }).already, true);
});

test('planBuy: price comes from the catalogue, never below zero, a repeat charges nothing', () => {
  const frame = itemById('frame-court');
  assert.equal(planBuy([earn(frame.price)], [], 'frame-court').entry.amount, -frame.price);
  assert.equal(planBuy([earn(frame.price)], [], 'frame-court').entry.id, 'buy:frame-court');
  assert.throws(() => planBuy([earn(frame.price - 1)], [], 'frame-court'), e => e.status === 409 && new RegExp(`costs ${frame.price} and you have ${frame.price - 1}`).test(e.message));
  assert.throws(() => planBuy([], [], 'frame-court'), e => e.status === 409);
  assert.throws(() => planBuy([earn(99)], [], 'frame-gold'), e => e.status === 400, 'an unknown item is refused');
  assert.throws(() => planBuy([earn(99)], [], '__proto__'), e => e.status === 400);
  assert.deepEqual(planBuy([earn(99)], ['frame-court'], 'frame-court'), { item: frame, already: true }, 'owned: nothing to charge');
  // The ledger already holds the spend (a replay that lost the item row): no second row.
  const spent = [earn(99), { id: 'buy:frame-court', kind: 'spend', amount: -frame.price, reason: 'shop:frame-court', day: null, streak: null }];
  assert.equal(planBuy(spent, [], 'frame-court').entry, null);
  assert.equal(ledgerBalance(spent), 99 - frame.price);
  // A spend never takes the balance below zero, however many are planned in a row.
  let ledger = [earn(55)];
  for (const id of ['frame-court', 'paddle-court']) { const p = planBuy(ledger, [], id); ledger = ledger.concat(p.entry); }
  assert.equal(ledgerBalance(ledger), 4);
  assert.throws(() => planBuy(ledger, [], 'paddle-blue'), e => e.status === 409);
});

test('wornFrom gives one item per slot, and none when nothing is worn', () => {
  assert.deepEqual(wornFrom([]), { frame: '', paddle: '', pet: '', title: '', style: '', theme: '', celebrate: '', sound: '' });
  assert.deepEqual(wornFrom([{ id: 'frame-ink', slot: 'frame', worn: true }, { id: 'frame-blue', slot: 'frame', worn: false }, { id: 'paddle-ink', slot: 'paddle', worn: false }]), { frame: 'frame-ink', paddle: '', pet: '', title: '', style: '', theme: '', celebrate: '', sound: '' });
});

test('clubLooksFrom allow-lists only catalogue item ids in their own slot and leaks nothing else', () => {
  const looks = clubLooksFrom([
    { name_key: 'ana', slot: 'frame', item: 'frame-court', dinks: 99, streak: 7, price: 6 },
    { name_key: 'ana', slot: 'paddle', item: 'paddle-stripe' },
    { name_key: 'ben', slot: 'frame', item: 'frame-gold' },          // unknown item: dropped
    { name_key: 'ben', slot: 'paddle', item: 'frame-blue' },         // wrong slot: dropped
    { name_key: 'cy', slot: 'hat', item: 'frame-ink' },              // unknown slot: dropped
    { name_key: '', slot: 'frame', item: 'frame-ink' },              // empty key: dropped
    null,
    { name_key: 'di', slot: 'frame', item: 'frame-double' }
  ]);
  assert.deepEqual(looks, { ana: { frame: 'frame-court', paddle: 'paddle-stripe' }, di: { frame: 'frame-double' } });
  assert.ok(!/dinks|streak|price|gold|hat/.test(JSON.stringify(looks)));
  assert.deepEqual(clubLooksFrom([]), {});
});

test('the shop never reaches scoring, rating or club-code paths, and the page source stays free of economy words', () => {
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  for (const f of ['api/_rating.js', 'api/_pb.js', 'api/_gamesave.js', 'api/games.js', 'api/club.js', 'pb-engine.js', 'rating-engine.js']) assert.ok(!/economyshop|reward_items/.test(read(f)), f);
  assert.ok(!/Math\.random|crypto/.test(read('api/_economyshop.js')), 'nothing random is sold');
  assert.ok(!/price|odds|loot/i.test(read('dink-score.html')), 'prices and drawing live in src/app/economy*.js only');
});

// The phone side: draws what the server sends, hides with the one-tap switch, never trusts a stored or answered id.
import { module, page } from './helpers/app.js';
const phone = ({ hide = false, on = true, box = false, spinFree = null, name = 'Ana', looksReply = { looks: {} } } = {}) => {
  const calls = [], kv = { 'pb.rewardsHide': hide }, listeners = [], root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const env = { clubSheet: null, renders: 0, announced: [] };
  const code = module('economy') + ';' + module('economyshop') + ';return { Rewards, rwItemCard, rwCur, rwClean, rwCleanLooks, rwApplyLook, rwSpinLearn, rwSpinNow, rwSpinNext, set sheet(v) { clubSheet = v; }, get sheet() { return clubSheet; } };';
  const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'renderClub', 'initials', 'iconSvg', 'skel', 'avatarInner', 'teamLabel',
    'let clubSheet = null;' + code)(
    { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } }, { code: 'club-a', rewards: on, mysteryBox: box }, String, m => env.announced.push(m),
    { documentElement: root, addEventListener: (t, f) => listeners.push(f), querySelector: () => null }, () => name, () => (name ? 'tok' : null),
    async b => {
      calls.push(b);
      if (b.action === 'rewards-looks') return looksReply;
      if (spinFree !== null && b.action === 'rewards-catalog') return { dinks: 20, worn: { frame: '', paddle: '' }, share: false, items: items([]), spin: { segments: [5], chances: [], max: 5, spunToday: !spinFree, wonToday: 0 } };
      if (b.action === 'rewards-spin') return { dinks: 25, worn: { frame: '', paddle: '' }, share: false, items: items([]), spin: { segments: [5], chances: [], max: 5, spunToday: true, wonToday: 5 }, spinResult: { value: 5 } };
      if (b.action === 'rewards-share') return { dinks: 14, worn: { frame: 'frame-court', paddle: '' }, share: !!b.share, items: items(['frame-court']) };
      return b.action === 'rewards-buy' ? { dinks: 14, worn: { frame: '', paddle: '' }, share: false, items: items(['frame-court']) } : { dinks: 20, worn: { frame: '', paddle: '' }, share: false, items: items([]) };
    },
    () => env.renders++, () => {}, s => s.slice(0, 2), () => '<svg></svg>', () => '<div class="skel-wrap"></div>', n => n.slice(0, 2), ps => ps.join(' & '));
  return { x, calls, kv, root, env, listeners };
};
// The daily spin on the Play tab: one state shared with the shop's wheel and the Shop tab dot (api/players.js rewards-sync carries it).
test('Play spin tile: Spin when free, Spun today with the win when used, one state for the Shop dot', () => {
  const { x } = phone({ box: true });
  assert.equal(x.Rewards.spinTileHTML(), '', 'nothing before the server has said');
  x.rwSpinLearn({ spunToday: false, wonToday: 0 });
  let tile = x.Rewards.spinTileHTML();
  assert.match(tile, /data-rw="spin"/); assert.match(tile, /<b>Daily spin: Spin<\/b>/); assert.ok(!/ done/.test(tile));
  x.rwSpinLearn({ spunToday: true, wonToday: 15 });
  tile = x.Rewards.spinTileHTML();
  assert.match(tile, /<b>Daily spin: Spun today, \+15<\/b>/); assert.match(tile, /Next spin (today|tomorrow) at /); assert.match(tile, / done/);
  assert.deepEqual(x.rwSpinNow(), { spun: true, won: 15 });
  x.rwSpinLearn(undefined);
  assert.equal(x.rwSpinNow(), null, 'an answer with no spin (box turned off) clears it');
});

test('Play spin tile and Shop dot are gone with rewards hidden or off, the box off, or no linked name', () => {
  for (const opts of [{ box: true, hide: true }, { box: true, on: false }, { box: false }, { box: true, name: '' }]) {
    const { x } = phone(opts);
    x.rwSpinLearn({ spunToday: false, wonToday: 0 });
    assert.equal(x.Rewards.spinTileHTML(), '', JSON.stringify(opts));
    assert.equal(x.rwSpinNow(), null, JSON.stringify(opts));
  }
});

test('a spin state from an earlier UTC day means ready again; the next spin is a clock time, not a countdown', () => {
  const { x } = phone({ box: true });
  x.rwSpinLearn({ spunToday: true, wonToday: 5 });
  const real = Date.now; Date.now = () => real() + 36 * 3600e3;
  try { assert.deepEqual(x.rwSpinNow(), { spun: false, won: 0 }); } finally { Date.now = real; }
  assert.ok(!/\d+ ?(h|hours?|min)\b.*left|countdown/i.test(x.rwSpinNext()));
  assert.match(x.rwSpinNext(new Date(Date.UTC(2026, 2, 5, 12))), /^(today|tomorrow) at /);
});

test('tapping the tile opens the shop and spins once through rewards-spin; an already used spin just opens it, and the tile follows', async () => {
  const free = phone({ box: true, spinFree: true });
  await free.x.Rewards.openStore({ spin: true });
  assert.deepEqual(free.calls.map(c => c.action), ['rewards-catalog', 'rewards-spin']);
  assert.match(free.x.Rewards.spinTileHTML(), /Spun today, \+5/, 'the tile reads the state the spin just set');
  const used = phone({ box: true, spinFree: false });
  await used.x.Rewards.openStore({ spin: true });
  assert.deepEqual(used.calls.map(c => c.action), ['rewards-catalog'], 'no second spin');
  const plain = phone({ box: true, spinFree: true });
  await plain.x.Rewards.openStore();
  assert.deepEqual(plain.calls.map(c => c.action), ['rewards-catalog'], 'the shop itself never spins on open');
});

test('wiring: the tile opens the shop and spins through the existing rewards-spin action; the Shop tab dot is a still dot named in its label', () => {
  const eco = module('economy'), shop = module('economyshop'), pg = page();
  assert.match(eco, /a === 'spin'\) \{ Rewards\.openStore\(\{ spin: true \}\)/);
  assert.match(shop, /async openStore\(opts\)[\s\S]*?rwStoreAct\(\{ action: 'rewards-spin' \}/);
  assert.match(eco, /b\.dataset\.dot = '1'/); assert.match(eco, /Shop\$\{dot \? '<span class="vh">, daily spin ready/);
  assert.match(pg, /tiles\.push\(Rewards\.spinTileHTML\(\)\)/);
  const css = pg.slice(pg.indexOf('.tabs button[data-dot]::after'), pg.indexOf('.tabs button[data-dot]::after') + 400);
  assert.ok(!/animation|transition/.test(css.split('\n')[0]), 'the dot is still');
  assert.match(pg.slice(pg.indexOf('.tile.rw-spintile {')).split('\n')[0], /min-height: 64px/, 'a 44 px+ target');
  assert.match(fs.readFileSync(new URL('../api/players.js', import.meta.url), 'utf8'), /rewards-get' \|\| body\.action === 'rewards-sync'[\s\S]*?club\.mystery_box \? [\s\S]*?spinStatus/);
});

const items = owned => CATALOGUE.map(i => ({ ...i, owned: owned.includes(i.id) }));

test('the shop sheet lists only what is unowned to buy and what is owned to wear, with fixed prices up front', () => {
  const { x } = phone();
  const html = x.Rewards.storeHTML({ store: { dinks: 44, worn: { frame: 'frame-court', paddle: '' }, items: items(['frame-court', 'frame-ink']) }, msg: '', error: '', busy: false });
  assert.match(html, /<b>44<\/b><span>Dinks<\/span>/);
  assert.ok(!/data-rw-wear/.test(html), 'the wear pickers moved to the Inventory');
  assert.match(html, /data-rw="inv"/);
  const wear = x.Rewards.storeHTML({ store: { dinks: 44, worn: { frame: 'frame-court', paddle: '' }, items: items(['frame-court', 'frame-ink']) }, msg: '', error: '', busy: false, inv: true });
  const buy = html.split('In the shop')[1];
  assert.match(wear, /data-rw-wear="frame:frame-court"[^>]*aria-pressed="true"/);
  assert.match(wear, /data-rw-wear="frame:frame-ink"[^>]*aria-pressed="false"/);
  assert.match(wear, /data-rw-wear="frame:"/, 'None is always an option');
  assert.ok(!/paddle:/.test(wear), 'no paddle picker until a paddle look is owned');
  assert.ok(!/data-rw-buy="frame-court"|data-rw-buy="frame-ink"/.test(buy), 'owned items are not offered again');
  assert.match(buy, /data-rw-buy="frame-blue"[\s\S]*?/);
  assert.match(buy, /Cobalt ring<\/b><small class="rw-cost">45 Dinks<\/small>[\s\S]*?data-rw-buy="frame-blue"[^>]*aria-label="Get Cobalt ring for 45 Dinks\. You need 1 more"[^>]*>1 more</, 'the price and the shortfall are stated before the tap');
  assert.match(html, /never changes a game, a rating, a rank/);
  assert.ok(!/animation|odds|random/i.test(html)); // WI-16 sells a celebration called Confetti, so that word is allowed in a card name; the effect itself is checked in economylooks.test.js
  assert.match(x.Rewards.storeHTML({ store: { dinks: 99, worn: {}, items: items(CATALOGUE.map(i => i.id)) }, msg: '', error: '', busy: false }), /You have everything in the shop/);
});

test('hidden on this phone: the sheet shows nothing to buy and no look is applied; shown: the worn ids become two attributes', () => {
  const hidden = phone({ hide: true });
  assert.ok(!/data-rw-buy|data-rw-wear/.test(hidden.x.Rewards.storeHTML({ store: { dinks: 50, worn: {}, items: items([]) } })));
  assert.equal(hidden.x.Rewards.cardHTML(), '');
  const shown = phone();
  shown.kv['pb.rewards'] = { 'club-a': { dinks: 3, streak: 1, last: '', worn: { frame: 'frame-double', paddle: 'paddle-stripe' } } };
  shown.x.rwApplyLook();
  assert.deepEqual(shown.root.attrs, { 'data-rw-frame': 'double', 'data-rw-skin': 'stripe' });
  const off = phone({ on: false });
  off.kv['pb.rewards'] = { 'club-a': { worn: { frame: 'frame-double', paddle: '' } } };
  off.x.rwApplyLook();
  assert.deepEqual(off.root.attrs, {}, 'a club with rewards off draws no look');
});

test('the card offers the Shop only to a phone linked to a name; opening it asks the server, a buy sends the item id and never a price', async () => {
  const { x, calls, listeners, kv } = phone();
  assert.match(x.Rewards.cardHTML(), /data-rw="store">Shop</);
  await x.Rewards.openStore();
  assert.deepEqual(calls[0], { action: 'rewards-catalog', name: 'Ana', playerToken: 'tok' });
  assert.equal(x.sheet.view, 'rwstore'); assert.equal(x.sheet.store.dinks, 20);
  const click = ds => listeners.forEach(f => f({ target: { closest: () => ({ dataset: ds }) } }));
  x.sheet.store = { ...x.sheet.store, dinks: 99 }; // enough for the 45-Dink Cobalt ring
  click({ rwBuy: 'frame-blue' });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(calls[1], { name: 'Ana', playerToken: 'tok', action: 'rewards-buy', item: 'frame-blue' });
  assert.equal(JSON.stringify(calls).includes('price'), false);
  assert.equal(kv['pb.rewards']['club-a'].dinks, 14, 'the card follows the server answer');
  // Too little: no call at all, a clear message.
  x.sheet.store = { dinks: 2, worn: {}, share: false, items: items([]) }; x.sheet.busy = false;
  const n = calls.length; click({ rwBuy: 'frame-court' });
  assert.equal(calls.length, n); assert.match(x.sheet.error, /Not enough Dinks yet: Forest ring costs 45 and you have 2\./);
});

test('club looks: never fetched when off or hidden, cleans server data, renders for members and updates on one-tap share toggle', async () => {
  const looksReply = { looks: { ana: { frame: 'frame-double', paddle: 'paddle-blue' }, bad: { frame: '"><x>', paddle: 'frame-ink' } } };
  // Off: no fetch, nothing drawn.
  const off = phone({ on: false, looksReply });
  await off.x.Rewards.syncLooks(true);
  assert.equal(off.calls.length, 0);
  assert.equal(off.x.Rewards.frameAttr('Ana'), '');
  assert.equal(off.x.Rewards.paddleBadgeHTML('Ana'), '');
  assert.equal(off.x.Rewards.teamHTML(['Ana', 'Ben']), 'Ana & Ben');
  // Hidden on this phone: no fetch, nothing drawn.
  const hid = phone({ hide: true, looksReply });
  await hid.x.Rewards.syncLooks(true);
  assert.equal(hid.calls.length, 0);
  assert.equal(hid.x.Rewards.frameAttr('Ana'), '');
  // On and shown (even for a member with no linked name): fetches once, drops bad ids, draws ring + paddle badge + game card inline look.
  const mem = phone({ name: null, looksReply });
  await mem.x.Rewards.syncLooks(true);
  assert.deepEqual(mem.calls, [{ action: 'rewards-looks' }]);
  assert.equal(mem.x.Rewards.frameAttr('Ana'), ' data-rw-frame="double"');
  assert.match(mem.x.Rewards.paddleBadgeHTML('Ana'), /data-rw-skin="blue"/);
  assert.equal(mem.x.Rewards.frameAttr('Ben'), '');
  assert.equal(mem.x.Rewards.frameAttr('Bad'), '');
  assert.match(mem.x.Rewards.teamHTML(['Ana', 'Ben']), /class="rw-g-av" data-rw-frame="double"[\s\S]*data-rw-skin="blue"[\s\S]*Ben/);
  assert.equal(mem.x.Rewards.teamHTML(['Ben', 'Cy']), 'Ben & Cy', 'games with no shared looks stay plain text');
  // One-tap share toggle in Shop sheet sends rewards-share and updates own club look immediately.
  const p = phone();
  const hOff = p.x.Rewards.storeHTML({ store: { dinks: 14, worn: { frame: 'frame-court', paddle: '' }, share: false, items: items(['frame-court']) }, msg: '', error: '', busy: false, inv: true });
  assert.match(hOff, /data-rw-share="1"[^>]*aria-pressed="false"/);
  assert.match(hOff, /Show my look to the club/);
  await p.x.Rewards.openStore();
  const click = ds => p.listeners.forEach(f => f({ target: { closest: () => ({ dataset: ds }) } }));
  click({ rwShare: '1' });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(p.calls[1], { name: 'Ana', playerToken: 'tok', action: 'rewards-share', share: true });
  assert.equal(p.x.Rewards.frameAttr('Ana'), ' data-rw-frame="court"', 'sharing immediately shows the worn ring in club views');
  click({ rwShare: '0' });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(p.x.Rewards.frameAttr('Ana'), '', 'hiding immediately removes the worn ring from club views');
});

// UX-09: fixed items come before the mystery box, an unaffordable button is muted but still says why, and "1 Dink" is singular.
test('UX-09: shop order, muted unaffordable buttons that stay focusable, and 1 Dink grammar', () => {
  const { x } = phone();
  const box = { price: 5, duplicateRefund: 2, dailyLimit: 3, openedToday: 0, tiers: [{ label: 'Common', chance: 100, items: [{ name: 'Team blue ring' }] }] };
  const html = x.Rewards.storeHTML({ store: { dinks: 1, worn: { frame: 'frame-court', paddle: '' }, items: items(['frame-court']), box }, msg: '', error: '', busy: false });
  const at = s => html.indexOf(s);
  assert.ok(at('rw-streak') > -1 && at('rw-streak') < at('In the shop'), 'the header and streak come first');
  if (at('Mystery box') > -1) assert.ok(at('In the shop') < at('Mystery box'), 'fixed items sit above the mystery box');
  assert.match(html, /<b>1<\/b><span>Dink<\/span>/);
  assert.ok(!/\b1 Dinks\b|<span>Dinks<\/span>/.test(html.replace(/<b>1<\/b><span>Dink<\/span>/g, '')), 'no "1 Dinks"');
  const buy = html.match(/<button[^>]*data-rw-buy="frame-blue"[^>]*>/)[0];
  assert.match(buy, /aria-disabled="true"/);
  assert.match(buy, /data-rw-short="1"/);
  assert.ok(!/ disabled/.test(buy), 'not natively disabled: it stays focusable and announces the shortfall when pressed');
  assert.match(buy, /aria-label="Get Cobalt ring for 45 Dinks\. You need 44 more"/);
  const rich = x.Rewards.storeHTML({ store: { dinks: 99999, worn: {}, items: items([]), box }, msg: '', error: '', busy: false });
  assert.ok(!/data-rw-short/.test(rich), 'affordable buttons are drawn as normal');
  assert.match(x.Rewards.storeHTML({ store: { dinks: 50, worn: {}, items: [{ id: 'frame-blue', slot: 'frame', name: 'Blue', price: 1, owned: false }] }, msg: '', error: '', busy: false }), /<small class="rw-cost">1 Dink<\/small>/);
});
test('WI-1: every item has a rarity, the rare tier is badged, and every shelf draws the same card', () => {
  for (const i of CATALOGUE) assert.ok(RARITIES.includes(i.rarity), `${i.id} has a known rarity`);
  assert.deepEqual(CATALOGUE.filter(i => i.rarity === 'rare').map(i => i.id), ['frame-double', 'paddle-stripe', 'pet-cat', 'pet-owl', 'pet-yorkie', 'pet-blob', 'pet-bat', 'pet-fox', 'sound-drum', 'sound-crowd', 'theme-sunset', 'theme-clay', 'theme-grass', 'theme-neon', 'theme-beach', 'theme-ice', 'theme-midnight', 'theme-arcade', 'celebrate-confetti', 'celebrate-balls', 'celebrate-pickles', 'celebrate-paddles', 'celebrate-hearts', 'title-erne', 'title-post', 'style-gold', 'style-glowing', 'style-flame', 'style-pickle', 'style-ice', 'style-neon']);
  assert.deepEqual(CATALOGUE.filter(i => i.rarity === 'legendary').map(i => i.id), ['pet-netdragon', 'sound-fanfare', 'frame-rainbow', 'frame-orbit', 'frame-crown', 'title-overlord', 'title-ruler', 'title-unbeaten', 'title-eager', 'style-holo', 'style-molten'], 'WI-13: the Legendary items (Net dragon came first)');
  const { x } = phone();
  const html = x.Rewards.storeHTML({ store: { dinks: 10, worn: { frame: 'frame-court' }, items: items(['frame-court']), season: null }, msg: '', error: '', busy: false });
  const cards = html.match(/<div class="rw-card"[\s\S]*?<\/button><\/div>/g) || [];
  assert.ok(cards.length >= 5, 'shelf draws cards');
  for (const c of cards) assert.match(c, /<div class="rw-badges">/, 'every card keeps the badge row so buttons line up');
  assert.match(html, /data-rw-card="frame-double"[\s\S]*?<span class="rw-badge" data-rarity="rare">Rare<\/span>/);
  assert.match(html, /data-rw-buy="frame-double"[^>]*aria-disabled="true"[^>]*>125 more</, 'unaffordable reads N more and stays focusable');
  assert.match(html, /data-rw-buy="paddle-court"[^>]*>Get</, 'affordable reads Get');
});
test('WI-1: owned cards read Wear / Wearing / Owned', () => {
  const { x } = phone();
  const season = { id: 'winter', name: 'Winter Frost', dates: 'Dec to Feb', returns: 'Back next year.' };
  const mk = worn => x.Rewards.storeHTML({ store: { dinks: 0, worn, season, items: [{ id: 'frame-frost', slot: 'frame', name: 'Winter Frost ring', price: 8, rarity: 'common', owned: true, seasonal: true, available: true }] }, msg: '', error: '', busy: false });
  assert.match(mk({ frame: '' }), /data-rw-wear="frame:frame-frost" aria-pressed="false" aria-label="Wear Winter Frost ring"[^>]*>Wear</);
  assert.match(mk({ frame: 'frame-frost' }), /aria-pressed="true" aria-label="Wearing Winter Frost ring"[^>]*>Wearing</);
  assert.match(x.rwItemCard({}, { dinks: 0, worn: {} }, { id: 'a', slot: 'frame', name: 'A', price: 1, owned: true }, { wear: false }), />Owned</);
});

test('slots are data-driven: eight known, unknown rejected, sound, theme and celebration never reach the club', async () => {
  const { SLOT_META, wearItem } = await import('../api/_economyshop.js');
  assert.deepEqual(SLOTS, ['frame', 'paddle', 'pet', 'title', 'style', 'theme', 'celebrate', 'sound']);
  assert.deepEqual(SLOTS, SLOT_META.map(s => s.id));
  for (const s of SLOT_META) assert.ok(s.label && s.note && typeof s.club === 'boolean', s.id);
  await assert.rejects(wearItem(null, 'c', 'k', 'court', ''), e => e.status === 400 && /Pick frame, paddle, pet, title, style, theme, celebrate or sound/.test(e.message));
  assert.deepEqual(wornFrom([{ id: 'frame-ink', slot: 'frame', worn: true }]), { frame: 'frame-ink', paddle: '', pet: '', title: '', style: '', theme: '', celebrate: '', sound: '' }); // a slot appears once the shop sells in it 
  // a title or style row with an unknown id is dropped; a known-slot row only passes through when its catalogue item exists
  assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: 'title', item: 'title-nope' }, { name_key: 'ana', slot: 'sound', item: 'sound-nope' }]), {});
});

// ---- WI-9: titles and name styles (upstream prices; ids and names pinned to the phone's mirror) ----
test('WI-9/13: sixteen titles and nine name styles at the upstream prices, in the right slots, with the phone mirror in step', async () => {
  const { TITLES, STYLES } = await import('../api/_economyitems.js');
  assert.deepEqual(TITLES.map(t => [t.name, t.price]), [['Kitchen King', 75], ['Dink Master', 75], ['Banger', 60], ['Lob Legend', 90], ['Third-Shot Wizard', 105], ['Erne Artist', 120], ['Soft Hands', 60], ['Net Ninja', 75], ['Drop Shot Doctor', 90], ['Speed-Up Specialist', 105], ['Around the Post', 135], ['Erne Overlord', 600], ['Ruler of the Kitchen', 720], ['The Unbeatable', 660], ['Gain Eager', 660], ['The Final Boss', 2800]]);
  assert.deepEqual(STYLES.map(s => [s.name, s.price]), [['Gold name', 120], ['Glowing name', 150], ['Flame name', 180], ['Pickle name', 120], ['Ice name', 135], ['Neon sign name', 165], ['Holographic name', 780], ['Molten gold name', 840], ['Starforged name', 3600]]);
  for (const i of [...TITLES, ...STYLES]) {
    assert.equal(itemById(i.id), i, `${i.id} is in the one CATALOGUE`);
    assert.match(i.id, new RegExp(`^${i.slot}-[a-z]{3,12}$`), 'id passes the phone allow-list');
  }
  assert.ok(TITLES.every(t => t.slot === 'title') && STYLES.every(s => s.slot === 'style' && ['rare', 'legendary', 'mythic'].includes(s.rarity)));
  const src = fs.readFileSync(path.join(root, 'src/app/economy.js'), 'utf8');
  const titles = new Function('return ' + /const RW_TITLES = (\{[^}]*\});/.exec(src)[1])();
  assert.deepEqual(Object.fromEntries(Object.entries(titles).filter(([k]) => TITLES.some(t => t.id === 'title-' + k))), Object.fromEntries(TITLES.map(t => [t.id.slice(6), t.name])), 'RW_TITLES mirrors the server titles (pass-only titles are pinned in economypass.test.js)');
  const styles = new Function('return ' + /const RW_STYLES = (\[[^\]]*\]);/.exec(src)[1])();
  assert.deepEqual(styles.filter(k => STYLES.some(s => s.id === 'style-' + k)), STYLES.map(s => s.id.slice(6)), 'RW_STYLES mirrors the server styles');
  // A title or style is an opt-in club look like a ring; the box never draws one.
  assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: 'title', item: 'title-kitchen' }, { name_key: 'ana', slot: 'style', item: 'style-gold' }, { name_key: 'ana', slot: 'style', item: 'title-kitchen' }]), { ana: { title: 'title-kitchen', style: 'style-gold' } });
});

test('WI-9: the shop shows Titles and Name styles shelves, and a worn title and style draw under and on the name', async () => {
  const looksReply = { looks: { ana: { frame: '', paddle: '', title: 'title-kitchen', style: 'style-gold' }, ben: { title: 'title-<x>', style: 'style-nope' } } };
  const { x } = phone({ looksReply });
  const html = x.Rewards.storeHTML({ store: { dinks: 80, worn: {}, items: items([]), season: null }, msg: '', error: '', busy: false });
  assert.match(html, /<h3 class="rw-h">Titles<\/h3><p class="rw-sec-note">Shown under your name\.<\/p>/);
  assert.match(html, /<h3 class="rw-h">Name styles<\/h3><p class="rw-sec-note">How your name looks on the leaderboard\.<\/p>/);
  assert.match(html, /data-rw-card="title-erne"[\s\S]*?<span class="rw-badge" data-rarity="rare">Rare<\/span>/);
  assert.match(html, /data-rw-card="style-gold"[\s\S]*?data-rw-style="gold"/);
  assert.match(html, /data-rw-buy="title-banger"[^>]*>Get</, 'affordable at 80');
  assert.match(html, /data-rw-buy="style-flame"[^>]*>100 more</, 'upstream price 180, 80 in hand');
  await x.Rewards.syncLooks(true);
  assert.match(x.Rewards.nameHTML('Ana'), /^<span class="rw-nm" data-rw-style="gold">Ana<\/span>$/);
  assert.equal(x.Rewards.titleHTML('Ana'), '<span class="rw-title">Kitchen King</span>');
  assert.equal(x.Rewards.nameHTML('Ben'), 'Ben', 'an unknown style is plain text');
  assert.equal(x.Rewards.titleHTML('Ben'), '');
  assert.equal(x.Rewards.nameHTML('Cal'), 'Cal');
  const off = phone({ on: false, looksReply });
  await off.x.Rewards.syncLooks(true);
  assert.equal(off.x.Rewards.nameHTML('Ana'), 'Ana');
  assert.equal(off.x.Rewards.titleHTML('Ana'), '');
});

// ---- WI-13: Mythic and Legendary shelves ----
test('WI-13: five Mythic and eleven Legendary items at the upstream prices, never in the box or the pass, none shown as a courts/celebration item yet', async () => {
  const { BOX_TIERS } = await import('../api/_economybox.js');
  const { PASS_TIERS } = await import('../api/_economypass.js');
  const mythic = CATALOGUE.filter(i => i.rarity === 'mythic');
  assert.deepEqual(mythic.map(i => [i.id, i.price]), [['pet-supernova', 4800], ['sound-ascension', 3000], ['frame-horizon', 3600], ['title-finalboss', 2800], ['style-starforged', 3600]]);
  const legend = CATALOGUE.filter(i => i.rarity === 'legendary');
  assert.deepEqual(legend.map(i => [i.name, i.price]), [['Net dragon', 800], ['Royal fanfare', 720], ['Spinning rainbow', 660], ['Orbiting ball', 720], ["Champion's crown", 960], ['Erne Overlord', 600], ['Ruler of the Kitchen', 720], ['The Unbeatable', 660], ['Gain Eager', 660], ['Holographic name', 780], ['Molten gold name', 840]]);
  const top = new Set([...mythic, ...legend].map(i => i.id));
  assert.ok(!BOX_TIERS.some(t => t.items.some(id => top.has(id))), 'a top item is not a box prize');
  assert.ok(!PASS_TIERS.some(t => t.item && top.has(t.item)), 'a top item is not a pass reward');
  for (const i of top) assert.match(i, /^[a-z]+-[a-z]{3,12}$/, 'id passes the phone allow-list');
});

test('WI-13: the Mythic and Legendary shelves come first Mythic, count the owners without names, and keep the common shelves free of them', () => {
  const { x } = phone();
  const list = owned => CATALOGUE.map(i => ({ ...i, owned: owned.includes(i.id), ...(i.rarity === 'mythic' ? { owners: i.id === 'title-finalboss' ? 2 : 0 } : {}) }));
  const html = x.Rewards.storeHTML({ store: { dinks: 99999, worn: {}, items: list([]), shinyWeek: null }, msg: '', error: '', busy: false });
  const at = s => html.indexOf(s);
  assert.ok(at('Mythic</h3>') > -1 && at('Mythic</h3>') < at('Legendary</h3>'), 'Mythic first, then Legendary');
  assert.match(html, /Only 5 exist\./);
  assert.match(html, /Nobody here has one yet/);
  assert.match(html, /2 players here have this/);
  assert.equal((html.match(/data-rw-top="mythic"/g) || []).length, 5);
  assert.equal((html.match(/data-rw-top="legendary"/g) || []).length, 11);
  const shelfOf = id => html.indexOf(`data-rw-card="${id}"`);
  assert.ok(shelfOf('title-finalboss') > at('Mythic</h3>') && shelfOf('title-finalboss') < at('Legendary</h3>'));
  assert.equal((html.match(/data-rw-card="title-finalboss"/g) || []).length, 1, 'each item is drawn once');
  assert.equal((html.match(/data-rw-card="pet-netdragon"/g) || []).length, 1, 'the Net dragon moved to the Legendary shelf');
  assert.ok(!/player here has this|players here have this/.test(html.replace(/2 players here have this/, '')), 'only the counted card says how many');
});

test('WI-13: buying a top item shows a quiet confirmation card; the card says nothing for a common item', () => {
  const { x } = phone();
  const list = owned => CATALOGUE.map(i => ({ ...i, owned: owned.includes(i.id), ...(i.rarity === 'mythic' ? { owners: owned.includes(i.id) ? 1 : 0 } : {}) }));
  const got = x.Rewards.storeHTML({ store: { dinks: 5, worn: {}, items: list(['title-finalboss']) }, got: 'title-finalboss', msg: '', error: '', busy: false });
  assert.match(got, /class="rw-got" role="status"[^>]*><b>The Final Boss is yours\.<\/b><span>One of 5 Mythic items in the shop\./);
  assert.ok(!/rw-got/.test(x.Rewards.storeHTML({ store: { dinks: 5, worn: {}, items: list(['title-finalboss']) }, msg: '', error: '', busy: false })), 'no card unless it was just bought');
});

test('WI-13: the owner count is a number per item, from this club only, with no name', async () => {
  const { loadOwnerCounts } = await import('../api/_economyshop.js');
  let q = '';
  const sql = (strings, ...vals) => { q = strings.join('?'); assert.deepEqual(vals, ['club-a']); return Promise.resolve([{ item: 'title-finalboss', n: 2 }]); };
  assert.deepEqual(await loadOwnerCounts(sql, 'club-a'), { 'title-finalboss': 2 });
  assert.ok(!/name_key\s*,|SELECT[^F]*name_key/i.test(q.split('FROM')[0]), 'the query selects no name');
  assert.match(q, /blocked_at IS NULL/);
});
