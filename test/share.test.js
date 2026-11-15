import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newShareToken, isShareToken, publicView } from '../api/_share.js';
import { createEvent, recordResult } from '../api/_events.js';

const NOW = Date.UTC(2026, 5, 1, 12);
const players = Array.from({ length: 8 }, (_, i) => 'P' + (i + 1));
const mk = format => createEvent({ name: 'Sunday cup', format, rotation: 'auto', courts: 2, players, seed: 'SECRET-SEED', rounds: 3, advance: 2 }, NOW);

test('share tokens are 192 random bits, URL safe, and never repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) { const t = newShareToken(); assert.match(t, /^[A-Za-z0-9_-]{32}$/); assert.ok(isShareToken(t)); seen.add(t); }
  assert.equal(seen.size, 500);
  assert.equal(Buffer.from(newShareToken(), 'base64url').length, 24);
});

test('only well-formed tokens are looked up', () => {
  for (const bad of [undefined, null, '', 'abc', 'a'.repeat(31), 'a'.repeat(33), 'a'.repeat(31) + '!', 'a'.repeat(31) + '/', "a".repeat(30) + "' ", 123, ['x'.repeat(32)], { toString: () => 'a'.repeat(32) }]) assert.equal(isShareToken(bad), false, String(bad));
});

// Every key a spectator may ever get. Adding a field to publicView means adding it here on purpose.
const ALLOWED = {
  top: ['v', 'name', 'format', 'partners', 'status', 'stage', 'target', 'scoring', 'winBy', 'courts', 'advance', 'poolDone', 'roundsPlanned', 'champion', 'updatedAt', 'teamInfo', 'standings', 'rounds', 'knockout', 'tree'],
  teamInfo: ['players', 'name', 'logo'],
  standing: ['rank', 'name', 'logo', 'played', 'wins', 'losses', 'diff'],
  round: ['n', 'title', 'status', 'matches', 'byes'],
  knockoutRound: ['key', 'title', 'matches'],
  match: ['id', 'court', 'teams', 'score', 'status', 'winner', 'ready'],
  tree: ['kind', 'rounds', 'matches'],
  treeRound: ['key', 'title'],
  treeMatch: ['id', 'court', 'teams', 'score', 'status', 'winner', 'ready', 'stage', 'round', 'pos', 'slots', 'winnerTo', 'loserTo']
};
const keys = o => Object.keys(o).sort();
const sameKeys = (o, list) => assert.deepEqual(keys(o), [...list].sort());

function checkShape(p) {
  sameKeys(p, ALLOWED.top);
  p.teamInfo.forEach(t => sameKeys(t, ALLOWED.teamInfo));
  p.standings.forEach(r => sameKeys(r, ALLOWED.standing));
  p.rounds.forEach(r => { sameKeys(r, ALLOWED.round); r.matches.forEach(m => sameKeys(m, ALLOWED.match)); });
  p.knockout.forEach(r => { sameKeys(r, ALLOWED.knockoutRound); r.matches.forEach(m => sameKeys(m, ALLOWED.match)); });
  if (p.tree) { sameKeys(p.tree, ALLOWED.tree); p.tree.rounds.forEach(r => sameKeys(r, ALLOWED.treeRound)); p.tree.matches.forEach(m => sameKeys(m, ALLOWED.treeMatch)); }
}

test('the public view lists only allowed fields, for every format', () => {
  for (const format of ['roundrobin', 'pool_knockout', 'single_elim', 'double_elim']) {
    const ev = mk(format);
    checkShape(publicView(ev));
  }
});

test('a private field added to an event, at any depth, never reaches a spectator', () => {
  const ev = mk('single_elim');
  // Plant secrets everywhere an event or a club could carry them.
  Object.assign(ev, { clubCode: 'K7P2QX', club: 'K7P2QX', pin: '123456', pinHash: 'h', ownerToken: 'tok', ownerHash: 'oh', shareToken: 'st', shop: { dinks: 9 }, purchases: [1], claimHash: 'c', email: 'a@b.c', notes: 'private' });
  ev.bracket.matches[0].secret = 'MATCH-SECRET'; ev.bracket.matches[0].gameId = 'GAME-ID-SECRET'; ev.bracket.matches[0].winnerTo.secret = 'LINK-SECRET';
  recordResult(ev, ev.bracket.matches.find(m => m.status === 'pending').id, { score: [11, 5], rallies: 40, live: true }, NOW);
  const text = JSON.stringify(publicView(ev));
  for (const s of ['K7P2QX', '123456', 'ownerToken', 'ownerHash', 'pinHash', 'claimHash', 'shareToken', 'dinks', 'a@b.c', 'private', 'MATCH-SECRET', 'GAME-ID-SECRET', 'LINK-SECRET', 'SECRET-SEED', 'seed', 'gameId', 'startedAt', 'endedAt', 'rallies', 'purchases', 'clubCode'])
    assert.ok(!text.includes(s), `leaked ${s}`);
  checkShape(publicView(ev));
});

const teamsFrom = (format, extra = {}) => createEvent({ name: 'Cup', format, rotation: 'manual', partners: 'fixed', courts: 2, players, seed: 'SECRET-SEED',
  teams: [[players[0], players[1]], [players[2], players[3]], [players[4], players[5]], [players[6], players[7]]],
  teamMeta: [{ name: 'Net Ninjas', logo: 'https://example.com/a.png' }, { name: 'Drop Shots', logo: '' }, { name: '', logo: 'https://example.com/c.png' }, { name: 'Kitchen Crew' }], ...extra }, NOW);

test('team names reach the public page; logos only when the organizer allowed them; DUPR IDs never', () => {
  const ev = teamsFrom('single_elim');
  ev.refs = { P1: 'K4M2P9' }; ev.duprId = 'K4M2P9'; ev.teamInfo[0].dupr = 'K4M2P9'; // even if one were planted in the event, only the allow-list leaves
  const on = publicView(ev);
  checkShape(on);
  assert.deepEqual(on.teamInfo.map(t => t.name), ['Net Ninjas', 'Drop Shots', '', 'Kitchen Crew']);
  assert.equal(on.teamInfo[0].logo, 'https://example.com/a.png');
  assert.ok(!JSON.stringify(on).includes('K4M2P9'));
  ev.publicLogos = false;
  const off = publicView(ev);
  assert.ok(off.teamInfo.every(t => t.logo === ''));
  assert.ok(!JSON.stringify(off).includes('example.com'));
  assert.deepEqual(off.teamInfo.map(t => t.name), on.teamInfo.map(t => t.name));
});

test('a stored logo that is not a safe https link is dropped, not served', () => {
  const ev = teamsFrom('single_elim');
  ev.teamInfo[0].logo = 'javascript:alert(1)'; ev.teamInfo[1].logo = 'http://example.com/x.png'; ev.teamInfo[2].logo = 'https://user:pw@example.com/x.png';
  const p = publicView(ev);
  assert.ok(p.teamInfo.every(t => !/javascript|http:|user:pw/.test(t.logo)));
});

test('fixed-team round robin standings carry the team name and logo', () => {
  const ev = teamsFrom('roundrobin');
  const p = publicView(ev);
  checkShape(p);
  assert.deepEqual(p.standings.map(r => r.name).sort(), ['Drop Shots', 'Kitchen Crew', 'Net Ninjas', 'P5 & P6'].sort());
  assert.ok(p.standings.some(r => r.logo === 'https://example.com/a.png'));
});

test('the public view carries what a screen needs: names, scores, standings, champion', () => {
  const ev = mk('single_elim');
  let guard = 0;
  while (ev.status !== 'done' && guard++ < 10) {
    const m = ev.bracket.matches.find(x => x.status === 'pending' && x.slots.every(s => s >= 0));
    recordResult(ev, m.id, { score: [11, 3] }, NOW);
  }
  const p = publicView(ev);
  assert.equal(p.status, 'done');
  assert.equal(p.champion.length, 2);
  assert.equal(p.name, 'Sunday cup');
  assert.ok(p.tree.matches.every(m => m.status !== 'pending'));
  const rr = publicView(mk('roundrobin'));
  assert.equal(rr.tree, null);
  assert.equal(rr.standings.length, 8);
});
