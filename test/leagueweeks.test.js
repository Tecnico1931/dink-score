import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeague, recordLeagueResult, correctLeagueResult, view, divisionTable, gameFor, endSeason } from '../api/_league.js';
import { setWeekPlan, rescheduleMatch, forfeitMatch, openedWeek, noteWeekSent, currentWeek, NOTIFY_GAP } from '../api/_leagueweeks.js';
import { leagueWeekMessages, leagueMovedMessages, whenText } from '../api/_push.js';
import { leaguePublicView } from '../api/_share.js';

const P = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
const rate = players => Object.fromEntries(players.map((p, i) => [p, 3 - i * 0.1]));
const ORG = { organizer: true, name: null };
const mk = (n, extra = {}) => createLeague({ name: 'Tuesday league', mode: 'singles', players: P(n), ...extra }, rate(P(n)), 1000, () => 0.5);
const play = (L, m, now = 5000) => recordLeagueResult(L, m.id, { score: [11, 4], endedAt: now }, now, ORG);

test('an odd division rests exactly one entry a week and everyone rests once; an even one never rests', () => {
  const L = mk(5), V = view(L);
  assert.equal(V.weeks.length, 5);
  const rested = V.weeks.flatMap(w => { assert.equal(w.byes.length, 1); return w.byes.map(b => b.members[0]); });
  assert.deepEqual(rested.sort(), P(5));
  for (const w of V.weeks) assert.ok(!w.matches.flatMap(m => m.teams.flat()).includes(w.byes[0].members[0]));
  assert.ok(view(mk(4)).weeks.every(w => w.byes.length === 0));
  // two legs of an odd division: every entry rests twice
  const two = view(mk(5, { legs: 2 }));
  assert.equal(two.weeks.length, 10);
  assert.deepEqual(two.weeks.flatMap(w => w.byes.map(b => b.members[0])).sort(), [...P(5), ...P(5)].sort());
});

test('a smaller division that has played all its rounds is finished, not resting', () => {
  const V = view(mk(13, { divisions: 2 })); // divisions of 7 and 6
  assert.deepEqual(V.divisions.map(d => d.entries.length), [7, 6]);
  assert.equal(V.weeks.length, 7);
  assert.deepEqual(V.weeks.map(w => w.byes.map(b => b.division)), [[0], [0], [0], [0], [0], [0], [0]]); // only the odd division ever rests anyone
});

test('a week gets a day, a time and courts; a blank clears; bad input and a finished season are refused', () => {
  const L = mk(6); // 3 matches a week
  setWeekPlan(L, 1, { date: '2026-03-14', time: '10:00', courts: 2 }, 2000);
  assert.deepEqual(L.weeks[0].matches.map(m => m.court), [1, 2, 1]);
  assert.equal(L.weeks[0].date, '2026-03-14');
  setWeekPlan(L, 1, { date: '2026-03-14', time: '' }, 2100); // courts left out: untouched, time cleared
  assert.equal(L.weeks[0].time, undefined);
  assert.deepEqual(L.weeks[0].matches.map(m => m.court), [1, 2, 1]);
  setWeekPlan(L, 1, { date: '', courts: 0 }, 2200);
  assert.equal(L.weeks[0].date, undefined);
  assert.ok(L.weeks[0].matches.every(m => m.court === undefined));
  for (const bad of [{ date: '2026-02-30' }, { date: 'tomorrow' }, { date: '2026-03-14', time: '25:00' }, { time: '10:00' }, { date: '2026-03-14', courts: 21 }, { date: '2026-03-14', courts: 1.5 }]) assert.throws(() => setWeekPlan(L, 1, bad), /not valid|Pick a day|1 to 20/, JSON.stringify(bad));
  assert.throws(() => setWeekPlan(L, 99, {}), /not in this league/);
  endSeason(L, 3000);
  assert.throws(() => setWeekPlan(L, 1, { date: '2026-03-14' }), /finished/);
});

test('already played matches keep their court when a week is replanned', () => {
  const L = mk(6);
  setWeekPlan(L, 1, { date: '2026-03-14', courts: 3 });
  play(L, L.weeks[0].matches[0]);
  setWeekPlan(L, 1, { date: '2026-03-14', courts: 1 });
  assert.deepEqual(L.weeks[0].matches.map(m => m.court), [1, 1, 1]);
  play(L, L.weeks[0].matches[1]);
  setWeekPlan(L, 1, { date: '2026-03-15', courts: 2 });
  assert.deepEqual(L.weeks[0].matches.map(m => m.court), [1, 1, 1]); // the two played ones did not change; the open one is now first in line
});

test('a match can move to another day, time or court and back; a played match cannot', () => {
  const L = mk(4), m = L.weeks[0].matches[0];
  setWeekPlan(L, 1, { date: '2026-03-14', time: '10:00' });
  assert.deepEqual(view(L).weeks[0].matches[0].when, { date: '2026-03-14', time: '10:00', moved: false, court: null });
  const r = rescheduleMatch(L, m.id, { date: '2026-03-17', time: '18:30', court: 3 }, 2000);
  assert.equal(r.changed, true);
  assert.deepEqual(view(L).weeks[0].matches[0].when, { date: '2026-03-17', time: '18:30', moved: true, court: 3 });
  assert.equal(rescheduleMatch(L, m.id, { date: '2026-03-17', time: '18:30', court: 3 }, 2100).changed, false);
  assert.equal(view(L).weeks[0].matches[1].when.moved, false); // only that match moved
  rescheduleMatch(L, m.id, { date: '', court: '' }, 2200);
  assert.deepEqual(view(L).weeks[0].matches[0].when, { date: '2026-03-14', time: '10:00', moved: false, court: null });
  assert.throws(() => rescheduleMatch(L, m.id, { time: '10:00' }), /Pick a day/);
  assert.throws(() => rescheduleMatch(L, m.id, { date: '2026-03-17', court: 100 }), /court number/);
  assert.throws(() => rescheduleMatch(L, 'nope', { date: '2026-03-17' }), /not in this league/);
  play(L, m);
  assert.throws(() => rescheduleMatch(L, m.id, { date: '2026-03-18' }), /has been played/);
});

test('a forfeit counts target to 0 in the table, is never a game, and can be undone', () => {
  const L = mk(4, { target: 15 });
  const [a, b] = [L.weeks[0].matches[0], L.weeks[0].matches[1]];
  const r = forfeitMatch(L, a.id, 1, 2000);
  assert.deepEqual([r.match.score, r.match.winner, r.match.status, r.match.forfeit], [[0, 15], 1, 'done', true]);
  assert.equal(gameFor(L, a), null); // not saved to the club record, so ratings never see it
  const winner = a.teams[1][0], row = divisionTable(L, 0).find(x => x.members[0] === winner);
  assert.deepEqual([row.wins, row.diff], [1, 15]);
  assert.equal(forfeitMatch(L, a.id, 1, 2100).changed, false);
  assert.equal(forfeitMatch(L, a.id, 0, 2200).match.winner, 0); // the organizer can switch the side
  assert.throws(() => recordLeagueResult(L, a.id, { score: [11, 3] }, 3000, ORG), /forfeit/);
  assert.throws(() => correctLeagueResult(L, a.id, [11, 3], 3000), /Undo the forfeit/);
  play(L, b);
  assert.throws(() => forfeitMatch(L, b.id, 0, 3000), /already played/);
  assert.throws(() => forfeitMatch(L, a.id, 2, 3000), /which side/);
  assert.throws(() => forfeitMatch(L, b.id, null, 3000), /not a forfeit/);
  const undone = forfeitMatch(L, a.id, null, 3100);
  assert.deepEqual([undone.match.status, undone.match.score, 'winner' in undone.match, 'forfeit' in undone.match], ['pending', null, false, false]);
  recordLeagueResult(L, a.id, { score: [11, 3], endedAt: 3200 }, 3200, ORG); // now it can be played for real
  assert.equal(gameFor(L, a).score[0], 11);
});

test('forfeits can finish a season, and a finished season cannot be changed by forfeit', () => {
  const L = mk(3); // 3 matches, one a week
  for (const m of L.weeks.flatMap(w => w.matches)) forfeitMatch(L, m.id, 0, 2000);
  assert.equal(L.status, 'done');
  assert.ok(L.champions[0]);
  assert.throws(() => forfeitMatch(L, L.weeks[0].matches[0].id, null, 3000), /finished/);
});

test('a week opens once: only when the week before is fully played, and only the first time', () => {
  const L = mk(6); // 3 matches a week
  assert.equal(currentWeek(L), 1);
  const [m1, m2, m3] = L.weeks[0].matches;
  let before = currentWeek(L);
  play(L, m1); assert.equal(openedWeek(L, before, 5000), null);
  before = currentWeek(L); play(L, m2); assert.equal(openedWeek(L, before, 5000), null);
  before = currentWeek(L); play(L, m3);
  const w = openedWeek(L, before, 6000);
  assert.equal(w.n, 2);
  assert.equal(w.notifiedAt, 6000);
  assert.equal(openedWeek(L, before, 7000), null); // already told
  // a forfeit of the last open match opens the next week the same way
  const [n1, n2, n3] = L.weeks[1].matches;
  play(L, n1); play(L, n2); before = currentWeek(L);
  forfeitMatch(L, n3.id, 0, 8000);
  assert.equal(openedWeek(L, before, 8000).n, 3);
});

test('the finished last week opens nothing', () => {
  const L = mk(3);
  for (const m of L.weeks.flatMap(w => w.matches).slice(0, 2)) play(L, m);
  const before = currentWeek(L);
  play(L, L.weeks[2].matches[0]);
  assert.equal(L.status, 'done');
  assert.equal(openedWeek(L, before, 9000), null);
});

test('"tell the players" works on a week with matches left, but not twice in a row', () => {
  const L = mk(6);
  assert.equal(noteWeekSent(L, 1, 10_000).notifiedAt, 10_000);
  assert.throws(() => noteWeekSent(L, 1, 10_000 + NOTIFY_GAP - 1), /a moment ago/);
  assert.equal(noteWeekSent(L, 1, 10_000 + NOTIFY_GAP).notifiedAt, 10_000 + NOTIFY_GAP);
  for (const m of L.weeks[0].matches) play(L, m);
  assert.throws(() => noteWeekSent(L, 1, 99_000_000), /has been played/);
});

test('week messages: each player hears opponent, day, time and court; a resting player hears the bye; played matches are skipped', () => {
  const L = mk(5);
  setWeekPlan(L, 1, { date: '2026-03-14', time: '10:00', courts: 2 });
  const w = L.weeks[0], msgs = leagueWeekMessages(L, w), [m1, m2] = w.matches, bye = view(L).weeks[0].byes[0].members[0];
  assert.equal(msgs.size, 5);
  const a = m1.teams[0][0], b = m1.teams[1][0];
  assert.equal(msgs.get(a).title, 'Tuesday league: week 1');
  assert.equal(msgs.get(a).body, `${a}, you play ${b} on Sat 14 Mar at 10:00, court 1.`);
  assert.equal(msgs.get(m2.teams[0][0]).body.endsWith('on Sat 14 Mar at 10:00, court 2.'), true);
  assert.equal(msgs.get(bye).body, `${bye}, you have a bye this week.`);
  assert.ok([...msgs.values()].every(m => m.tag === 'league-' + L.id));
  play(L, m1);
  assert.ok(!leagueWeekMessages(L, w).has(a));
});

test('no day set reads "this week"; a doubles pair hears both opponents', () => {
  const L = createLeague({ name: 'Doubles', mode: 'doubles', players: P(12) }, rate(P(12)), 1000, () => 0.5);
  const m = L.weeks[0].matches[0], me = m.teams[0][0], msg = leagueWeekMessages(L, L.weeks[0]).get(me);
  assert.equal(msg.body, `${me}, you play ${m.teams[1].join(' & ')} this week.`);
  assert.equal(whenText({ date: '2026-12-01', time: null, court: null }), 'on Tue 1 Dec');
  assert.equal(whenText({ date: null, time: '10:00', court: 4 }), 'this week, court 4');
  assert.equal(whenText({ date: 'garbage', time: null, court: null }), 'this week');
});

test('a moved match tells only the two sides in it, with the new slot', () => {
  const L = mk(4), m = L.weeks[0].matches[0];
  rescheduleMatch(L, m.id, { date: '2026-03-17', time: '18:30', court: 3 });
  const msgs = leagueMovedMessages(L, L.weeks[0], m);
  assert.deepEqual([...msgs.keys()].sort(), m.teams.flat().sort());
  assert.equal(msgs.get(m.teams[0][0]).body, `${m.teams[0][0]}, you play ${m.teams[1][0]} on Tue 17 Mar at 18:30, court 3.`);
  assert.equal(msgs.get(m.teams[0][0]).title, 'Tuesday league: match moved');
});

test('long names are cut so a message stays short', () => {
  const L = createLeague({ name: 'N'.repeat(40), mode: 'singles', players: ['A'.repeat(40), 'B'.repeat(40), 'C'.repeat(40)] }, {}, 1000, () => 0.5);
  for (const m of leagueWeekMessages(L, L.weeks[0]).values()) assert.ok(m.title.length <= 60 && m.body.length < 120, m.body);
});

test('the public page gets the day, court, byes and forfeit flag, and still no ids', () => {
  const L = mk(5);
  setWeekPlan(L, 1, { date: '2026-03-14', time: '10:00', courts: 2 });
  forfeitMatch(L, L.weeks[0].matches[0].id, 0, 2000);
  rescheduleMatch(L, L.weeks[0].matches[1].id, { date: '2026-03-20', court: 2 });
  const v = leaguePublicView(L), text = JSON.stringify(v);
  assert.equal(v.weeks[0].matches[0].forfeit, true);
  assert.deepEqual(v.weeks[0].matches[1].when, { date: '2026-03-20', time: null, moved: true, court: 2 });
  assert.equal(v.weeks[0].byes.length, 1);
  assert.deepEqual(Object.keys(v.weeks[0].byes[0]).sort(), ['division', 'name']);
  assert.deepEqual(Object.keys(v.weeks[0].matches[0]).sort(), ['division', 'forfeit', 'score', 'status', 'teams', 'when']);
  for (const hidden of [L.id, L.weeks[0].matches[0].id, 'notifiedAt', 'gameId']) assert.ok(!text.includes(hidden), hidden);
});

test('leagues made before weeks were planned still load, with no day, no courts and byes worked out', () => {
  const L = mk(5);
  for (const w of L.weeks) for (const k of ['date', 'time', 'notifiedAt']) assert.ok(!(k in w));
  const V = view(L);
  assert.equal(V.weeks[0].matches[0].when.date, null);
  assert.equal(V.weeks[0].byes.length, 1);
});
