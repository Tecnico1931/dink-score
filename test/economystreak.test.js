// Rewards: the phone's streak display, the club switch and the DESIGN.md rules held by the code. The earning rules themselves are the
// server's (api/_economy.js); the first tests here pin the phone's copy of them to the server's, the ledger is in economyledger.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { module } from './helpers/app.js';
import * as E from '../api/_economy.js';

const src = fs.readFileSync(new URL('../src/app/economy.js', import.meta.url), 'utf8');
const pure = src.slice(0, src.indexOf('let rwState'));
const { rwStreak, rwNext, rwBonusFor, rwClean, rwDayKey, RW_BONUS } = new Function(pure + '; return { rwStreak, rwNext, rwBonusFor, rwClean, rwDayKey, RW_BONUS };')();
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

const d = n => rwDayKey(new Date(2026, 0, n)); // made-up days: January 2026
test("the phone's bonus table and calendar-day maths are the server's", () => {
  assert.deepEqual(RW_BONUS, E.BONUS);
  for (let day = 1; day <= 130; day++) assert.equal(rwBonusFor(day), E.bonusFor(day), 'day ' + day);
  assert.equal(rwDayKey(new Date(2026, 2, 29)), '2026-03-29');
});

test('after day 30 the day-30 bonus repeats every 30th day only', () => {
  assert.equal(rwBonusFor(31), 0); assert.equal(rwBonusFor(59), 0); assert.equal(rwBonusFor(60), 25); assert.equal(rwBonusFor(90), 25);
  assert.deepEqual(rwNext(30), { day: 60, bonus: 25, in: 30 });
  assert.deepEqual(rwNext(0), { day: 3, bonus: 2, in: 3 });
  assert.deepEqual(rwNext(7), { day: 14, bonus: 10, in: 7 });
});

test('the streak shown is 0 once yesterday and today were both missed, and counts through today if not yet played', () => {
  const s = { streak: 3, best: 3, dinks: 6, last: d(3) };
  assert.equal(rwStreak(s, d(3)), 3); assert.equal(rwStreak(s, d(4)), 3, 'played yesterday: still alive today'); assert.equal(rwStreak(s, d(5)), 0);
  assert.equal(rwStreak({ streak: 3, best: 3, dinks: 6, last: '2026-12-31' }, '2027-01-01'), 3, 'a year change is one day');
  assert.equal(rwStreak({ streak: 2, best: 2, dinks: 3, last: '2026-03-28' }, '2026-03-30'), 0, 'a clock change never adds or drops a day');
});

test('a stored state that was edited or damaged is cleaned, never trusted', () => {
  const none = { frame: '', paddle: '', pet: '' };
  assert.deepEqual(rwClean(null), { streak: 0, best: 0, dinks: 0, last: '', worn: none });
  assert.deepEqual(rwClean({ streak: -4, best: 'x', dinks: NaN, last: 'yesterday' }), { streak: 0, best: 0, dinks: 0, last: '', worn: none });
  // A worn item is a plain item id or nothing: markup, a path or a wrong type never gets through to the page's attributes.
  assert.deepEqual(rwClean({ worn: { frame: 'frame-court', paddle: '"><img src=x onerror=1>', pet: 'pet-frog' } }).worn, { frame: 'frame-court', paddle: '', pet: 'pet-frog' });
  assert.deepEqual(rwClean({ worn: 'frame-court' }).worn, none);
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
  const make = (club, hide) => new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', mod + `; return { Rewards, get s() { return rwCur(); } };`)(
    { get: (k, f) => (k === 'pb.rewardsHide' ? hide : f), set() {} }, club, String, () => {}, { addEventListener() {} }, () => 'Ana', () => 'tok', null, () => {});
  const off = make({ rewards: false }, false), none = make(null, false), hidden = make({ rewards: true }, true), on = make({ rewards: true }, false);
  for (const x of [off, none]) { assert.equal(x.s.dinks, 0); assert.equal(x.Rewards.cardHTML() + x.Rewards.flameHTML() + x.Rewards.youRowHTML(), ''); }
  assert.equal(hidden.Rewards.cardHTML(), ''); assert.match(hidden.Rewards.youRowHTML(), /Show rewards and streak/);
  assert.match(on.Rewards.cardHTML(), /Your Dink[\s\S]*can't be bought with real money or cashed out/);
  assert.match(on.Rewards.youRowHTML(), /Hide rewards and streak/);
});

test('calm and play-money rules: no purchase, no randomness, no animation or sound in the module', () => {
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '').replace(/can't be bought/, '');
  assert.ok(!/buy|purchase|price|Math\.random|@keyframes|animation|transition|confetti|Audio\(|\.play\(\)/i.test(code), 'play money, no odds, no motion, no sound');
  const html = read('dink-score.html');
  const css = html.slice(html.indexOf('.card.rw-card {'), html.indexOf('.me-btn.frame-crown::before'));
  assert.ok(!/animation|transition|@keyframes/.test(css));
  assert.match(css, /\.rw-hide \{[^}]*min-height: 44px/);
});

test('the phone only asks the server: no call while off, hidden-or-not it shows the synced value, a legacy local balance is replaced', async () => {
  const mod = module('economy');
  const run = async (club, { name = 'Ana', stored = {}, reply } = {}) => {
    const calls = [], kv = { 'pb.rewards': stored };
    const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', mod + '; return { Rewards, cur: rwCur };')(
      { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } }, club, String, () => {}, { addEventListener() {} }, () => name, () => 'tok',
      async b => { calls.push(b); return reply; }, () => {});
    await x.Rewards.sync(true);
    return { calls, kv, x };
  };
  const reply = { dinks: 7, streak: 3, best: 3, last: '2026-01-03', gained: 2, entries: [] };
  assert.equal((await run({ rewards: false, code: 'ABC123' }, { reply })).calls.length, 0, 'off: no reward call at all');
  assert.equal((await run({ rewards: true, code: 'ABC123' }, { reply, name: null })).calls.length, 0, 'no linked name: nothing to ask for');
  const r = await run({ rewards: true, code: 'ABC123' }, { reply, stored: { streak: 40, best: 40, dinks: 999, last: '2025-01-01' } });
  assert.deepEqual(r.calls.map(c => c.action), ['rewards-sync', 'rewards-pass'], 'a sync is followed by one read of the pass for the ready tag'); assert.equal(r.calls[0].action, 'rewards-sync'); assert.ok(Number.isInteger(r.calls[0].tz));
  assert.ok(!('dinks' in r.calls[0]) && !('streak' in r.calls[0]), 'the phone never sends a balance');
  assert.deepEqual(Object.keys(r.kv['pb.rewards']), ['ABC123'], 'the old flat local balance is gone');
  assert.equal(r.x.cur().dinks, 7, "the server's number, not the phone's own 999");
  const off = await run({ rewards: true, code: 'ABC123' }, { reply: undefined, stored: { ABC123: { streak: 2, best: 2, dinks: 5, last: '2026-01-02' } } });
  assert.equal(off.x.cur().dinks, 5, 'a failed sync (offline) keeps the last synced value');
});
