import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, startNextRound, setRound, publishRound, recordResult, correctResult, startKnockout, endEvent, standingsFor, view, findMatch, gameFor } from '../api/_events.js';
import { pairTeams, roundRobin, standings } from '../api/_schedule.js';
import { fairness } from '../api/_rotation.js';
import { ready } from '../api/_bracket.js';

const names = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
const base = o => ({ name: 'Sunday session', format: 'roundrobin', rotation: 'auto', courts: 2, players: names(8), seed: 'fixed', ...o });
const NOW = Date.UTC(2026, 5, 1, 12);
// Scores every pending match in a round: the first team always wins 11-7.
const scoreRound = (ev, n, now = NOW) => { for (const m of ev.rounds.find(r => r.n === n).matches) if (m.status === 'pending') recordResult(ev, m.id, { score: [11, 7], live: true, endedAt: now }, now); };

test('an 8 player rotating doubles round robin on 2 courts plays out round by round', () => {
  const ev = createEvent(base(), NOW);
  assert.equal(ev.partners, 'rotating');
  assert.equal(ev.roundsPlanned, 7);
  assert.equal(ev.rounds.length, 1);
  assert.equal(ev.rounds[0].matches.length, 2);
  assert.deepEqual(ev.rounds[0].matches.map(m => m.court), [1, 2]);
  for (let n = 1; n <= 7; n++) {
    assert.equal(ev.rounds.length, n);
    if (n < 7) assert.throws(() => startNextRound(ev, NOW), /Finish the current round/);
    scoreRound(ev, n);
    assert.equal(ev.rounds[n - 1].status, 'done');
    if (n < 7) startNextRound(ev, NOW);
  }
  assert.equal(ev.status, 'done');
  assert.deepEqual(fairness(ev.players, ev.rounds.map(r => ({ matches: r.matches, byes: r.byes }))).partner, { min: 1, max: 1 });
  const table = standingsFor(ev);
  assert.equal(table.length, 8);
  assert.equal(table.reduce((s, r) => s + r.played, 0), 7 * 8);
  assert.equal(table.reduce((s, r) => s + r.wins, 0), table.reduce((s, r) => s + r.losses, 0));
  assert.ok(table.every((r, i) => i === 0 || table[i - 1].wins > r.wins || (table[i - 1].wins === r.wins && table[i - 1].diff >= r.diff)));
  assert.deepEqual(ev.champion, [table[0].id]);
});

test('recording a result: validation, retries, and refusing a different score', () => {
  const ev = createEvent(base(), NOW);
  const id = ev.rounds[0].matches[0].id;
  assert.throws(() => recordResult(ev, id, { score: [11, 11] }, NOW), /tied/);
  assert.throws(() => recordResult(ev, id, { score: [11] }, NOW), /Scores must/);
  assert.throws(() => recordResult(ev, 'zzz', { score: [11, 4] }, NOW), /not in this event/);
  const first = recordResult(ev, id, { score: [11, 4], startedAt: NOW - 600000, endedAt: NOW, rallies: 40, live: true }, NOW);
  assert.equal(first.changed, true);
  assert.equal(first.game.id, `${ev.id}-${id}`);
  assert.equal(first.game.mode, 'doubles');
  assert.equal(first.game.logged, false);
  assert.deepEqual(first.game.score, [11, 4]);
  const again = recordResult(ev, id, { score: [11, 4], live: true }, NOW);
  assert.equal(again.changed, false);
  assert.equal(again.game.id, first.game.id, 'a retry gives the same game, so it is never recorded twice');
  assert.throws(() => recordResult(ev, id, { score: [4, 11] }, NOW), /already scored/);
  const fixed = correctResult(ev, id, [4, 11], NOW);
  assert.deepEqual(fixed.game.score, [4, 11]);
  assert.equal(fixed.game.id, first.game.id);
});

test('hand-entered scores are logged, not live', () => {
  const ev = createEvent(base(), NOW);
  const r = recordResult(ev, ev.rounds[0].matches[0].id, { score: [11, 9] }, NOW);
  assert.equal(r.game.logged, true);
});

test('manual rotation: the organizer edits a suggested round, then opens it', () => {
  const ev = createEvent(base({ rotation: 'manual' }), NOW);
  assert.equal(ev.rounds[0].status, 'draft');
  assert.throws(() => recordResult(ev, ev.rounds[0].matches[0].id, { score: [11, 2] }, NOW), /not been opened/);
  setRound(ev, 1, [{ teams: [['P1', 'P2'], ['P3', 'P4']] }, { teams: [['P5', 'P6'], ['P7', 'P8']] }], NOW);
  assert.deepEqual(ev.rounds[0].matches[0].teams, [['P1', 'P2'], ['P3', 'P4']]);
  publishRound(ev, 1, NOW);
  assert.equal(ev.rounds[0].status, 'live');
  assert.throws(() => publishRound(ev, 1, NOW), /already open/);
  assert.throws(() => setRound(ev, 1, [{ teams: [['P1', 'P1'], ['P3', 'P4']] }], NOW), /more than one/);
  recordResult(ev, ev.rounds[0].matches[0].id, { score: [11, 2] }, NOW);
  assert.throws(() => setRound(ev, 1, [{ teams: [['P1', 'P3'], ['P2', 'P4']] }], NOW), /scores/);
});

test('auto and random events let the organizer override an unscored round too', () => {
  for (const rotation of ['auto', 'random']) {
    const ev = createEvent(base({ rotation }), NOW);
    assert.equal(ev.rounds[0].status, 'live');
    setRound(ev, 1, [{ teams: [['P8', 'P2'], ['P3', 'P4']] }], NOW);
    assert.equal(ev.rounds[0].matches.length, 1);
    assert.deepEqual(ev.rounds[0].byes.sort(), ['P1', 'P5', 'P6', 'P7']);
  }
});

test('more players than courts: byes rotate fairly and every round fits the courts', () => {
  const ev = createEvent(base({ players: names(11), courts: 2, rounds: 11 }), NOW);
  for (let n = 1; n <= 11; n++) { assert.equal(ev.rounds[n - 1].matches.length, 2); assert.equal(ev.rounds[n - 1].byes.length, 3); scoreRound(ev, n); if (n < 11) startNextRound(ev, NOW); }
  const f = fairness(ev.players, ev.rounds.map(r => ({ matches: r.matches, byes: r.byes })));
  assert.ok(f.byes.max - f.byes.min <= 1);
  assert.equal(ev.status, 'done');
});

test('round robin with fixed teams: every team plays every other once, split across courts', () => {
  const ev = createEvent(base({ partners: 'fixed', rotation: 'random', players: names(10), courts: 2 }), NOW);
  assert.equal(ev.teams.length, 5);
  const pairs = ev.rounds.flatMap(r => r.matches.map(m => m.teams.map(t => t.join('&')).sort().join(' v ')));
  assert.equal(pairs.length, 10); // C(5,2)
  assert.equal(new Set(pairs).size, 10);
  assert.ok(ev.rounds.every(r => r.matches.length <= 2));
  for (const r of ev.rounds) for (const m of r.matches) recordResult(ev, m.id, { score: [11, 6] }, NOW);
  assert.equal(ev.status, 'done');
  const t = standingsFor(ev);
  assert.equal(t.length, 5);
  assert.ok(t.every(r => r.played === 4));
});

test('pool play then a knockout takes the top of the table', () => {
  const ev = createEvent(base({ format: 'pool_knockout', advance: 4, rounds: 7 }), NOW);
  assert.equal(ev.advance, 4);
  assert.throws(() => startKnockout(ev, 4, NOW), /Finish pool play/);
  for (let n = 1; n <= 7; n++) { scoreRound(ev, n); if (n < 7) startNextRound(ev, NOW); }
  assert.equal(ev.status, 'live');
  assert.equal(ev.poolDone, true);
  const top = standingsFor(ev).slice(0, 8).map(r => r.id);
  startKnockout(ev, 4, NOW);
  assert.equal(ev.bracket.count, 4);
  // strongest with weakest of the 8 qualifiers: seed 1 is rank 1 with rank 8
  assert.deepEqual(ev.bracket.teams[0].slice().sort(), [top[0], top[7]].sort());
  assert.deepEqual(ev.bracket.teams[3].slice().sort(), [top[3], top[4]].sort());
  assert.throws(() => startKnockout(ev, 4, NOW), /already started/);
  for (let guard = 0; guard < 10; guard++) {
    const m = ready(ev.bracket)[0];
    if (!m) break;
    recordResult(ev, m.id, { score: [11, 8] }, NOW);
  }
  assert.equal(ev.status, 'done');
  assert.equal(ev.champion.length, 2);
  const v = view(ev);
  assert.deepEqual(v.knockout.map(r => r.title), ['Semifinals', 'Final']);
});

test('single and double elimination events with fixed teams, courts handed out as matches come up', () => {
  for (const format of ['single_elim', 'double_elim']) {
    const ev = createEvent(base({ format, players: names(12), courts: 2, rotation: 'auto', ratings: Object.fromEntries(names(12).map((p, i) => [p, 12 - i])) }), NOW);
    assert.equal(ev.teams.length, 6);
    assert.deepEqual(ev.teams[0].slice().sort(), ['P1', 'P12'].sort(), 'auto teams: strongest with weakest');
    let games = 0;
    for (let guard = 0; guard < 40 && ev.status !== 'done'; guard++) {
      const rd = ready(ev.bracket);
      assert.ok(rd.filter(m => m.court).length <= 2, 'never more matches on court than courts');
      assert.ok(rd.length === 0 || rd[0].court, 'the next match is on a court');
      recordResult(ev, rd[0].id, { score: [11, 5] }, NOW); games++;
    }
    assert.equal(ev.status, 'done');
    assert.equal(games, format === 'single_elim' ? 5 : 10);
    assert.ok(ev.champion);
  }
});

test('a bracket event refuses an out-of-turn result', () => {
  const ev = createEvent(base({ format: 'single_elim', players: names(8), courts: 1 }), NOW);
  assert.throws(() => recordResult(ev, 'W2-0', { score: [11, 5] }, NOW), /waiting for its teams/);
});

test('creation checks its input', () => {
  assert.throws(() => createEvent(base({ name: '  ' }), NOW), /name/);
  assert.throws(() => createEvent(base({ format: 'swiss' }), NOW), /format/);
  assert.throws(() => createEvent(base({ players: names(3) }), NOW), /at least 4/);
  assert.throws(() => createEvent(base({ players: names(33) }), NOW), /at most 32/);
  assert.throws(() => createEvent(base({ partners: 'fixed', players: names(7) }), NOW), /even number/);
  assert.throws(() => createEvent(base({ format: 'double_elim', players: names(4) }), NOW), /at least 3 teams/);
  assert.throws(() => createEvent(base({ format: 'pool_knockout', players: names(6) }), NOW), /at least 8 players/);
  const dup = createEvent(base({ players: ['Ana', 'ana', ' Ben ', 'Cy', 'Di', 'Ed'] }), NOW);
  assert.deepEqual(dup.players, ['Ana', 'Ben', 'Cy', 'Di', 'Ed']);
  assert.equal(createEvent(base({ courts: 99 }), NOW).courts, 8);
});

test('ending an event early keeps the standings', () => {
  const ev = createEvent(base(), NOW);
  scoreRound(ev, 1);
  endEvent(ev, NOW);
  assert.equal(ev.status, 'done');
  assert.equal(ev.champion.length, 1);
  assert.throws(() => recordResult(ev, 'r1m1', { score: [3, 11] }, NOW), /already scored/);
  assert.throws(() => startNextRound(ev, NOW), /finished/);
});

test('view() spells out matches and carries the table, without mutating the event', () => {
  const ev = createEvent(base({ format: 'pool_knockout', rounds: 7 }), NOW), snap = JSON.stringify(ev);
  const v = view(ev);
  assert.equal(JSON.stringify(ev), snap);
  assert.equal(v.standings.length, 8);
  assert.ok(v.rounds[0].matches.every(m => m.ready && m.teams.every(t => t.length === 2)));
});

test('schedule helpers: teams, circle method and standings', () => {
  const p = names(8);
  assert.deepEqual(pairTeams(p, { how: 'manual', teams: [['P1', 'P2'], ['p3', 'P4'], ['P5', 'P6'], ['P7', 'P8']] }).map(t => t.join('')), ['P1P2', 'P3P4', 'P5P6', 'P7P8']);
  assert.throws(() => pairTeams(p, { how: 'manual', teams: [['P1', 'P2']] }), /every player/);
  assert.throws(() => pairTeams(p, { how: 'manual', teams: [['P1', 'P2'], ['P2', 'P3'], ['P4', 'P5'], ['P6', 'P7']] }), /more than one team/);
  assert.deepEqual(pairTeams(p, { how: 'random', seed: 1 }), pairTeams(p, { how: 'random', seed: 1 }));
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) {
    const plan = roundRobin(n, 2).flat();
    assert.equal(plan.length, n * (n - 1) / 2);
    assert.equal(new Set(plan.map(([a, b]) => Math.min(a, b) + '-' + Math.max(a, b))).size, plan.length);
  }
  const t = standings(['A', 'B', 'C', 'D'], [{ teams: [['A', 'B'], ['C', 'D']], score: [11, 5] }, { teams: [['A', 'C'], ['B', 'D']], score: [9, 11] }]);
  assert.deepEqual(t.map(r => [r.id, r.wins, r.diff]), [['B', 2, 8], ['A', 1, 4], ['D', 1, -4], ['C', 0, -8]]);
});
