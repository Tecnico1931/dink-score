import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/app/result-links.js'), 'utf8');
const pure = src.slice(src.indexOf('/*AUDIT-PURE-START*/'), src.indexOf('/*AUDIT-PURE-END*/'));
const { auditLine } = new Function('teamLabel', pure + '; return { auditLine };')(p => p.join(' & '));

const game = { teams: [['Ann', 'Bo'], ['Cy', 'Di']], score: [11, 7] };
const row = (action, extra) => ({ action, actor: 'creator', at: '2026-11-22T10:00:00Z', before: null, after: null, note: null, ...extra });

test('every kind of history row renders without throwing', () => {
  assert.equal(auditLine(row('create', { after: game })).what, 'Ann & Bo 11–7 Cy & Di');
  const edit = auditLine(row('edit', { before: game, after: { ...game, score: [11, 9] } }));
  assert.equal(edit.what, 'Ann & Bo 11–9 Cy & Di');
  assert.equal(edit.was, 'Ann & Bo 11–7 Cy & Di');
  assert.equal(auditLine(row('delete', { before: game })).what, 'Ann & Bo 11–7 Cy & Di');
  assert.equal(auditLine(row('confirm', { after: game })).word, 'Confirmed');
  assert.equal(auditLine(row('share', { note: 'public link made' })).what, '');
});

test('a setting row reads as a plain sentence, never JSON', () => {
  const l = auditLine(row('setting', { before: { rewards: false }, after: { rewards: true } }));
  assert.deepEqual([l.word, l.what], ['Setting changed', 'Rewards turned on']);
  assert.equal(auditLine(row('setting', { after: { requireConfirmation: false } })).what, 'Count only confirmed games turned off');
  assert.equal(auditLine(row('setting', { after: { mysteryBox: true } })).what, 'Mystery box turned on');
  assert.equal(auditLine(row('setting', { after: { publicResults: true } })).what, 'Public result links turned on');
  assert.equal(auditLine(row('setting', { after: { somethingNew: true } })).what, 'A club setting was changed');
  assert.equal(auditLine(row('setting')).what, 'A club setting was changed');
});

test('unknown or malformed rows are labelled, not thrown on', () => {
  assert.equal(auditLine(row('teleport', { after: { x: 1 } })).word, 'Changed');
  for (const bad of [null, undefined, 5, {}, row('edit', { before: {}, after: { teams: 'x' } }), row('create', { after: { teams: [['A']], score: [1, 2] } }), { action: 'delete', actor: 7 }]) assert.doesNotThrow(() => auditLine(bad));
  assert.equal(auditLine(row('create', { after: { teams: [['A']], score: [1, 2] } })).what, '');
});
