import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, advance, correct, champion, ready, assignCourts, rounds, seedOrder, isReady } from '../api/_bracket.js';
import { makeRng } from '../api/_rotation.js';

// Plays a bracket to the end. 'pick' decides who wins a ready match: (match) => 0 | 1. Returns the final bracket and the games played.
function playOut(b, pick) {
  const played = [];
  for (let guard = 0; guard < 500; guard++) {
    const m = ready(b)[0];
    if (!m) break;
    const w = pick(m);
    played.push({ id: m.id, teams: m.slots.slice(), winner: m.slots[w] });
    b = advance(b, m.id, w === 0 ? [11, 5] : [5, 11]);
  }
  return { b, played };
}
const topSeedWins = m => (m.slots[0] < m.slots[1] ? 0 : 1);

test('seed order puts 1 and 2 at opposite ends and keeps pairs summing to size + 1', () => {
  assert.deepEqual(seedOrder(2), [1, 2]);
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const o = seedOrder(16);
  for (let i = 0; i < 16; i += 2) assert.equal(o[i] + o[i + 1], 17);
});

test('single elimination: 2 to 32 teams, a champion, and teams - 1 games', () => {
  for (let n = 2; n <= 32; n++) {
    const { b, played } = playOut(build(n), topSeedWins);
    assert.equal(played.length, n - 1, `${n} teams`);
    assert.equal(champion(b), 0, 'the top seed wins when seeds always win');
    const losses = new Map();
    for (const g of played) for (const t of g.teams) if (t !== g.winner) losses.set(t, (losses.get(t) || 0) + 1);
    assert.ok([...losses.values()].every(c => c === 1), 'nobody loses twice');
    assert.equal(losses.size, n - 1);
  }
});

test('single elimination byes go to the top seeds and never to two teams in one match', () => {
  const b = build(11); // size 16, 5 byes: seeds 1 to 5
  const first = b.matches.filter(m => m.round === 1);
  assert.equal(first.length, 8);
  const byeTeams = first.filter(m => m.status === 'bye').map(m => Math.max(...m.slots));
  assert.deepEqual(byeTeams.sort((a, c) => a - c), [0, 1, 2, 3, 4]);
  assert.ok(first.every(m => !(m.slots[0] === -1 && m.slots[1] === -1)));
  // byes are already moved on into round 2
  assert.ok(b.matches.filter(m => m.round === 2).some(m => m.slots.some(s => s >= 0)));
});

test('top seeds only meet late: 1 and 2 can only meet in the final', () => {
  for (const n of [4, 8, 13, 16, 24]) {
    const { played } = playOut(build(n), topSeedWins);
    const met = played.find(g => g.teams.includes(0) && g.teams.includes(1));
    assert.equal(met.id, `W${Math.log2(n <= 2 ? 2 : 2 ** Math.ceil(Math.log2(n)))}-0`);
  }
});

test('upsets move the right team on', () => {
  const { b } = playOut(build(8), m => (m.slots[0] > m.slots[1] ? 0 : 1)); // the lower seed always wins
  assert.equal(champion(b), 7);
});

test('double elimination: every team is knocked out only after two losses, and there is one champion', () => {
  const rand = makeRng('de');
  for (let n = 3; n <= 20; n++) {
    for (let trial = 0; trial < 6; trial++) {
      const { b, played } = playOut(build(n, 'double'), () => (rand() < 0.5 ? 0 : 1));
      const c = champion(b);
      assert.ok(c !== null, `${n} teams: no champion`);
      const losses = new Map();
      for (const g of played) for (const t of g.teams) if (t !== g.winner) losses.set(t, (losses.get(t) || 0) + 1);
      for (const [t, l] of losses) assert.ok(l <= 2, `${n} teams: team ${t} lost ${l} times`);
      for (let t = 0; t < n; t++) if (t !== c) assert.equal(losses.get(t), 2, `${n} teams: team ${t} should be out after two losses (champion ${c})`);
      assert.ok((losses.get(c) || 0) <= 1);
      // 2(n - 1) games, plus one if the reset was needed, minus nothing for byes (byes aren't games)
      assert.ok(played.length === 2 * (n - 1) + (losses.get(c) ? 1 : 0), `${n} teams: ${played.length} games`);
    }
  }
});

test('double elimination: the winners bracket champion wins the grand final without a reset', () => {
  const { b, played } = playOut(build(8, 'double'), topSeedWins);
  assert.equal(champion(b), 0);
  assert.ok(!played.some(g => g.id === 'F2'));
  assert.equal(b.matches.find(m => m.id === 'F2').status, 'skipped');
  assert.equal(played.length, 2 * 7); // 14 games, no reset
});

test('double elimination: a losers bracket champion forces a reset match', () => {
  // the top seed wins every game until the grand final, where the other finalist wins
  let b = build(4, 'double'), played = [];
  for (let guard = 0; guard < 50; guard++) {
    const m = ready(b)[0];
    if (!m) break;
    let w = topSeedWins(m);
    if (m.id === 'F1') w = 1;
    played.push(m.id);
    b = advance(b, m.id, w === 0 ? [11, 3] : [3, 11]);
  }
  assert.ok(played.includes('F1') && played.includes('F2'));
  assert.notEqual(champion(b), null);
});

test('matches only become ready once both teams are known, and nothing is played twice', () => {
  let b = build(4);
  assert.deepEqual(ready(b).map(m => m.id), ['W1-0', 'W1-1']);
  assert.throws(() => advance(b, 'W2-0', [11, 4]), /waiting for its teams/);
  b = advance(b, 'W1-0', [11, 4]);
  assert.throws(() => advance(b, 'W1-0', [11, 4]), /already been played/);
  assert.throws(() => advance(b, 'W1-1', [11, 11]), /tied/);
  assert.throws(() => advance(b, 'nope', [11, 4]), /not in this bracket/);
  assert.ok(isReady(b.matches.find(m => m.id === 'W1-1')));
});

test('input brackets are never changed', () => {
  const b = build(8), snap = JSON.stringify(b);
  advance(b, 'W1-0', [11, 2]); assignCourts(b, 2);
  assert.equal(JSON.stringify(b), snap);
});

test('courts: ready matches take free courts in order and the rest wait', () => {
  let b = assignCourts(build(8), 2);
  assert.deepEqual(ready(b).map(m => m.court), [1, 2, null, null]);
  b = advance(b, 'W1-1', [11, 6]); // the match on court 2 finishes
  b = assignCourts(b, 2);
  const onCourt = ready(b).filter(m => m.court);
  assert.equal(onCourt.length, 2);
  assert.deepEqual(onCourt.map(m => m.court).sort(), [1, 2]);
  assert.equal(ready(b).find(m => m.id === 'W1-0').court, 1, 'a match keeps its court');
});

test('correcting a score: same winner is always fine, a new winner only before later games', () => {
  let b = build(4);
  b = advance(b, 'W1-0', [11, 4]);
  b = correct(b, 'W1-0', [11, 9]);
  assert.deepEqual(b.matches.find(m => m.id === 'W1-0').score, [11, 9]);
  // swap the winner while the next round hasn't been played: the team moves
  const before = b.matches.find(m => m.id === 'W2-0').slots[0];
  b = correct(b, 'W1-0', [4, 11]);
  assert.notEqual(b.matches.find(m => m.id === 'W2-0').slots[0], before);
  // play it on, then try to change a result it fed
  b = advance(b, 'W1-1', [11, 0]);
  b = advance(b, 'W2-0', [11, 3]);
  assert.throws(() => correct(b, 'W1-0', [11, 4]), /Later matches have been played/);
  assert.doesNotThrow(() => correct(b, 'W1-0', [4, 12]));
});

test('round titles read naturally', () => {
  assert.deepEqual(rounds(build(8)).map(r => r.title), ['Quarterfinals', 'Semifinals', 'Final']);
  assert.deepEqual(rounds(build(16)).map(r => r.title), ['Round 1', 'Quarterfinals', 'Semifinals', 'Final']);
  const de = rounds(build(4, 'double')).map(r => r.title);
  assert.deepEqual(de, ['Winners round 1', 'Winners final', 'Losers round 1', 'Losers final', 'Grand final', 'Grand final reset']);
  assert.deepEqual(rounds(build(3)).map(r => r.title), ['Semifinals', 'Final']);
});

test('bad sizes are refused', () => {
  assert.throws(() => build(1), /at least 2/);
  assert.throws(() => build(2, 'double'), /at least 3/);
  assert.throws(() => build(33), /at most 32/);
});
