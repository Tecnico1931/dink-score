// Rewards slice 5: free Season Pass pure rules, guard assertions and phone UI (api/_economypass.js + src/app/economypass.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASS_TIERS, tierByNum, passClaimId, countSeasonGames, buildPassView, planPassClaim } from '../api/_economypass.js';
import { CATALOGUE, itemById } from '../api/_economyshop.js';
import { validEntry, summary, deriveEarnings, ledgerBalance } from '../api/_economy.js';
import { seasonAt } from '../api/_progress.js';
import { module } from './helpers/app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const Q4 = seasonAt(Date.UTC(2026, 10, 15), []);
const CUSTOM = seasonAt(Date.UTC(2026, 10, 15), [{ at: Date.UTC(2026, 10, 10), name: 'Fall 2026, part 2' }]);

test('PASS_TIERS is a calm 10-tier track referencing only existing shop items, with valid ledger claim ids', () => {
  assert.ok(PASS_TIERS.length >= 10 && PASS_TIERS.length <= 12);
  let prevGames = 0;
  let cosmeticCount = 0;
  for (let i = 0; i < PASS_TIERS.length; i++) {
    const t = PASS_TIERS[i];
    assert.deepEqual(Object.keys(t).sort(), ['dinks', 'games', 'item', 'tier']);
    assert.equal(t.tier, i + 1);
    assert.ok(Number.isInteger(t.games) && t.games > prevGames, `tier ${t.tier} games strictly increasing`);
    prevGames = t.games;
    assert.ok(Number.isInteger(t.dinks) && t.dinks >= 1 && t.dinks <= 25);
    if (t.item !== null) {
      cosmeticCount++;
      assert.ok(itemById(t.item), `tier ${t.tier} item ${t.item} must exist in CATALOGUE`);
    }
    for (const s of [Q4, CUSTOM]) {
      const id = passClaimId(s.id, t.tier);
      assert.ok(validEntry({ id, kind: 'earn', amount: t.dinks, reason: 'pass', day: null, streak: null }), id);
    }
  }
  assert.ok(cosmeticCount >= 3 && cosmeticCount <= 5, 'a few free cosmetic items from the existing catalogue');
});

test('countSeasonGames counts only games saved by the player\'s verified phone inside the season, regardless of win or score', () => {
  const inS = Q4.start + 3600e3;
  const games = [
    { teams: [['Ana', 'Ben'], ['Cy', 'Di']], r: inS, scoredBy: 'ana', score: [0, 11], winner: 1 },            // counts (even a 0-11 loss)
    { teams: [['ana ', 'Cy'], ['Ben', 'Di']], receivedAt: inS + 1000, scoredByPlayer: 'ana' },                 // counts (creator's claimed name)
    { teams: [['Ana', 'Ben'], ['Cy', 'Di']], r: inS + 2000, scoredBy: 'ben' },                                 // ignored: saved by another phone
    { teams: [['Ben', 'Cy'], ['Di', 'Eve']], r: inS + 3000, scoredBy: 'ana' },                                 // ignored: Ana did not play
    { teams: [['Ana', 'Ben'], ['Cy', 'Di']], r: Q4.start - 1, scoredBy: 'ana' },                               // ignored: previous season
    { teams: [['Ana', 'Ben'], ['Cy', 'Di']], r: Q4.end, scoredBy: 'ana' },                                     // ignored: next season (end is exclusive)
    { teams: [['Ana', 'Ben'], ['Cy', 'Di']], r: NaN, scoredBy: 'ana' },                                        // ignored: bad timestamp
    null
  ];
  assert.equal(countSeasonGames(games, 'ana', Q4), 2);
  assert.equal(countSeasonGames(games, 'ben', Q4), 1);
  assert.equal(countSeasonGames(games, '', Q4), 0);
  // Custom season started by ending early: games before the cut don't count for the new season.
  assert.equal(countSeasonGames([{ teams: [['Ana', 'Ben'], ['Cy', 'Di']], r: CUSTOM.start - 1000, scoredBy: 'ana' }], 'ana', CUSTOM), 0);
  assert.equal(countSeasonGames([{ teams: [['Ana', 'Ben'], ['Cy', 'Di']], r: CUSTOM.start + 1000, scoredBy: 'ana' }], 'ana', CUSTOM), 1);
});

test('planPassClaim: enforces tier validity, earned progress, idempotent replay, item grant and already-owned Dinks fallback', () => {
  for (const bad of [0, -1, 11, 1.5, '1', null, undefined, '__proto__']) {
    assert.throws(() => planPassClaim({ games: 99, season: Q4, tier: bad }), e => e.status === 400);
  }
  assert.equal(tierByNum(1).tier, 1);
  assert.equal(tierByNum('1'), null);

  // Not yet earned -> 409 with plain message.
  assert.throws(() => planPassClaim({ games: 0, season: Q4, tier: 1 }), e => e.status === 409 && /Play 1 more game/.test(e.message));
  assert.throws(() => planPassClaim({ games: 2, season: Q4, tier: 3 }), e => e.status === 409 && /Play 3 more games/.test(e.message));

  // Earned Dinks tier.
  const p1 = planPassClaim({ ledger: [], owned: [], games: 1, season: Q4, tier: 1 });
  assert.equal(p1.already, false);
  assert.equal(p1.item, null);
  assert.deepEqual(p1.entry, { id: `pass:${Q4.id}:1`, kind: 'earn', amount: 2, reason: 'pass:tier-1', day: null, streak: null });
  assert.ok(validEntry(p1.entry));

  // Replay of already-claimed tier -> idempotent { already: true }.
  const rep = planPassClaim({ ledger: [p1.entry], owned: [], games: 1, season: Q4, tier: 1 });
  assert.deepEqual(rep, { tier: PASS_TIERS[0], already: true, entry: null, item: null, alreadyOwned: false });

  // Earned cosmetic tier (tier 3 -> frame-court) when unowned: grants item + tier Dinks.
  const p3 = planPassClaim({ ledger: [p1.entry], owned: [], games: 5, season: Q4, tier: 3 });
  assert.equal(p3.already, false);
  assert.equal(p3.alreadyOwned, false);
  assert.equal(p3.item.id, 'frame-court');
  assert.equal(p3.entry.amount, PASS_TIERS[2].dinks);
  assert.equal(p3.entry.id, `pass:${Q4.id}:3`);

  // Earned cosmetic tier when already owned: grants item's Dinks price instead and no duplicate item.
  const p3Owned = planPassClaim({ ledger: [p1.entry], owned: ['frame-court'], games: 5, season: Q4, tier: 3 });
  assert.equal(p3Owned.already, false);
  assert.equal(p3Owned.alreadyOwned, true);
  assert.equal(p3Owned.item, null);
  assert.equal(p3Owned.entry.amount, itemById('frame-court').price);
  assert.ok(validEntry(p3Owned.entry));

  // Same tier in a new custom season gets a distinct claim id and can be earned again.
  const pCustom = planPassClaim({ ledger: [p1.entry], owned: [], games: 1, season: CUSTOM, tier: 1 });
  assert.equal(pCustom.already, false);
  assert.equal(pCustom.entry.id, `pass:${CUSTOM.id}:1`);

  // Pass ledger rows never disturb the daily streak calculation or summary.
  const day1 = Date.parse('2026-11-15T12:00:00Z');
  const day2 = Date.parse('2026-11-16T12:00:00Z');
  const dayEarn = deriveEarnings({ ledger: [p1.entry], receivedAt: [day1], tz: 0, now: day1 + 1000 });
  assert.equal(dayEarn.length, 1);
  assert.equal(dayEarn[0].streak, 1);
  const combined = [p1.entry, ...dayEarn];
  assert.equal(ledgerBalance(combined), 3);
  assert.deepEqual(summary(combined, 0, day2), { dinks: 3, streak: 1, best: 1, last: '2026-11-15' });
});

test('buildPassView reports unlocked, claimed, claimable and already-owned Dinks payout accurately', () => {
  const ledger = [
    { id: 'day:2026-11-10', kind: 'earn', amount: 5, reason: 'day', day: '2026-11-10', streak: 1 },
    { id: `pass:${Q4.id}:1`, kind: 'earn', amount: 2, reason: 'pass:tier-1', day: null, streak: null }
  ];
  const items = [{ id: 'frame-court', slot: 'frame', worn: true }];
  const v = buildPassView({ season: Q4, games: 6, ledger, items, share: true });
  assert.equal(v.season.id, Q4.id);
  assert.equal(v.games, 6);
  assert.equal(v.dinks, 7);
  assert.deepEqual(v.worn, { frame: 'frame-court', paddle: '', pet: '' });
  assert.equal(v.share, true);
  assert.equal(v.claimable, 2, 'tiers 2 and 3 unlocked and unclaimed (tier 1 already claimed)');
  assert.equal(v.tiers[0].claimed, true);
  assert.equal(v.tiers[1].unlocked, true);
  assert.equal(v.tiers[1].claimed, false);
  assert.equal(v.tiers[2].item.owned, true);
  assert.equal(v.tiers[2].payoutDinks, itemById('frame-court').price);
  assert.equal(v.tiers[3].unlocked, false);
});

test('guard: season pass code never reads scores/ratings/ranks, has no randomness, paid tier or motion', () => {
  for (const f of ['api/_economypass.js', 'src/app/economypass.js']) {
    const code = read(f).replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
    assert.ok(!/\bscore\b|\brating|\brank|pairing|winner|Math\.random|\bstripe\b|payment|@keyframes|animation|transition|confetti|Audio\(|\.play\(\)/i.test(code.replace(/a game, a rating or a rank/g, '').replace(/paddle-stripe/g, '')), f);
  }
  for (const f of ['api/_rating.js', 'api/_pb.js', 'api/_gamesave.js', 'api/games.js', 'api/club.js', 'pb-engine.js', 'rating-engine.js']) {
    assert.ok(!/economypass|rewards-pass/.test(read(f)), f + ' must not touch season pass');
  }
});

// Phone UI tests for src/app/economypass.js.
const phone = ({ hide = false, on = true, name = 'Ana', passReply, claimReply } = {}) => {
  const calls = [], kv = { 'pb.rewardsHide': hide }, listeners = [], rootEl = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const env = { renders: 0, announced: [], focused: null };
  const code = module('economy') + ';' + module('economyshop') + ';' + module('economypass')
    + ';return { Rewards, set sheet(v) { clubSheet = v; }, get sheet() { return clubSheet; } };';
  const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'renderClub', 'initials', 'iconSvg', 'skel', 'avatarInner', 'teamLabel',
    'let clubSheet = null;' + code)(
    { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } },
    { code: 'club-a', rewards: on }, String, m => env.announced.push(m),
    { documentElement: rootEl, addEventListener: (t, f) => listeners.push(f), querySelector: sel => ({ focus() { env.focused = sel; } }) },
    () => name, () => (name ? 'tok' : null),
    async b => {
      calls.push(b);
      if (b.action === 'rewards-pass') return passReply;
      if (b.action === 'rewards-pass-claim') return typeof claimReply === 'function' ? claimReply(b) : claimReply;
      return { dinks: 0, worn: { frame: '', paddle: '' }, share: false, items: CATALOGUE.map(i => ({ ...i, owned: false })) };
    },
    () => env.renders++, () => {}, s => s.slice(0, 2), () => '<svg></svg>', () => '<div class="skel-wrap"></div>', n => n.slice(0, 2), ps => ps.join(' & '));
  return { x, calls, kv, env, listeners };
};

test('phone UI: Season pass button on Your Dink card, renders track calmly, claims via server and announces, respects one-tap hide', async () => {
  const initialPass = buildPassView({
    season: Q4,
    games: 5,
    ledger: [{ id: `pass:${Q4.id}:1`, kind: 'earn', amount: 2, reason: 'pass:tier-1', day: null, streak: null }],
    items: [],
    share: false
  });
  const afterClaim3 = {
    ...buildPassView({
      season: Q4,
      games: 5,
      ledger: [
        { id: `pass:${Q4.id}:1`, kind: 'earn', amount: 2, reason: 'pass:tier-1', day: null, streak: null },
        { id: `pass:${Q4.id}:3`, kind: 'earn', amount: 2, reason: 'pass:frame-court', day: null, streak: null }
      ],
      items: [{ id: 'frame-court', slot: 'frame', worn: false }],
      share: false
    }),
    claimed: true,
    gained: 2,
    granted: { id: 'frame-court', slot: 'frame', name: 'Court green ring' }
  };

  // Hidden or off: card and pass sheet show nothing and make no API calls.
  const off = phone({ on: false, passReply: initialPass });
  assert.equal(off.x.Rewards.cardHTML(), '');
  await off.x.Rewards.openPass();
  assert.equal(off.calls.length, 0);

  const hid = phone({ hide: true, passReply: initialPass });
  assert.equal(hid.x.Rewards.cardHTML(), '');
  assert.ok(!/data-rw-claim/.test(hid.x.Rewards.passHTML({ pass: initialPass })));
  await hid.x.Rewards.openPass();
  assert.equal(hid.calls.length, 0);

  // Unlinked phone: Your Dink card does not show Season pass button.
  const unlinked = phone({ name: null, passReply: initialPass });
  assert.ok(!/data-rw="pass"/.test(unlinked.x.Rewards.cardHTML()));

  // Linked phone with rewards on: button present, openPass loads, passHTML renders tiers, Claim sends only tier + seasonId and announces.
  const p = phone({ passReply: initialPass, claimReply: afterClaim3 });
  assert.match(p.x.Rewards.cardHTML(), /data-rw="pass">Season pass</);
  await p.x.Rewards.openPass();
  assert.deepEqual(p.calls[0], { action: 'rewards-pass', name: 'Ana', playerToken: 'tok' });
  assert.equal(p.x.sheet.view, 'rwpass');
  const html = p.x.Rewards.passHTML(p.x.sheet);
  assert.match(html, /Fall 2026/);
  assert.match(html, /Free track/);
  assert.match(html, /No paid tier, no real money/);
  assert.match(html, /role="progressbar"/);
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
  assert.equal(JSON.stringify(p.calls).includes('"games"'), false, 'phone never sends its own game count');
  assert.equal(JSON.stringify(p.calls).includes('"amount"'), false, 'phone never sends a payout amount');
  assert.equal(p.kv['pb.rewards']['club-a'].dinks, 4, 'local card balance follows server');
  assert.match(p.env.announced[0], /Tier 3 claimed: Court green ring and \+2 Dinks/);
  assert.equal(p.env.focused, '#club-h');
});
