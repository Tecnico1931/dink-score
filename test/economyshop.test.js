import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CATALOGUE, SLOTS, itemById, planBuy, wornFrom, buyId } from '../api/_economyshop.js';
import { DAY_PAY, BONUS, ledgerBalance } from '../api/_economy.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const earn = n => ({ id: 'day:2026-01-' + String(n).padStart(2, '0'), kind: 'earn', amount: n, reason: 'day', day: null, streak: 1 });

test('the catalogue is small, fixed-price, cosmetic-only and affordable', () => {
  assert.ok(CATALOGUE.length >= 6 && CATALOGUE.length <= 10);
  assert.equal(new Set(CATALOGUE.map(i => i.id)).size, CATALOGUE.length, 'ids are unique');
  // Only these keys: nothing here can carry a rule, a score effect or a random draw.
  for (const i of CATALOGUE) {
    assert.deepEqual(Object.keys(i).sort(), ['id', 'name', 'price', 'slot']);
    assert.ok(SLOTS.includes(i.slot) && i.id.startsWith(i.slot + '-'));
    assert.ok(Number.isInteger(i.price) && i.price >= 1 && i.price <= 30);
    assert.match(buyId(i), /^[a-z0-9:_-]{4,64}$/, 'the ledger id is valid for spendEntry');
  }
  // A daily player (1 Dink a day plus the day-3 and day-7 streak bonuses) pays for any one item within a week or two.
  const week = 7 * DAY_PAY + BONUS[0][1] + BONUS[1][1];
  assert.ok(Math.max(...CATALOGUE.map(i => i.price)) <= 2 * week, 'the dearest item is within two weeks of play');
  assert.ok(Math.min(...CATALOGUE.map(i => i.price)) <= week, 'a first item is within a week');
});

test('planBuy: price comes from the catalogue, never below zero, a repeat charges nothing', () => {
  const frame = itemById('frame-court');
  assert.equal(planBuy([earn(frame.price)], [], 'frame-court').entry.amount, -frame.price);
  assert.equal(planBuy([earn(frame.price)], [], 'frame-court').entry.id, 'buy:frame-court');
  assert.throws(() => planBuy([earn(frame.price - 1)], [], 'frame-court'), e => e.status === 409 && /costs 6 and you have 5/.test(e.message));
  assert.throws(() => planBuy([], [], 'frame-court'), e => e.status === 409);
  assert.throws(() => planBuy([earn(99)], [], 'frame-gold'), e => e.status === 400, 'an unknown item is refused');
  assert.throws(() => planBuy([earn(99)], [], '__proto__'), e => e.status === 400);
  assert.deepEqual(planBuy([earn(99)], ['frame-court'], 'frame-court'), { item: frame, already: true }, 'owned: nothing to charge');
  // The ledger already holds the spend (a replay that lost the item row): no second row.
  const spent = [earn(20), { id: 'buy:frame-court', kind: 'spend', amount: -6, reason: 'shop:frame-court', day: null, streak: null }];
  assert.equal(planBuy(spent, [], 'frame-court').entry, null);
  assert.equal(ledgerBalance(spent), 14);
  // A spend never takes the balance below zero, however many are planned in a row.
  let ledger = [earn(14)];
  for (const id of ['frame-court', 'paddle-court']) { const p = planBuy(ledger, [], id); ledger = ledger.concat(p.entry); }
  assert.equal(ledgerBalance(ledger), 2);
  assert.throws(() => planBuy(ledger, [], 'paddle-blue'), e => e.status === 409);
});

test('wornFrom gives one item per slot, and none when nothing is worn', () => {
  assert.deepEqual(wornFrom([]), { frame: '', paddle: '' });
  assert.deepEqual(wornFrom([{ id: 'frame-ink', slot: 'frame', worn: true }, { id: 'frame-blue', slot: 'frame', worn: false }, { id: 'paddle-ink', slot: 'paddle', worn: false }]), { frame: 'frame-ink', paddle: '' });
});

test('the shop never reaches scoring, rating or club-code paths, and the page source stays free of economy words', () => {
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  for (const f of ['api/_rating.js', 'api/_pb.js', 'api/_gamesave.js', 'api/games.js', 'api/club.js', 'pb-engine.js', 'rating-engine.js']) assert.ok(!/economyshop|reward_items/.test(read(f)), f);
  assert.ok(!/Math\.random|crypto/.test(read('api/_economyshop.js')), 'nothing random is sold');
  assert.ok(!/price|odds|loot/i.test(read('dink-score.html')), 'prices and drawing live in src/app/economy*.js only');
});

// The phone side: draws what the server sends, hides with the one-tap switch, never trusts a stored or answered id.
import { module } from './helpers/app.js';
const phone = ({ hide = false, on = true } = {}) => {
  const calls = [], kv = { 'pb.rewardsHide': hide }, listeners = [], root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const env = { clubSheet: null, renders: 0, announced: [] };
  const code = module('economy') + ';' + module('economyshop') + ';return { Rewards, rwCur, rwClean, rwApplyLook, set sheet(v) { clubSheet = v; }, get sheet() { return clubSheet; } };';
  const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'renderClub', 'initials', 'iconSvg', 'skel',
    'let clubSheet = null;' + code)(
    { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } }, { code: 'club-a', rewards: on }, String, m => env.announced.push(m),
    { documentElement: root, addEventListener: (t, f) => listeners.push(f), querySelector: () => null }, () => 'Ana', () => 'tok',
    async b => { calls.push(b); return b.action === 'rewards-buy' ? { dinks: 14, worn: { frame: '', paddle: '' }, items: items(['frame-court']) } : { dinks: 20, worn: { frame: '', paddle: '' }, items: items([]) }; },
    () => env.renders++, () => {}, s => s.slice(0, 2), () => '<svg></svg>', () => '<div class="skel-wrap"></div>');
  return { x, calls, kv, root, env, listeners };
};
const items = owned => CATALOGUE.map(i => ({ ...i, owned: owned.includes(i.id) }));

test('the shop sheet lists only what is unowned to buy and what is owned to wear, with fixed prices up front', () => {
  const { x } = phone();
  const html = x.Rewards.storeHTML({ store: { dinks: 7, worn: { frame: 'frame-court', paddle: '' }, items: items(['frame-court', 'frame-ink']) }, msg: '', error: '', busy: false });
  assert.match(html, /<b>7<\/b> Dinks/);
  const [wear, buy] = html.split('In the shop');
  assert.match(wear, /data-rw-wear="frame:frame-court"[^>]*aria-pressed="true"/);
  assert.match(wear, /data-rw-wear="frame:frame-ink"[^>]*aria-pressed="false"/);
  assert.match(wear, /data-rw-wear="frame:"/, 'None is always an option');
  assert.ok(!/paddle:/.test(wear), 'no paddle picker until a paddle look is owned');
  assert.ok(!/data-rw-buy="frame-court"|data-rw-buy="frame-ink"/.test(buy), 'owned items are not offered again');
  assert.match(buy, /data-rw-buy="frame-blue"[\s\S]*?/);
  assert.match(buy, /Team blue ring<\/b><small>8 Dinks\. You need 1 more\./, 'the price and the shortfall are stated before the tap');
  assert.match(html, /never changes a game, a rating, a rank/);
  assert.ok(!/animation|confetti|odds|random/i.test(html));
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
  click({ rwBuy: 'frame-blue' });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(calls[1], { name: 'Ana', playerToken: 'tok', action: 'rewards-buy', item: 'frame-blue' });
  assert.equal(JSON.stringify(calls).includes('price'), false);
  assert.equal(kv['pb.rewards']['club-a'].dinks, 14, 'the card follows the server answer');
  // Too little: no call at all, a clear message.
  x.sheet.store = { dinks: 2, worn: {}, items: items([]) }; x.sheet.busy = false;
  const n = calls.length; click({ rwBuy: 'frame-court' });
  assert.equal(calls.length, n); assert.match(x.sheet.error, /Not enough Dinks yet: Court green ring costs 6 and you have 2\./);
});
