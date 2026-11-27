// Boost events (M11): the windows, the doubled game pay and cap, the doubled XP, and the new undo kinds. Pure, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boostWindow, boostedAt, boostState } from '../api/_economyboost.js';
import { gameDays, planGameRows, EARN } from '../api/_economygame.js';
import { xpFromGames, XP_DAY_CAP } from '../api/_economyxp.js';
import { undoKind } from '../api/_undo.js';
import { describe, activityFrom } from '../api/_economyactivity.js';
import { totals } from '../api/_economy.js';

const D = 864e5, T = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h);
const WED = T(2026, 11, 25, 15), SAT = T(2026, 11, 28, 9), SUN = T(2026, 11, 29, 20); // 2026-11-25 is a Wednesday

test('boost windows: today, this weekend, 1, 3, 7 days (UTC)', () => {
  assert.deepEqual(boostWindow('today', WED), { from: WED, to: T(2026, 11, 26) });
  assert.deepEqual(boostWindow('weekend', WED), { from: T(2026, 11, 28), to: T(2026, 11, 30) }, 'Saturday 00:00 to the end of Sunday');
  assert.deepEqual(boostWindow('weekend', SAT), { from: SAT, to: T(2026, 11, 30) }, 'already the weekend: starts now');
  assert.deepEqual(boostWindow('weekend', SUN), { from: SUN, to: T(2026, 11, 30) });
  for (const n of [1, 3, 7]) assert.deepEqual(boostWindow(String(n), WED), { from: WED, to: WED + n * D });
  assert.equal(boostWindow('2', WED), null); assert.equal(boostWindow('tomorrow', WED), null); assert.equal(boostWindow(undefined, WED), null);
});

test('boostedAt and boostState', () => {
  const b = [{ id: 1, from: 1000, to: 2000, xp: false }, { id: 2, from: 5000, to: 6000, xp: true }];
  assert.equal(boostedAt(b, 999), false); assert.equal(boostedAt(b, 1000), true); assert.equal(boostedAt(b, 1999), true); assert.equal(boostedAt(b, 2000), false, 'the end is exclusive');
  assert.equal(boostedAt(b, 1500, 'xp'), false, 'XP only when ticked'); assert.equal(boostedAt(b, 5500, 'xp'), true);
  assert.equal(boostedAt([], 1), false); assert.equal(boostedAt(undefined, 1), false);
  assert.deepEqual(boostState(b, 1500), { active: { id: 1, from: 1000, until: 2000, dinks: 2, xp: 1 }, upcoming: { id: 2, from: 5000, until: 6000, dinks: 2, xp: 2 } });
  assert.deepEqual(boostState(b, 3000).active, null); assert.equal(boostState(b, 7000).upcoming, null);
});

const game = (r, win = 0, id = 'g' + r) => ({ id, teams: [['Ana', 'Ben'], ['Cy', 'Di']], winner: win, receivedAt: r, scoredBy: 'ana' });

test('a game received inside a boost pays double, outside it does not, and the day cap doubles', () => {
  const day = T(2026, 11, 25), boosts = [{ id: 1, from: day + 10 * 3600e3, to: day + 12 * 3600e3, xp: false }];
  const before = game(day + 9 * 3600e3, 0, 'a'), inside = game(day + 11 * 3600e3, 0, 'b');
  const plain = gameDays([before, inside], 'ana'), boosted = gameDays([before, inside], 'ana', {}, boosts);
  assert.equal(plain.get('2026-11-25'), 12 + 12);
  assert.equal(boosted.get('2026-11-25'), 12 + 24, 'only the game inside the window doubles');
  assert.ok(boosted.boosted.has('2026-11-25') && plain.boosted.size === 0);
  // 40 wins: 40 x (12 + 5 after the third in a row) is far over the cap. Unboosted it stops at 300, boosted at 600.
  const many = Array.from({ length: 40 }, (_, i) => game(day + 10 * 3600e3 + i * 60e3, 0, 'm' + i));
  const now = day + 20 * 3600e3, sum = rows => rows.reduce((n, r) => n + r.amount, 0);
  assert.equal(sum(planGameRows({ ledger: [], days: gameDays(many, 'ana'), now })), EARN.cap);
  assert.equal(sum(planGameRows({ ledger: [], days: gameDays(many, 'ana', {}, boosts), now })), 40 * 17 > 600 ? 600 : 40 * 17, 'a boosted day holds twice the cap');
  // A day with no boosted game keeps the normal cap even when another day was boosted.
  const other = gameDays([...many, ...many.map((g, i) => ({ ...g, id: 'n' + i, receivedAt: g.receivedAt - D }))], 'ana', {}, boosts);
  assert.ok(other.boosted.has('2026-11-25') && !other.boosted.has('2026-11-24'));
  const rows = planGameRows({ ledger: [], days: other, now });
  assert.deepEqual(rows.map(r => r.amount).sort((a, b) => a - b), [300, 600]);
  // Idempotent: planning again from the ledger that holds the rows gives nothing.
  assert.deepEqual(planGameRows({ ledger: rows.map(r => ({ ...r })), days: other, now }), []);
});

test('boosted XP: double, with a doubled day cap, only where XP is ticked', () => {
  const day = T(2026, 11, 25), boosts = [{ id: 1, from: day, to: day + D, xp: true }];
  const g = (i, w) => ({ teams: [['Ana', 'Ben'], ['Cy', 'Di']], winner: w, r: day + 1000 * (i + 1), scoredBy: 'ana' });
  assert.equal(xpFromGames([g(0, 0)], 'ana'), 15);
  assert.equal(xpFromGames([g(0, 0)], 'ana', { boosts }), 30);
  assert.equal(xpFromGames([g(0, 0)], 'ana', { boosts: [{ ...boosts[0], xp: false }] }), 15, 'a Dinks-only boost leaves XP alone');
  const many = Array.from({ length: 80 }, (_, i) => g(i, 0));
  assert.equal(xpFromGames(many, 'ana'), XP_DAY_CAP); assert.equal(xpFromGames(many, 'ana', { boosts }), 2 * XP_DAY_CAP);
});

test('undo kinds for rewards changes by hand and boosts', () => {
  const now = Date.now(), at = new Date(now - 3600e3).toISOString();
  const e = (action, detail, target = 'Ana') => ({ action, detail, target, at, undone_at: null });
  assert.equal(undoKind(e('reward-give', { amount: 5, reason: 'x' }), now), 'points');
  assert.equal(undoKind(e('reward-take', { amount: 5, reason: 'x' }), now), 'points');
  assert.equal(undoKind(e('reward-give', { amount: 0 }), now), null); assert.equal(undoKind(e('reward-give', {}, null), now), null);
  assert.equal(undoKind(e('reward-gift', { item: 'pet-owl' }), now), 'gift'); assert.equal(undoKind(e('reward-gift', {}), now), null);
  assert.equal(undoKind(e('boost', { boostId: 3 }, null), now), 'boost'); assert.equal(undoKind(e('boost', {}, null), now), null);
  assert.equal(undoKind(e('reward-spin-reset', { day: '2026-11-25' }), now), null, 'a spin reset is not undone');
  assert.equal(undoKind({ ...e('reward-give', { amount: 5 }), undone_at: new Date() }, now), null, 'once only');
  assert.equal(undoKind(e('reward-give', { amount: 5 }), now + 8 * D), null, 'within 7 days');
});

test('the player reads the reason, and a take lowers what was earned rather than counting as spent', () => {
  assert.equal(describe({ kind: 'earn', reason: 'org:Ran the night' }), 'From an organizer: Ran the night');
  assert.equal(describe({ kind: 'spend', reason: 'orgtake:Paddle fee' }), 'Taken by an organizer: Paddle fee');
  const ledger = [{ kind: 'earn', amount: 30, reason: 'org:x' }, { kind: 'spend', amount: -10, reason: 'orgtake:y' }, { kind: 'spend', amount: -5, reason: 'shop:frame-court' }];
  assert.deepEqual(totals(ledger), { earned: 20, spent: 5 });
  assert.equal(activityFrom(ledger.map(e => ({ ...e, at: 1 }))).balance, 15);
});
