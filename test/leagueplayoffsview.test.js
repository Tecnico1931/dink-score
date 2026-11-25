// The playoffs section of the league screen (src/app/leagues-view.js) drawn from the real server view (api/_leagueplayoffs.js playoffView).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeague, recordLeagueResult, endSeason, allMatches, view } from '../api/_league.js';
import { startPlayoffs, recordPlayoff, playoffView } from '../api/_leagueplayoffs.js';
import { module as mod } from './helpers/app.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const names = Array.from({ length: 4 }, (_, i) => 'P' + (i + 1));
const ORG = { organizer: true, name: null };

function season(playoffs) {
  const L = createLeague({ name: 'Spring', mode: 'singles', players: names }, Object.fromEntries(names.map((p, i) => [p, 3 - i * 0.1])), 1000, () => 0.5);
  for (const m of allMatches(L)) recordLeagueResult(L, m.id, { score: Number(m.teams[0][0].slice(1)) < Number(m.teams[1][0].slice(1)) ? [11, 3] : [3, 11], endedAt: 2000 }, 2000, ORG);
  if (L.status !== 'done') endSeason(L, 2500);
  if (playoffs) startPlayoffs(L, { top: 4 }, 3000);
  return L;
}
// What the phone receives: L.view plus the named bracket.
const shown = L => Object.assign(view(L), L.playoffs ? { playoffs: playoffView(L) } : {});

function draw(L, { org = true, me = () => false, screen = {}, ops = [] } = {}) {
  const g = { esc, TEAM_COLOR: ['blue', 'green'], isMe: me, clubOps: () => ops, evStepper: (k, label, v) => `<div data-step="${k}">${label}: <output>${v}</output><button data-ev="step" data-k="${k}"></button></div>`, setInterval: () => 0, $: () => null, document: { addEventListener() {} }, lgScreen: null };
  const keys = Object.keys(g);
  const src = `${mod('leagues-view')}\nlgScreen = { view: 'detail', league: L, busy: false, ...screen };\nreturn lgPlayoffsHTML(lgScreen, L, ORG);`;
  return new Function(...keys, 'L', 'ORG', 'screen', src.replace(/^let lgScreen = null;.*$/m, 'let lgScreenX;'))(...keys.map(k => g[k]), L, org, screen);
}

test('a finished league offers the organizer a start card, and nobody else', () => {
  const L = shown(season(false));
  const html = draw(L);
  assert.match(html, /data-lg="po-start"/);
  assert.match(html, /data-lg="step"/, 'the qualifier stepper is wired to the league screen');
  assert.match(html, /The best 2 of each division/);
  assert.match(draw(L, { screen: { poTop: 4 } }), /The best 4 of each division/);
  assert.equal(draw(L, { org: false }), '');
  const live = shown(createLeague({ name: 'x', mode: 'singles', players: names }, {}, 1000, () => 0.5));
  assert.equal(draw(live), '', 'no playoffs for a season still being played');
});

test('started playoffs show the bracket by round, with seeds named and scores enterable', () => {
  const L = season(true), v = shown(L), html = draw(v);
  assert.doesNotMatch(html, /po-start/);
  assert.match(html, /<h4 class="lg-po-round">Semifinals<\/h4>/);
  assert.match(html, /<h4 class="lg-po-round">Final<\/h4>/);
  assert.match(html, /P1<\/span>/);
  assert.match(html, /To be decided/, 'the final waits for the semifinals');
  assert.equal(html.match(/data-lg="po-enter"/g).length, 2, 'only the two ready semifinals can be scored');
  assert.match(html, /data-lg="po-enter" data-m="W1-0"/);
});

test('a player sees Enter score only for a match they are in; an organizer can fix a played one', () => {
  const L = season(true), v = shown(L);
  const mine = draw(v, { org: false, me: n => n === 'P1' });
  assert.equal(mine.match(/data-lg="po-enter"/g).length, 1);
  assert.match(mine, /data-m="W1-0"/);
  assert.doesNotMatch(draw(v, { org: false }), /po-enter/);
  recordPlayoff(L, 'W1-0', [11, 5], 3100);
  const after = draw(shown(L));
  assert.match(after, /data-lg="po-fix" data-m="W1-0"/);
  assert.match(after, /<span class="pts">11<\/span>/);
  assert.doesNotMatch(draw(shown(L), { org: false }), /po-fix/);
});

test('the score form opens under the match, and a queued result shows as waiting', () => {
  const v = shown(season(true));
  assert.match(draw(v, { screen: { entry: { m: 'W1-1', po: true, s: ['', ''], error: '' } } }), /data-lg-form="entry"/);
  const q = draw(v, { ops: [{ type: 'league-result', leagueId: v.id, matchId: 'W1-0', playoff: true, score: [11, 4] }] });
  assert.match(q, /Waiting to send 11–4/);
  // a season match with the same id is not the playoff match
  assert.doesNotMatch(draw(v, { ops: [{ type: 'league-result', leagueId: v.id, matchId: 'W1-0', score: [11, 4] }] }), /Waiting to send/);
});

test('the champion is named once the final is played', () => {
  const L = season(true);
  recordPlayoff(L, 'W1-0', [11, 5], 3100); recordPlayoff(L, 'W1-1', [11, 9], 3200); recordPlayoff(L, 'W2-0', [9, 11], 3300);
  assert.match(draw(shown(L)), /<b>Champion:<\/b> P2/);
});

test('the outbox sends the playoff flag and the actions are wired', () => {
  assert.match(mod('leagues-actions'), /league-playoffs-fix/);
  assert.match(mod('club-sync'), /matchId: op\.matchId, playoff: op\.playoff/);
  assert.match(mod('leagues-actions'), /league-playoffs-start/);
});
