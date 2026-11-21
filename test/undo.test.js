// Undo for organizer changes (L19): which logged changes can be undone, the 7-day window, and the conflict checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { undoKind, undoConflict, UNDO_DAYS } from '../api/_undo.js';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 10, 21, 12);
const DAY = 86400000;
const role = (action, from, to, extra) => ({ action, target: 'Ana', detail: { from, to }, at: NOW - DAY, ...extra });
const rename = extra => ({ action: 'rename', target: 'Dina', detail: { from: 'Di', to: 'Dina' }, at: NOW - DAY, ...extra });

test('role changes and renames are undoable; merges, removals and undos never are', () => {
  assert.equal(undoKind(role('promote', 'player', 'organizer'), NOW), 'role');
  assert.equal(undoKind(role('demote', 'organizer', 'player'), NOW), 'role');
  assert.equal(undoKind(rename(), NOW), 'rename');
  for (const action of ['merge', 'remove', 'unblock', 'release', 'leave', 'undo']) assert.equal(undoKind({ action, target: 'Ana', detail: { from: 'a', to: 'b' }, at: NOW }, NOW), null, action);
});

test('the window is UNDO_DAYS from the logged time, and a row can be undone once', () => {
  assert.equal(UNDO_DAYS, 7);
  assert.equal(undoKind(rename({ at: NOW - 7 * DAY }), NOW), 'rename');
  assert.equal(undoKind(rename({ at: NOW - 7 * DAY - 1 }), NOW), null);
  assert.equal(undoKind(rename({ at: new Date(NOW - DAY) }), NOW), 'rename', 'a Date from the database works too');
  assert.equal(undoKind(rename({ undone_at: new Date(NOW) }), NOW), null);
  assert.equal(undoKind(null, NOW), null);
});

test('rows without the detail needed to reverse them are not undoable', () => {
  assert.equal(undoKind({ action: 'rename', target: 'Dina', detail: null, at: NOW }, NOW), null);
  assert.equal(undoKind({ action: 'rename', target: 'Dina', detail: { from: '' }, at: NOW }, NOW), null);
  assert.equal(undoKind(role('promote', 'player', 'admin'), NOW), null);
  assert.equal(undoKind({ action: 'promote', target: 'Ana', at: NOW }, NOW), null);
});

test('a role undo needs the member to still hold the role the change left, and a phone link to be promoted again', () => {
  const promo = role('promote', 'player', 'organizer'), demo = role('demote', 'organizer', 'player');
  assert.equal(undoConflict(promo, 'role', { name: 'Ana', role: 'organizer', claim_hash: 'h' }), null);
  assert.match(undoConflict(promo, 'role', { name: 'Ana', role: null, claim_hash: 'h' }), /role has changed/);
  assert.equal(undoConflict(demo, 'role', { name: 'Ana', role: null, claim_hash: 'h' }), null);
  assert.match(undoConflict(demo, 'role', { name: 'Ana', role: null, claim_hash: null }), /no longer linked/);
  assert.match(undoConflict(demo, 'role', { name: 'Ana', role: 'organizer', claim_hash: 'h' }), /role has changed/);
  assert.match(undoConflict(promo, 'role', undefined), /gone/);
});

test('a rename undo needs the player to still carry the new name and the old name to be free', () => {
  const row = { name: 'Dina', name_key: 'dina' };
  assert.equal(undoConflict(rename(), 'rename', row, undefined), null);
  assert.match(undoConflict(rename(), 'rename', row, { name: 'Di', name_key: 'di' }), /Di is a saved player now/);
  assert.equal(undoConflict(rename({ target: 'DINA', detail: { from: 'dina', to: 'DINA' } }), 'rename', { name: 'DINA', name_key: 'dina' }, { name: 'DINA', name_key: 'dina' }), null, 'a casing-only rename goes back');
  assert.match(undoConflict(rename(), 'rename', undefined, undefined), /no longer a saved player/);
});

test('wiring: undo and the logged rename/merge are in the handlers and the sheet', () => {
  const players = read('api/players.js'), html = read('dink-score.html'), db = read('api/_db.js');
  assert.match(players, /body\.action === 'undo'/);
  assert.match(players, /audit\(sql, code, actor, merge \? 'merge' : 'rename'/);
  assert.match(players, /audit\(sql, code, actor, 'undo'/);
  assert.match(db, /ADD COLUMN IF NOT EXISTS undone_at/);
  assert.match(html, /data-undo="\$\{a\.id\}"/);
  assert.match(html, /action: 'undo', id: Number\(ds\.undo\)/);
});
