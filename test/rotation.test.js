import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRound, validateRound, fairness, tally, makeRng, shuffle, matchesPerRound } from '../api/_rotation.js';

const names = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
const play = (players, courts, rounds, { mode = 'auto', seed = 'seed', history = [] } = {}) => {
  const h = history.slice();
  for (let r = 0; r < rounds; r++) h.push(planRound({ players, courts, history: h, mode, seed }));
  return h;
};
const everyoneOnce = (players, round) => {
  const seen = round.matches.flatMap(m => m.teams.flat()).concat(round.byes);
  assert.deepEqual(seen.slice().sort(), players.slice().sort(), 'every player is playing or sitting out, exactly once');
};

test('the same seed gives the same rounds, a different seed a different one', () => {
  const p = names(10);
  assert.deepEqual(play(p, 2, 6, { seed: 'a' }), play(p, 2, 6, { seed: 'a' }));
  assert.notDeepEqual(play(p, 2, 6, { seed: 'a' }), play(p, 2, 6, { seed: 'b' }));
  assert.deepEqual(play(p, 2, 6, { mode: 'random', seed: 'a' }), play(p, 2, 6, { mode: 'random', seed: 'a' }));
});

test('every round is well formed for 4 to 16 players on 1 to 4 courts, in both modes', () => {
  for (let n = 4; n <= 16; n++) for (const courts of [1, 2, 3, 4]) for (const mode of ['auto', 'random']) {
    const p = names(n);
    const h = play(p, courts, 4, { mode });
    for (const r of h) {
      everyoneOnce(p, r);
      assert.equal(r.matches.length, matchesPerRound(n, courts));
      assert.ok(r.matches.length <= courts);
      assert.deepEqual(r.matches.map(m => m.court), r.matches.map((_, i) => i + 1));
      assert.equal(r.byes.length, n - 4 * r.matches.length);
    }
  }
});

test('byes are shared: nobody has more than one bye more than anyone else, at every point', () => {
  for (let n = 4; n <= 16; n++) for (const courts of [1, 2, 3]) for (const mode of ['auto', 'random']) {
    const p = names(n), h = [];
    for (let r = 0; r < 14; r++) {
      h.push(planRound({ players: p, courts, history: h, mode, seed: 's' + n }));
      const f = fairness(p, h);
      assert.ok(f.byes.max - f.byes.min <= 1, `n=${n} courts=${courts} ${mode} round ${r + 1}: byes ${JSON.stringify(f.byes)}`);
    }
  }
});

test('nobody sits out two rounds running while someone else has not sat out yet, for 5 to 7 players', () => {
  for (const n of [5, 6, 7]) {
    const p = names(n), h = play(p, 1, 12);
    for (let r = 1; r < h.length; r++) {
      for (const who of h[r].byes) if (h[r - 1].byes.includes(who)) {
        const hist = h.slice(0, r);
        assert.ok(false, `n=${n}: ${who} sat out rounds ${r} and ${r + 1} (${hist.length} before)`);
      }
    }
  }
});

test('when everyone plays, nobody partners twice until everyone has partnered everyone', () => {
  for (const n of [4, 8, 12, 16]) for (const seed of ['a', 'b', 'c']) {
    const p = names(n), h = play(p, n / 4, n - 1, { seed });
    const f = fairness(p, h);
    assert.equal(f.partner.min, 1, `n=${n}: some pair never partnered`);
    assert.equal(f.partner.max, 1, `n=${n}: some pair partnered twice in one cycle`);
    // and the next cycle starts fresh: after 2 cycles everyone has partnered everyone twice
    const f2 = fairness(p, play(p, n / 4, n - 1, { seed, history: h }));
    assert.deepEqual(f2.partner, { min: 2, max: 2 });
  }
});

test('8 players on 2 courts: in 7 rounds every pair partners once and faces each other twice', () => {
  for (const seed of ['a', 'b', 'c', 'd', 'e']) {
    const p = names(8), f = fairness(p, play(p, 2, 7, { seed }));
    assert.deepEqual(f.partner, { min: 1, max: 1 });
    assert.deepEqual(f.opponent, { min: 2, max: 2 });
  }
});

test('with byes, partners are not repeated early (first quarter of the rounds that would cover every pair)', () => {
  for (let n = 5; n <= 16; n++) for (const courts of [1, 2, 3, 4]) {
    const per = 2 * matchesPerRound(n, courts);
    if (per * 2 === n) continue; // everyone plays: covered above
    const cover = Math.ceil((n * (n - 1) / 2) / per), safe = Math.floor(cover / 4);
    const p = names(n);
    for (const seed of ['a', 'b', 'c']) {
      const f = fairness(p, play(p, courts, safe, { seed }));
      assert.ok(f.partner.max <= 1, `n=${n} courts=${courts} seed=${seed}: a pair partnered twice within ${safe} rounds`);
    }
  }
});

test('opponents stay spread: no pair faces another more than twice the fair share plus one, in the first half of a cycle', () => {
  for (let n = 5; n <= 16; n++) for (const courts of [1, 2, 4]) {
    const per = matchesPerRound(n, courts) * 4, p = names(n);
    const rounds = Math.max(1, Math.floor((n * (n - 1) / 2) / (per / 2) / 2));
    const f = fairness(p, play(p, courts, rounds));
    const fair = Math.ceil(rounds * per / (n * (n - 1) / 2));
    assert.ok(f.opponent.max <= 2 * fair + 1, `n=${n} courts=${courts}: opponent max ${f.opponent.max} after ${rounds} rounds (fair ${fair})`);
  }
});

test('random draws mix partners without crashing and still share byes', () => {
  const p = names(9), h = play(p, 2, 10, { mode: 'random', seed: 'r' });
  for (const r of h) everyoneOnce(p, r);
  assert.ok(fairness(p, h).partner.max <= 4);
});

test('a hand-edited round is taken into account by the next one', () => {
  const p = names(8), h = play(p, 2, 2);
  // the organizer repeats round 1 exactly as round 3
  h.push({ matches: h[0].matches, byes: [] });
  const next = planRound({ players: p, courts: 2, history: h, seed: 'seed' });
  everyoneOnce(p, next);
  const t = tally(p, h);
  for (const m of next.matches) for (const team of m.teams) {
    assert.equal(t.partner.get(team[0] < team[1] ? team[0] + '\u0000' + team[1] : team[1] + '\u0000' + team[0]) || 0, 0, 'avoids partnerships that have already happened');
  }
});

test('planRound needs 4 players', () => {
  assert.throws(() => planRound({ players: names(3), courts: 1 }), /at least 4/);
});

test('validateRound accepts good picks and fills in the byes', () => {
  const p = names(6);
  const r = validateRound({ players: p, courts: 2, matches: [{ teams: [['p1', 'P2'], ['P3', 'P4']] }] });
  assert.deepEqual(r.matches[0].teams, [['P1', 'P2'], ['P3', 'P4']]);
  assert.deepEqual(r.byes, ['P5', 'P6']);
});

test('validateRound refuses bad picks with a plain message', () => {
  const p = names(8), ok = [['P1', 'P2'], ['P3', 'P4']];
  assert.throws(() => validateRound({ players: p, courts: 1, matches: [{ teams: ok }, { teams: [['P5', 'P6'], ['P7', 'P8']] }] }), /1 court/);
  assert.throws(() => validateRound({ players: p, courts: 2, matches: [{ teams: ok }, { teams: [['P4', 'P6'], ['P7', 'P8']] }] }), /P4 is in more than one/);
  assert.throws(() => validateRound({ players: p, courts: 2, matches: [{ teams: [['P1', 'Zed'], ['P3', 'P4']] }] }), /Zed is not in this event/);
  assert.throws(() => validateRound({ players: p, courts: 2, matches: [{ teams: [['P1'], ['P3', 'P4']] }] }), /two players/);
  assert.throws(() => validateRound({ players: p, courts: 2, matches: [] }), /at least one match/);
});

test('the seeded generator is repeatable and shuffle keeps every item', () => {
  assert.equal(makeRng('x')(), makeRng('x')());
  assert.notEqual(makeRng('x')(), makeRng('y')());
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], makeRng('z')).sort(), [1, 2, 3, 4, 5]);
});
