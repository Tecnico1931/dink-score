import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, checkLog, parseLog, encode, MAX_LOG } from '../api/_rallylog.js';
import { section, iife } from './helpers/app.js';

// The client's scoring engine and move helpers, pulled out of dink-score.html so the server's copy is held to the same results.
const { PB, Scoring } = new Function(iife('PB') + section('SCORING') + '\nreturn { PB, Scoring };')();

// A small deterministic random generator, so a failure can be replayed.
const rng = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const cfgs = [];
for (const mode of ['doubles', 'singles']) for (const scoring of ['sideout', 'rally']) for (const target of [11, 15, 21]) for (const winBy of [1, 2]) for (const first of [0, 1])
  cfgs.push({ mode, scoring, target, winBy, first, teams: mode === 'doubles' ? [['A', 'B'], ['C', 'D']] : [['A'], ['C']] });

// Plays a whole game with PB through Scoring; returns the live game.
function playOut(cfg, rand, bias) {
  const live = { state: PB.newGame(cfg), stack: [], log: [] };
  while (live.state.winner === null) Scoring.rally(live, rand() < bias ? 0 : 1);
  return live;
}
const gameOf = (live, extra = {}) => { const s = live.state, c = s.cfg; return { mode: c.mode, scoring: c.scoring, target: c.target, winBy: c.winBy, score: s.score, winner: s.winner, rallies: s.rallies, logged: false, ...extra }; };

test('the server replay matches PB at every rally: score, who serves, server number, winner', () => {
  const rand = rng(7);
  for (const cfg of cfgs) for (const bias of [0.5, 0.65, 0.9]) {
    const live = playOut(cfg, rand, bias);
    const wins = live.log;
    const mine = replay(cfg, cfg.first, wins);
    let s = PB.newGame(cfg);
    assert.deepEqual([mine[0].score, mine[0].serving, mine[0].serverNum], [s.score, s.serving, s.serverNum]);
    wins.forEach((w, k) => {
      s = PB.rally(s, w);
      assert.deepEqual([mine[k + 1].score, mine[k + 1].serving, mine[k + 1].serverNum, mine[k + 1].winner], [s.score, s.serving, s.serverNum, s.winner], `${JSON.stringify(cfg)} rally ${k + 1}`);
    });
  }
});

test('a live game saves a log that replays to its own score (side-out and rally, singles and doubles, win by 1 and 2)', () => {
  const rand = rng(11);
  let longest = 0;
  for (const cfg of cfgs) for (let i = 0; i < 6; i++) {
    const live = playOut(cfg, rand, 0.5 + 0.08 * i);
    const raw = Scoring.logOf(live);
    assert.equal(raw, encode(cfg.first, live.log));
    assert.equal(checkLog(gameOf(live), raw), raw, JSON.stringify(cfg));
    longest = Math.max(longest, live.log.length);
  }
  assert.ok(longest > 21, 'some games went past the target (win by 2)');
});

test('undo takes the rally out of the log, and out of the score with it', () => {
  const live = { state: PB.newGame({ mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, first: 1, teams: [['A', 'B'], ['C', 'D']] }), stack: [], log: [] };
  Scoring.rally(live, 1); Scoring.rally(live, 1); Scoring.rally(live, 0);
  assert.equal(Scoring.logOf(live), '1:110');
  Scoring.undo(live);
  assert.equal(Scoring.logOf(live), '1:11');
  assert.deepEqual(live.state.score, [0, 2]);
  Scoring.undo(live); Scoring.undo(live);
  assert.equal(Scoring.logOf(live), '1:');
  assert.equal(live.stack.length, 0);
  Scoring.rally(live, 0);
  assert.equal(Scoring.logOf(live), '1:0');
});

test('a game restored from before logs existed saves without one, and a fresh one starts an empty log', () => {
  const cfg = cfgs[0];
  const old = { state: PB.rally(PB.newGame(cfg), 0), stack: [] };
  Scoring.restore(old);
  assert.equal(old.log, null);
  Scoring.rally(old, 1); Scoring.undo(old); // taps and undo still work without a log
  assert.equal(Scoring.logOf(old), null);
  const fresh = { state: PB.newGame(cfg), stack: [] };
  Scoring.restore(fresh);
  assert.deepEqual(fresh.log, []);
  const kept = { state: PB.rally(PB.newGame(cfg), 0), stack: [], log: [0] };
  Scoring.restore(kept);
  assert.deepEqual(kept.log, [0]);
});

test('the server refuses a log that is tampered with, too long, or for a different result', () => {
  const rand = rng(3);
  const live = playOut(cfgs[0], rand, 0.7);
  const g = gameOf(live), raw = Scoring.logOf(live);
  assert.equal(checkLog(g, raw), raw);
  const flipped = raw.slice(0, 2) + (raw[2] === '0' ? '1' : '0') + raw.slice(3);
  assert.equal(checkLog(g, flipped), null, 'one rally changed');
  assert.equal(checkLog(g, raw + '0'), null, 'a rally after the game was over');
  assert.equal(checkLog(g, raw.slice(0, -1)), null, 'missing the last rally');
  assert.equal(checkLog({ ...g, score: [g.score[1], g.score[0]], winner: 1 - g.winner }, raw), null, 'for the other result');
  assert.equal(checkLog({ ...g, rallies: g.rallies + 1 }, raw), null, 'rally count disagrees');
  assert.equal(checkLog({ ...g, logged: true }, raw), null, 'a hand-logged result has no rallies');
  assert.equal(checkLog({ ...g, scoring: 'rally' }, raw), null, 'different scoring rules');
  for (const bad of [null, undefined, 5, '', ':', '0:', '2:01', '0:012', '0:0 1', '00:01', ['0'], { a: 1 }, '0:' + '01'.repeat(MAX_LOG)]) assert.equal(checkLog(g, bad), null, String(bad));
  assert.equal(parseLog('0:' + '0'.repeat(MAX_LOG + 1)), null);
});
