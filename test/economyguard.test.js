import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as m from '../api/_progress.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// Economy, XP, level, prestige and shop code (see the Rewards rules in DESIGN.md) may live only here.
const ALLOWED = [/^src\/app\/economy[^/]*\.js$/, /^api\/_economy[^/]*\.js$/, /^api\/_progress\.js$/];
// Scoring, rating and club-code paths: never any of it.
const CORE = ['pb-engine.js', 'rating-engine.js', 'api/_pb.js', 'api/_rating.js', 'api/_rating_store.js', 'api/_gamesave.js',
  'api/_rallylog.js', 'api/_rotation.js', 'api/_confirm.js', 'api/_clublinks.js', 'api/club.js', 'api/games.js'];
// The currency is "Dinks"; Dink Rating, Dink Score, dink-score and a "nice dink" are the product and the game.
const TERMS = /\bdinks\b|\bwallet\b|\beconomy\b|\bprestige\b|\bxp\b|\blevelFrom\b|\bLEVEL_MAX\b|\bshop\b|\binventory\b|\bcosmetics?\b/i;
// Only comments and unused columns of the removed shop (#60, #65): _db.js keeps them (additive, never dropped), _rename.js's header still names it.
const LEGACY = new Set(['api/_db.js', 'api/_rename.js']);

const sources = () => {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    const f = d ? d + '/' + e.name : e.name;
    if (e.isDirectory()) walk(f); else if (/\.js$/.test(e.name)) out.push(f);
  } };
  walk('api'); walk('src/app');
  for (const e of fs.readdirSync(root)) if (/\.(js|cjs|mjs|html)$/.test(e) && e !== 'index.html' && e !== 'b.html' && e !== 'r.html') out.push(e);
  return out;
};

test('economy, XP, level, prestige and shop code exist only in the dedicated modules', () => {
  const files = sources();
  assert.ok(files.includes('dink-score.html') && files.includes('api/club.js'), 'the walk finds the page and the API');
  for (const f of files) {
    if (ALLOWED.some(r => r.test(f)) || LEGACY.has(f)) continue;
    const hit = read(f).match(TERMS);
    assert.ok(!hit, `${f} has economy code ("${hit && hit[0]}"); it belongs in src/app/economy*.js, api/_economy*.js or api/_progress.js`);
  }
});

test('scoring, rating and club-code paths never touch the economy', () => {
  for (const f of CORE) {
    assert.ok(fs.existsSync(path.join(root, f)), f + ' is a core path that should exist');
    assert.ok(!TERMS.test(read(f)), f + ' mentions the economy');
    assert.ok(!/require\(['"][^'"]*economy|from ['"][^'"]*economy/.test(read(f)), f + ' imports economy code');
  }
});

test('rewards are off by default per club: the rule and the switch', () => {
  assert.match(read('api/_db.js'), /ADD COLUMN IF NOT EXISTS rewards boolean NOT NULL DEFAULT false/, 'a club has the switch off until an organizer sets it');
  assert.match(read('api/_db.js'), /rewards: !!c\.rewards/);
  assert.match(read('src/app/economy.js'), /const rwShown = \(\) => rwClubOn\(\) && !rwHidden\(\)/, 'nothing draws unless the club switch is on and the device switch is not');
  const sec = read('DESIGN.md').match(/### Rewards\n([\s\S]*?)\n## /);
  assert.ok(sec, 'DESIGN.md has a Rewards section');
  const rules = sec[1];
  assert.match(rules, /\*\*Off by default, per club\.\*\*/);
  for (const r of [/no cash value and no purchase path/, /odds/i, /prefers-reduced-motion/, /Sound is off until/, /One tap hides it all/, /never change a rating/])
    assert.match(rules, r);
  assert.ok(!/casino or gacha/.test(read('DESIGN.md')), 'the old casino rule is replaced');
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
