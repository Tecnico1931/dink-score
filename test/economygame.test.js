// WI-17: per-game Dinks, the 300 a day cap, edit/delete adjustment and challenge rewards (api/_economygame.js), pure and with made-up players only.
// The ledger is simulated the way the database keeps it: append-only, and an insert of an id that exists is dropped (ON CONFLICT DO NOTHING).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as G from '../api/_economygame.js';
import { ledgerBalance, totals, validEntry, paceFrom, gameRowDay } from '../api/_economy.js';
import { compute } from '../api/_rating.js';
import { describe } from '../api/_economyactivity.js';

const NOW = Date.UTC(2026, 0, 20, 12);
const H = 36e5;
let seq = 0;
// A saved game: Ana and Ben (team 0) against Cy and Di. `by` is who sent it ('ana' = her own phone), `at` hours before NOW.
const game = ({ win = 0, by = 'ana', at = 1, id, teams = [['Ana', 'Ben'], ['Cy', 'Di']] } = {}) =>
  ({ id: id || 'g' + ++seq, teams, winner: win, score: win === 0 ? [11, 5] : [5, 11], endedAt: NOW - at * H, receivedAt: NOW - at * H, ...(by ? { scoredBy: by } : {}) });
const store = () => {
  const ledger = [];
  const add = rows => { for (const r of rows) { assert.ok(validEntry(r), JSON.stringify(r)); if (!ledger.some(e => e.id === r.id)) ledger.push(r); } return rows; };
  const sync = (games, { now = NOW, changes = {}, key = 'ana' } = {}) => add(G.planGameRows({ ledger, days: G.gameDays(games, key, changes), now }));
  return { ledger, add, sync, bal: () => ledgerBalance(ledger) };
};
const day = ms => new Date(ms).toISOString().slice(0, 10);

test('a game pays +2 for playing, +10 more for a win; a loss is just the +2', () => {
  const w = G.gameDays([game({ win: 0 })], 'ana');
  assert.equal(w.get(day(NOW - H)), 12);
  assert.equal(G.gameDays([game({ win: 1 })], 'ana').get(day(NOW - H)), 2);
  assert.equal(G.gameDays([game({ win: 1 })], 'cy').get(day(NOW - H)), 12, 'the other side wins');
  assert.equal(G.gameDays([game({ win: 0 })], 'zed').size, 0, 'a player who was not in the game earns nothing from it');
  assert.equal(G.gameDays([{ ...game(), winner: null }], 'ana').get(day(NOW - H)), 2, 'no winner: only the +2');
});

test('only a game sent from a club player\'s own phone earns more than the +2', () => {
  for (const by of [null, 'organizer']) assert.equal(G.gameDays([game({ by })], 'ana').get(day(NOW - H)), 2, String(by));
  assert.equal(G.gameDays([game({ by: 'cy' })], 'ana').get(day(NOW - H)), 12, "another club player's phone counts");
  assert.equal(G.gameDays([{ ...game({ by: 'organizer' }), scoredByPlayer: 'ana' }], 'ana').get(day(NOW - H)), 12, "the creating phone's own player counts");
  assert.equal(G.verifiedGame({ scoredBy: '' }), false);
});

test('beating the forecast pays +3 even in a loss, and never from a game the engine has no forecast for', () => {
  const g = game({ win: 0 });
  // team 1 (Cy, Di) lost, but was forecast to get 40% of the points and got 45%: it beat the forecast while losing
  const changes = { [g.id]: { usedShareA: 0.55, expected: 0.6 } };
  assert.equal(G.gameDays([g], 'cy', changes).get(day(NOW - H)), 2 + 3);
  assert.equal(G.gameDays([g], 'ana', changes).get(day(NOW - H)), 12, 'team 0 won but got less than forecast: the win only');
  assert.equal(G.gameDays([g], 'cy', {}).get(day(NOW - H)), 2, 'no forecast: no bonus');
  // the real engine: Ana and Ben beat Cy and Di 11-0, then Cy and Di lose 9-11 but get more than the share they were forecast
  const priors = [9, 8, 7, 6].map(at => ({ ...game({ win: 0, at, id: 'e' + at }), score: [11, 0] })), g2 = { ...game({ win: 0, at: 1, id: 'e2' }), score: [11, 9] };
  const { changes: real } = compute([...priors, g2]);
  assert.ok(1 - real.e2.usedShareA > 1 - real.e2.expected, 'the engine forecast Cy and Di less than the 9 of 20 points they got');
  assert.equal(G.gameDays([g2], 'cy', real).get(day(NOW - H)), 5, 'losing 9-11 after being forecast to do worse earns the forecast bonus');
});

test('+5 for each win from the third in a row; a loss resets the run; counted in the order the server received the games', () => {
  const gs = [1, 2, 3, 4, 5, 6].map(i => game({ win: 0, at: 10 - i }));
  assert.deepEqual([...G.gameDays(gs, 'ana').values()], [12 + 12 + 17 + 17 + 17 + 17]);
  const lossFirst = [game({ win: 0, at: 9 }), game({ win: 0, at: 8 }), game({ win: 1, at: 7 }), game({ win: 0, at: 6 }), game({ win: 0, at: 5 }), game({ win: 0, at: 4 })];
  assert.equal(G.gameDays(lossFirst, 'ana').get(day(NOW - 4 * H)), 12 + 12 + 2 + 12 + 12 + 17, 'the loss restarts the count');
  // backdating a game (endedAt) does not move it in the run: receivedAt is the server's clock
  const a = game({ win: 0, at: 3 }), b = { ...game({ win: 1, at: 2 }), endedAt: NOW - 100 * H }, c = game({ win: 0, at: 1 });
  assert.equal(G.gameDays([a, b, c], 'ana').get(day(NOW - H)), 12 + 2 + 12);
});

test('games pay at most 300 Dinks a (UTC) day', () => {
  const wins = Array.from({ length: 40 }, (_, i) => game({ win: 0, at: 1 + i / 100 }));
  const s = store();
  const rows = s.sync(wins);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, G.EARN.cap);
  assert.equal(s.bal(), 300);
  assert.deepEqual(s.sync(wins), [], 'the same sync again adds nothing');
  // one more win the same day still pays nothing, and the next day starts fresh
  assert.deepEqual(s.sync([...wins, game({ win: 0, at: 0.5 })]), []);
  const tomorrow = game({ win: 0, at: -13 });
  const next = s.sync([...wins, tomorrow], { now: NOW + 14 * H });
  assert.deepEqual(next.map(r => [r.id, r.amount]), [['play:' + day(tomorrow.receivedAt), 17]], 'a win in a run of wins: +2 +10 +5');
  assert.equal(s.bal(), 317);
});

test('the cap is per day and counts a day\'s games together, however many syncs they arrive in', () => {
  const s = store(), gs = [];
  for (let i = 0; i < 40; i++) { gs.push(game({ win: 0, at: 2 })); s.sync(gs); }
  assert.equal(s.bal(), 300, 'paid in 40 small steps, never past the cap');
  assert.ok(s.ledger.every(r => r.amount > 0 && r.reason === 'game'));
  assert.equal(new Set(s.ledger.map(r => r.id)).size, s.ledger.length);
});

test('an edited game adjusts what it paid: a win turned into a loss takes 10 back, and back again gives it again', () => {
  const s = store(), a = game({ win: 0, id: 'ed1' }), b = game({ win: 0, id: 'ed2', at: 2 });
  s.sync([a, b]);
  assert.equal(s.bal(), 24);
  const lost = { ...a, winner: 1, score: [5, 11] };
  const down = s.sync([lost, b]);
  assert.deepEqual(down.map(r => [r.kind, r.amount, r.reason]), [['spend', -10, 'game-adj']]);
  assert.equal(s.bal(), 14);
  assert.deepEqual(s.sync([lost, b]), [], 'idempotent');
  const up = s.sync([a, b]);
  assert.deepEqual(up.map(r => [r.kind, r.amount, r.reason]), [['earn', 10, 'game']]);
  assert.equal(s.bal(), 24);
  assert.deepEqual(s.ledger.map(r => r.id), [`play:${day(a.receivedAt)}`, `play:${day(a.receivedAt)}:1`, `play:${day(a.receivedAt)}:2`], 'each change is one more id, never a rewrite');
});

test('an edit that takes the sender away (an unverified game) or turns a win into a loss lowers the pay, and a delete takes the whole game back', () => {
  const s = store(), a = game({ win: 0, id: 'dl1' }), b = game({ win: 0, id: 'dl2', at: 2 });
  s.sync([a, b]);
  s.sync([{ ...a, scoredBy: undefined }, b]);
  assert.equal(s.bal(), 2 + 12, 'a no longer verified game is worth only its +2');
  s.sync([b]); // deleted
  assert.equal(s.bal(), 12, 'a deleted game pays nothing');
  s.sync([]);
  assert.equal(s.bal(), 0, 'every game of the day deleted: the day is worth 0');
  assert.deepEqual(s.sync([]), []);
  s.sync([a, b]); // restored
  assert.equal(s.bal(), 24, 'a game that comes back pays again');
});

test('a deleted game that took a streak with it adjusts the later wins too', () => {
  const gs = [1, 2, 3, 4].map(i => game({ win: 0, at: 6 - i, id: 'st' + i }));
  const s = store();
  s.sync(gs);
  assert.equal(s.bal(), 12 + 12 + 17 + 17);
  s.sync(gs.filter(g => g.id !== 'st1')); // one of the first wins is removed: the run is 3 long now
  assert.equal(s.bal(), 12 + 12 + 17);
});

test('the cap holds after edits: a day over the cap stays at 300 when a game is removed, and drops only once it is under', () => {
  const gs = Array.from({ length: 30 }, (_, i) => game({ win: 0, at: 1 + i / 100, id: 'cp' + i })); // 5 x 12... 30 wins = 12*2 + 17*28 = 500
  const s = store();
  s.sync(gs);
  assert.equal(s.bal(), 300);
  assert.deepEqual(s.sync(gs.slice(1)), [], 'still over the cap without one game: nothing to adjust');
  const few = gs.slice(0, 5);
  s.sync(few);
  assert.equal(s.bal(), 12 + 12 + 17 + 17 + 17);
});

test('a take-back never takes the balance below zero; the rest comes out of later earnings', () => {
  const s = store(), a = game({ win: 0, id: 'sp1' });
  s.sync([a]);
  s.add([{ id: 'spend:thing-1', kind: 'spend', amount: -11, reason: 'shop:x', day: null, streak: null }]);
  assert.equal(s.bal(), 1);
  const rows = s.sync([]); // the game is deleted after the Dinks were spent
  assert.deepEqual(rows.map(r => r.amount), [-1], 'only what is left is taken');
  assert.equal(s.bal(), 0);
  assert.deepEqual(s.sync([]), [], 'nothing to take from an empty balance');
  const b = game({ win: 0, id: 'sp2', at: 0.5 });
  s.sync([b]);
  assert.equal(s.bal(), 12 - 11, 'the 11 still owed from that day is netted against the next earning');
  assert.ok(s.ledger.every(r => r.id.startsWith('play:') || r.id.startsWith('spend:')));
});

test('only the last 14 days can change: an older day is final even when its games are edited or deleted', () => {
  const s = store(), old = game({ win: 0, at: 15 * 24 + 1, id: 'ol1' }), recent = game({ win: 0, id: 'ol2' });
  const first = s.sync([old, recent]);
  assert.deepEqual(first.map(r => r.id), [`play:${day(recent.receivedAt)}`], 'an old history is never back-paid');
  // the old day is paid by an earlier sync, then it falls out of the window and its games are deleted
  const early = NOW - 15 * 24 * H;
  s.add([{ id: `play:${day(old.receivedAt)}`, kind: 'earn', amount: 12, reason: 'game', day: null, streak: null }]);
  assert.deepEqual(s.sync([recent]), [], 'older than the window: no adjustment');
  assert.equal(day(early) <= day(old.receivedAt), true);
});

test('rows a merge moved under m:<name key>: still count as paid, so merged players are not paid twice', () => {
  const own = { id: 'play:2026-01-20', kind: 'earn', amount: 12, reason: 'game', day: null, streak: null };
  const moved = { ...own, id: 'm:remy:play:2026-01-20', amount: 14 }, movedAdj = { ...own, id: 'm:remy:play:2026-01-20:1', kind: 'spend', amount: -2, reason: 'game-adj' };
  assert.equal(G.planGameRows({ ledger: [own, moved, movedAdj], days: new Map([['2026-01-20', 24]]), now: NOW }).length, 0, 'paid 12 + 14 - 2 = the 24 the day is worth');
  const more = G.planGameRows({ ledger: [own, moved, movedAdj], days: new Map([['2026-01-20', 30]]), now: NOW });
  assert.deepEqual(more.map(r => [r.id, r.amount]), [['play:2026-01-20:3', 6]], 'a new id: after the rows the day already has');
  for (const id of ['day:2026-01-20', 'xplay:2026-01-20', 'play:2026-01-2', 'm:a:b:play:2026-01-20:2']) assert.equal(gameRowDay(id), id.endsWith('play:2026-01-20:2') ? '2026-01-20' : null, id);
});

test('two phones syncing at once derive the same ids and amounts, so one insert wins and nothing is paid twice', () => {
  const gs = [game({ win: 0 }), game({ win: 1, at: 2 })];
  const a = G.planGameRows({ ledger: [], days: G.gameDays(gs, 'ana'), now: NOW }), b = G.planGameRows({ ledger: [], days: G.gameDays([...gs].reverse(), 'ana'), now: NOW });
  assert.deepEqual(a, b);
  const s = store();
  s.add(a); s.add(b);
  assert.equal(s.bal(), 14);
});

test('every game row is a valid ledger row that leaves the daily streak alone, and a take-back lowers earned rather than adding to spent', () => {
  const s = store(), a = game({ win: 0, id: 'tl1' });
  s.sync([a]); s.sync([{ ...a, winner: 1 }]);
  assert.ok(s.ledger.every(r => r.day === null && r.streak === null && validEntry(r)));
  assert.deepEqual(totals(s.ledger), { earned: 2, spent: 0 });
  assert.equal(describe({ ...s.ledger[0], at: 0 }), 'Earned from games');
  assert.match(describe({ ...s.ledger[1], at: 0 }), /Taken back/);
  assert.equal(describe({ kind: 'earn', reason: 'challenge' }), 'Weekly challenge reward');
});

test('pace counts a day\'s game Dinks and adjustments, and nothing else', () => {
  const d = n => `2026-01-${String(n).padStart(2, '0')}`;
  const rows = [10, 11, 12].map(n => ({ id: 'play:' + d(n), kind: 'earn', amount: 24, reason: 'game', day: null, streak: null }));
  rows.push({ id: 'play:' + d(12) + ':1', kind: 'spend', amount: -12, reason: 'game-adj', day: null, streak: null });
  rows.push({ id: 'chal:2026-W03:win-3', kind: 'earn', amount: 99, reason: 'challenge', day: null, streak: null });
  assert.equal(paceFrom(rows, NOW), 20);
});

test('challenge rewards: +10, +10, +15 for the week\'s first, second and third, each paid once', () => {
  const weeks = { '2026-W04': [{ id: 'win-3', done: true }, { id: 'play-5', done: true }, { id: 'upset', done: true }], '2026-W03': [{ id: 'singles', done: false }, { id: 'streak-3', done: true }, { id: 'play-5', done: false }] };
  const rows = G.planChallengeRows({ ledger: [], weeks });
  assert.deepEqual(rows.map(r => [r.id, r.amount]), [['chal:2026-W04:win-3', 10], ['chal:2026-W04:play-5', 10], ['chal:2026-W04:upset', 15], ['chal:2026-W03:streak-3', 10]]);
  assert.ok(rows.every(validEntry) && rows.every(r => r.day === null && r.reason === 'challenge'));
  assert.deepEqual(G.planChallengeRows({ ledger: rows, weeks }), [], 'a second sync pays nothing');
  assert.deepEqual(G.CHALLENGE_PAY, [10, 10, 15]);
});

test('the earning code stays on the server, in the economy modules, and the scoring paths do not import it', () => {
  const src = fs.readFileSync(new URL('../api/_economygame.js', import.meta.url), 'utf8');
  assert.ok(!/\bUPDATE reward_ledger|DELETE FROM reward_ledger|INSERT INTO/.test(src), 'planning never writes; _economysync.js only appends');
  assert.ok(!/req\.|body\./.test(src), 'nothing a request says is an input');
  for (const f of ['api/_gamesave.js', 'api/games.js', 'api/_rating_store.js', 'rating-engine.js'])
    assert.ok(!/economy/.test(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')), f + ' stays out of the economy');
  const sync = fs.readFileSync(new URL('../api/_economysync.js', import.meta.url), 'utf8');
  assert.match(sync, /ON CONFLICT DO NOTHING/, 'every insert is idempotent by id');
  assert.ok(!/UPDATE reward_ledger|DELETE FROM reward_ledger/.test(sync), 'the ledger is append-only');
});
