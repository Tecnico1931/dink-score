// Runs the club API against a throwaway in-memory Postgres (PGlite) instead of Neon, so the SQL in api/*.js can be
// checked without touching any real database. It answers the Neon driver's SQL-over-HTTP calls on a local port.
//   npm ci && npm i --no-save @electric-sql/pglite && node tools/api-check.mjs
// Nothing is read from .env files or the environment: the connection string below is a made-up local one.
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { signIntent } from '../api/live.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { console.error('Install the test database first: npm i --no-save @electric-sql/pglite'); process.exit(2); }
const neon = await import('@neondatabase/serverless'); // the same copy api/_db.js loads

const pg = new PGlite();
const TEXT_OIDS = [16, 20, 21, 23, 25, 700, 701, 1043, 1082, 1114, 1184, 1700, 114, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map(o => [o, v => v]));
async function run(q) {
  const r = await pg.query(q.query, q.params || [], { rowMode: 'array', parsers });
  return { command: 'SELECT', rowCount: r.rows.length, rows: r.rows, fields: r.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID, tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })), rowAsArray: true };
}
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', c => (data += c));
  req.on('end', async () => {
    try {
      const body = JSON.parse(data);
      const out = body.queries ? await Promise.all(body.queries.map(run)) : await run(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body.queries ? { results: out } : out));
    } catch (err) { res.statusCode = 400; res.end(JSON.stringify({ message: String(err.message), code: err.code || '42000' })); }
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
neon.neonConfig.fetchEndpoint = () => `http://127.0.0.1:${server.address().port}/sql`;
process.env.DATABASE_URL = 'postgres://local:local@localhost/throwaway';

const load = async name => (await import(pathToFileURL(path.join(root, 'api', name + '.js')).href)).default;
const [club, roster, games, events, playersApi, bracket, live] = await Promise.all(['club', 'roster', 'games', 'events', 'players', 'bracket', 'live'].map(load));
let ip = 0;
async function call(handler, method, { query = '', body, headers = {} } = {}) {
  const req = { method, url: '/api/x' + query, headers: { 'x-real-ip': '10.0.0.' + (++ip % 200), ...headers }, body };
  let status = 0, text = '';
  const res = { statusCode: 0, setHeader() {}, end(t) { status = res.statusCode; text = t; } };
  await handler(req, res);
  return { status, json: JSON.parse(text) };
}
const ok = (r, want = 200) => { assert.equal(r.status, want, JSON.stringify(r.json)); return r.json; };

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('ok  ' + name); };

const created = ok(await call(club, 'POST', { body: { name: 'API check club' } }), 201);
const code = created.club.code, owner = created.ownerToken;
const players = ['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal'];
const create = (event, creds = { ownerToken: owner }) => call(events, 'POST', { body: { code, action: 'create', event, ...creds } });
const act = (action, extra = {}, creds = { ownerToken: owner }) => call(events, 'POST', { body: { code, action, ...extra, ...creds } });
const clubGames = async () => ok(await call(club, 'GET', { query: '?code=' + code })).games;

let ev;
await step('only the organizer can create events', async () => {
  const r = await create({ name: 'Nope', format: 'roundrobin', players }, {});
  assert.equal(r.status, 403);
  assert.equal(ok(await call(events, 'GET', { query: '?code=' + code })).events.length, 0);
});
await step('create an 8 player rotating doubles round robin on 2 courts', async () => {
  ev = ok(await create({ name: 'Sunday rotation', format: 'roundrobin', rotation: 'auto', courts: 2, players, seed: 'api' }), 201).event;
  assert.equal(ev.rounds.length, 1);
  assert.equal(ev.rounds[0].matches.length, 2);
  assert.equal(ok(await call(events, 'GET', { query: `?code=${code}` })).events[0].name, 'Sunday rotation');
  const rosterNow = ok(await call(club, 'GET', { query: '?code=' + code })).roster;
  assert.equal(rosterNow.length, 8, 'event players are saved to the club roster');
});
await step('results feed the club record once, with the event named on the game', async () => {
  const m = ev.rounds[0].matches[0];
  const body = { id: ev.id, matchId: m.id, score: [11, 6], startedAt: Date.now() - 600000, endedAt: Date.now(), rallies: 33, live: true };
  const r = ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, ...body } }));
  assert.equal(r.event.rounds[0].matches[0].status, 'done');
  let g = await clubGames();
  assert.equal(g.length, 1);
  assert.equal(g[0].id, `${ev.id}-${m.id}`);
  assert.equal(g[0].event.id, ev.id);
  assert.equal(g[0].logged, false);
  ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, ...body } })); // a phone retrying
  assert.equal((await clubGames()).length, 1, 'a retry does not add a second game');
  const other = await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, ...body, score: [3, 11] } });
  assert.equal(other.status, 409);
  assert.equal((await clubGames()).length, 1);
});
await step('two phones scoring different courts at the same moment both land', async () => {
  const [a, b] = ev.rounds[0].matches;
  const second = ev.rounds[0].matches[1];
  const [r1, r2] = await Promise.all([
    call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: ev.id, matchId: second.id, score: [11, 9], endedAt: Date.now() } }),
    call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: ev.id, matchId: a.id, score: [11, 6], endedAt: Date.now() } })
  ]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  const now = ok(await call(events, 'GET', { query: `?code=${code}&id=${ev.id}` })).event;
  assert.ok(now.rounds[0].matches.every(m => m.status === 'done'));
  assert.equal(now.rounds[0].status, 'done');
  assert.equal((await clubGames()).length, 2);
});
await step('next round, organizer-only', async () => {
  assert.equal((await act('next-round', { id: ev.id }, {})).status, 403);
  const r = ok(await act('next-round', { id: ev.id })).event;
  assert.equal(r.rounds.length, 2);
  ev = r;
});
await step('a manual round: set the pairings, publish, then score', async () => {
  const m = ok(await create({ name: 'Manual', format: 'roundrobin', rotation: 'manual', courts: 1, players: players.slice(0, 5) }), 201).event;
  assert.equal(m.rounds[0].status, 'draft');
  const set = ok(await act('set-round', { id: m.id, round: 1, matches: [{ teams: [['Ana', 'Ben'], ['Cy', 'Di']] }] })).event;
  assert.deepEqual(set.rounds[0].matches[0].teams, [['Ana', 'Ben'], ['Cy', 'Di']]);
  assert.equal((await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: m.id, matchId: 'r1m1', score: [11, 1] } })).status, 409);
  ok(await act('publish-round', { id: m.id, round: 1 }));
  ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: m.id, matchId: 'r1m1', score: [11, 1], endedAt: Date.now() } }));
  const bad = await act('set-round', { id: m.id, round: 1, matches: [{ teams: [['Ana', 'Ben'], ['Cy', 'Di']] }] });
  assert.equal(bad.status, 409);
});
await step('correcting a score updates the club game in place', async () => {
  const m = ev.rounds[0].matches[0];
  const r = ok(await act('correct', { id: ev.id, matchId: m.id, score: [8, 11] })).event;
  assert.deepEqual(r.rounds[0].matches[0].score, [8, 11]);
  const g = (await clubGames()).find(x => x.id === `${ev.id}-${m.id}`);
  assert.deepEqual(g.score, [8, 11]);
  assert.equal(g.winner, 1);
  assert.equal(g.event.id, ev.id, 'the event tag survives a correction');
  assert.ok(g.receivedAt, 'when the server got it is kept');
  assert.equal((await act('correct', { id: ev.id, matchId: m.id, score: [8, 11] }, {})).status, 403);
});
await step('a single elimination bracket plays to a champion and every game is recorded', async () => {
  const b = ok(await create({ name: 'Cup', format: 'single_elim', rotation: 'random', courts: 2, players, seed: 'cup' }), 201).event;
  let cur = b, played = 0;
  const before = (await clubGames()).length;
  for (let guard = 0; guard < 10 && cur.status !== 'done'; guard++) {
    const next = cur.knockout.flatMap(r => r.matches).find(m => m.ready);
    cur = ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: b.id, matchId: next.id, score: [11, 4], endedAt: Date.now() } })).event; played++;
  }
  assert.equal(cur.status, 'done'); assert.equal(played, 3); assert.equal(cur.champion.length, 2);
  assert.equal((await clubGames()).length, before + 3);
  assert.equal((await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: b.id, matchId: 'W1-0', score: [1, 11] } })).status, 409);
});
await step('pool play then knockout through the API', async () => {
  const p = ok(await create({ name: 'Pool', format: 'pool_knockout', rotation: 'auto', courts: 2, players, rounds: 3, advance: 2, seed: 'pool' }), 201).event;
  let cur = p;
  for (let r = 1; r <= 3; r++) {
    for (const m of cur.rounds[r - 1].matches) cur = ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: p.id, matchId: m.id, score: [11, 7], endedAt: Date.now() } })).event;
    if (r < 3) cur = ok(await act('next-round', { id: p.id })).event;
  }
  assert.equal(cur.poolDone, true);
  cur = ok(await act('start-knockout', { id: p.id, advance: 2 })).event;
  assert.equal(cur.knockout.length, 1);
  assert.equal(cur.knockout[0].title, 'Final');
});
await step('end and delete hide an event but keep its games', async () => {
  const list = ok(await call(events, 'GET', { query: '?code=' + code })).events;
  const gamesBefore = (await clubGames()).length;
  ok(await act('end', { id: ev.id }));
  ok(await act('delete', { id: ev.id }));
  assert.equal((await call(events, 'GET', { query: `?code=${code}&id=${ev.id}` })).status, 404);
  assert.equal(ok(await call(events, 'GET', { query: '?code=' + code })).events.length, list.length - 1);
  assert.equal((await clubGames()).length, gamesBefore);
});
await step('the public bracket link: organizer makes it, a spectator sees only the allowed fields, revoking and deleting end it', async () => {
  const pub = await create({ name: 'Public Cup', format: 'double_elim', rotation: 'random', courts: 2, players, seed: 'SECRET-SEED' });
  const e = ok(pub, 201).event;
  const spectator = token => call(bracket, 'GET', { query: '?token=' + encodeURIComponent(token) });
  // Only an organizer can make, replace or remove the link.
  for (const a of ['share', 'share-new', 'share-off']) assert.equal((await call(events, 'POST', { body: { code, action: a, id: e.id } })).status, 403, a + ' without credentials');
  assert.equal((await call(events, 'POST', { body: { code, action: 'share', id: e.id, ownerToken: 'wrong' } })).status, 403);
  const { shareToken: t1 } = ok(await act('share', { id: e.id }));
  assert.match(t1, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(ok(await act('share', { id: e.id })).shareToken, t1, 'asking again returns the same link');
  // The link never shows up for people who are not organizers.
  const asMember = JSON.stringify(ok(await call(events, 'GET', { query: `?code=${code}&id=${e.id}` })));
  assert.ok(!asMember.includes(t1), 'the token is not in the event a member reads');
  // A spectator: no code, no PIN, no cookies, just the token.
  const first = await spectator(t1);
  assert.equal(first.status, 200);
  const v = first.json;
  assert.deepEqual(Object.keys(v).sort(), ['advance', 'champion', 'courts', 'format', 'name', 'partners', 'poolDone', 'roundsPlanned', 'rounds', 'knockout', 'scoring', 'stage', 'standings', 'status', 'target', 'teamInfo', 'tree', 'updatedAt', 'v', 'winBy'].sort());
  assert.equal(v.name, 'Public Cup');
  assert.ok(v.tree.matches.length > 5);
  const text = JSON.stringify(v);
  for (const secret of [code, owner, 'SECRET-SEED', 'ownerToken', 'pin_hash', 'owner_hash', 'purchases', 'claim', 'Another club event', e.id]) assert.ok(!text.includes(secret), 'leaked ' + secret);
  assert.ok(!text.includes('"gameId"') && !text.includes('startedAt') && !text.includes('rallies'));
  // Every bad token gets the very same answer.
  const answers = new Set();
  for (const bad of ['', 'nope', 'a'.repeat(32), t1.slice(0, -1), t1 + 'x', "x' OR '1'='1", t1.toLowerCase() === t1 ? t1.toUpperCase() : t1.toLowerCase()]) {
    const r = await spectator(bad); assert.equal(r.status, 404, `bad token ${bad}`); answers.add(JSON.stringify(r.json));
  }
  assert.equal(answers.size, 1);
  assert.equal((await call(bracket, 'POST', { body: { token: t1 } })).status, 405);
  // Replacing the link kills the old one.
  const { shareToken: t2 } = ok(await act('share-new', { id: e.id }));
  assert.notEqual(t2, t1);
  assert.equal((await spectator(t1)).status, 404);
  assert.equal((await spectator(t2)).status, 200);
  // A score shows up for the spectator.
  const m = (await spectator(t2)).json.tree.matches.find(x => x.ready);
  ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: e.id, matchId: m.id, score: [11, 2], endedAt: Date.now() } }));
  const after = (await spectator(t2)).json.tree.matches.find(x => x.id === m.id);
  assert.deepEqual(after.score, [11, 2]);
  // Removing the link, and deleting the event, both end it.
  ok(await act('share-off', { id: e.id }));
  assert.equal((await spectator(t2)).status, 404);
  const { shareToken: t3 } = ok(await act('share', { id: e.id }));
  assert.equal((await spectator(t3)).status, 200);
  ok(await act('delete', { id: e.id }));
  assert.equal((await spectator(t3)).status, 404);
  assert.equal((await act('share', { id: e.id })).status, 404, 'a deleted event cannot be shared');
});
await step('the existing club data still loads with event games in it (ratings, progress, history)', async () => {
  const c = ok(await call(club, 'GET', { query: '?code=' + code }));
  assert.ok(c.games.length >= 5);
  assert.ok(c.progress && c.progress.players);
});

// Self-reported DUPR rating: set by the name's own phone or an organizer, never a stranger; display only.
const PIN = '482159';
ok(await call(club, 'POST', { body: { code, action: 'set-pin', pin: PIN, ownerToken: owner } }));
const sh = (body) => call(playersApi, 'POST', { body: { code, ...body } });
const dupr = async name => (ok(await call(club, 'GET', { query: '?code=' + code })).players.find(p => p.name === name) || {}).dupr;
let anaToken;
await step('DUPR: a name has none until set, and its phone can set, change and clear it', async () => {
  anaToken = ok(await sh({ action: 'claim', name: 'Ana', ownerToken: owner })).playerToken;
  assert.equal(await dupr('Ana'), null);
  assert.equal(ok(await sh({ action: 'dupr', name: 'Ana', playerToken: anaToken, rating: '3.52' })).dupr, 3.52);
  assert.equal(await dupr('Ana'), 3.52);
  ok(await sh({ action: 'dupr', name: 'Ana', playerToken: anaToken, rating: 4.125 }));
  assert.equal(await dupr('Ana'), 4.125);
  assert.equal(ok(await sh({ action: 'dupr', name: 'Ana', playerToken: anaToken, rating: '' })).dupr, null);
  assert.equal(await dupr('Ana'), null);
});
await step('DUPR: out of range, extra decimals and non-numbers are refused and change nothing', async () => {
  ok(await sh({ action: 'dupr', name: 'Ana', playerToken: anaToken, rating: '3.5' }));
  for (const rating of ['1.99', '8.001', '3.5217', 'abc', '-4', '1e1']) assert.equal((await sh({ action: 'dupr', name: 'Ana', playerToken: anaToken, rating })).status, 400, rating);
  assert.equal(await dupr('Ana'), 3.5);
});
await step('DUPR: a stranger, another player or a wrong PIN cannot set or clear it', async () => {
  assert.equal((await sh({ action: 'dupr', name: 'Ana', rating: '6' })).status, 403);
  assert.equal((await sh({ action: 'dupr', name: 'Ana', playerToken: 'f'.repeat(48), rating: '6' })).status, 403);
  assert.equal((await sh({ action: 'dupr', name: 'Ana', pin: '0000', rating: '6' })).status, 403);
  assert.equal((await sh({ action: 'dupr', name: 'Ana', rating: '' })).status, 403);
  const benToken = ok(await sh({ action: 'claim', name: 'Ben', ownerToken: owner })).playerToken;
  assert.equal((await sh({ action: 'dupr', name: 'Ana', playerToken: benToken, rating: '6' })).status, 403);
  assert.equal(await dupr('Ana'), 3.5);
});
await step('DUPR: an organizer (PIN or creator phone) can set it, including on a guest name', async () => {
  ok(await sh({ action: 'dupr', name: 'Ana', pin: PIN, rating: '5' }));
  assert.equal(await dupr('Ana'), 5);
  ok(await call(roster, 'POST', { body: { code, name: 'Guesty' } }));
  assert.equal((await sh({ action: 'dupr', name: 'Guesty', rating: '3' })).status, 403);
  ok(await sh({ action: 'dupr', name: 'Guesty', ownerToken: owner, rating: '3.1' }));
  assert.equal(await dupr('Guesty'), 3.1);
  assert.equal((await sh({ action: 'dupr', name: 'Nobody', ownerToken: owner, rating: '3' })).status, 404);
});
await step('DUPR: releasing a name clears it, and it never changes ratings or the club record', async () => {
  const before = JSON.stringify(ok(await call(club, 'GET', { query: '?code=' + code })).games);
  ok(await sh({ action: 'release', name: 'Ana', pin: PIN }));
  assert.equal(await dupr('Ana'), null);
  assert.equal(JSON.stringify(ok(await call(club, 'GET', { query: '?code=' + code })).games), before);
});
await step('DUPR: it is not in event responses', async () => {
  const list = JSON.stringify(ok(await call(events, 'GET', { query: '?code=' + code })));
  assert.ok(!/dupr/i.test(list));
});


await step('event results: players in the match and organizers by default, any member when the organizer allows it', async () => {
  const sh = body => call(playersApi, 'POST', { body: { code, ...body } });
  const pinSet = ok(await call(club, 'POST', { body: { code, action: 'set-pin', pin: PIN, ownerToken: owner } }));
  const e = ok(await create({ name: 'Who scores', format: 'roundrobin', rotation: 'auto', courts: 1, players: ['Pa', 'Pb', 'Pc', 'Pd', 'Pe', 'Pf', 'Pg', 'Ph'], seed: 'perm' }), 201).event;
  assert.equal(e.resultsBy, 'players', 'the default');
  const [m] = e.rounds[0].matches, playing = m.teams.flat().map(x => x.toLowerCase());
  const sitting = ['Pa', 'Pb', 'Pc', 'Pd', 'Pe', 'Pf', 'Pg', 'Ph'].find(n => !playing.includes(n.toLowerCase()));
  const inMatch = m.teams[0][0], inMatch2 = m.teams[1][1];
  const tok = {};
  for (const n of [inMatch, inMatch2, sitting]) tok[n] = ok(await sh({ action: 'claim', name: n, ownerToken: owner, pin: PIN })).playerToken;
  const res = (extra, matchId = m.id, score = [11, 5]) => call(events, 'POST', { body: { code, action: 'result', id: e.id, matchId, score, endedAt: Date.now(), ...extra } });
  let r = await res({});
  assert.equal(r.status, 403, 'a stranger with only the club code'); assert.match(r.json.error || r.json.message || '', /players in this match or an organizer/);
  r = await res({ playerName: sitting, playerToken: tok[sitting] });
  assert.equal(r.status, 403, 'a verified member who is not in the match');
  r = await res({ playerName: inMatch, playerToken: tok[sitting] });
  assert.equal(r.status, 403, 'a player name with someone else\'s token');
  r = await res({ playerName: inMatch, playerToken: 'f'.repeat(48) });
  assert.equal(r.status, 403, 'a guessed token');
  assert.equal((await res({ pin: '0000' })).status, 403, 'a wrong PIN is not an organizer');
  assert.equal((await clubGames()).filter(g => g.event && g.event.id === e.id).length, 0, 'nothing was saved by the refused tries');
  ok(await res({ playerName: inMatch, playerToken: tok[inMatch] }));
  assert.equal((await clubGames()).filter(g => g.event && g.event.id === e.id).length, 1, 'a player in the match');
  const m2 = e.rounds[0].matches[1];
  ok(await res({ pin: PIN }, m2 ? m2.id : m.id)); // organizer by PIN (or a retry of the same score when there is one court)
  // Organizer toggle: refused for members, allowed for organizers.
  assert.equal((await act('results-by', { id: e.id, who: 'club' }, { playerName: sitting, playerToken: tok[sitting] })).status, 403);
  assert.equal((await act('results-by', { id: e.id, who: 'nobody' })).status, 400);
  assert.equal(ok(await act('results-by', { id: e.id, who: 'club' })).event.resultsBy, 'club');
  const next = ok(await act('next-round', { id: e.id })).event;
  const nm = next.rounds[1].matches[0];
  ok(await call(events, 'POST', { body: { code, action: 'result', id: e.id, matchId: nm.id, score: [11, 3], endedAt: Date.now() } })); // any member, even with no proof
  const e2 = ok(await act('results-by', { id: e.id, who: 'players' })).event;
  assert.equal(e2.resultsBy, 'players');
  assert.equal(ok(await call(events, 'GET', { query: `?code=${code}&id=${e.id}` })).event.resultsBy, 'players');
  const e3 = ok(await create({ name: 'Open', format: 'roundrobin', players: ['Pa', 'Pb', 'Pc', 'Pd'], resultsBy: 'club' }), 201).event;
  assert.equal(e3.resultsBy, 'club', 'an organizer can start an event open to any member');
});
await step('watch scoring: per-game secret; publish, point and undo intents, ack clears them, end removes the game', async () => {
  const st = { cfg: { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, teams: [['Ana', 'Ben'], ['Cy', 'Di']] }, score: [0, 0], serving: 0, serverNum: 2, server: 0, rallies: 0, winner: null, startedAt: 123 };
  const SA = 'secretAAA111', SB = 'secretBBB222';
  const pub = (id, secret, state = st, ack = 0) => call(live, 'POST', { body: { code, action: 'state', id, secret, state, ack } });
  let r = await call(live, 'POST', { body: { code, action: 'point', game: 'live-t1', secret: SA, side: 0 } });
  assert.equal(r.status, 404, 'no live game yet');
  assert.equal((await pub('live-t1', '')).status, 400, 'publishing needs a secret');
  ok(await pub('live-t1', SA));
  ok(await pub('live-t2', SB, { ...st, score: [5, 5] }));
  assert.equal((await pub('live-t1', SB)).status, 403, 'another secret cannot take over a game');
  // A club-code-only intent (no game, no secret) is refused, and so is the wrong secret for a game.
  assert.equal((await call(live, 'POST', { body: { code, action: 'point', side: 0 } })).status, 400);
  assert.equal((await call(live, 'POST', { body: { code, action: 'point', game: 'live-t1', side: 0 } })).status, 403);
  assert.equal((await call(live, 'POST', { body: { code, action: 'point', game: 'live-t1', secret: SB, side: 0 } })).status, 403, 'game 2 secret does not drive game 1');
  r = ok(await call(live, 'POST', { body: { code, action: 'point', game: 'live-t1', secret: SA, side: 1 } }));
  assert.equal(r.pending, 1);
  assert.deepEqual(r.score, [0, 0], 'an intent does not change the published score by itself');
  ok(await call(live, 'POST', { body: { code, action: 'undo', game: 'live-t1', secret: SA } }));
  ok(await call(live, 'POST', { body: { code, action: 'point', game: 'live-t2', secret: SB, side: 0 } }));
  const q = (id, secret) => '?code=' + code + '&id=' + id + (secret ? '&secret=' + secret : '');
  assert.equal((await call(live, 'GET', { query: q('live-t1') })).status, 403, 'reading a game needs its secret');
  assert.equal((await call(live, 'GET', { query: q('live-t1', SB) })).status, 403);
  const got = ok(await call(live, 'GET', { query: q('live-t1', SA) }));
  assert.equal(got.intents.length, 2, 'only game 1 taps are in game 1');
  assert.equal(got.intents[0].kind, 'point'); assert.equal(got.intents[0].side, 1); assert.equal(got.intents[0].g, 'live-t1');
  assert.equal(got.intents[1].kind, 'undo');
  assert.equal(got.intents[0].sig, signIntent(SA, 'live-t1', got.intents[0].n, 'point', 1), 'each intent is signed with the secret');
  const got2b = ok(await call(live, 'GET', { query: q('live-t2', SB) }));
  assert.equal(got2b.intents.length, 1, 'game 2 has its own tap');
  assert.equal(got2b.intents[0].g, 'live-t2'); assert.equal(got2b.intents[0].side, 0);
  ok(await pub('live-t1', SA, { ...st, score: [0, 1] }, got.intents[1].n));
  const got2 = ok(await call(live, 'GET', { query: q('live-t1', SA) }));
  assert.equal(got2.intents.length, 0, 'acked intents are gone');
  assert.deepEqual(got2.state.score, [0, 1]);
  assert.equal(ok(await call(live, 'GET', { query: q('live-t2', SB) })).intents.length, 1, 'acking game 1 leaves game 2 alone');
  assert.equal((await call(live, 'POST', { body: { code, action: 'end', id: 'live-t1', secret: SB } })).status, 403); // wrong secret: nothing removed
  assert.equal((await call(live, 'GET', { query: q('live-t1', SA) })).status, 200, 'wrong secret did not end the game');
  ok(await call(live, 'POST', { body: { code, action: 'end', id: 'live-t1', secret: SA } }));
  r = await call(live, 'POST', { body: { code, action: 'point', game: 'live-t1', secret: SA, side: 0 } });
  assert.equal(r.status, 404, 'the game ended, so points bounce off');
  ok(await call(live, 'POST', { body: { code, action: 'end', id: 'live-t2', secret: SB } }));
});

// Importing players and teams from a sheet. Google is never called: fetch is stubbed for docs.google.com (everything else, such as
// the database driver, goes through the real fetch). A sheet's DUPR IDs are private references kept outside the event.
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBcD';
const sheetLink = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`;
const teamCsv = 'Team,Player 1,Player 2,DUPR ID 1,DUPR ID 2,Logo URL\r\nNet Ninjas,Ana,Ben,k4m2p9,R7T3QX,https://example.com/n.png\r\nDrop Shots,Cy,Di,,,\r\nKitchen Crew,Ed,Flo,,,https://example.com/k.png\r\nLob City,Gus,Hal,,,\r\n';
const realFetch = globalThis.fetch;
let googleCalls = [], googleReply = () => ({ status: 200, headers: new Headers({ 'content-type': 'text/csv; charset=utf-8' }), body: teamCsv });
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('google')) return realFetch(url, opts);
  googleCalls.push(String(url));
  const r = googleReply(String(url));
  return new Response(r.body, { status: r.status, headers: r.headers });
};
const sheetFetch = (url, creds = { ownerToken: owner }) => call(events, 'POST', { body: { code, action: 'sheet-fetch', url, ...creds } });
await step('sheet import: only an organizer can read a sheet, and only Google sheet links are fetched', async () => {
  googleCalls = [];
  assert.equal((await sheetFetch(sheetLink, {})).status, 403);
  assert.equal((await sheetFetch(sheetLink, { pin: '0000' })).status, 403);
  assert.equal(googleCalls.length, 0, 'no Google request without organizer rights');
  for (const bad of ['https://evil.com/spreadsheets/d/' + SHEET_ID, 'http://docs.google.com/spreadsheets/d/' + SHEET_ID, 'https://docs.google.com@evil.com/spreadsheets/d/' + SHEET_ID, 'file:///etc/passwd', '', 42])
    assert.equal((await sheetFetch(bad)).status, 400, String(bad));
  assert.equal(googleCalls.length, 0, 'bad links never reach fetch');
  const got = ok(await sheetFetch(sheetLink));
  assert.equal(got.csv, teamCsv);
  assert.deepEqual(googleCalls, [`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`]);
  ok(await sheetFetch(sheetLink, { pin: PIN }));
});
await step('sheet import: clear errors for a sheet that is private, missing, not CSV, empty or too large; redirects off Google are refused', async () => {
  const err = async reply => { googleReply = reply; return (await sheetFetch(sheetLink)); };
  let r = await err(() => ({ status: 302, headers: new Headers({ location: 'https://accounts.google.com/ServiceLogin' }) }));
  assert.equal(r.status, 422); assert.match(r.json.error, /Anyone with the link/);
  r = await err(() => ({ status: 302, headers: new Headers({ location: 'https://evil.example/x' }) }));
  assert.equal(r.status, 422); assert.ok(!googleCalls.some(u => u.includes('evil')));
  assert.equal((await err(() => ({ status: 404, headers: new Headers() }))).status, 404);
  assert.equal((await err(() => ({ status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: '<html>' }))).status, 422);
  assert.equal((await err(() => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: '{}' }))).status, 400);
  assert.match((await err(() => ({ status: 200, headers: new Headers({ 'content-type': 'text/csv' }), body: '  ' }))).json.error, /empty/);
  assert.match((await err(() => ({ status: 200, headers: new Headers({ 'content-type': 'text/csv' }), body: 'x'.repeat(600 * 1024) }))).json.error, /too large/);
  // one hop to Google's own download host is followed
  let n = 0;
  googleReply = () => (++n === 1 ? { status: 307, headers: new Headers({ location: 'https://doc-0k-9c-sheets.googleusercontent.com/export/x' }) } : { status: 200, headers: new Headers({ 'content-type': 'text/csv' }), body: teamCsv });
  assert.equal(ok(await sheetFetch(sheetLink)).csv, teamCsv);
  googleReply = () => ({ status: 200, headers: new Headers({ 'content-type': 'text/csv; charset=utf-8' }), body: teamCsv });
});
let imported;
await step('sheet import: a bracket is created from the sheet\'s teams, with names and logos, and the DUPR IDs stay private', async () => {
  const parsed = await import(pathToFileURL(path.join(root, 'sheet-import.js')).href);
  const draft = parsed.parseSheet(teamCsv).draft;
  const input = parsed.toEventInput(draft, { format: 'single_elim' });
  imported = ok(await create({ name: 'Sheet cup', format: 'single_elim', courts: 2, ...input, publicLogos: true }), 201).event;
  assert.deepEqual(imported.teams, [['Ana', 'Ben'], ['Cy', 'Di'], ['Ed', 'Flo'], ['Gus', 'Hal']]);
  assert.deepEqual(imported.teamInfo.map(t => t.name), ['Net Ninjas', 'Drop Shots', 'Kitchen Crew', 'Lob City']);
  assert.equal(imported.teamInfo[0].logo, 'https://example.com/n.png');
  assert.ok(!JSON.stringify(imported).includes('K4M2P9'));
  const full = ok(await call(events, 'GET', { query: `?code=${code}&id=${imported.id}` })).event;
  assert.ok(!JSON.stringify(full).includes('K4M2P9') && !JSON.stringify(full).includes('R7T3QX'), 'club members never see reference IDs in the event');
  assert.deepEqual(ok(await act('refs', { id: imported.id })).refs, { Ana: 'K4M2P9', Ben: 'R7T3QX' });
  assert.equal((await act('refs', { id: imported.id }, {})).status, 403, 'only organizers read them');
  assert.equal((await act('refs', { id: 'nope' })).status, 404);
});
await step('sheet import: the public bracket page shows team names and logos, never a DUPR ID, and logos can be switched off', async () => {
  const { shareToken } = ok(await act('share', { id: imported.id }));
  const pub = async () => ok(await call(bracket, 'GET', { query: '?token=' + shareToken }));
  let p = await pub();
  assert.deepEqual(p.teamInfo.map(t => t.name), ['Net Ninjas', 'Drop Shots', 'Kitchen Crew', 'Lob City']);
  assert.equal(p.teamInfo[0].logo, 'https://example.com/n.png');
  assert.ok(!/K4M2P9|R7T3QX|dupr/i.test(JSON.stringify(p)));
  assert.equal((await act('public-logos', { id: imported.id, on: false }, {})).status, 403);
  ok(await act('public-logos', { id: imported.id, on: false }));
  p = await pub();
  assert.ok(p.teamInfo.every(t => t.logo === '') && !JSON.stringify(p).includes('example.com'));
  assert.deepEqual(p.teamInfo.map(t => t.name)[0], 'Net Ninjas');
  ok(await act('public-logos', { id: imported.id, on: true }));
  assert.equal((await pub()).teamInfo[0].logo, 'https://example.com/n.png');
  assert.ok(!/K4M2P9|R7T3QX|dupr/i.test(JSON.stringify(ok(await call(events, 'GET', { query: '?code=' + code })))));
});
await step('sheet import: bad logos, wrong team counts, bad DUPR IDs and non-organizers are refused and create nothing', async () => {
  const before = ok(await call(events, 'GET', { query: '?code=' + code })).events.length;
  const base = { name: 'Bad', format: 'single_elim', rotation: 'manual', partners: 'fixed', players: ['Ana', 'Ben', 'Cy', 'Di'], teams: [['Ana', 'Ben'], ['Cy', 'Di']] };
  assert.equal((await create({ ...base, teamMeta: [{ name: 'A', logo: 'javascript:alert(1)' }, { name: 'B' }] })).status, 400);
  assert.equal((await create({ ...base, teamMeta: [{ name: 'A', logo: 'http://example.com/a.png' }, { name: 'B' }] })).status, 400);
  assert.equal((await create({ ...base, teamMeta: [{ name: 'A', logo: 'https://u:p@example.com/a.png' }, { name: 'B' }] })).status, 400);
  assert.equal((await create({ ...base, teamMeta: [{ name: 'A' }] })).status, 400);
  assert.equal((await create({ ...base, teamMeta: [{ name: 'A' }, { name: 'B' }], refs: { Ana: 'nope!' } })).status, 400);
  assert.equal((await create({ ...base, teamMeta: [{ name: 'A' }, { name: 'B' }] }, {})).status, 403);
  assert.equal(ok(await call(events, 'GET', { query: '?code=' + code })).events.length, before);
});
await step('sheet import: with rotating partners only the players are added (team names are not used)', async () => {
  const r = ok(await create({ name: 'Rot', format: 'roundrobin', partners: 'rotating', rotation: 'auto', players, rounds: 3, teamMeta: [{ name: 'Ignored' }], refs: { Ana: 'K4M2P9' } }), 201).event;
  assert.equal(r.teamInfo, undefined);
  assert.deepEqual(ok(await act('refs', { id: r.id })).refs, { Ana: 'K4M2P9' });
});
// Organizer protection by default, and club code rotation (N2).
const mk = async (extra = {}) => ok(await call(club, 'POST', { body: { name: 'Rot club', ...extra } }), 201);
const gm = id => ({ id, mode: 'singles', teams: [['Ann'], ['Bo']], score: [11, 5], endedAt: Date.now() - 1000 });
await step('new clubs always get an organizer credential: the PIN given, or a generated code shown once', async () => {
  const withPin = await mk({ pin: '556677' });
  assert.equal(withPin.organizerCode, undefined);
  assert.equal(withPin.club.hasPin, true);
  const gen = await mk();
  assert.match(gen.organizerCode, /^\d{8}$/);
  assert.equal(gen.club.hasPin, true);
  ok(await call(club, 'POST', { body: { code: gen.club.code, action: 'verify-pin', pin: gen.organizerCode } }));
  assert.equal((await call(club, 'POST', { body: { code: gen.club.code, action: 'verify-pin', pin: '00000000' } })).status, 403);
  assert.equal((await call(club, 'POST', { body: { name: 'Bad', pin: '12' } })).status, 400);
  assert.ok(!JSON.stringify(ok(await call(club, 'GET', { query: '?code=' + gen.club.code }))).includes(gen.organizerCode));
});
await step('a legacy club without a PIN is reported as unprotected and has no organizer-only rotation for strangers', async () => {
  const c = await mk();
  await pg.query("UPDATE clubs SET pin_hash = NULL WHERE code = $1", [c.club.code]); // simulate a club made before the default
  const got = ok(await call(club, 'GET', { query: '?code=' + c.club.code })).club;
  assert.equal(got.hasPin, false);
  const rot = body => call(club, 'POST', { body: { code: c.club.code, action: 'rotate-code', ...body } });
  assert.equal((await rot({})).status, 403, 'a bare code holder cannot rotate');
  assert.equal((await rot({ pin: '1234' })).status, 403);
  assert.equal((await rot({ ownerToken: 'f'.repeat(48) })).status, 403, 'a wrong creator token cannot rotate');
  ok(await rot({ ownerToken: c.ownerToken })); // the creating phone can
});
await step('rotate-code: who may do it', async () => {
  const c = await mk({ pin: '778899' });
  const rot = body => call(club, 'POST', { body: { code: c.club.code, action: 'rotate-code', ...body } });
  assert.equal((await rot({})).status, 403, 'no credential');
  assert.equal((await rot({ pin: '1111' })).status, 403, 'wrong PIN');
  assert.equal((await rot({ ownerToken: '0'.repeat(48) })).status, 403, 'wrong creator token');
  assert.equal((await rot({ pin: '778899', graceMinutes: -1 })).status, 400);
  assert.equal((await rot({ pin: '778899', graceMinutes: 99999 })).status, 400);
  assert.equal((await call(club, 'POST', { body: { code: 'ZZZZZZ', action: 'rotate-code', pin: '778899' } })).status, 404);
  assert.equal((await call(club, 'GET', { query: '?code=' + c.club.code })).status, 200, 'nothing changed after refusals');
  const r1 = ok(await rot({ pin: '778899' }));
  assert.notEqual(r1.club.code, c.club.code);
  assert.equal(r1.oldCode, c.club.code);
  const r2 = ok(await call(club, 'POST', { body: { code: r1.club.code, action: 'rotate-code', ownerToken: c.ownerToken, graceMinutes: 0 } }));
  assert.notEqual(r2.club.code, r1.club.code, 'the creating phone can rotate too');
});
await step('rotation: new code works, old code works during the overlap and says when it stops, then 404; data and roles carry over', async () => {
  const c = await mk({ pin: '246802' });
  const oldCode = c.club.code;
  ok(await call(games, 'POST', { body: { code: oldCode, games: [gm('rot-g1')] } }));
  const r = ok(await call(club, 'POST', { body: { code: oldCode, action: 'rotate-code', pin: '246802', graceMinutes: 30 } }));
  const newCode = r.club.code;
  const viaNew = ok(await call(club, 'GET', { query: '?code=' + newCode }));
  assert.equal(viaNew.club.code, newCode);
  assert.equal(viaNew.club.oldCodeUntil, undefined);
  assert.equal(viaNew.games.length, 1, 'games stay with the club');
  const viaOld = ok(await call(club, 'GET', { query: '?code=' + oldCode }));
  assert.equal(viaOld.club.code, newCode, 'a phone on the old code is told the new one');
  assert.ok(viaOld.club.oldCodeUntil > Date.now() && viaOld.club.oldCodeUntil < Date.now() + 31 * 6e4);
  ok(await call(games, 'POST', { body: { code: oldCode, games: [gm('rot-g2')] } })); // other endpoints accept either code
  ok(await call(roster, 'POST', { body: { code: newCode, name: 'Cy' } }));
  assert.equal(ok(await call(club, 'GET', { query: '?code=' + newCode })).games.length, 2);
  assert.equal((await call(games, 'DELETE', { query: `?code=${newCode}&id=rot-g1` })).status, 403, 'roles are unchanged: delete still needs the organizer');
  ok(await call(games, 'DELETE', { query: `?code=${oldCode}&id=rot-g1`, headers: { 'x-club-pin': '246802' } }));
  await pg.query("UPDATE club_aliases SET expires_at = now() - interval '1 second' WHERE code = $1", [oldCode]); // the overlap ends
  for (const call_ of [() => call(club, 'GET', { query: '?code=' + oldCode }), () => call(games, 'POST', { body: { code: oldCode, games: [gm('rot-g3')] } }), () => call(live, 'POST', { body: { code: oldCode, action: 'point', side: 0 } })]) {
    assert.equal((await call_()).status, 404, 'the old code stops working');
  }
  assert.equal((await call(club, 'GET', { query: '?code=' + newCode })).status, 200);
});
await step('rotation with no overlap cuts the old code at once; retired codes are never handed to another club', async () => {
  const c = await mk({ pin: '135790' });
  const r = ok(await call(club, 'POST', { body: { code: c.club.code, action: 'rotate-code', pin: '135790', graceMinutes: 0 } }));
  assert.equal((await call(club, 'GET', { query: '?code=' + c.club.code })).status, 404);
  assert.equal(ok(await call(club, 'GET', { query: '?code=' + r.club.code })).club.code, r.club.code);
  await pg.query("INSERT INTO club_aliases (code, club, expires_at) VALUES ('AAAAAA', $1, now() - interval '1 day')", [c.club.code]);
  const { codeTaken } = await import(pathToFileURL(path.join(root, 'api', '_db.js')).href);
  assert.equal(await codeTaken(neon.neon(process.env.DATABASE_URL), 'AAAAAA'), true);
});
await step('a stranger on a rotated club still needs the organizer for organizer actions; players of one club cannot use another club\'s code', async () => {
  const a = await mk({ pin: '999999' }), b = await mk({ pin: '888888' });
  const ra = ok(await call(club, 'POST', { body: { code: a.club.code, action: 'rotate-code', pin: '999999', graceMinutes: 5 } }));
  assert.equal((await call(club, 'POST', { body: { code: ra.club.code, action: 'rotate-code', pin: '888888' } })).status, 403, "another club's PIN does not work");
  assert.equal((await call(club, 'POST', { body: { code: ra.club.code, action: 'set-pin', pin: '121212', oldPin: '0000' } })).status, 403);
  assert.equal((await call(club, 'GET', { query: '?code=' + b.club.code })).json.club.code, b.club.code);
});
await step('the event list pages through every event the club keeps (60 and up to the 100 limit)', async () => {
  const page = async offset => ok(await call(events, 'GET', { query: `?code=${code}${offset == null ? '' : '&offset=' + offset}` }));
  const mk = i => create({ name: 'Paging ' + i, format: 'roundrobin', partners: 'rotating', rotation: 'auto', players, rounds: 3 });
  const walk = async () => { const ids = []; let off = 0, p; do { p = await page(off); assert.ok(p.events.length <= 50); ids.push(...p.events.map(e => e.id)); off += p.events.length; } while (p.more); return ids; };
  let n = (await walk()).length;
  for (; n < 60; n++) assert.equal((await mk(n)).status, 201);
  let ids = await walk();
  assert.equal(ids.length, 60, 'all 60 events are reachable');
  assert.equal(new Set(ids).size, 60, 'no event repeats or is skipped across pages');
  assert.equal((await page()).events.length, 50);
  assert.equal((await page()).more, true);
  assert.equal((await page(50)).events.length, 10);
  assert.equal((await page(50)).more, false);
  for (; n < 100; n++) assert.equal((await mk(n)).status, 201);
  ids = await walk();
  assert.equal(new Set(ids).size, 100, 'all 100 events are reachable');
  assert.equal((await mk(100)).status, 400, 'the 101st is refused');
  assert.equal((await page(-5)).events.length, 50, 'a bad offset falls back to the first page');
});
globalThis.fetch = realFetch;

await step('report endpoint: 204 and nothing sent when ERROR_REPORT_URL is unset; rejects GET', async () => {
  const report = await load('report');
  delete process.env.ERROR_REPORT_URL;
  const post = { method: 'POST', url: '/api/report', headers: {}, body: { message: 'x' } };
  let st = 0; await report(post, { setHeader() {}, end() { st = this.statusCode; } });
  assert.equal(st, 204);
  let g = 0; await report({ method: 'GET', url: '/api/report', headers: {} }, { setHeader() {}, end() { g = this.statusCode; } });
  assert.equal(g, 405);
});

const transfer = await load('transfer');
const xfer = (body, h = {}) => call(transfer, 'POST', { body, headers: h });
await step('transfer: stores a blob once, hands it over once, then it is gone', async () => {
  const id = 'a'.repeat(64), blob = 'QUJD';
  ok(await xfer({ action: 'create', id, blob }));
  const [row] = await pg.query('SELECT id_hash, blob FROM transfers').then(r => r.rows);
  assert.notEqual(row.id_hash, id, 'the id is stored hashed');
  assert.equal(ok(await xfer({ action: 'claim', id })).blob, blob);
  assert.equal((await xfer({ action: 'claim', id })).status, 404);
  assert.equal((await xfer({ action: 'create', id: 'zz', blob })).status, 400);
});
await step('transfer: an expired code is refused', async () => {
  const id = 'b'.repeat(64);
  ok(await xfer({ action: 'create', id, blob: 'QUJD' }));
  await pg.query("UPDATE transfers SET expires_at = now() - interval '1 minute'");
  assert.equal((await xfer({ action: 'claim', id })).status, 404);
});
await step('transfer: wrong codes are rate limited per address, and making codes too', async () => {
  const h = { 'x-real-ip': '203.0.113.9' };
  let last;
  for (let i = 0; i < 12; i++) last = await xfer({ action: 'claim', id: i.toString(16).padStart(64, '0') }, h);
  assert.equal(last.status, 429);
  const h2 = { 'x-real-ip': '203.0.113.10' };
  for (let i = 0; i < 10; i++) ok(await xfer({ action: 'create', id: (i + 100).toString(16).padStart(64, '0'), blob: 'QUJD' }, h2));
  assert.equal((await xfer({ action: 'create', id: 'c'.repeat(64), blob: 'QUJD' }, h2)).status, 429);
});
await step('recovery code: only the creator makes one; single use; expires; stored hashed; follows a rotated code', async () => {
  const c = ok(await call(club, 'POST', { body: { name: 'Recovery club' } }), 201);
  const cc = c.club.code;
  assert.equal((await xfer({ action: 'recovery-create', code: cc, ownerToken: 'nope' })).status, 403);
  const made = ok(await xfer({ action: 'recovery-create', code: cc, ownerToken: c.ownerToken }));
  const [{ recovery_hash }] = await pg.query('SELECT recovery_hash FROM clubs WHERE code = $1', [cc]).then(r => r.rows);
  assert.ok(recovery_hash && !made.recovery.replace(/-/g, '').includes(recovery_hash));
  assert.equal((await xfer({ action: 'recovery-redeem', code: cc, recovery: 'AAAA-AAAA-AAAA-AAAA' })).status, 403);
  const got = ok(await xfer({ action: 'recovery-redeem', code: cc, recovery: made.recovery.toLowerCase() }));
  assert.ok(got.ownerToken && got.ownerToken !== c.ownerToken);
  assert.equal((await xfer({ action: 'recovery-redeem', code: cc, recovery: made.recovery })).status, 403, 'single use');
  // the new token is the creator token now, the old one is not
  assert.equal((await xfer({ action: 'recovery-create', code: cc, ownerToken: c.ownerToken })).status, 403);
  const again = ok(await xfer({ action: 'recovery-create', code: cc, ownerToken: got.ownerToken }));
  await pg.query("UPDATE clubs SET recovery_expires = now() - interval '1 day' WHERE code = $1", [cc]);
  assert.equal((await xfer({ action: 'recovery-redeem', code: cc, recovery: again.recovery })).status, 403, 'expired');
  // after a code rotation the typed (public) code still resolves
  const again2 = ok(await xfer({ action: 'recovery-create', code: cc, ownerToken: got.ownerToken }));
  const rot = ok(await call(club, 'POST', { body: { code: cc, action: 'rotate-code', graceMinutes: 0, ownerToken: got.ownerToken } }));
  const back = ok(await xfer({ action: 'recovery-redeem', code: rot.club.code, recovery: again2.recovery }));
  assert.equal(back.club.code, rot.club.code);
});

// N3 / N3b: resource limits and organizer PIN hardening
await step('PINs: 6 to 8 digits for new or changed PINs; an older 4-digit PIN still unlocks and is flagged', async () => {
  const c2 = ok(await call(club, 'POST', { body: { name: 'PIN club' } }), 201);
  assert.equal((await call(club, 'POST', { body: { name: 'Short', pin: '1234' } })).status, 400);
  assert.equal((await call(club, 'POST', { body: { code: c2.club.code, action: 'set-pin', pin: '12345', ownerToken: c2.ownerToken } })).status, 400);
  ok(await call(club, 'POST', { body: { code: c2.club.code, action: 'set-pin', pin: '654321', ownerToken: c2.ownerToken } }));
  assert.equal(ok(await call(club, 'POST', { body: { code: c2.club.code, action: 'verify-pin', pin: '654321' } })).shortPin, false);
  // An old club: a 4-digit hash written straight to the table, as before the minimum existed.
  const { hashPin } = await import(pathToFileURL(path.join(root, 'api', '_db.js')).href);
  await pg.query('UPDATE clubs SET pin_hash = $1 WHERE code = $2', [hashPin('4821'), c2.club.code]);
  assert.equal(ok(await call(club, 'POST', { body: { code: c2.club.code, action: 'verify-pin', pin: '4821' } })).shortPin, true);
});
await step('PIN backoff: escalates per network, locks right guesses out too, spares a device already unlocked', async () => {
  const c3 = ok(await call(club, 'POST', { body: { name: 'Backoff club' } }), 201);
  ok(await call(club, 'POST', { body: { code: c3.club.code, action: 'set-pin', pin: '135790', ownerToken: c3.ownerToken } }));
  const h = { 'x-real-ip': '203.0.113.9' };
  const verify = pin => call(club, 'POST', { headers: h, body: { code: c3.club.code, action: 'verify-pin', pin } });
  const good = ok(await verify('135790'));
  assert.match(good.deviceKey, /^[0-9a-f]{64}$/);
  for (let i = 0; i < 5; i++) assert.equal((await verify('000000')).status, 403);
  const locked = await verify('000000');
  assert.equal(locked.status, 429);
  assert.equal((await verify('135790')).status, 429, 'a locked network refuses the right PIN too');
  // An unlocked phone sends its device key and keeps working from the same locked network.
  ok(await verify('000000:' + good.deviceKey));
  assert.equal((await verify('000000:' + '0'.repeat(64))).status, 429);
  // Another network is unaffected.
  ok(await call(club, 'POST', { headers: { 'x-real-ip': '203.0.113.77' }, body: { code: c3.club.code, action: 'verify-pin', pin: '135790' } }));
  // The device key stops working when the PIN changes.
  const changed = ok(await call(club, 'POST', { headers: { 'x-real-ip': '203.0.113.78' }, body: { code: c3.club.code, action: 'set-pin', pin: '246801', oldPin: '135790' } }));
  assert.notEqual(changed.deviceKey, good.deviceKey);
});
await step('address limits: an IPv6 caller is limited as a whole /64', async () => {
  const c4 = ok(await call(club, 'POST', { body: { name: 'v6 club' } }), 201);
  let last;
  for (let i = 0; i < 22; i++) last = await call(club, 'GET', { query: '?code=ZZZZZZ', headers: { 'x-real-ip': '2001:db8:1:2:' + (i + 1).toString(16) + '::' + i } });
  assert.equal(last.status, 429);
  ok(await call(club, 'GET', { query: '?code=' + c4.club.code, headers: { 'x-real-ip': '2001:db8:9:9::1' } }));
});
await step('club creation is throttled per network, and a bad PIN does not use up a creation', async () => {
  const h = { 'x-real-ip': '198.51.100.5' };
  for (let i = 0; i < 5; i++) assert.equal((await call(club, 'POST', { headers: h, body: { name: 'Bad', pin: '12' } })).status, 400);
  for (let i = 0; i < 10; i++) ok(await call(club, 'POST', { headers: h, body: { name: 'Club ' + i } }), 201);
  assert.equal((await call(club, 'POST', { headers: h, body: { name: 'One too many' } })).status, 429);
  ok(await call(club, 'POST', { headers: { 'x-real-ip': '198.51.100.6' }, body: { name: 'Elsewhere' } }), 201);
});
await step('game allowance counts only games that are not deleted, and an organizer can reset the pause', async () => {
  const c5 = ok(await call(club, 'POST', { body: { name: 'Allowance club' } }), 201);
  const mk = n => Array.from({ length: n }, (_, i) => gm('a' + i + '-' + Math.random().toString(36).slice(2)));
  const send = (n, extra = {}) => call(games, 'POST', { body: { code: c5.club.code, games: mk(n), ownerToken: c5.ownerToken, ...extra } });
  const r1 = await send(3);
  assert.ok(r1.status < 300, JSON.stringify(r1.json));
  const live = (await pg.query('SELECT count(*)::int AS n FROM games WHERE club = $1', [c5.club.code])).rows[0].n;
  assert.equal(live, 3);
  // Pretend a long history: total_count used to cap a club for good; it no longer matters.
  await pg.query('UPDATE clubs SET total_count = 999999 WHERE code = $1', [c5.club.code]);
  assert.ok((await send(1)).status < 300, 'a lifetime counter must not block new games');
  // Fill the 10-minute window, then an organizer resets it.
  await pg.query('UPDATE clubs SET window_count = 1200, window_start = now() WHERE code = $1', [c5.club.code]);
  assert.equal((await send(1)).status, 429);
  assert.equal((await call(club, 'POST', { body: { code: c5.club.code, action: 'reset-allowance' } })).status, 403);
  ok(await call(club, 'POST', { body: { code: c5.club.code, action: 'reset-allowance', ownerToken: c5.ownerToken } }));
  assert.ok((await send(1)).status < 300);
});
await step('live games: each club keeps at most 20 open at once, stale ones expire', async () => {
  const c6 = ok(await call(club, 'POST', { body: { name: 'Live club' } }), 201);
  const st = { score: [0, 0], serving: 0, cfg: { mode: 'singles' }, winner: null };
  const put = id => call(live, 'POST', { body: { code: c6.club.code, action: 'state', id, state: st, secret: 'secret123' } });
  for (let i = 0; i < 20; i++) ok(await put('g' + i));
  assert.equal((await put('overflow')).status, 429);
  ok(await put('g3')); // updating one that exists is always fine
  await pg.query("UPDATE live_games SET updated_at = now() - interval '2 days' WHERE club = $1 AND id = 'g0'", [c6.club.code]);
  ok(await put('overflow'));
});
await step('photo avatars: kept out of the club payload, served lazily, capped per club', async () => {
  const c7 = ok(await call(club, 'POST', { body: { name: 'Photo club' } }), 201);
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(500);
  const toks = {};
  const setAv = async name => {
    if (!toks[name]) toks[name] = ok(await call(playersApi, 'POST', { body: { code: c7.club.code, action: 'claim', name, ownerToken: c7.ownerToken } })).playerToken;
    return call(playersApi, 'POST', { body: { code: c7.club.code, action: 'avatar', name, avatar: { type: 'photo', value: photo }, playerToken: toks[name] } });
  };
  const first = await setAv('Ana');
  assert.ok(first.status < 300, JSON.stringify(first.json));
  const main = ok(await call(club, 'GET', { query: '?code=' + c7.club.code }));
  assert.ok(!JSON.stringify(main).includes('AAAAAAAAAA'), 'the photo bytes are not in the main payload');
  assert.equal(main.players.find(p => p.name === 'Ana').avatar.type, 'photo');
  const lazy = ok(await call(club, 'GET', { query: '?code=' + c7.club.code + '&avatars=1' }));
  assert.equal(lazy.photos.Ana.value, photo);
  assert.equal(lazy.photos.Ana.v, main.players.find(p => p.name === 'Ana').avatar.v);
  for (let i = 1; i < 50; i++) await pg.query("INSERT INTO roster (club, name, name_key, avatar) VALUES ($1, $2, $3, $4::jsonb)", [c7.club.code, 'P' + i, 'p' + i, JSON.stringify({ type: 'photo', value: photo })]);
  assert.equal((await setAv('Zed')).status, 409);
  assert.ok((await setAv('Ana')).status < 300, 'replacing your own photo is fine');
});

await step('Dinks and the shop are gone: no routes, and recording, editing and deleting a game never touch Dinks tables', async () => {
  const fs = await import('node:fs');
  for (const f of ['shop.js', '_dinks.js']) assert.ok(!fs.existsSync(path.join(root, 'api', f)), f + ' should not exist');
  assert.ok(!/shop|dinks/i.test(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8').replace(/"script-src[^"]*"/g, '')), 'no shop or dinks route in vercel.json');
  await assert.rejects(import(pathToFileURL(path.join(root, 'api', 'shop.js')).href));
  const purchases = async () => (await pg.query('SELECT count(*)::int AS n FROM purchases')).rows[0].n;
  const before = await purchases();
  const g = Object.assign(gm('nodinks-1'), { winner: 0 });
  ok(await call(games, 'POST', { body: { code, games: [g], ownerToken: owner } }));
  ok(await call(games, 'POST', { body: { code, edit: Object.assign({}, g, { score: [11, 7] }), ownerToken: owner } }));
  ok(await call(games, 'DELETE', { query: `?code=${code}&id=nodinks-1`, headers: { 'x-club-owner': owner } }));
  assert.equal(await purchases(), before, 'no purchase rows written');
  const data = ok(await call(club, 'GET', { query: '?code=' + code }));
  for (const k of ['shop', 'purchases']) assert.ok(!(k in data), k + ' is no longer sent');
  assert.ok(data.players.every(p => !('equipped' in p)));
  for (const p of Object.values(data.progress.players)) for (const k of ['earned', 'base', 'bonus']) assert.ok(!(k in p), k);
  assert.ok(!('prizes' in data.progress.season) && !('prestigeDinks' in data.progress.levels));
});

console.log(`\n${passed} API checks passed against a throwaway in-memory Postgres.`);
server.close(); await pg.close(); process.exit(0);
