// Rewards mystery box: pure odds/draw rules (api/_economybox.js), guard checks and calm Shop UI (src/app/economyshop.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOX_PRICE, BOX_DUPLICATE_REFUND, BOX_DAILY_LIMIT, BOX_TIERS,
  boxOdds, boxTiers, boxEligible, drawBoxItem, tierOfItem, cleanOpenId, boxSpendId, boxRefundId
} from '../api/_economybox.js';
import { CATALOGUE } from '../api/_economyshop.js';
import { SEASONAL, EVENT_ITEMS } from '../api/_economyseason.js';
import { PASS_ITEMS } from '../api/_economyxp.js';
import { validEntry } from '../api/_economy.js';
import { module } from './helpers/app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('odds are 82 / 17 / 1, the pool is every unowned non-Mythic catalogue item, and refund is strictly below cost', () => {
  assert.deepEqual(BOX_TIERS.map(t => [t.id, t.chance]), [['regular', 82], ['pet', 17], ['legendary', 1]]);
  assert.equal(BOX_TIERS.reduce((s, t) => s + t.chance, 0), 100, 'rarity chances must sum to exactly 100%');
  assert.equal(BOX_PRICE, 300);
  assert.ok(Number.isInteger(BOX_DUPLICATE_REFUND) && BOX_DUPLICATE_REFUND > 0 && BOX_DUPLICATE_REFUND < BOX_PRICE);
  assert.ok(Number.isInteger(BOX_DAILY_LIMIT) && BOX_DAILY_LIMIT >= 1 && BOX_DAILY_LIMIT <= 10);

  const full = boxTiers();
  const flat = full.flatMap(t => t.items.map(i => i.id));
  assert.equal(new Set(flat).size, flat.length, 'no item listed twice across tiers');
  assert.deepEqual(flat.slice().sort(), CATALOGUE.filter(i => i.rarity !== 'mythic').map(i => i.id).sort(), 'every non-Mythic catalogue item is in the pool');
  const [regular, pet, legendary] = full;
  assert.ok(regular.items.every(i => i.slot !== 'pet' && i.rarity !== 'legendary'));
  assert.ok(pet.items.length === 10 && pet.items.every(i => i.slot === 'pet' && i.rarity !== 'legendary' && i.rarity !== 'mythic'));
  assert.ok(legendary.items.length === 15 && legendary.items.every(i => i.rarity === 'legendary'));
  assert.ok(flat.every(id => CATALOGUE.find(i => i.id === id).rarity !== 'mythic'), 'no Mythic');
  assert.ok(CATALOGUE.filter(i => i.rarity === 'mythic').every(i => !boxEligible(i)));
  // Pass, event and seasonal items are not in CATALOGUE, so they can never be drawn.
  for (const i of [...SEASONAL, ...EVENT_ITEMS, ...PASS_ITEMS]) assert.ok(!flat.includes(i.id), i.id + ' is not a box prize');

  const odds = boxOdds();
  assert.equal(odds.price, BOX_PRICE);
  assert.equal(odds.duplicateRefund, BOX_DUPLICATE_REFUND);
  assert.equal(odds.dailyLimit, BOX_DAILY_LIMIT);
  assert.deepEqual(odds.tiers.map(t => [t.id, t.label, t.chance, t.items.length]), full.map(t => [t.id, t.label, t.chance, t.items.length]), 'boxOdds() comes straight from the draw rules');
});

test('owned items leave the pool, an empty group hands its weight on, and the odds shown still sum to 100', () => {
  const ids = t => t.items.map(i => i.id);
  const [regular, pet] = boxTiers();
  const have = [ids(regular)[0], ids(pet)[0]];
  const after = boxTiers(have);
  assert.ok(!after.flatMap(ids).some(id => have.includes(id)), 'an owned item is not offered');
  assert.deepEqual(after.map(t => t.chance), [82, 17, 1]);
  // Own every pet: the pet group is empty, its 17 goes to Regular, and the table says so.
  const noPets = boxTiers(CATALOGUE.filter(i => i.slot === 'pet').map(i => i.id));
  assert.deepEqual(noPets.map(t => [t.id, t.chance]), [['regular', 99], ['legendary', 1]]);
  // Own every regular item: the first group left (Pet) takes Regular's 82.
  const noRegular = boxTiers(regular.items.map(i => i.id));
  assert.deepEqual(noRegular.map(t => [t.id, t.chance]), [['pet', 99], ['legendary', 1]]);
  // Own everything the box can give: no tiers, no draw.
  const all = CATALOGUE.map(i => i.id);
  assert.deepEqual(boxTiers(all), []);
  assert.equal(drawBoxItem(() => 0, all), null);
  assert.deepEqual(boxOdds(null, all).tiers, []);
  // A draw never returns an owned item, for every possible roll.
  for (let roll = 0; roll < 100; roll++) {
    const got = drawBoxItem(max => (max === 100 ? roll : max - 1), have);
    assert.ok(!have.includes(got.item.id));
  }
});

test('pure drawBoxItem with an injected random source maps every roll 0..99 to the right group and item', () => {
  const counts = { regular: 0, pet: 0, legendary: 0 };
  for (let roll = 0; roll < 100; roll++) {
    let step = 0;
    const picked = drawBoxItem(max => {
      step++;
      if (step === 1) { assert.equal(max, 100); return roll; }
      return 0;
    });
    counts[picked.tier.id]++;
    assert.equal(picked.tier.id, roll < 82 ? 'regular' : roll < 99 ? 'pet' : 'legendary');
    assert.deepEqual(tierOfItem(picked.item.id), picked.tier);
  }
  assert.deepEqual(counts, { regular: 82, pet: 17, legendary: 1 });

  // Every item within each group is reachable by the second random call.
  const bounds = [['regular', 0], ['pet', 82], ['legendary', 99]];
  for (const [tierId, tierRoll] of bounds) {
    const tier = boxTiers().find(t => t.id === tierId);
    const seen = tier.items.map((_, idx) => {
      let step = 0;
      return drawBoxItem(() => (++step === 1 ? tierRoll : idx)).item.id;
    });
    assert.deepEqual(seen, tier.items.map(i => i.id));
  }

  // Out-of-range or non-integer random outputs throw instead of silently biasing.
  for (const bad of [-1, 100, 1.5, NaN]) assert.throws(() => drawBoxItem(() => bad), /out of range/);
  assert.throws(() => { let n = 0; drawBoxItem(m => (++n === 1 ? 0 : m)); }, /out of range/);
});

test('openId validation and ledger entry ids satisfy the append-only ledger rules', () => {
  assert.equal(cleanOpenId('box_open-1234'), 'box_open-1234');
  for (const bad of ['', 'short', 'has space 123', 'bad/slash123', 'a'.repeat(41), null, undefined]) {
    assert.throws(() => cleanOpenId(bad), e => e.status === 400);
  }
  const spend = { id: boxSpendId('abcd1234ef'), kind: 'spend', amount: -BOX_PRICE, reason: 'box:frame-court', day: '2026-11-22', streak: null };
  const refund = { id: boxRefundId('abcd1234ef'), kind: 'earn', amount: BOX_DUPLICATE_REFUND, reason: 'boxref:frame-court', day: null, streak: null };
  assert.ok(validEntry(spend));
  assert.ok(validEntry(refund));
});

test('server draw uses node:crypto CSPRNG only, switch is additive and organizer-only, no scoring/rating coupling', () => {
  const src = read('api/_economybox.js');
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  assert.match(code, /from 'node:crypto'/);
  assert.match(code, /\brandomInt\b/);
  assert.ok(!/Math\.random|pity|countdown|\bstripe\b|payment/i.test(code.replace(/paddle-stripe/g, '')));
  assert.match(read('api/_db.js'), /ADD COLUMN IF NOT EXISTS mystery_box boolean NOT NULL DEFAULT false/);
  const clubJs = read('api/club.js');
  const at = clubJs.indexOf("body.action === 'set-mystery-box'");
  assert.ok(at > 0, 'club.js has set-mystery-box');
  const block = clubJs.slice(at, clubJs.indexOf("body.action === 'set-pay-link'", at));
  assert.match(block, /requireOrganizer\(club, body\.pin, req, body\.ownerToken\)/);
  assert.match(block, /AND NOT quick/);
  // Calm UI: no animation, transition, keyframes, confetti, or audio in shop/box CSS or module.
  const shopJs = read('src/app/economyshop.js');
  assert.ok(!/Math\.random|@keyframes|confetti|Audio\(|\.play\(/i.test(shopJs));
  const html = read('dink-score.html');
  const boxCss = html.slice(html.indexOf('.rw-box {'), html.indexOf('.me-btn.frame-crown::before'));
  assert.ok(!/animation|transition|@keyframes/.test(boxCss));
  assert.match(boxCss, /\.btn-court \{[^}]*min-height: 44px/);
});

// Phone UI behavior for the Mystery box in the Shop sheet.
const phone = ({ hide = false, rewards = true, mysteryBox = true, name = 'Ana', replyFn } = {}) => {
  const calls = [], kv = { 'pb.rewardsHide': hide }, listeners = [];
  const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const env = { announced: [] };
  const code = module('economy') + ';' + module('economyshop') + ';return { Rewards, set sheet(v) { clubSheet = v; }, get sheet() { return clubSheet; } };';
  const defaultBox = { ...boxOdds(), openedToday: 0 };
  const items = owned => CATALOGUE.map(i => ({ ...i, owned: owned.includes(i.id) }));
  const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'renderClub', 'initials', 'iconSvg', 'skel', 'avatarInner', 'teamLabel',
    'let clubSheet = null;' + code)(
    { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } },
    { code: 'club-a', rewards, mysteryBox },
    String,
    m => env.announced.push(m),
    { documentElement: root, addEventListener: (t, f) => listeners.push(f), querySelector: () => null },
    () => name,
    () => (name ? 'tok' : null),
    async b => {
      calls.push(b);
      if (replyFn) return replyFn(b);
      if (b.action === 'rewards-box-open') {
        return {
          dinks: 13, worn: { frame: '', paddle: '' }, share: false, items: items(['frame-blue']),
          box: { ...defaultBox, openedToday: 1 },
          result: { openId: b.openId, item: CATALOGUE[1], tier: { id: 'regular', label: 'Regular', chance: 82 }, duplicate: false, refund: 0, cost: BOX_PRICE, replayed: false }
        };
      }
      return { dinks: 20, worn: { frame: '', paddle: '' }, share: false, items: items([]), ...(mysteryBox ? { box: defaultBox } : {}) };
    },
    () => {}, () => {}, s => s.slice(0, 2), () => '<svg></svg>', () => '<div></div>', n => n.slice(0, 2), ps => ps.join(' & ')
  );
  return { x, calls, env, listeners, items, defaultBox };
};

test('Shop UI hides the mystery box when rewards off, mysteryBox off, or one-tap hide is on', () => {
  const odds = { ...boxOdds(), openedToday: 0 };
  const store = { dinks: 20, worn: { frame: '', paddle: '' }, share: false, items: CATALOGUE.map(i => ({ ...i, owned: false })), box: odds };
  for (const opts of [{ rewards: false, mysteryBox: true }, { rewards: true, mysteryBox: false }, { rewards: true, mysteryBox: true, hide: true }]) {
    const { x } = phone(opts);
    const html = x.Rewards.storeHTML({ store, msg: '', error: '', busy: false, boxResult: null });
    assert.ok(!/data-rw-box-open|Odds before you open/.test(html), JSON.stringify(opts));
  }
});

test('Shop UI shows plain-words odds before opening, announces results, handles shortfall/limit, and reuses openId on offline retry', async () => {
  let failOnce = true;
  const p = phone({
    replyFn: async b => {
      if (b.action === 'rewards-catalog') return { dinks: BOX_PRICE + 20, worn: { frame: '', paddle: '' }, share: false, items: CATALOGUE.map(i => ({ ...i, owned: false })), box: { ...boxOdds(), openedToday: 0 } };
      if (b.action === 'rewards-box-open') {
        if (failOnce) { failOnce = false; throw Object.assign(new Error("Can't reach the server."), { offline: true }); }
        return {
          dinks: 17, worn: { frame: '', paddle: '' }, share: false, items: CATALOGUE.map(i => ({ ...i, owned: i.id === 'frame-court' })),
          box: { ...boxOdds(), openedToday: 1 },
          result: { openId: b.openId, item: CATALOGUE[0], tier: { id: 'regular', label: 'Regular', chance: 82 }, duplicate: true, refund: BOX_DUPLICATE_REFUND, cost: BOX_PRICE, replayed: false }
        };
      }
      return {};
    }
  });
  await p.x.Rewards.openStore();
  const html = p.x.Rewards.storeHTML(p.x.sheet);
  assert.match(html, /Odds before you open/);
  assert.match(html, /Regular[\s\S]*82% \(82 in 100\)/);
  assert.match(html, /Pet[\s\S]*17% \(17 in 100\)/);
  assert.match(html, /Legendary[\s\S]*1% \(1 in 100\)/);
  assert.match(html, /you don\u2019t own yet: [^<]*Optic ring/);
  assert.match(html, /Duplicate refund: if you already own the item drawn, 4 Dinks are returned/);
  assert.match(html, /0 of 3 opened today/);
  assert.match(html, new RegExp(`Open mystery box \\(${BOX_PRICE} Dinks\\)`));
  // Card: gift art, the odds in one sentence built from the server tiers, and no shortfall label while the balance reaches.
  assert.match(html, /class="rw-gift"/);
  assert.match(html, /A random look from the shop\. 82% regular · 17% pet · 1% legendary\./);
  assert.ok(!/more Dinks/.test(html));
  assert.equal(BOX_PRICE, 300, 'upstream box price');

  const click = ds => p.listeners.forEach(f => f({ target: { closest: () => ({ dataset: ds }) } }));
  // First click hits offline error -> pendingOpenId is kept for idempotent retry.
  click({ rwBoxOpen: '1' });
  await new Promise(r => setTimeout(r, 10));
  const firstId = p.calls[1].openId;
  assert.match(firstId, /^[a-zA-Z0-9_-]{8,40}$/);
  assert.equal('price' in p.calls[1] || 'item' in p.calls[1], false, 'client never sends price or item');

  // Retry sends the EXACT same openId and announces the duplicate refund calmly.
  click({ rwBoxOpen: '1' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(p.calls[2].openId, firstId, 'offline retry reuses the same openId');
  assert.match(p.env.announced.at(-1), /Mystery box: Optic ring \(Regular\), already owned\. 4 Dinks returned/);
  const afterHtml = p.x.Rewards.storeHTML(p.x.sheet);
  assert.match(afterHtml, /Optic ring \(already owned\)/);
  assert.match(afterHtml, /1 of 3 opened today/);

  // Shortfall refuses locally with a clear announced message and no extra server call.
  const countBefore = p.calls.length;
  p.x.sheet.store.dinks = 3;
  click({ rwBoxOpen: '1' });
  assert.equal(p.calls.length, countBefore);
  assert.match(p.x.sheet.error, new RegExp(`Not enough Dinks yet: a mystery box costs ${BOX_PRICE} and you have 3\\.`));
  // The button reads "N more Dinks" (muted, still focusable, shortfall spoken) when the balance doesn't reach.
  const low = p.x.Rewards.storeHTML(p.x.sheet);
  assert.match(low, new RegExp(`data-rw-box-open="1" aria-label="Open mystery box for ${BOX_PRICE} Dinks\\. You need ${BOX_PRICE - 3} more" aria-disabled="true" data-rw-short="1"[^>]*>${BOX_PRICE - 3} more Dinks<`));
});
