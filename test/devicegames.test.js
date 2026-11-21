import { test } from 'node:test';
import assert from 'node:assert/strict';
import { page, section } from './helpers/app.js';

const src = page();
const DeviceGames = new Function(section('DEVICEGAMES') + '\nreturn DeviceGames;')();
const games = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('save-to-club after a game uploads only that game', () => {
  assert.deepEqual(DeviceGames.select(games, ['b']), [{ id: 'b' }]);
  assert.deepEqual(DeviceGames.select(games, []), []);
});

test('uploading later from the club sheet sends every device game, as a copy', () => {
  const all = DeviceGames.select(games);
  assert.deepEqual(all, games);
  assert.notEqual(all, games);
});

test('starting a game or logging a result no longer requires a club', () => {
  assert.ok(!/needsClubToLog|startAfterJoin|logAfterJoin/.test(src));
  const begin = src.match(/function beginGame\(\) \{([\s\S]*?)\n\}/)[1];
  const open = src.match(/function openLog\(\) \{([\s\S]*?)\n\}/)[1];
  assert.ok(!/clubSheet/.test(begin) && !/clubSheet/.test(open));
});
