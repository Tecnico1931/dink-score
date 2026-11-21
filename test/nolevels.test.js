import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as m from '../api/_progress.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('levels, XP and prestige are gone from the progress module and the players API', () => {
  for (const k of ['XP', 'LEVEL_MAX', 'levelNeed', 'levelFrom', 'computeXP']) assert.ok(!(k in m), k);
  assert.ok(!/prestige/i.test(read('api/players.js')) && !/prestige|levels/i.test(read('api/club.js')));
  for (const f of ['dink-score.html', 'index.html']) assert.ok(!/\bXP\b|prestige|levelFrom|LEVEL_MAX/i.test(read(f)), f + ' still has level or XP code');
});

test('achievements, weekly challenges and seasons still compute', () => {
  const g = (i, score, winner) => ({ id: 'g' + i, mode: 'doubles', teams: [['Ana', 'Ben'], ['Cy', 'Di']], score, winner, endedAt: Date.UTC(2026, 0, 5, 10, i), receivedAt: Date.UTC(2026, 0, 5, 10, i), scoredBy: 'a' });
  const games = [g(1, [11, 0], 0), g(2, [11, 5], 0)];
  const p = m.computeProgress(games, Date.UTC(2026, 6, 1));
  const ana = p.get('ana');
  assert.deepEqual(Object.keys(ana).sort(), ['achievements', 'name', 'streak', 'trophies', 'weeks']);
  assert.ok(['first-win', 'shutout'].every(id => ana.achievements.some(a => a.id === id)));
  const wk = m.weekOf(Date.UTC(2026, 0, 5, 10)).id;
  assert.equal(ana.weeks[wk].length, 3);
  assert.equal(m.challengesFor(wk).length, 3);
  assert.equal(m.seasonOf(Date.UTC(2026, 0, 5)).id, '2026-Q1');
  assert.ok(m.seasonStandings(games, m.seasonOf(Date.UTC(2026, 0, 5)), 'doubles') instanceof Array);
});
