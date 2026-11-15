import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvField, toCsv, toText, exportRows, fileName, dateOf, DUPR_COLUMNS } from '../dupr-export.js';
import { createEvent, startNextRound, recordResult, view } from '../api/_events.js';

const T = (d, h) => new Date(2026, 5, d, h).getTime(); // local time, like dateOf
const m = (id, teams, score, endedAt, status = score ? 'done' : 'pending') => ({ id, teams, score, status, endedAt, startedAt: null });
const ev = (rounds, extra) => ({ name: 'Cup', updatedAt: T(1, 9), rounds, ...extra });

test('csvField quotes commas, quotes and newlines (RFC 4180)', () => {
  assert.equal(csvField('Smith, Jo'), '"Smith, Jo"');
  assert.equal(csvField('Say "hi"'), '"Say ""hi"""');
  assert.equal(csvField('a\nb'), '"a\nb"');
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField(11), '11');
});

test('csvField neutralises spreadsheet formulas', () => {
  for (const s of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx']) assert.ok(csvField(s).replace(/^"/, '').startsWith("'"), s);
  assert.equal(csvField('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);
  assert.equal(csvField(-3), '-3'); // numbers are scores, not text
});

test('toCsv has a BOM, CRLF and the declared columns', () => {
  const rows = [{ event: 'Cup', round: 'Round 1', date: '2026-06-01', teams: [['A', 'B'], ['C', 'D']], score: [11, 7], winner: 0 }];
  const csv = toCsv(rows);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], DUPR_COLUMNS.map(c => c[0]).join(','));
  assert.equal(lines[1], 'Cup,Round 1,2026-06-01,DOUBLES,A,B,C,D,11,7,Team A');
});

test('exportRows skips pending, tied, under-6 and unknown-player matches with a reason', () => {
  const e = ev([{ title: 'Round 1', matches: [
    m('a', [['A', 'B'], ['C', 'D']], [11, 7], T(1, 10)),
    m('b', [['A', 'C'], ['B', 'D']], null, null),
    m('c', [['A', 'D'], ['B', 'C']], [8, 8], T(1, 11)),
    m('d', [['A', 'B'], ['C', 'D']], [5, 3], T(1, 12)),
    m('e', [['A', 'B'], null], null, null),
    m('f', [['A', 'B'], ['C', 'D']], [6, 4], T(1, 13))] }]);
  const { rows, skipped } = exportRows(e);
  assert.deepEqual(rows.map(r => r.id), ['a', 'f']);
  assert.deepEqual(skipped.map(s => [s.id, s.reason]), [['b', 'Not played yet'], ['c', 'Tied, so there is no winner'], ['d', 'Winner has under 6 points'], ['e', 'Not played yet']]);
});

test('winner is read from the score, and rows are ordered by finish time', () => {
  const e = ev([{ title: 'R1', matches: [m('late', [['A', 'B'], ['C', 'D']], [3, 11], T(2, 9)), m('early', [['A', 'C'], ['B', 'D']], [11, 9], T(1, 9))] }],
    { knockout: [{ title: 'Final', matches: [m('k', [['A', 'B'], ['C', 'D']], [11, 0], T(3, 9))] }] });
  const { rows } = exportRows(e);
  assert.deepEqual(rows.map(r => r.id), ['early', 'late', 'k']);
  assert.deepEqual(rows.map(r => r.winner), [0, 1, 0]);
  assert.deepEqual(rows.map(r => r.date), ['2026-06-01', '2026-06-02', '2026-06-03']);
  assert.equal(rows[2].round, 'Final');
});

test('dateOf, fileName and toText', () => {
  assert.equal(dateOf(T(5, 12)), '2026-06-05');
  assert.equal(fileName({ name: 'Café "Cup" / ../x' }, '2026-06-05'), 'dink-cafe-cup-x-2026-06-05.csv');
  assert.equal(fileName({ name: '???' }, '2026-06-05'), 'dink-event-2026-06-05.csv');
  const rows = [{ round: 'R1', date: '2026-06-01', teams: [['A', 'B'], ['C', 'D']], score: [11, 7] }];
  assert.equal(toText({ name: 'Cup' }, rows), 'Cup\n2026-06-01 · R1: A & B 11–7 C & D\n');
});

test('a real 8 player rotating event exports one row per played match', () => {
  const now = Date.UTC(2026, 5, 1, 12);
  const e = createEvent({ name: 'Sunday, "session"', format: 'roundrobin', rotation: 'auto', courts: 2, players: Array.from({ length: 8 }, (_, i) => 'P' + (i + 1)), seed: 'fixed' }, now);
  for (;;) {
    for (const mt of e.rounds[e.rounds.length - 1].matches) recordResult(e, mt.id, { score: [11, 7], live: true, endedAt: now }, now);
    if (e.rounds.length >= e.roundsPlanned) break;
    startNextRound(e, now);
  }
  const { rows, skipped } = exportRows(view(e));
  assert.equal(skipped.length, 0);
  assert.equal(rows.length, e.rounds.reduce((n, r) => n + r.matches.length, 0));
  assert.match(toCsv(rows), /"Sunday, ""session"""/);
});
