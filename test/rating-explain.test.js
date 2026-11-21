import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, explain, explainText, START, MIN, PROVISIONAL } from '../api/_rating.js';
import { page, iife } from './helpers/app.js';

const html = page();
const client = new Function(iife('DR').replace('const DR =', 'return'))();

const g = (id, score, endedAt, teams, { mode = 'doubles', target = 11 } = {}) => ({
  id, mode, target, score, winner: score[0] > score[1] ? 0 : 1, endedAt, teams
});

test('explain returns null when a player has no rated games in that mode', () => {
  const games = [g('g1', [11, 5], 1e12, [['Ana', 'Ben'], ['Cal', 'Dee']])];
  assert.equal(explain(games, 'doubles', 'Nobody'), null);
  assert.equal(explain(games, 'singles', 'Ana'), null);
  assert.equal(explain([], 'doubles', 'Ana'), null);
  assert.equal(explain(games, 'doubles', ''), null);
  assert.equal(client.explain(games, 'singles', 'Ana'), null);
});

test('explain matches compute() exactly on both server and client copies', () => {
  const games = [
    g('g1', [11, 4], 1e12, [['Ana', 'Ben'], ['Cal', 'Dee']]),
    g('g2', [11, 7], 1e12 + 36e5, [['Ana', 'Cal'], ['Ben', 'Dee']])
  ];
  const { tables, changes } = compute(games);
  const ex = explain(games, 'doubles', 'Ana');
  const cx = client.explain(games, 'doubles', 'Ana');
  assert.ok(ex && cx);
  assert.equal(ex.game.id, 'g2');
  assert.equal(ex.after, tables.doubles.get('ana').rating);
  assert.equal(ex.delta, tables.doubles.get('ana').delta);
  assert.equal(ex.before, changes.g2.list.find(x => x.name === 'Ana').before);
  assert.equal(cx.after, ex.after);
  assert.equal(cx.delta, ex.delta);
  assert.equal(cx.expectedShare, ex.expectedShare);
  assert.deepEqual(cx.forecast, ex.forecast);
});

test('first game: winner rises with provisional note, loser hits 2.00 floor with zero delta', () => {
  const games = [g('g1', [11, 5], 1e12, [['Ana', 'Ben'], ['Cal', 'Dee']])];
  const winEx = explain(games, 'doubles', 'Ana');
  const winTxt = explainText(winEx);
  assert.equal(winEx.won, true);
  assert.equal(winEx.gamesBefore, 0);
  assert.equal(winEx.gamesAfter, 1);
  assert.equal(winEx.provisional, true);
  assert.equal(winEx.forecast.even, true);
  assert.ok(winEx.roundedDelta > 0);
  assert.match(winTxt.forecastLabel, /Even matchup/);
  assert.match(winTxt.reason, /even matchup/i);
  assert.match(winTxt.reason, /\+0\.\d{2}/);
  assert.ok(winTxt.notes.some(n => /First rated doubles game/i.test(n)));

  const loseEx = explain(games, 'doubles', 'Cal');
  const loseTxt = explainText(loseEx);
  assert.equal(loseEx.won, false);
  assert.equal(loseEx.before, START);
  assert.equal(loseEx.after, MIN);
  assert.equal(loseEx.roundedDelta, 0);
  assert.equal(loseEx.floorClamped, true);
  assert.match(loseTxt.reason, /2\.00 rating floor/);
});

test('blowout win sets capped=true and includes cap note', () => {
  const games = [g('g1', [11, 0], 1e12, [['Ana', 'Ben'], ['Cal', 'Dee']])];
  const ex = explain(games, 'doubles', 'Ana');
  const txt = explainText(ex);
  assert.equal(ex.capped, true);
  assert.equal(ex.actualShare, 1);
  assert.ok(ex.usedShare < 0.8);
  assert.ok(txt.notes.some(n => /capped at an 11–3/i.test(n)));
});

test('beating the forecast in a loss raises the rating and explains why', () => {
  // Build up Ana & Ben's rating well above Cal & Dee
  const games = [];
  for (let i = 0; i < 12; i++) {
    games.push(g('w' + i, [11, 2], 1e12 + i * 36e5, [['Ana', 'Ben'], ['Eve', 'Fay']]));
  }
  // Now Cal & Dee (at 2.00) lose 9-11 to strong Ana & Ben: underdog beats forecast in a loss!
  games.push(g('close', [11, 9], 1e12 + 20 * 36e5, [['Ana', 'Ben'], ['Cal', 'Dee']]));

  const underdogEx = explain(games, 'doubles', 'Cal');
  const underdogTxt = explainText(underdogEx);
  assert.equal(underdogEx.won, false);
  assert.equal(underdogEx.forecast.fav, 0);
  assert.ok(underdogEx.roundedDelta > 0, 'underdog rating rises despite loss');
  assert.match(underdogTxt.reason, /Even in a 9–11 loss, Cal beat the/);

  // Meanwhile, heavily favored Ana won 11-9 but missed her forecast -> rating drops!
  const favEx = explain(games, 'doubles', 'Ana');
  const favTxt = explainText(favEx);
  assert.equal(favEx.won, true);
  assert.equal(favEx.provisional, false);
  assert.ok(favEx.gamesAfter >= PROVISIONAL);
  assert.ok(favEx.roundedDelta < 0, 'favorite rating drops despite win');
  assert.match(favTxt.reason, /Even in an? 11–9 win, Ana was forecast to win/);
  assert.ok(favTxt.notes.some(n => /Reliability was \d+%/i.test(n)));
});

test('upset win by underdog explains beating the forecast', () => {
  const games = [];
  for (let i = 0; i < 10; i++) {
    games.push(g('w' + i, [11, 3], 1e12 + i * 36e5, [['Ana'], ['Eve']], { mode: 'singles' }));
  }
  games.push(g('upset', [6, 11], 1e12 + 12 * 36e5, [['Ana'], ['Cal']], { mode: 'singles' }));

  const calEx = explain(games, 'singles', 'Cal');
  const calTxt = explainText(calEx);
  assert.equal(calEx.won, true);
  assert.equal(calEx.forecast.fav, 0);
  assert.ok(calEx.roundedDelta > 0);
  assert.match(calTxt.reason, /Forecast to lose .*, Cal won 11–6/);

  const anaEx = explain(games, 'singles', 'Ana');
  const anaTxt = explainText(anaEx);
  assert.equal(anaEx.won, false);
  assert.ok(anaEx.roundedDelta < 0);
  assert.match(anaTxt.reason, /Forecast to win .*, Ana lost 6–11/);
});

test('explain supports specific gameId lookup and normalized names', () => {
  const games = [
    g('g1', [11, 5], 1e12, [['Zoé'], ['Bob']], { mode: 'singles' }),
    g('g2', [11, 9], 1e12 + 36e5, [['zoe\u0301 '], ['Bob']], { mode: 'singles' })
  ];
  const latest = explain(games, 'singles', 'ZOÉ');
  const first = explain(games, 'singles', '  zoé', { gameId: 'g1' });
  assert.equal(latest.game.id, 'g2');
  assert.equal(first.game.id, 'g1');
  assert.equal(first.gamesBefore, 0);
  assert.equal(latest.gamesBefore, 1);
});

test('dink-score.html wires accessible rating-change explanation controls without nested buttons', () => {
  assert.match(html, /id="sheet8"/);
  assert.match(html, /data-explain-player=/);
  assert.match(html, /class="delta-btn"/);
  assert.match(html, /Explain rating change/);
  // Leaderboard rows and podium steps must not wrap delta-btn in an outer <button>
  assert.doesNotMatch(html, /<button class="prow"/);
  assert.doesNotMatch(html, /<button class="step /);
});
