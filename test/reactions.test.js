// Reactions on finished games (L12): allow-list, grouping, client/server parity, and public allow-list isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  REACTIONS, REACTION_KEYS, MAX_REACTIONS_PER_MEMBER_PER_GAME, MAX_REACTIONS_PER_GAME,
  cleanReaction, summarizeReactions, groupReactions
} from '../api/_reactions.js';
import { gameView, sessionView } from '../api/_result.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('cleanReaction allows only the fixed reaction keys and normalizes case/spaces', () => {
  assert.equal(REACTION_KEYS.length, 5);
  for (const k of REACTION_KEYS) {
    assert.equal(cleanReaction(k), k);
    assert.equal(cleanReaction('  ' + k.toUpperCase() + '  '), k);
  }
  for (const bad of ['', null, undefined, '🔥', 'heart', 'like', 'clap!', 123, {}]) {
    assert.throws(() => cleanReaction(bad), err => err.status === 400);
  }
});

test('summarizeReactions keeps canonical order, drops unknown keys and empty buckets', () => {
  const s = summarizeReactions([
    { reaction: 'trophy', name: 'Cy' },
    { reaction: 'fire', name: 'Ana' },
    { reaction: 'bogus', name: 'Mallory' },
    { reaction: 'fire', name: 'Ben' },
    { reaction: 'clap', name: '' },
    null
  ]);
  assert.deepEqual(Object.keys(s), ['fire', 'trophy']);
  assert.deepEqual(s, { fire: ['Ana', 'Ben'], trophy: ['Cy'] });
  assert.deepEqual(summarizeReactions([]), {});
});

test('groupReactions maps each game id to its summary and omits empty games', () => {
  const m = groupReactions([
    { game_id: 'g2', reaction: 'pickle', name: 'Di' },
    { game_id: 'g1', reaction: 'fire', name: 'Ana' },
    { game_id: 'g1', reaction: 'clap', name: 'Ben' },
    { game_id: 'g3', reaction: 'invalid', name: 'Eve' }
  ]);
  assert.deepEqual([...m.keys()].sort(), ['g1', 'g2']);
  assert.deepEqual(m.get('g1'), { clap: ['Ben'], fire: ['Ana'] });
  assert.deepEqual(m.get('g2'), { pickle: ['Di'] });
  assert.equal(m.has('g3'), false);
});

test('caps are positive and sensible', () => {
  assert.ok(MAX_REACTIONS_PER_MEMBER_PER_GAME >= 1 && MAX_REACTIONS_PER_MEMBER_PER_GAME <= REACTION_KEYS.length);
  assert.ok(MAX_REACTIONS_PER_GAME >= 20 && MAX_REACTIONS_PER_GAME <= 200);
});

test('client reactions list matches the server allow-list exactly', () => {
  const src = readFileSync(path.join(root, 'src', 'app', 'reactions.js'), 'utf8');
  const m = src.match(/const GAME_REACTIONS = (\[[\s\S]*?\]);/);
  assert.ok(m, 'GAME_REACTIONS found in src/app/reactions.js');
  const clientList = new Function('return ' + m[1])();
  assert.deepEqual(clientList, REACTIONS);
});

test('public result views never leak reactions', () => {
  const g = {
    id: 'g1', mode: 'singles', teams: [['Ana'], ['Ben']], score: [11, 7], winner: 0,
    scoring: 'sideout', target: 11, winBy: 2, rallies: 20, startedAt: 1000, endedAt: 2000,
    reactions: { fire: ['Cy', 'Di'], clap: ['Ana'] }
  };
  assert.ok(!JSON.stringify(gameView(g, null)).includes('reactions'));
  assert.ok(!JSON.stringify(gameView(g, null)).includes('Cy'));
  assert.ok(!JSON.stringify(sessionView([g], 1000, 2000)).includes('reactions'));
  assert.ok(!JSON.stringify(sessionView([g], 1000, 2000)).includes('Cy'));
});
