import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeague, createLadder, recordLeagueResult, recordChallenge, correctLeagueResult, nextSeason, endSeason, closeLadderSeason, ladderOrder, ladderRows, challengeable, divisionTable, view, summary, checkResultActor, gameFor } from '../api/_league.js';
import { rewriteNames } from '../api/_rename.js';

const P = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
const rate = players => Object.fromEntries(players.map((p, i) => [p, 3 - i * 0.1])); // P1 is strongest
const ORG = { organizer: true, name: null };
const rand = () => 0.5;

test('a singles league splits by rating into divisions and everyone plays everyone in their division', () => {
  const L = createLeague({ name: 'Tuesday league', mode: 'singles', players: P(8), divisions: 2 }, rate(P(8)), 1000, rand);
  assert.deepEqual(L.divisions.map(d => d.label), ['Division A', 'Division B']);
  assert.deepEqual(L.divisions[0].entries.map(i => L.entries[i][0]), ['P1', 'P2', 'P3', 'P4']);
  assert.deepEqual(L.divisions[1].entries.map(i => L.entries[i][0]), ['P5', 'P6', 'P7', 'P8']);
  const all = L.weeks.flatMap(w => w.matches);
  assert.equal(all.length, 12); // 6 per division
  const pairs = new Set(all.map(m => m.division + m.teams.map(t => t[0]).sort().join('v')));
  assert.equal(pairs.size, 12);
  for (const w of L.weeks) { // nobody plays twice in a week
    const who = w.matches.flatMap(m => m.teams.flat());
    assert.equal(new Set(who).size, who.length);
  }
});

test('two legs doubles the schedule; doubles teams pair strongest with weakest', () => {
  const L = createLeague({ name: 'Doubles', mode: 'doubles', players: P(12), legs: 2 }, rate(P(12)), 1000, rand);
  assert.equal(L.entries.length, 6);
  assert.equal(L.weeks.flatMap(w => w.matches).length, 30);
  assert.ok(L.entries.some(t => t.includes('P1') && t.includes('P12')));
  assert.equal(L.divisions.length, 1);
});

test('refuses too few entries for the divisions', () => {
  assert.throws(() => createLeague({ name: 'x', mode: 'singles', players: P(5), divisions: 2 }, {}), /too few/);
  assert.throws(() => createLeague({ name: '', mode: 'singles', players: P(4) }, {}), /name/);
  assert.throws(() => createLeague({ name: 'x', mode: 'doubles', players: P(4) }, {}), /at least 3 teams/);
});

function playAll(L, winner = m => (m.teams[0][0] < m.teams[1][0] ? 0 : 1)) {
  for (const m of L.weeks.flatMap(w => w.matches).filter(x => x.status === 'pending')) recordLeagueResult(L, m.id, { score: winner(m) === 0 ? [11, 5] : [5, 11], endedAt: 5000 }, 5000, ORG);
}

test('league results: idempotent retry, conflict, standings, season ends when every match is played', () => {
  const L = createLeague({ name: 'L', mode: 'singles', players: P(4) }, rate(P(4)), 1000, rand);
  const m = L.weeks[0].matches[0];
  const r = recordLeagueResult(L, m.id, { score: [11, 7], endedAt: 2000 }, 2000, ORG);
  assert.equal(r.changed, true);
  assert.equal(r.game.id, `${L.id}-${m.id}`);
  assert.equal(r.game.mode, 'singles');
  assert.equal(recordLeagueResult(L, m.id, { score: [11, 7] }, 3000, ORG).changed, false);
  assert.throws(() => recordLeagueResult(L, m.id, { score: [11, 9] }, 3000, ORG), /already scored/);
  assert.throws(() => recordLeagueResult(L, m.id, { score: [11, 11] }, 3000, ORG), /tied/);
  assert.throws(() => recordLeagueResult(L, 'nope', { score: [11, 1] }, 3000, ORG), /not in this league/);
  assert.equal(L.status, 'live');
  playAll(L);
  assert.equal(L.status, 'done');
  const t = divisionTable(L, 0);
  assert.equal(t.length, 4);
  assert.equal(t[0].played, 3);
  assert.ok(L.champions[0]);
  assert.throws(() => correctLeagueResult(L, 'nope', [11, 3]), /not been played/);
  const fixed = correctLeagueResult(L, m.id, [3, 11], 9000);
  assert.equal(fixed.match.winner, 1);
});

test('who may enter a result: organizer, a player in the match, anyone only when the league allows it', () => {
  const L = createLeague({ name: 'L', mode: 'singles', players: P(4) }, {}, 1000, rand);
  const m = L.weeks[0].matches[0];
  const [a, b] = [m.teams[0][0].toLowerCase(), 'someone else'];
  assert.doesNotThrow(() => checkResultActor(L, m.teams, { organizer: false, name: a }));
  assert.throws(() => checkResultActor(L, m.teams, { organizer: false, name: b }), /Only the players/);
  assert.throws(() => checkResultActor(L, m.teams, null), /Only the players/);
  assert.throws(() => recordLeagueResult(L, m.id, { score: [11, 1] }, 2000, { organizer: false, name: b }), /Only the players/);
  L.resultsBy = 'club';
  assert.doesNotThrow(() => checkResultActor(L, m.teams, { organizer: false, name: b }));
});

test('next season: top of a division goes up, bottom goes down, sizes stay, one division just replays', () => {
  const L = createLeague({ name: 'League', season: 'Autumn 1', mode: 'singles', players: P(9), divisions: 3 }, rate(P(9)), 1000, rand);
  assert.throws(() => nextSeason(L), /Finish this season/);
  playAll(L); // lower number wins: P1 > P2 > ... in every division
  const N = nextSeason(L, {}, 2000, rand);
  assert.equal(N.season, 'Autumn 2');
  const div = d => N.divisions[d].entries.map(i => N.entries[i][0]).sort();
  assert.deepEqual(div(0), ['P1', 'P2', 'P4']);          // P3 down, P4 up
  assert.deepEqual(div(1), ['P3', 'P5', 'P7']);          // P4 up, P6 down; P3 and P7 arrive
  assert.deepEqual(div(2), ['P6', 'P8', 'P9']);          // P7 up, P6 arrives
  assert.equal(N.weeks.flatMap(w => w.matches).length, 9);
  assert.equal(N.previous, L.id);
  assert.equal(N.history.length, 1);
  assert.equal(N.history[0].season, 'Autumn 1');
  assert.deepEqual(N.history[0].divisions.map(d => d.label), ['Division A', 'Division B', 'Division C']);
  assert.deepEqual(N.history[0].divisions[0].rows.map(r => r.members[0]), ['P1', 'P2', 'P3']); // final order, strongest first
  assert.deepEqual(Object.keys(N.history[0].divisions[0].rows[0]).sort(), ['diff', 'losses', 'members', 'played', 'wins']);
  assert.deepEqual(view(N).history.map(h => h.season), ['Autumn 1']);
  assert.equal(N.status, 'live');
  playAll(N); // the history keeps growing, newest first in the view, and a league made before history existed has none
  assert.deepEqual(view(nextSeason(N, {}, 3000, rand)).history.map(h => h.season), ['Autumn 2', 'Autumn 1']);
  assert.deepEqual(view(createLeague({ name: 'Old', mode: 'singles', players: P(4) }, {}, 1000, rand)).history, []);
  const one = createLeague({ name: 'One', mode: 'singles', players: P(4) }, {}, 1000, rand);
  playAll(one);
  assert.deepEqual(nextSeason(one, {}, 2000, rand).entries.flat().sort(), P(4));
});

test('ending a league early crowns whoever leads', () => {
  const L = createLeague({ name: 'L', mode: 'singles', players: P(4) }, rate(P(4)), 1000, rand);
  recordLeagueResult(L, L.weeks[0].matches[0].id, { score: [11, 2] }, 2000, ORG);
  endSeason(L, 3000);
  assert.equal(L.status, 'done');
  assert.ok(L.champions[0]);
  assert.throws(() => endSeason(L), /already finished/);
});

const ladder = (n = 6, extra = {}) => createLadder({ name: 'Ladder', mode: 'singles', players: P(n), jump: 2, ...extra }, rate(P(n)), 1000, rand);
const challenge = (L, key, c, d, score, actor = ORG) => recordChallenge(L, { key, challenger: [c], defender: [d], score }, 2000, actor);
const names = L => ladderOrder(L).map(i => L.entries[i][0]);

test('ladder: a winning challenger takes the place above, the others move down; a loss changes nothing', () => {
  const L = ladder();
  assert.deepEqual(names(L), P(6));
  challenge(L, 'k001', 'P4', 'P2', [11, 5]);
  assert.deepEqual(names(L), ['P1', 'P4', 'P2', 'P3', 'P5', 'P6']);
  challenge(L, 'k002', 'P6', 'P5', [4, 11]);
  assert.deepEqual(names(L), ['P1', 'P4', 'P2', 'P3', 'P5', 'P6']);
  const rows = ladderRows(L);
  assert.equal(rows[1].name, 'P4'); assert.equal(rows[1].wins, 1); assert.equal(rows.find(r => r.name === 'P6').losses, 1);
});

test('ladder: only up to the jump above, never below or self, retry by key is safe', () => {
  const L = ladder();
  assert.throws(() => challenge(L, 'k001', 'P5', 'P2', [11, 1]), /up to 2 places/);
  assert.throws(() => challenge(L, 'k001', 'P2', 'P5', [11, 1]), /above you/);
  assert.throws(() => challenge(L, 'k001', 'P2', 'P2', [11, 1]), /themselves/);
  assert.throws(() => challenge(L, 'k001', 'P2', 'Zed', [11, 1]), /not on this ladder/);
  assert.throws(() => challenge(L, 'x', 'P2', 'P1', [11, 1]), /key/);
  const first = challenge(L, 'k001', 'P3', 'P1', [11, 1]);
  assert.equal(first.changed, true);
  assert.equal(challenge(L, 'k001', 'P3', 'P1', [11, 1]).changed, false);
  assert.equal(L.results.length, 1);
  assert.throws(() => challenge(L, 'k001', 'P3', 'P1', [11, 2]), /already used/);
  assert.deepEqual(challengeable(L, L.entries.findIndex(e => e[0] === 'P2')).map(i => L.entries[i][0]), ['P3', 'P1']);
  assert.equal(first.game.mode, 'singles');
  assert.equal(first.game.id, `${L.id}-k001`);
});

test('ladder: who may report; closing a season keeps the order and starts clean', () => {
  const L = ladder();
  assert.throws(() => challenge(L, 'k001', 'P2', 'P1', [11, 1], { organizer: false, name: 'p5' }), /Only the players/);
  challenge(L, 'k001', 'P2', 'P1', [11, 1], { organizer: false, name: 'p2' });
  closeLadderSeason(L, undefined, 5000);
  assert.deepEqual(L.entries.map(e => e[0]), ['P2', 'P1', 'P3', 'P4', 'P5', 'P6']);
  assert.deepEqual(L.results, []);
  assert.equal(L.seasons[0].label, 'Season 1');
  assert.equal(L.season, 'Season 2');
  assert.deepEqual(names(L), ['P2', 'P1', 'P3', 'P4', 'P5', 'P6']);
});

test('doubles ladder challenges between teams', () => {
  const L = createLadder({ name: 'D', mode: 'doubles', players: P(8), teams: [['P1', 'P2'], ['P3', 'P4'], ['P5', 'P6'], ['P7', 'P8']] }, {}, 1000, rand);
  const r = recordChallenge(L, { key: 'abcd', challenger: ['P7', 'P8'], defender: ['P5', 'P6'], score: [11, 9] }, 2000, ORG);
  assert.equal(r.game.mode, 'doubles');
  assert.deepEqual(r.game.teams, [['P7', 'P8'], ['P5', 'P6']]);
  assert.deepEqual(L.entries[ladderOrder(L)[2]], ['P7', 'P8']);
});

test('views and summaries carry what the screens need and nothing private', () => {
  const lg = createLeague({ name: 'L', mode: 'singles', players: P(4) }, rate(P(4)), 1000, rand);
  assert.equal(view(lg).tables[0].rows.length, 4);
  assert.equal(summary(lg).matches, 6);
  const ld = ladder(); challenge(ld, 'k001', 'P2', 'P1', [11, 1]);
  const v = view(ld);
  assert.equal(v.rows[0].name, 'P2');
  assert.deepEqual(v.rows[2].canChallenge.map(x => x[0]), ['P2', 'P1']); // best place first
  assert.equal(summary(ld).top[0], 'P2');
  assert.equal(gameFor(ld, { status: 'pending' }), null);
});

test('rename reaches every name in a league and a ladder', () => {
  const lg = createLeague({ name: 'P1 league', mode: 'singles', players: P(4) }, {}, 1000, rand);
  const ld = ladder(); challenge(ld, 'k001', 'P2', 'P1', [11, 1]);
  for (const L of [lg, ld]) {
    const out = rewriteNames(L, new Map([['p1', 'Pat']]));
    assert.ok(!JSON.stringify(out.value).includes('"P1"'), 'no old name left');
    assert.ok(JSON.stringify(out.value).includes('"Pat"'));
    assert.equal(out.value.name, L.name); // titles are left alone
  }
});
