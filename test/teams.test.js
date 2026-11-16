import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, cleanRefs, view, recordResult, standingsFor } from '../api/_events.js';

const NOW = Date.UTC(2026, 5, 1, 12);
const players = ['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal'];
const teams = [['Ana', 'Ben'], ['Cy', 'Di'], ['Ed', 'Flo'], ['Gus', 'Hal']];
const meta = [{ name: 'Net Ninjas', logo: 'https://example.com/n.png' }, { name: 'Drop Shots', logo: '' }, { name: '', logo: 'https://example.com/e.png' }, { name: '', logo: '' }];
const mk = (format, extra = {}) => createEvent({ name: 'Cup', format, partners: 'fixed', rotation: 'manual', courts: 2, players, teams, teamMeta: meta, ...extra }, NOW);

test('imported teams keep the sheet order, names and logos; unnamed teams fall back to their players', () => {
  const ev = mk('single_elim');
  assert.deepEqual(ev.teams, teams);
  assert.deepEqual(ev.teamInfo, [{ players: ['Ana', 'Ben'], name: 'Net Ninjas', logo: 'https://example.com/n.png' }, { players: ['Cy', 'Di'], name: 'Drop Shots', logo: '' }, { players: ['Ed', 'Flo'], name: '', logo: 'https://example.com/e.png' }]);
  assert.equal(ev.publicLogos, true);
  assert.equal(mk('single_elim', { publicLogos: false }).publicLogos, false);
  assert.equal(view(ev).teamInfo.length, 3);
});

test('team names and logos are checked on the server too', () => {
  assert.throws(() => mk('single_elim', { teamMeta: meta.slice(0, 3) }), /do not match/);
  for (const logo of ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'https://u:p@example.com/a.png', 'https://127.0.0.1/a.png'])
    assert.throws(() => mk('single_elim', { teamMeta: [{ name: 'X', logo }, ...meta.slice(1)] }), /logo/i, logo);
  const long = mk('single_elim', { teamMeta: [{ name: 'x'.repeat(80) }, ...meta.slice(1)] });
  assert.equal(long.teamInfo[0].name.length, 40);
  const junk = mk('single_elim', { teamMeta: [{ name: 'Net​|Ninjas\u0007' }, ...meta.slice(1)] });
  assert.equal(junk.teamInfo[0].name, 'NetNinjas');
});

test('team names only apply to the organizer\'s own pairs, never to rotating partners', () => {
  const rot = createEvent({ name: 'Rot', format: 'roundrobin', partners: 'rotating', rotation: 'manual', players, teams, teamMeta: meta, rounds: 3 }, NOW);
  assert.equal(rot.teams, null);
  assert.equal(rot.teamInfo, undefined);
  const auto = createEvent({ name: 'Auto', format: 'single_elim', rotation: 'auto', players, teamMeta: meta }, NOW);
  assert.equal(auto.teamInfo, undefined); // the app drew the teams, so there is nothing to match the names to
});

test('fixed-team round robin standings and the knockout use team names', () => {
  const ev = mk('roundrobin');
  const first = ev.rounds[0].matches[0];
  recordResult(ev, first.id, { score: [11, 4] }, NOW);
  const rows = standingsFor(ev);
  assert.ok(rows.find(r => r.name === 'Net Ninjas' && r.logo === 'https://example.com/n.png'));
  assert.ok(rows.find(r => r.name === 'Gus & Hal' && r.logo === undefined) || rows.find(r => r.name === 'Gus & Hal'));
  assert.deepEqual(rows.find(r => r.name === 'Net Ninjas').members, ['Ana', 'Ben']); // members stay the players
  const ko = mk('pool_knockout', { advance: 4 });
  assert.equal(ko.teamInfo.length, 3);
});

test('the match record still names players, so ratings and the game record are unchanged by team names', () => {
  const ev = mk('single_elim');
  const m = ev.bracket.matches.find(x => x.status === 'pending' && x.slots.every(s => s >= 0));
  const { game } = recordResult(ev, m.id, { score: [11, 5] }, NOW);
  assert.ok(game.teams.flat().every(p => players.includes(p)));
  assert.ok(!JSON.stringify(game).includes('Net Ninjas'));
});

test('DUPR reference IDs: kept for this event\'s players only, normalised, checked, and not part of the event or its view', () => {
  assert.deepEqual(cleanRefs({ Ana: 'k4m2p9', ana: 'zzzzzz', Stranger: 'ABCDEF', Ben: '', Cy: null }, players), { Ana: 'ZZZZZZ' });
  assert.deepEqual(cleanRefs(undefined, players), {});
  assert.deepEqual(cleanRefs('nope', players), {});
  assert.throws(() => cleanRefs({ Ana: 'bad' }, players), /Ana: A DUPR ID is 5 to 10/);
  assert.throws(() => cleanRefs({ Ana: '<b>' }, players), /DUPR ID/);
  const ev = mk('single_elim', { refs: { Ana: 'K4M2P9' } });
  assert.ok(!JSON.stringify(ev).includes('K4M2P9'));
  assert.ok(!JSON.stringify(view(ev)).includes('K4M2P9'));
  assert.equal(ev.refs, undefined);
});
