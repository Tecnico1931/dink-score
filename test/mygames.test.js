import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../dupr-export.js';
import { page, section, iife } from './helpers/app.js';

const html = page();
const DR = new Function(iife('DR').replace('const DR =', 'return'))();
const MyGames = new Function(section('MYGAMES') + '\nreturn MyGames;')();

const g = (id, teams, score, endedAt, extra = {}) => ({ id, mode: 'doubles', teams, score, winner: score[0] > score[1] ? 0 : 1, endedAt, ...extra });
const clubs = [{ code: 'AAAAAA', name: 'Alpha' }, { code: 'BBBBBB', name: 'Beta' }, { code: 'CCCCCC', name: 'Gamma' }];
const store = {
  AAAAAA: [g('1', [['Me', 'Ann'], ['Bob', 'Cy']], [11, 5], 1000), g('2', [['Dee', 'Ed'], ['Fay', 'Gus']], [11, 2], 2000), g('3', [['Bob', 'Cy'], ['me', 'Ann']], [9, 11], 3000, { hold: true })],
  BBBBBB: [g('4', [['Me', 'Zed'], ['Y', 'X']], [4, 11], 1500)],
  CCCCCC: [g('5', [['Me', 'Q'], ['R', 'S']], [11, 0], 1)]
};
const me = { AAAAAA: { name: 'Me' }, BBBBBB: { name: 'Me' } }; // Gamma: phone not linked
const run = () => MyGames.collect(DR, clubs, me, c => store[c] || null);

test('only clubs this phone is linked to a player in, and only that player\'s games', () => {
  const r = run();
  assert.deepEqual(r.map(x => x.club), ['Alpha', 'Beta']);
  assert.deepEqual(r[0].rows.map(x => x.id), ['3', '1']);
  assert.ok(!JSON.stringify(r).includes('Dee') && !JSON.stringify(r).includes('Gamma'));
});

test('rating per club ignores held games; record and partner are right', () => {
  const [a, b] = run();
  assert.equal(a.rating.doubles.games, 1);
  assert.ok(a.rating.doubles.rating > 2);
  assert.equal(a.wins, 1); assert.equal(a.losses, 0);
  assert.equal(b.losses, 1); assert.equal(b.rating.doubles.rating, 2);
  assert.equal(a.rows[1].partner, 'Ann');
  assert.equal(a.rows[0].after, null);
  assert.equal(a.rows[0].hold, true);
});

test('a club with no copy on the phone is listed as not loaded', () => {
  const r = MyGames.collect(DR, clubs, me, () => null);
  assert.ok(r.every(x => !x.loaded && !x.rows.length));
});

test('CSV: newest first, one header, formula cells are neutralised', () => {
  const bad = { AAAAAA: [g('9', [['=cmd()', '+x'], ['@y', '-z']], [11, 1], 5000)] };
  const r = MyGames.collect(DR, [{ code: 'AAAAAA', name: '=HYPERLINK("x")' }], { AAAAAA: { name: '=cmd()' } }, c => bad[c]);
  const csv = toCsv(MyGames.flat(r), MyGames.COLUMNS);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^"?'=HYPERLINK/);
  assert.ok(lines[1].includes("'+x") && lines[1].includes("'@y") && lines[1].includes("'=cmd()"));
  const all = MyGames.flat(run());
  assert.deepEqual(all.map(x => x.id), ['3', '4', '1']);
});

test('the sheet is wired in', () => {
  assert.ok(html.includes("data-act=\"club-mine\"") && html.includes("a === 'club-mine-csv'"));
});
