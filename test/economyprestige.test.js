import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL_XP } from '../api/_economyxp.js';
import { PRESTIGE_DINKS, RUN_XP, prestigeId, prestigeCount, runLevel, planPrestige, levelsFrom } from '../api/_economyprestige.js';
import { buildPassView, PASS_TIERS } from '../api/_economypass.js';
import { validEntry } from '../api/_economy.js';
import { describe } from '../api/_economyactivity.js';

const TOP = LEVEL_XP[24];
const row = (n, id = prestigeId(n)) => ({ id, kind: 'earn', amount: PRESTIGE_DINKS, reason: 'prestige', day: null, streak: null });

test('prestige: only at level 25, +250 Dinks, one idempotent ledger id per run', () => {
  assert.equal(PRESTIGE_DINKS, 250);
  assert.equal(RUN_XP, TOP);
  assert.throws(() => planPrestige({ allXp: TOP - 1 }), e => e.status === 409);
  const p = planPrestige({ allXp: TOP });
  assert.deepEqual(p.entry, row(1));
  assert.ok(validEntry(p.entry));
  assert.equal(p.count, 1);
});

test('prestige: the next run needs the whole curve again; XP past level 25 carries over', () => {
  assert.throws(() => planPrestige({ allXp: TOP + 100, ledger: [row(1)] }), e => e.status === 409, 'level 1 again');
  const second = planPrestige({ allXp: 2 * TOP + 7, ledger: [row(1)] });
  assert.equal(second.entry.id, 'prestige:2');
  assert.equal(runLevel(TOP + 45, 1).level, 2, '45 XP carried over passes the first 40');
  assert.equal(runLevel(TOP + 45, 1).xp, TOP + 45, 'all-time XP for the label');
  assert.equal(runLevel(TOP, 1).level, 1);
  assert.equal(runLevel(10, 0).level, 1);
  assert.equal(runLevel(TOP, 0).level, 25);
});

test('prestige: the count is the ledger rows, including one a merge moved; spends and look-alikes do not count', () => {
  assert.equal(prestigeCount([row(1), row(2, 'm:ana:prestige:1')]), 2);
  assert.equal(prestigeCount([{ id: 'prestige:1', kind: 'spend', amount: -5 }, { id: 'xpass:q4:1', kind: 'earn' }, { id: 'noprestige:1', kind: 'earn' }]), 0);
  assert.equal(prestigeCount(null), 0);
});

test('prestige: the pass view carries the count and when it is ready; season XP is untouched', () => {
  const season = { id: 'q4', name: 'Q4', start: 0, end: 1 };
  const v = buildPassView({ season, xp: 130, allXp: TOP, ledger: [], items: [] });
  assert.deepEqual(v.prestige, { count: 0, dinks: 250, ready: true });
  assert.equal(v.level.level, 25);
  const after = buildPassView({ season, xp: 130, allXp: TOP + 10, ledger: [row(1)], items: [] });
  assert.deepEqual(after.prestige, { count: 1, dinks: 250, ready: false });
  assert.equal(after.level.level, 1);
  assert.equal(after.xp, 130);
  assert.equal(after.tiers.length, PASS_TIERS.length);
});

test('prestige: the ledger row reads in plain words; club levels come only from the keys asked for', () => {
  assert.match(describe({ kind: 'earn', reason: 'prestige' }), /Prestige/);
  const t = 1e12, g = by => ({ teams: [[by, 'zed'], ['x', 'y']], r: t, winner: 0, scored_by: by, scored_by_player: null });
  const out = levelsFrom([g('ana'), g('ana'), g('cy')], { ana: 2 }, ['ana']);
  assert.deepEqual(Object.keys(out), ['ana'], 'only the asked-for key');
  assert.deepEqual(out.ana, { level: 1, prestige: 2 });
});
