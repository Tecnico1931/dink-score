// WI-14: XP, levels and the XP season pass: pure rules, guard assertions and phone UI (api/_economyxp.js, api/_economypass.js, src/app/economypass.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASS_TIERS, PASS_MAX_XP, tierByNum, passClaimId, buildPassView, planPassClaim } from '../api/_economypass.js';
import { XP_GAME, XP_WIN, XP_DAY_CAP, LEVEL_MAX, LEVEL_XP, PASS_ITEMS, levelFor, xpFromGames } from '../api/_economyxp.js';
import { CATALOGUE, itemById, planBuy, clubLooksFrom } from '../api/_economyshop.js';
import { validEntry, summary, deriveEarnings, ledgerBalance } from '../api/_economy.js';
import { seasonAt } from '../api/_progress.js';
import { module } from './helpers/app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const Q4 = seasonAt(Date.UTC(2026, 10, 15), []);
const CUSTOM = seasonAt(Date.UTC(2026, 10, 15), [{ at: Date.UTC(2026, 10, 10), name: 'Fall 2026, part 2' }]);

test('XP: 10 a game, 15 for a win, 300 a UTC day, only games your own phone saved, only if you played', () => {
  assert.deepEqual([XP_GAME, XP_WIN, XP_DAY_CAP, LEVEL_MAX], [10, 15, 300, 25]);
  const t = Date.UTC(2026, 10, 15, 10);
  const g = (over = {}) => ({ teams: [['Ana', 'Ben'], ['Cy', 'Di']], r: t, scoredBy: 'ana', winner: 1, ...over });
  assert.equal(xpFromGames([g()], 'ana'), 10, 'a loss gives 10');
  assert.equal(xpFromGames([g({ winner: 0 })], 'ana'), 15, 'a win gives 15');
  assert.equal(xpFromGames([g({ winner: 0 })], 'cy', { }), 0, 'sent by someone else: nothing');
  assert.equal(xpFromGames([g({ winner: 0, scoredBy: 'cy' })], 'cy'), 10, 'the other side lost');
  assert.equal(xpFromGames([g({ winner: 1, scoredBy: 'cy' })], 'cy'), 15);
  assert.equal(xpFromGames([g({ winner: null })], 'ana'), 10, 'no winner on record: the play XP only');
  assert.equal(xpFromGames([g({ scoredBy: undefined, scoredByPlayer: 'ana', winner: 0 })], 'ana'), 15, 'the creator\'s claimed name counts');
  assert.equal(xpFromGames([g({ teams: [['Ben', 'Cy'], ['Di', 'Eve']] })], 'ana'), 0, 'Ana did not play');
  assert.equal(xpFromGames([g({ r: NaN })], 'ana'), 0);
  assert.equal(xpFromGames([g(), null], ''), 0);
  // 25 wins in one UTC day: 375 raw, 300 kept; the next day starts over.
  const day = Array.from({ length: 25 }, (_, i) => g({ winner: 0, r: t + i * 1000 }));
  assert.equal(xpFromGames(day, 'ana'), 300);
  assert.equal(xpFromGames([...day, g({ winner: 0, r: t + 864e5 })], 'ana'), 315);
  // A season window is half open.
  assert.equal(xpFromGames([g({ r: Q4.start - 1 }), g({ r: Q4.start }), g({ r: Q4.end })], 'ana', { from: Q4.start, to: Q4.end }), 10);
});

test('levels: 25, 40 XP to level 2 as upstream shows, rising steps, capped at the top', () => {
  assert.equal(LEVEL_XP.length, 25);
  assert.deepEqual(levelFor(0), { xp: 0, level: 1, max: 25, toNext: 40, into: 0, step: 40 });
  assert.equal(levelFor(39).level, 1);
  assert.equal(levelFor(40).level, 2);
  assert.equal(levelFor(40).toNext, 50);
  for (let i = 1; i < LEVEL_XP.length; i++) assert.ok(LEVEL_XP[i] > LEVEL_XP[i - 1]);
  assert.equal(levelFor(LEVEL_XP[24]).level, 25);
  assert.equal(levelFor(1e9).level, 25);
  assert.equal(levelFor(1e9).toNext, 0);
  assert.equal(levelFor(-5).level, 1);
  assert.equal(levelFor('x').xp, 0);
});

test('PASS_TIERS is 8 tiers of 125 season XP, 1000 in all, every item pass-only and out of the shop', () => {
  assert.equal(PASS_TIERS.length, 8);
  assert.equal(PASS_MAX_XP, 1000);
  let prev = 0, items = 0;
  for (let i = 0; i < PASS_TIERS.length; i++) {
    const t = PASS_TIERS[i];
    assert.deepEqual(Object.keys(t).sort(), ['dinks', 'item', 'tier', 'xp']);
    assert.equal(t.tier, i + 1);
    assert.equal(t.xp, 125 * (i + 1));
    assert.ok(t.xp > prev); prev = t.xp;
    assert.equal(t.dinks, 25);
    if (t.item) {
      items++;
      assert.ok(PASS_ITEMS.some(p => p.id === t.item), `tier ${t.tier} item ${t.item} is a pass item`);
      assert.equal(CATALOGUE.some(c => c.id === t.item), false, 'not sold in the shop or drawn by the box');
    }
    for (const s of [Q4, CUSTOM]) assert.ok(validEntry({ id: passClaimId(s.id, t.tier), kind: 'earn', amount: t.dinks, reason: 'pass', day: null, streak: null }));
  }
  assert.equal(items, 7);
  for (const p of PASS_ITEMS) {
    assert.equal(itemById(p.id), p, 'owned pass items stay known to the shop');
    assert.match(p.id, new RegExp(`^${p.slot}-[a-z]{3,12}$`));
    assert.throws(() => planBuy([{ id: 'x:1234', kind: 'earn', amount: 9999, reason: 'x', day: null, streak: null }], [], p.id), e => e.status === 409 && /can't be bought/.test(e.message));
  }
  // A pass title/ring is an opt-in club look like any other; a sound stays on its phone.
  assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: 'title', item: 'title-grinder' }, { name_key: 'ana', slot: 'sound', item: 'sound-whistle' }]), { ana: { title: 'title-grinder' } });
});

test('the phone mirrors the pass-only titles and style names', () => {
  const src = read('src/app/economy.js');
  const titles = new Function('return ' + /const RW_TITLES = (\{[^}]*\});/.exec(src)[1])();
  for (const p of PASS_ITEMS.filter(i => i.slot === 'title')) assert.equal(titles[p.id.slice(6)], p.name, p.id);
  const styles = new Function('return ' + /const RW_STYLES = (\[[^\]]*\]);/.exec(src)[1])();
  for (const p of PASS_ITEMS.filter(i => i.slot === 'style')) assert.ok(styles.includes(p.id.slice(6)), p.id);
  assert.match(read('src/app/economysound.js'), /'sound-whistle':/);
  const css = read('dink-score.html');
  for (const p of PASS_ITEMS.filter(i => i.slot === 'frame')) assert.ok(css.includes(`[data-rw-frame="${p.id.slice(6)}"]`), p.id);
  assert.ok(css.includes('.rw-nm[data-rw-style="courtline"]'));
});

test('planPassClaim: tier validity, season XP, idempotent replay, item grant and the already-owned fallback', () => {
  for (const bad of [0, -1, 9, 1.5, '1', null, undefined, '__proto__']) {
    assert.throws(() => planPassClaim({ xp: 9999, season: Q4, tier: bad }), e => e.status === 400);
  }
  assert.equal(tierByNum(1).tier, 1);
  assert.equal(tierByNum('1'), null);
  assert.throws(() => planPassClaim({ xp: 0, season: Q4, tier: 1 }), e => e.status === 409 && /Earn 125 more season XP/.test(e.message));
  assert.throws(() => planPassClaim({ xp: 300, season: Q4, tier: 3 }), e => e.status === 409 && /Earn 75 more season XP/.test(e.message));

  // The Dinks-only tier (6).
  const p6 = planPassClaim({ ledger: [], owned: [], xp: 750, season: Q4, tier: 6 });
  assert.equal(p6.item, null);
  assert.deepEqual(p6.entry, { id: `xpass:${Q4.id}:6`, kind: 'earn', amount: 25, reason: 'pass:tier-6', day: null, streak: null });
  assert.ok(validEntry(p6.entry));
  const rep = planPassClaim({ ledger: [p6.entry], owned: [], xp: 750, season: Q4, tier: 6 });
  assert.deepEqual(rep, { tier: PASS_TIERS[5], already: true, entry: null, item: null, alreadyOwned: false });

  // An item tier grants the item and the 25 Dinks the first time ...
  const p1 = planPassClaim({ ledger: [], owned: [], xp: 125, season: Q4, tier: 1 });
  assert.equal(p1.item.id, 'title-grinder');
  assert.equal(p1.entry.amount, 25);
  assert.equal(p1.entry.reason, 'pass:title-grinder');
  // ... and only the 25 Dinks when it is already owned (a later season).
  const own = planPassClaim({ ledger: [], owned: ['title-grinder'], xp: 125, season: CUSTOM, tier: 1 });
  assert.equal(own.item, null);
  assert.equal(own.alreadyOwned, true);
  assert.equal(own.entry.amount, 25);
  assert.equal(own.entry.id, `xpass:${CUSTOM.id}:1`);

  // Pass ledger rows never disturb the daily streak calculation or summary.
  const day1 = Date.parse('2026-11-15T12:00:00Z'), day2 = Date.parse('2026-11-16T12:00:00Z');
  const dayEarn = deriveEarnings({ ledger: [p6.entry], receivedAt: [day1], tz: 0, now: day1 + 1000 });
  assert.equal(dayEarn.length, 1);
  assert.equal(dayEarn[0].streak, 1);
  const combined = [p6.entry, ...dayEarn];
  assert.deepEqual(summary(combined, 0, day2), { dinks: ledgerBalance(combined), streak: 1, best: 1, last: '2026-11-15' });
});

test('buildPassView: season XP, level, unlocked, claimed, claimable and owned flags', () => {
  const ledger = [{ id: 'day:2026-11-10', kind: 'earn', amount: 5, reason: 'day', day: '2026-11-10', streak: 1 }, { id: `xpass:${Q4.id}:1`, kind: 'earn', amount: 25, reason: 'pass:title-grinder', day: null, streak: null }];
  const items = [{ id: 'title-grinder', slot: 'title', worn: true }];
  const v = buildPassView({ season: Q4, xp: 300, allXp: 45, ledger, items, share: true });
  assert.equal(v.xp, 300);
  assert.equal(v.maxXp, 1000);
  assert.equal(v.tierXp, 125);
  assert.deepEqual(v.level, levelFor(45));
  assert.equal(v.dinks, 30);
  assert.equal(v.worn.title, 'title-grinder');
  assert.equal(v.share, true);
  assert.equal(v.claimable, 1, 'tier 2 is unlocked and unclaimed; tier 1 is claimed');
  assert.equal(v.tiers[0].claimed, true);
  assert.equal(v.tiers[0].item.owned, true);
  assert.equal(v.tiers[1].unlocked, true);
  assert.equal(v.tiers[1].item.owned, false);
  assert.equal(v.tiers[2].unlocked, false);
  assert.equal(v.tiers[5].item, null);
  assert.ok(v.tiers.every(t => t.payoutDinks === 25 && t.xp === 125 * t.tier));
});

test('guard: pass code has no randomness, paid tier or motion; XP code reads only who, who sent, when and the winning side', () => {
  for (const f of ['api/_economypass.js', 'src/app/economypass.js']) {
    const code = read(f).replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
    assert.ok(!/\bscore\b|\brating|\brank|pairing|winner|Math\.random|\bstripe\b|payment|@keyframes|animation|transition|confetti|Audio\(|\.play\(\)/i.test(code.replace(/a game, a rating or a rank/g, '').replace(/data->>'winner' AS winner, /, '')), f);
  }
  const xp = read('api/_economyxp.js').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  assert.ok(!/\bscore\b|\brating|\brank|pairing|Math\.random|payment/i.test(xp), 'XP never reads a score, rating, rank or pairing');
  for (const f of ['api/_rating.js', 'api/_pb.js', 'api/_gamesave.js', 'api/games.js', 'api/club.js', 'pb-engine.js', 'rating-engine.js']) {
    assert.ok(!/economypass|economyxp|rewards-pass/.test(read(f)), f + ' must not touch the pass or XP');
  }
});

// Phone UI tests for src/app/economypass.js.
const phone = ({ hide = false, on = true, name = 'Ana', passReply, claimReply, restartReply } = {}) => {
  const calls = [], kv = { 'pb.rewardsHide': hide }, listeners = [], rootEl = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const env = { renders: 0, announced: [], focused: null };
  const code = module('economy') + ';' + module('economyshop') + ';' + module('economypass')
    + ';return { Rewards, set sheet(v) { clubSheet = v; }, get sheet() { return clubSheet; } };';
  const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'renderClub', 'initials', 'iconSvg', 'skel', 'avatarInner', 'teamLabel', 'isMe',
    'let clubSheet = null;' + code)(
    { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } },
    { code: 'club-a', rewards: on }, String, m => env.announced.push(m),
    { documentElement: rootEl, addEventListener: (t, f) => listeners.push(f), querySelector: sel => ({ focus() { env.focused = sel; } }) },
    () => name, () => (name ? 'tok' : null),
    async b => {
      calls.push(b);
      if (b.action === 'rewards-pass') return passReply;
      if (b.action === 'rewards-pass-claim') return typeof claimReply === 'function' ? claimReply(b) : claimReply;
      if (b.action === 'rewards-restart') return restartReply;
      return { dinks: 0, worn: { frame: '', paddle: '' }, share: false, items: CATALOGUE.map(i => ({ ...i, owned: false })) };
    },
    () => env.renders++, () => {}, s => s.slice(0, 2), () => '<svg></svg>', () => '<div class="skel-wrap"></div>', n => n.slice(0, 2), ps => ps.join(' & '), n => n === name);
  return { x, calls, kv, env, listeners };
};

test('phone UI: Season pass renders XP tiers calmly, claims via server and announces, respects one-tap hide', async () => {
  const L1 = { id: `xpass:${Q4.id}:1`, kind: 'earn', amount: 25, reason: 'pass:title-grinder', day: null, streak: null };
  const initialPass = buildPassView({ season: Q4, xp: 380, allXp: 380, ledger: [L1], items: [{ id: 'title-grinder', slot: 'title', worn: false }], share: false });
  const afterClaim3 = { ...buildPassView({ season: Q4, xp: 380, allXp: 380, ledger: [L1, { ...L1, id: `xpass:${Q4.id}:3`, reason: 'pass:sound-whistle' }], items: [{ id: 'title-grinder', slot: 'title', worn: false }, { id: 'sound-whistle', slot: 'sound', worn: false }], share: false }), claimed: true, gained: 25, granted: { id: 'sound-whistle', slot: 'sound', name: "Ref's whistle" } };

  const off = phone({ on: false, passReply: initialPass });
  assert.equal(off.x.Rewards.tileHTML(), '');
  await off.x.Rewards.openPass();
  assert.equal(off.calls.length, 0);
  const hid = phone({ hide: true, passReply: initialPass });
  assert.equal(hid.x.Rewards.tileHTML(), '');
  assert.equal(hid.x.Rewards.levelCardHTML('Ana'), '', 'hidden: no level card');
  await hid.x.Rewards.openPass();
  assert.equal(hid.calls.length, 0);
  const unlinked = phone({ name: null, passReply: initialPass });
  assert.ok(!/data-rw="pass"/.test(unlinked.x.Rewards.youRowHTML()));

  const p = phone({ passReply: initialPass, claimReply: afterClaim3 });
  await p.x.Rewards.openPass();
  assert.deepEqual(p.calls[0], { action: 'rewards-pass', name: 'Ana', playerToken: 'tok' });
  assert.equal(p.x.sheet.view, 'rwpass');
  const html = p.x.Rewards.passHTML(p.x.sheet);
  assert.match(html, /Fall 2026/);
  assert.match(html, /<b>380<\/b><small>\/ 1000 season XP/);
  assert.match(html, /axis|aria-valuenow="380"|role="progressbar"/);
  assert.match(html, /495 XP|120 XP to tier 4/);
  assert.match(html, /These items can't be bought/);
  assert.match(html, /No paid tier, no real money/);
  assert.match(html, /Claimed/);
  assert.match(html, /data-rw-claim="2"/);
  assert.match(html, /data-rw-claim="3"/);
  assert.ok(!/data-rw-claim="1"/.test(html), 'already claimed tier has no Claim button');
  assert.ok(!/data-rw-claim="4"/.test(html), 'locked tier has no Claim button');
  assert.ok(!/days left|hurry|expires|limited time|buy pass|premium/i.test(html), 'no FOMO or paid tier copy');

  const click = ds => p.listeners.forEach(f => f({ target: { closest: () => ({ dataset: ds }) } }));
  click({ rwClaim: '3' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(p.calls[1], { action: 'rewards-pass-claim', name: 'Ana', playerToken: 'tok', tier: 3, seasonId: Q4.id });
  assert.equal(JSON.stringify(p.calls).includes('"xp"'), false, 'phone never sends its own XP');
  assert.equal(JSON.stringify(p.calls).includes('"amount"'), false, 'phone never sends a payout amount');
  assert.match(p.env.announced[0], /Tier 3 claimed: Ref's whistle and \+25 Dinks/);
  assert.equal(p.env.focused, '#club-h');
});

test('phone UI: the level card shows on your own profile only, from the pass answer, and says how XP works', async () => {
  const pass = buildPassView({ season: Q4, xp: 0, allXp: 0, ledger: [], items: [], share: false });
  const p = phone({ passReply: pass });
  assert.equal(p.x.Rewards.levelCardHTML('Ana'), '', 'nothing known yet');
  await p.x.Rewards.syncReady(true);
  const card = p.x.Rewards.levelCardHTML('Ana');
  assert.match(card, /Level 1 of 25/);
  assert.match(card, /0 XP all time/);
  assert.match(card, /40 XP to level 2\. Games sent from a club player's phone give 10 XP, 15 for a win, up to 300 a day\./);
  assert.equal(p.x.Rewards.levelCardHTML('Ben'), '', 'never another player\'s level');
  const top = phone({ passReply: buildPassView({ season: Q4, xp: 0, allXp: 99999, ledger: [], items: [], share: false }) });
  await top.x.Rewards.syncReady(true);
  assert.match(top.x.Rewards.levelCardHTML('Ana'), /Level 25 of 25[\s\S]*You are at the top level/);
});

test('phone UI: at level 25 a two-tap Prestige button restarts at level 1 and puts a star on the level chip and avatar', async () => {
  const none = [];
  const topPass = buildPassView({ season: Q4, xp: 0, allXp: 3720, ledger: none, items: none, share: false });
  const done = { ...buildPassView({ season: Q4, xp: 0, allXp: 3720, ledger: [{ id: 'prestige:1', kind: 'earn', amount: 250, reason: 'prestige', day: null, streak: null }], items: none, share: false }), restarted: true, gained: 250 };
  const p = phone({ passReply: topPass, restartReply: done });
  await p.x.Rewards.syncReady(true);
  assert.match(p.x.Rewards.levelCardHTML('Ana'), /Level 25 of 25[\s\S]*data-rw="restart"[^>]*>Prestige</);
  assert.match(p.x.Rewards.levelChipHTML('Ana'), /Lv 25/);
  assert.doesNotMatch(p.x.Rewards.frameAttr('Ana'), /data-rw-star/, 'no star before a prestige');
  const click = () => p.listeners.forEach(f => f({ target: { closest: () => ({ dataset: { rw: 'restart' } }) } }));
  click();
  assert.match(p.x.Rewards.levelCardHTML('Ana'), /Tap again to prestige/, 'first tap only arms it');
  assert.ok(!p.calls.some(c => c.action === 'rewards-restart'), 'nothing sent on the first tap');
  click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(p.calls.filter(c => c.action === 'rewards-restart').length, 1, 'second tap sends one request');
  const card = p.x.Rewards.levelCardHTML('Ana');
  assert.match(card, /Level 1 of 25/);
  assert.match(card, /Prestige 1/);
  assert.doesNotMatch(card, /data-rw="restart"/, 'back at level 1: no button');
  assert.match(p.x.Rewards.levelChipHTML('Ana'), /rw-stars[^>]*>★<[\s\S]*Lv 1/);
  assert.match(p.x.Rewards.frameAttr('Ana'), /data-rw-star="1"/);
  assert.equal(p.x.Rewards.levelChipHTML('Ben'), '', 'another member only when they share');
});

test('UX-10: ready tag on the You sheet, learned from the pass, cleared by a claim', async () => {
  const unclaimed = buildPassView({ season: Q4, xp: 125, allXp: 125, ledger: [], items: [], share: false });
  assert.equal(unclaimed.claimable, 1);
  const none = buildPassView({ season: Q4, xp: 0, allXp: 0, ledger: [], items: [], share: false });
  const p = phone({ passReply: unclaimed, claimReply: { ...unclaimed, claimable: 0, claimed: true, gained: 25, dinks: 25 } });
  assert.ok(!/rw-ready/.test(p.x.Rewards.youRowHTML()), 'no tag before the pass has been read');
  assert.match(p.x.Rewards.youRowHTML(), /data-rw="pass"[\s\S]*Shop &amp; season pass[\s\S]*Claim rewards and spend your Dinks/);
  assert.match(p.x.Rewards.youRowHTML(), /Hide rewards and streak/);
  await p.x.Rewards.syncReady(true);
  assert.deepEqual(p.calls.map(c => c.action), ['rewards-pass']);
  assert.match(p.x.Rewards.youRowHTML(), /1 reward is ready to claim[\s\S]*<span class="rw-ready">1 ready<\/span>/);
  await p.x.Rewards.openPass();
  const click = ds => p.listeners.forEach(f => f({ target: { closest: () => ({ dataset: ds }) } }));
  click({ rwClaim: '1' });
  await new Promise(r => setTimeout(r, 10));
  assert.ok(!/rw-ready/.test(p.x.Rewards.youRowHTML()), 'claimed: the tag is gone');
  assert.match(p.x.Rewards.youRowHTML(), /Claim rewards and spend your Dinks/);
  const hid = phone({ hide: true, passReply: unclaimed });
  await hid.x.Rewards.syncReady(true);
  assert.equal(hid.calls.length, 0, 'hidden: never asks');
  assert.ok(!/data-rw="pass"/.test(hid.x.Rewards.youRowHTML()) && /Show rewards and streak/.test(hid.x.Rewards.youRowHTML()));
  const idle = phone({ passReply: none });
  await idle.x.Rewards.syncReady(true);
  assert.ok(!/rw-ready/.test(idle.x.Rewards.youRowHTML()));
  const anon = phone({ name: null, passReply: unclaimed });
  assert.ok(!/data-rw="pass"/.test(anon.x.Rewards.youRowHTML()), 'a phone with no linked name has no pass to open');
});
