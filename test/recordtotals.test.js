// UX-22: Record never shows "0 Rallies scored" and "0 Minutes" for a club that only logs results from other courts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const a = html.indexOf('function historyView()');
const fn = html.slice(a, html.indexOf('function leaderStats', a));

test('live-scored games keep Games, Rallies scored and Minutes', () => {
  assert.match(fn, /totalRallies > 0\n\s*\? stat\(games\.length, 'Games'\) \+ stat\(totalRallies, 'Rallies scored'\) \+ stat\(totalMin, 'Minutes'\)/);
});

test('with no rallies the totals are Games, Players and Points, like This month', () => {
  assert.match(fn, /: stat\(games\.length, 'Games'\) \+ stat\([^\n]*'Players'\) \+ stat\([^\n]*'Points'\)/);
  assert.match(fn, /filter\(n => !isDefaultName\(n\)\)/, 'default names are not players');
  assert.match(html, /<div class="month-stats"><div><b>\$\{mine\.length\}<\/b><span>Games<\/span><\/div><div><b>\$\{list\.length\}<\/b><span>Players<\/span><\/div><div><b>\$\{points\}<\/b><span>Points<\/span>/, 'same labels as This month');
});
