// Rewards slice 1: the daily play streak and Dinks as pure functions, the club switch, and the DESIGN.md rules held by the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { module } from './helpers/app.js';

const src = fs.readFileSync(new URL('../src/app/economy.js', import.meta.url), 'utf8');
const pure = src.slice(0, src.indexOf('let rwState'));
const { rwPlay, rwStreak, rwNext, rwBonusFor, rwClean, rwDayKey, RW_BONUS } = new Function(pure + '; return { rwPlay, rwStreak, rwNext, rwBonusFor, rwClean, rwDayKey, RW_BONUS };')();
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

// Plays on each of the given days (YYYY-MM-DD), in order; returns every result.
const run = days => { let s = {}; return days.map(d => { const r = rwPlay(s, d); s = r.state; return r; }); };
const d = n => rwDayKey(new Date(2026, 0, n)); // made-up days: January 2026

test('the first game ever starts day 1 and pays 1 Dink; a second game the same day pays nothing', () => {
  const [a, b] = run([d(5), d(5)]);
  assert.deepEqual([a.fresh, a.day, a.gained, a.state.dinks, a.state.streak], [true, 1, 1, 1, 1]);
  assert.deepEqual([b.fresh, b.gained, b.state.dinks], [false, 0, 1]);
});

test('consecutive days grow the streak and pay the bonuses on days 3, 7, 14 and 30', () => {
  const r = run(Array.from({ length: 30 }, (_, i) => d(1 + i)));
  assert.deepEqual(RW_BONUS, [[3, 2], [7, 5], [14, 10], [30, 25]]);
  for (const day of [3, 7, 14, 30]) assert.equal(r[day - 1].bonus, rwBonusFor(day));
  assert.deepEqual([3, 7, 14, 30].map(x => r[x - 1].gained), [3, 6, 11, 26]);
  assert.equal(r[1].gained, 1, 'a plain day pays 1');
  assert.equal(r[29].state.streak, 30);
  assert.equal(r[29].state.dinks, 30 + 2 + 5 + 10 + 25);
});

test('after day 30 the day-30 bonus repeats every 30th day only', () => {
  assert.equal(rwBonusFor(31), 0); assert.equal(rwBonusFor(59), 0); assert.equal(rwBonusFor(60), 25); assert.equal(rwBonusFor(90), 25);
  assert.deepEqual(rwNext(30), { day: 60, bonus: 25, in: 30 });
  assert.deepEqual(rwNext(0), { day: 3, bonus: 2, in: 3 });
  assert.deepEqual(rwNext(7), { day: 14, bonus: 10, in: 7 });
});

test('a missed day starts the streak again at 1 but keeps the balance and the best run', () => {
  const r = run([d(1), d(2), d(3), d(5)]);
  assert.equal(r[3].day, 1);
  assert.deepEqual([r[3].state.streak, r[3].state.best, r[3].state.dinks], [1, 3, 1 + 1 + 3 + 1]);
});

test('the streak shown is 0 once yesterday and today were both missed, and counts through today if not yet played', () => {
  const s = run([d(1), d(2), d(3)])[2].state;
  assert.equal(rwStreak(s, d(3)), 3); assert.equal(rwStreak(s, d(4)), 3, 'played yesterday: still alive today'); assert.equal(rwStreak(s, d(5)), 0);
});

test('months, years and a clock change never add or drop a day; a clock set back pays nothing', () => {
  const r = run(['2025-12-31', '2026-01-01', '2026-03-28', '2026-03-29', '2026-03-30']);
  assert.deepEqual(r.map(x => x.day), [1, 2, 1, 2, 3]);
  const back = rwPlay(r[4].state, '2026-03-01');
  assert.deepEqual([back.fresh, back.gained, back.state.dinks], [false, 0, r[4].state.dinks]);
});

test('a stored state that was edited or damaged is cleaned, never trusted', () => {
  assert.deepEqual(rwClean(null), { streak: 0, best: 0, dinks: 0, last: '' });
  assert.deepEqual(rwClean({ streak: -4, best: 'x', dinks: NaN, last: 'yesterday' }), { streak: 0, best: 0, dinks: 0, last: '' });
  assert.equal(rwClean({ dinks: 1e12 }).dinks, 1e6);
});

test('the club switch is off by default and organizer-only; the schema is additive', () => {
  assert.match(read('api/_db.js'), /ADD COLUMN IF NOT EXISTS rewards boolean NOT NULL DEFAULT false/);
  const club = read('api/club.js');
  const at = club.indexOf("body.action === 'set-rewards'");
  const handler = club.slice(at, club.indexOf("body.action === 'set-pay-link'", at));
  assert.match(handler, /requireOrganizer\(club, body\.pin, req, body\.ownerToken\)/);
  assert.match(handler, /AND NOT quick/, 'a quick game room never gets rewards');
});

test('with the club switch off, or the device switch on, nothing is drawn and nothing is counted', () => {
  const mod = module('economy');
  const make = (club, hide) => new Function('store', 'club', 'esc', 'announce', 'api', 'document', mod.replace(/^let rwState = .*$/m, 'let rwState = rwClean({});') + `; return { Rewards, get s() { return rwState; } };`)(
    { get: (k, f) => (k === 'pb.rewardsHide' ? hide : f), set() {} }, club, String, () => {}, null, { addEventListener() {} });
  const off = make({ rewards: false }, false), none = make(null, false), hidden = make({ rewards: true }, true), on = make({ rewards: true }, false);
  for (const x of [off, none]) { x.Rewards.played({}); assert.equal(x.s.dinks, 0); assert.equal(x.Rewards.cardHTML() + x.Rewards.flameHTML() + x.Rewards.youRowHTML(), ''); }
  assert.equal(hidden.Rewards.cardHTML(), ''); assert.match(hidden.Rewards.youRowHTML(), /Show my daily streak/);
  on.Rewards.played({}); assert.equal(on.s.dinks, 1);
  assert.match(on.Rewards.cardHTML(), /Your Dink[\s\S]*can't be bought or cashed out/);
  assert.match(on.Rewards.youRowHTML(), /Hide my daily streak/);
});

test('calm and play-money rules: no purchase, no randomness, no animation or sound in the module', () => {
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '').replace(/can't be bought/, '');
  assert.ok(!/buy|purchase|price|Math\.random|@keyframes|animation|transition|confetti|Audio\(|\.play\(\)/i.test(code), 'play money, no odds, no motion, no sound');
  const html = read('dink-score.html');
  const css = html.slice(html.indexOf('.card.rw-card {'), html.indexOf('.me-btn.frame-crown::before'));
  assert.ok(!/animation|transition|@keyframes/.test(css));
  assert.match(css, /\.rw-hide \{[^}]*min-height: 44px/);
});
