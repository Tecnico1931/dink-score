import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Stored state is untrusted. The Heal block (inline in dink-score.html) checks and migrates it; load just that block.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'dink-score.html'), 'utf8');
const block = src.match(/\/\*RECOVERY-START\*\/([\s\S]*?)\/\*RECOVERY-END\*\//);
assert.ok(block, 'the RECOVERY block is missing from dink-score.html');
const fake = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), key: i => [...m.keys()][i], get length() { return m.size; }, m };
};
const ls = fake();
const Heal = new Function('localStorage', block[1] + '\nreturn Heal;')(ls);

const game = (id, extra) => Object.assign({ id, teams: [['Ana', 'Bo'], ['Cy', 'Di']], score: [11, 5], endedAt: 1000 }, extra);

test('a good game passes and keeps unknown fields; bad shapes are rejected', () => {
  const g = Heal.game(game('g1', { replay: true, futureField: 7 }));
  assert.equal(g.id, 'g1'); assert.equal(g.futureField, 7); assert.equal(g.mode, 'doubles'); assert.equal(g.rallies, 0);
  for (const bad of [null, 'x', 5, [], {}, game(''), game('a', { teams: [['A']] }), game('a', { teams: [['A'], 'B'] }), game('a', { teams: [[], []] }),
    game('a', { teams: [[1], [2]] }), game('a', { score: [1] }), game('a', { score: ['1', '2'] }), game('a', { score: [NaN, 1] }), game('a', { endedAt: 'soon' }), game('a', { endedAt: null })]) assert.equal(Heal.game(bad), null, JSON.stringify(bad));
});

test('a game list with junk keeps the good games and hands back the rest', () => {
  const r = Heal.games([game('a'), null, 7, game('b', { score: 'x' }), game('c')]);
  assert.deepEqual(r.ok.map(g => g.id), ['a', 'c']);
  assert.equal(r.bad.length, 3);
  assert.deepEqual(Heal.games(null).ok, []); assert.deepEqual(Heal.games({ not: 'a list' }).ok, []);
});

test('unsent changes: readable ones are kept, unreadable ones are reported so they can be set aside', () => {
  const ops = [{ type: 'game', code: 'ABC123', game: game('g1') }, { type: 'delete', code: 'ABC123', id: 'g0' }, { type: 'event-result', code: 'ABC123', eventId: 'e', matchId: 'm', score: [11, 3] },
    { type: 'game', code: 'ABC123' }, { code: 'ABC123' }, 'junk', null, { type: 'game', code: 7, game: game('g2') }, { type: 'edit', code: 'ABC123', id: 'x', game: { id: 'x' } }];
  const r = Heal.outbox(ops);
  assert.equal(r.ok.length, 3);
  assert.equal(r.bad.length, 6);
  assert.equal(Heal.outbox('nope').ok.length, 0);
  assert.equal(Heal.outbox([{ type: 'game', game: game('f'), failed: { status: 400, message: 'no' } }]).ok[0].failed.status, 400);
});

test('quarantine keeps what was set aside, capped, and never throws', () => {
  Heal.quarantine('pb.outbox', [{ type: 'game' }]);
  Heal.quarantine('pb.outbox', []);
  const q = JSON.parse(ls.getItem('pb.quarantine'));
  assert.equal(q.length, 1); assert.deepEqual(q[0].items, [{ type: 'game' }]);
  for (let i = 0; i < 30; i++) Heal.quarantine('k', [i]);
  assert.equal(JSON.parse(ls.getItem('pb.quarantine')).length, 20);
  ls.setItem('pb.quarantine', '{broken');
  assert.doesNotThrow(() => Heal.quarantine('k', [1]));
});

test('cached club data: an old shape with missing fields is migrated; wrong club or a newer schema is dropped', () => {
  // the shape from before Dinks, levels and the shop were removed, with fields added since missing
  const old = { code: 'ABC123', games: [game('a'), { id: 'broken' }], roster: ['Ana', 7, null], players: [{ name: 'Ana', dinks: 40, level: 3, xp: 120 }, { dinks: 1 }, null] };
  const d = Heal.clubData(old, 'ABC123');
  assert.equal(d.v, Heal.SCHEMA);
  assert.deepEqual(d.games.map(g => g.id), ['a']);
  assert.deepEqual(d.roster, ['Ana']);
  assert.deepEqual(d.deleted, []);
  assert.equal(d.progress, null);
  assert.deepEqual(d.players.map(p => p.name), ['Ana']);
  assert.equal(d.players[0].xp, 120); // removed fields are carried, never read
  assert.equal(Heal.clubData(old, 'ZZZ999'), null);
  assert.equal(Heal.clubData({ code: 'ABC123', v: Heal.SCHEMA + 1, games: [] }, 'ABC123'), null);
  for (const bad of [null, undefined, 'x', 5, [], { games: [] }, { code: 5 }]) assert.equal(Heal.clubData(bad, 'ABC123'), null);
  assert.equal(Heal.clubData({ code: 'ABC123' }, 'ABC123').games.length, 0);
});

test('clubs and the open club: only entries with a code, and a name always exists', () => {
  assert.deepEqual(Heal.clubs([{ code: 'A1' }, null, 'x', { name: 'no code' }, { code: 'B2', name: 'Bees', hasPin: true }]).map(c => c.code + ':' + c.name), ['A1:A1', 'B2:Bees']);
  assert.deepEqual(Heal.clubs(null), []);
  assert.equal(Heal.club('x'), null); assert.equal(Heal.club({ code: '' }), null);
});

test('setup: wrong kinds fall back to defaults and the name grid is always 2 x 2 text', () => {
  const defaults = { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, first: 0, names: [['', ''], ['', '']] };
  for (const bad of [null, 'x', 5, [], { names: 'x' }, { names: [null, 5] }, { names: [['a']] }, { mode: 'triples', target: 99, winBy: 'x', first: 3, scoring: 1 }]) {
    const s = Heal.setup(bad, defaults);
    assert.equal(s.names.length, 2); for (const t of s.names) { assert.equal(t.length, 2); for (const n of t) assert.equal(typeof n, 'string'); }
    assert.ok(['doubles', 'singles'].includes(s.mode)); assert.equal(s.target, 11); assert.equal(s.winBy, 2); assert.equal(s.first, 0);
  }
  assert.deepEqual(Heal.setup({ mode: 'singles', target: 15, names: [['Ana', 'x'], ['Bo']] }, defaults).names, [['Ana', 'x'], ['Bo', '']]);
});

test('a game in progress must be whole, or it is dropped', () => {
  const st = { cfg: { teams: [['A', 'B'], ['C', 'D']], mode: 'doubles' }, score: [3, 2], serving: 0, serverNum: 2, right: [0, 0], server: 0, rallies: 5, winner: null };
  const l = Heal.live({ state: st, stack: [st, { junk: 1 }, null], open: true });
  assert.equal(l.stack.length, 1); assert.equal(l.open, true);
  for (const bad of [null, 'x', {}, { state: {} }, { state: Object.assign({}, st, { cfg: {} }) }, { state: Object.assign({}, st, { score: [1] }) }, { state: Object.assign({}, st, { right: undefined }) }, { state: Object.assign({}, st, { winner: 'x' }) }]) assert.equal(Heal.live(bad), null);
  assert.deepEqual(Heal.live({ state: st }).stack, []);
});

test('Clear club data removes this club\'s cache but never unsent games, saved games or the club itself', () => {
  const s = fake({ 'pb.club': JSON.stringify({ code: 'ABC123', name: 'X' }), 'pb.clubCache': '{"code":"ABC123"}', 'pb.clubCaches': JSON.stringify({ ABC123: { code: 'ABC123' }, OTHER1: { code: 'OTHER1' } }),
    'pb.outbox': '[{"type":"game"}]', 'pb.games': '[1]', 'pb.tab': '"leaders"', 'pb.setup': '{}', 'pb.live': '{"state":1}', 'pb.pins': '{"ABC123":"1234"}' });
  Heal.clearClub(s);
  assert.equal(s.getItem('pb.clubCache'), null);
  assert.deepEqual(Object.keys(JSON.parse(s.getItem('pb.clubCaches'))), ['OTHER1']);
  for (const k of ['pb.outbox', 'pb.games', 'pb.club', 'pb.live', 'pb.pins']) assert.notEqual(s.getItem(k), null, k);
  assert.equal(s.getItem('pb.tab'), null);
  const t = fake({ 'pb.club': '{bad', 'pb.clubCaches': '[[[', 'pb.outbox': 'x' });
  assert.doesNotThrow(() => Heal.clearClub(t));
  assert.equal(t.getItem('pb.clubCaches'), null); assert.equal(t.getItem('pb.outbox'), 'x');
});

test('Reset settings keeps unsent games, saved games, the live game and club membership', () => {
  const s = fake({ 'pb.outbox': 'o', 'pb.games': 'g', 'pb.live': 'l', 'pb.quarantine': 'q', 'pb.club': 'c', 'pb.clubs': 'cs', 'pb.pins': 'p', 'pb.owners': 'w', 'pb.me': 'm',
    'pb.setup': 's', 'pb.tab': 't', 'pb.roster': 'r', 'pb.clubCache': 'x', 'pb.clubCaches': 'y', 'pb.seenProgress': 'z', 'other': 'keep' });
  Heal.resetAll(s);
  assert.deepEqual([...s.m.keys()].sort(), ['other', 'pb.club', 'pb.clubs', 'pb.games', 'pb.live', 'pb.me', 'pb.outbox', 'pb.owners', 'pb.pins', 'pb.quarantine'].sort());
});

test('the recovery panel escapes the error text and offers reload, clear and reset', () => {
  const html = Heal.panel(new Error('<img src=x onerror=alert(1)>'), false);
  assert.ok(!html.includes('<img'));
  for (const a of ['reload', 'clear', 'reset']) assert.ok(html.includes(`data-heal="${a}"`));
});

test('guard returns the view, or a recovery card when drawing throws', () => {
  assert.equal(Heal.guard(() => '<p>ok</p>'), '<p>ok</p>');
  const orig = globalThis.setTimeout; globalThis.setTimeout = () => 0; // the deferred rethrow (for error reporting) stays out of the test run
  try { assert.ok(Heal.guard(() => { throw new TypeError("Cannot read properties of undefined (reading 'win')"); }).includes('data-heal="reload"')); }
  finally { globalThis.setTimeout = orig; }
});

test('the app reads stored state through Heal and draws behind the boundary', () => {
  assert.match(src, /Heal\.clubData\(store\.get\('pb\.clubCache'/);
  assert.match(src, /Heal\.outbox\(store\.get\('pb\.outbox'/);
  assert.match(src, /Heal\.live\(store\.get\('pb\.live'/);
  assert.match(src, /Heal\.setup\(store\.get\('pb\.setup'/);
  assert.match(src, /Heal\.games\(store\.get\('pb\.games'/);
  assert.match(src, /function render\(\) \{\s*try \{ renderApp\(\)/);
  assert.match(src, /Heal\.guard\(\(\) => tab === 'play'/);
});

test('the service worker keeps only good pages', () => {
  const sw = readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(sw, /if \(res\.ok\) \{ const copy/);
  assert.ok(!/res\.type === 'opaque'/.test(sw));
});
