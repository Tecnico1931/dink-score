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
  const out = {};
  const res = { statusCode: 0, setHeader(k, v) { out[k.toLowerCase()] = v; }, end(t) { status = res.statusCode; text = t || ''; } };
  await handler(req, res);
  return { status, json: text ? JSON.parse(text) : null, headers: out, bytes: Buffer.byteLength(text) };
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
await step('paddles: only the linked phone reads or writes them, photos follow the avatar limits, and they never reach the club payload', async () => {
  const pad = (action, extra) => sh({ action, name: 'Ana', ...extra });
  assert.deepEqual(ok(await pad('paddles-get', { playerToken: anaToken })).paddles, { list: [], used: {} });
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(200);
  const doc = { list: [{ id: 'ab12', name: 'Vanguard', photo }, { id: 'cd34', name: 'Joola' }], used: { 'g-pad1': 'ab12', 'g-pad2': 'gone' } };
  assert.deepEqual(ok(await pad('paddles-set', { playerToken: anaToken, paddles: doc })).paddles.used, { 'g-pad1': 'ab12' }, 'a tag for a missing paddle is dropped');
  assert.equal(ok(await pad('paddles-get', { playerToken: anaToken })).paddles.list[0].photo, photo);
  // Not the organizer, not another phone, not a bad token.
  for (const creds of [{ pin: PIN }, { ownerToken: owner }, { playerToken: 'f'.repeat(48) }, {}]) {
    assert.equal((await pad('paddles-get', creds)).status, 403);
    assert.equal((await pad('paddles-set', { ...creds, paddles: doc })).status, 403);
  }
  // Same limits as an avatar photo.
  for (const bad of ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,' + 'A'.repeat(60000), 'https://x.test/p.jpg']) {
    assert.equal((await pad('paddles-set', { playerToken: anaToken, paddles: { list: [{ id: 'ab12', name: 'x', photo: bad }], used: {} } })).status, 400);
  }
  assert.equal((await pad('paddles-set', { playerToken: anaToken, paddles: { list: Array.from({ length: 7 }, (_, i) => ({ id: 'p' + i + 'xyz', name: 'p' })), used: {} } })).status, 400);
  // Private: never in the club payload, the sync digest or the live list.
  const clubJson = JSON.stringify(ok(await call(club, 'GET', { query: '?code=' + code })));
  assert.ok(!clubJson.includes('Vanguard') && !clubJson.includes(photo) && !/paddle/i.test(clubJson));
  // Your own export has it.
  const exp = ok(await sh({ action: 'export', name: 'Ana', playerToken: anaToken }));
  assert.equal(exp.player.paddles.list.length, 2);
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

await step('scoring rules parity: the server port matches the client PB, rally for rally', async () => {
  const { rally: sRally, call: sCall } = await import('../api/_pb.js');
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
  const at = html.indexOf('const PB = (() => {');
  const src = html.slice(at, html.indexOf('})();', at) + 5);
  const PB = new Function(src + '; return PB;')();
  const strip = x => { const c = JSON.parse(JSON.stringify(x)); delete c.endedAt; return c; };
  const patterns = [[0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0], [1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
  for (const cfg of [
    { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, first: 0, teams: [['A', 'B'], ['C', 'D']] },
    { mode: 'doubles', scoring: 'rally', target: 15, winBy: 2, first: 1, teams: [['A', 'B'], ['C', 'D']] },
    { mode: 'singles', scoring: 'sideout', target: 11, winBy: 2, first: 0, teams: [['A'], ['C']] },
    { mode: 'singles', scoring: 'rally', target: 21, winBy: 1, first: 0, teams: [['A'], ['C']] },
  ]) {
    for (const pat of patterns) {
      let a = PB.newGame(cfg), b = JSON.parse(JSON.stringify(a));
      for (const w of pat) {
        a = PB.rally(a, w); b = sRally(b, w);
        assert.deepEqual(strip(b), strip(a));
        assert.deepEqual(sCall(b), PB.call(a));
        if (a.winner !== null) break;
      }
    }
  }
});

await step('shared scoring: the server referees rallies; the club list shows players and scores', async () => {
  const st = { cfg: { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, teams: [['Ana', 'Ben'], ['Cy', 'Di']] }, score: [0, 0], serving: 0, serverNum: 2, right: [0, 0], server: 0, rallies: 0, switched: false, justSwitched: false, winner: null, startedAt: 456, endedAt: null };
  const SM = 'secretMMM333';
  const rally = (game, secret, side, base) => call(live, 'POST', { body: { code, action: 'rally', game, secret, side, ...(base !== undefined ? { base } : {}) } });
  const unrally = (game, secret, base) => call(live, 'POST', { body: { code, action: 'unrally', game, secret, ...(base !== undefined ? { base } : {}) } });
  ok(await call(live, 'POST', { body: { code, action: 'state', id: 'live-m1', secret: SM, state: st, ack: 0 } }));
  // The club list needs only the club code and shows players + the score as it stands.
  const list = ok(await call(live, 'GET', { query: '?code=' + code }));
  const mine = list.games.find(g => g.id === 'live-m1');
  assert.ok(mine, 'the live game is listed');
  assert.deepEqual(mine.teams, [['Ana', 'Ben'], ['Cy', 'Di']]);
  assert.deepEqual(mine.score, [0, 0]);
  assert.equal((await rally('live-m1', 'secretXXX999', 0)).status, 403, 'a rally needs the game secret');
  assert.equal((await call(live, 'POST', { body: { code, action: 'rally', secret: SM, side: 0 } })).status, 400, 'a rally needs a game');
  let r = ok(await rally('live-m1', SM, 0));
  assert.deepEqual(r.state.score, [1, 0], 'the serving team scores');
  assert.equal(r.say, 'Score: 1, 0, 2');
  const v1 = r.version;
  r = ok(await rally('live-m1', SM, 1, v1));
  assert.deepEqual(r.state.score, [1, 0], 'a receiving-team rally is a side out, not a point');
  assert.equal(r.state.serving, 1); assert.equal(r.state.serverNum, 1);
  assert.equal(r.say, 'Score: 0, 1, 1');
  const stale = ok(await rally('live-m1', SM, 0, v1));
  assert.equal(stale.ok, false, 'a stale base answers with a conflict, not a score');
  assert.equal(stale.conflict, true);
  assert.deepEqual(stale.state.score, [1, 0]);
  r = ok(await unrally('live-m1', SM));
  assert.equal(r.state.serving, 0, 'undo gives the serve back');
  assert.deepEqual(r.state.score, [1, 0]);
  r = ok(await unrally('live-m1', SM));
  assert.deepEqual(r.state.score, [0, 0], 'undo reaches the start');
  r = ok(await unrally('live-m1', SM));
  assert.equal(r.unchanged, true, 'nothing left to undo is a no-op, not an error');
  const got = ok(await call(live, 'GET', { query: '?code=' + code + '&id=live-m1&secret=' + SM }));
  assert.equal(got.version, r.version, 'the scoring phone reads the same version');
  // An old-style intent still lands in the queue, and the ack action clears it.
  ok(await call(live, 'POST', { body: { code, action: 'point', game: 'live-m1', secret: SM, side: 0 } }));
  const withIntent = ok(await call(live, 'GET', { query: '?code=' + code + '&id=live-m1&secret=' + SM }));
  assert.equal(withIntent.intents.length, 1);
  ok(await call(live, 'POST', { body: { code, action: 'ack', game: 'live-m1', secret: SM, ack: withIntent.intents[0].n } }));
  assert.equal(ok(await call(live, 'GET', { query: '?code=' + code + '&id=live-m1&secret=' + SM })).intents.length, 0, 'acked intents are gone');
  // A finished game refuses more rallies.
  const quick = { ...st, cfg: { ...st.cfg, target: 1, winBy: 1 }, startedAt: 789 };
  ok(await call(live, 'POST', { body: { code, action: 'state', id: 'live-m2', secret: SM, state: quick, ack: 0 } }));
  r = ok(await rally('live-m2', SM, 0));
  assert.equal(r.state.winner, 0); assert.equal(r.say, 'Game over');
  assert.equal((await rally('live-m2', SM, 1)).status, 409, 'no rallies after the game ends');
  ok(await call(live, 'POST', { body: { code, action: 'end', id: 'live-m1', secret: SM } }));
  ok(await call(live, 'POST', { body: { code, action: 'end', id: 'live-m2', secret: SM } }));
  const after = ok(await call(live, 'GET', { query: '?code=' + code }));
  assert.ok(!after.games.some(g => g.id === 'live-m1' || g.id === 'live-m2'), 'ended games leave the list');
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
  assert.ok(!('prizes' in data.progress.season));
});

await step('levels, XP and prestige are gone: no fields in the club payload, the prestige action is refused, the rest of progress stays', async () => {
  const data = ok(await call(club, 'GET', { query: '?code=' + code }));
  assert.ok(!('levels' in data.progress), 'no levels block');
  for (const p of Object.values(data.progress.players)) for (const k of ['xp', 'level', 'levels']) assert.ok(!(k in p), k);
  assert.ok(data.players.every(p => !('prestige' in p)), 'no prestige on saved players');
  assert.ok(!/\b(xp|level|prestige)/i.test(JSON.stringify(data)), 'no XP, level or prestige anywhere in the payload');
  await pg.query('DELETE FROM lookup_fails'); // earlier steps used up this address's wrong-code allowance
  const r = await sh({ action: 'prestige', name: 'Ana', playerToken: anaToken, ownerToken: owner });
  assert.equal(r.status, 400, 'prestige is an unknown action now');
  assert.ok(data.progress.achievements.length && data.progress.challenges.length && data.progress.week.challenges.length === 3 && data.progress.season.id);
  assert.ok(Object.values(data.progress.players).some(p => p.achievements.length), 'achievements still computed');
});

// Rally logs: a game scored live carries who won each rally so it can be replayed (api/_rallylog.js).
const { replay: replayLog, encode: encodeLog } = await import(pathToFileURL(path.join(root, 'api', '_rallylog.js')).href);
const playLog = (cfg, bias, seed) => { // a whole game as a log, from a made-up but repeatable sequence of rally winners
  let x = seed; const wins = [];
  do { x = (x * 1664525 + 1013904223) >>> 0; wins.push(x / 2 ** 32 < bias ? 0 : 1); } while (replayLog(cfg, 0, wins).at(-1).winner === null);
  const end = replayLog(cfg, 0, wins).at(-1);
  return { wins, raw: encodeLog(0, wins), score: end.score, winner: end.winner };
};
const dcfg = { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2 };
const live1 = playLog(dcfg, 0.6, 5);
const rg = (id, extra = {}) => ({ id, ...dcfg, teams: [['Ana', 'Ben'], ['Cy', 'Di']], score: live1.score, winner: live1.winner, rallies: live1.wins.length, startedAt: Date.now() - 900000, endedAt: Date.now() - 1000, rallyLog: live1.raw, ...extra });
const logOf = async id => ok(await call(games, 'GET', { query: `?code=${code}&id=${id}` })).rallyLog;
const inClub = async id => (await clubGames()).find(g => g.id === id);
await step('rally log: a valid log is stored beside the game, the club list only says it can be replayed', async () => {
  const r = ok(await call(games, 'POST', { body: { code, games: [rg('rl-ok')] } }));
  assert.equal(r.saved, 1); assert.equal(r.rejectedLogs, undefined);
  assert.equal(await logOf('rl-ok'), live1.raw);
  const g = await inClub('rl-ok');
  assert.equal(g.replay, true);
  assert.ok(!('rallyLog' in g), 'the log itself is not in the club payload');
  assert.ok(!JSON.stringify(g).includes(live1.raw));
  const plain = ok(await call(games, 'POST', { body: { code, games: [gm('rl-none')] } }));
  assert.equal(plain.saved, 1);
  assert.equal(await logOf('rl-none'), null);
  assert.ok(!('replay' in (await inClub('rl-none'))));
  assert.equal((await call(games, 'GET', { query: `?code=${code}&id=nope-nope` })).status, 404);
  assert.equal((await call(games, 'GET', { query: `?code=ZZZZZZ&id=rl-ok` })).status, 404);
});
await step('rally log: tampered, oversized or mismatched logs are dropped and the game is still saved', async () => {
  const flip = live1.raw.slice(0, 4) + (live1.raw[4] === '0' ? '1' : '0') + live1.raw.slice(5);
  const bad = {
    'rl-flip': { rallyLog: flip },
    'rl-extra': { rallyLog: live1.raw + '1' },
    'rl-short': { rallyLog: live1.raw.slice(0, -1) },
    'rl-score': { score: [live1.score[0], live1.score[1] + 1] },
    'rl-big': { rallyLog: '0:' + '01'.repeat(500), rallies: 1000 },
    'rl-junk': { rallyLog: '0:abc' },
    'rl-type': { rallyLog: { x: 1 } },
    'rl-hand': { logged: true },
    'rl-count': { rallies: live1.wins.length + 3 },
    'rl-rules': { scoring: 'rally' }
  };
  const r = ok(await call(games, 'POST', { body: { code, games: Object.entries(bad).map(([id, x]) => rg(id, x)) } }));
  assert.equal(r.saved, Object.keys(bad).length, 'every game is still saved');
  assert.deepEqual([...r.rejectedLogs].sort(), Object.keys(bad).sort());
  for (const id of Object.keys(bad)) { assert.equal(await logOf(id), null, id); assert.ok(!(await inClub(id)).replay, id); }
});
await step('rally log: editing the score clears it; editing only the date or names keeps it', async () => {
  const edit = (id, x) => call(games, 'POST', { body: { code, edit: rg(id, x), ownerToken: owner } });
  ok(await call(games, 'POST', { body: { code, games: [rg('rl-edit1'), rg('rl-edit2')] } }));
  ok(await edit('rl-edit1', { endedAt: Date.now() - 5000, teams: [['Ana', 'Eli'], ['Cy', 'Di']], rallyLog: undefined }));
  assert.equal(await logOf('rl-edit1'), live1.raw, 'the date and a name changed, the result did not');
  assert.equal((await inClub('rl-edit1')).replay, true);
  ok(await edit('rl-edit2', { score: [live1.score[0], live1.score[1] - 1], rallyLog: live1.raw }));
  assert.equal(await logOf('rl-edit2'), null, 'a corrected score clears the log, even when the edit sends it back');
  assert.ok(!(await inClub('rl-edit2')).replay);
  ok(await edit('rl-edit1', { target: 15, score: [15, 3], winner: 0 }));
  assert.equal(await logOf('rl-edit1'), null, 'a changed target clears it too');
});
await step('rally log: event matches scored live keep their log; correcting the score clears it', async () => {
  const c = await mk(), cc = c.club.code, co = c.ownerToken; // a fresh club: the main one is at its event limit by now
  const ev_ = (action, extra) => call(events, 'POST', { body: { code: cc, action, ownerToken: co, ...extra } });
  const logIn = async id => ok(await call(games, 'GET', { query: `?code=${cc}&id=${id}` })).rallyLog;
  const gameIn = async id => ok(await call(club, 'GET', { query: '?code=' + cc })).games.find(g => g.id === id);
  const e = ok(await ev_('create', { event: { name: 'Replay cup', format: 'roundrobin', rotation: 'auto', courts: 2, players, seed: 'rl' } }), 201).event;
  const [m, m2] = e.rounds[0].matches;
  const l = playLog({ mode: 'doubles', scoring: e.scoring, target: e.target, winBy: e.winBy }, 0.55, 9);
  const body = { id: e.id, startedAt: Date.now() - 600000, endedAt: Date.now(), rallies: l.wins.length, live: true };
  const gid = `${e.id}-${m.id}`;
  ok(await ev_('result', { ...body, matchId: m.id, score: l.score, rallyLog: l.raw }));
  assert.equal(await logIn(gid), l.raw);
  assert.equal((await gameIn(gid)).replay, true);
  assert.ok(!JSON.stringify(ok(await call(events, 'GET', { query: `?code=${cc}&id=${e.id}` }))).includes(l.raw), 'the event itself does not carry the log');
  // a mismatched log is dropped without refusing the result
  ok(await ev_('result', { ...body, matchId: m2.id, score: l.score, rallyLog: l.raw.slice(0, -1) }));
  assert.equal(await logIn(`${e.id}-${m2.id}`), null);
  assert.ok(await gameIn(`${e.id}-${m2.id}`), 'the game itself was saved');
  ok(await ev_('correct', { id: e.id, matchId: m.id, score: [l.score[0], l.score[1] === 0 ? 1 : l.score[1] - 1] }));
  assert.equal(await logIn(gid), null);
  assert.ok(!(await gameIn(gid)).replay);
});
await step('rally log: the column is additive and nullable, so older rows and old clients are untouched', async () => {
  const col = (await pg.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'rally_log'")).rows;
  assert.deepEqual(col.map(c => c.is_nullable), ['YES']);
  const total = (await pg.query('SELECT count(*)::int AS n FROM games')).rows[0].n;
  const withLog = (await pg.query('SELECT count(*)::int AS n FROM games WHERE rally_log IS NOT NULL')).rows[0].n;
  assert.ok(withLog > 0 && withLog < total);
});

// ---- undo for organizer changes (L19): a role change or a rename, once, within 7 days; merges never ----
{
  const PIN = '735194';
  const made = ok(await call(club, 'POST', { body: { name: 'Undo club', pin: PIN } }), 201);
  const uc = made.club.code, own = { ownerToken: made.ownerToken };
  const P = (body, creds = own) => call(playersApi, 'POST', { body: { code: uc, ...body, ...creds } });
  const log = async () => ok(await P({ action: 'members' })).audit;
  const last = async action => (await log()).find(a => a.action === action);
  await step('undo: a promotion is undone once, logged, and a later role change blocks it', async () => {
    const tok = ok(await P({ action: 'claim', name: 'Ana' }, {})).playerToken;
    ok(await P({ action: 'claim', name: 'Ben' }, {}));
    ok(await P({ action: 'set-role', name: 'Ana', role: 'organizer' }));
    const promo = await last('promote');
    assert.ok(promo.undoable && !promo.undone);
    assert.equal((await P({ action: 'undo', id: promo.id }, { playerToken: tok, playerName: 'Ana' })).status, 403, 'only organizers undo');
    ok(await P({ action: 'undo', id: promo.id }));
    const members = ok(await P({ action: 'members' })).members;
    assert.equal(members.find(m => m.name === 'Ana').role, 'player');
    assert.ok((await log()).find(a => a.id === promo.id).undone, 'the original is marked');
    const u = await last('undo');
    assert.deepEqual([u.target, u.detail.undid], ['Ana', 'promote']);
    assert.equal((await P({ action: 'undo', id: promo.id })).status, 409, 'once only');
    assert.equal((await P({ action: 'undo', id: u.id })).status, 409, 'an undo is not itself undoable');
    ok(await P({ action: 'set-role', name: 'Ben', role: 'organizer' }));
    const benPromo = await last('promote');
    ok(await P({ action: 'set-role', name: 'Ben', role: 'player' }));
    assert.equal((await P({ action: 'undo', id: benPromo.id })).status, 409, 'the role changed again since');
    const demote = await last('demote');
    ok(await P({ action: 'undo', id: demote.id })); // puts Ben back as an organizer
    assert.equal(ok(await P({ action: 'members' })).members.find(m => m.name === 'Ben').role, 'organizer');
  });
  await step('undo: a co-organizer can undo a rename but not a role change; a rename goes back with games and the phone pointer', async () => {
    const coTok = ok(await P({ action: 'claim', name: 'Cy' }, {})).playerToken;
    ok(await P({ action: 'set-role', name: 'Cy', role: 'organizer' }));
    const co = { ownerToken: `${coTok}:Cy` }; // a co-organizer's credential goes where the owner token does
    ok(await call(games, 'POST', { body: { code: uc, games: [{ id: 'u-g001', mode: 'doubles', teams: [['Di', 'Ed'], ['Fay', 'Gus']], score: [11, 4], endedAt: Date.now() - 5000 }], ...own } }));
    ok(await P({ action: 'rename', name: 'Di', newName: 'Dina' }, co));
    const ren = await last('rename');
    assert.deepEqual([ren.target, ren.detail.from, ren.undoable], ['Dina', 'Di', true]);
    const promo = await last('promote');
    assert.equal((await P({ action: 'undo', id: promo.id }, co)).status, 403);
    ok(await P({ action: 'undo', id: ren.id }, co));
    const v = ok(await call(club, 'GET', { query: '?code=' + uc }));
    assert.ok(v.players.some(p => p.name === 'Di') && !v.players.some(p => p.name === 'Dina'));
    assert.deepEqual(v.games.find(g => g.id === 'u-g001').teams, [['Di', 'Ed'], ['Fay', 'Gus']]);
    assert.equal(v.renamed.dina, 'Di', 'a phone still holding the new name follows it back');
    assert.ok(!v.renamed.di);
    assert.equal((await last('undo')).target, 'Di');
  });
  await step('undo: a rename is blocked when the old name is taken, the player is gone or the window passed; merges are not undoable', async () => {
    ok(await P({ action: 'rename', name: 'Ed', newName: 'Eddie' }));
    const ren = await last('rename');
    ok(await call(roster, 'POST', { body: { code: uc, name: 'Ed' } }));
    assert.equal((await P({ action: 'undo', id: ren.id })).status, 409, 'Ed is a saved player again');
    ok(await P({ action: 'rename', name: 'Fay', newName: 'Faye' }));
    const ren2 = await last('rename');
    ok(await call(roster, 'POST', { body: { code: uc, name: 'Hal' } }));
    ok(await P({ action: 'merge', name: 'Faye', into: 'Hal' }));
    const mrg = await last('merge');
    assert.equal(mrg.undoable, false);
    assert.equal((await P({ action: 'undo', id: mrg.id })).status, 409);
    assert.equal((await P({ action: 'undo', id: ren2.id })).status, 409, 'Faye is gone');
    ok(await P({ action: 'rename', name: 'Gus', newName: 'Gustav' }));
    const old = await last('rename');
    await pg.query("UPDATE club_audit SET at = now() - interval '8 days' WHERE id = $1", [old.id]);
    assert.equal((await P({ action: 'undo', id: old.id })).status, 409, 'past 7 days');
    assert.equal((await log()).find(a => a.id === old.id).undoable, false);
    assert.equal((await P({ action: 'undo', id: 999999 })).status, 404);
    assert.equal((await P({ action: 'undo', id: 'x' })).status, 404);
  });
}
// ---- player names: normalisation, did-you-mean, rename and merge ----
{
  const PIN = '482916';
  const made = ok(await call(club, 'POST', { body: { name: 'Names club', pin: PIN } }), 201);
  const nc = made.club.code, no = made.ownerToken;
  const org = { ownerToken: no };
  const P = (body, creds = org) => call(playersApi, 'POST', { body: { code: nc, ...body, ...creds } });
  const G = async (id, teams, creds = org) => ok(await call(games, 'POST', { body: { code: nc, games: [{ id, mode: 'doubles', teams, score: [11, 4], endedAt: Date.now() - 5000 }], ...creds } }));
  const view = async () => ok(await call(club, 'GET', { query: '?code=' + nc }));
  const names = async () => (await view()).players.map(p => p.name).sort();
  await step('names: accents typed two ways and different case are one player', async () => {
    await G('n-g001', [['José', 'Ben'], ['Cy', 'Di']]); // "e" + combining accent
    await G('n-g002', [['JOSÉ', 'Ben'], ['Cy', 'Di']]);
    const v = await view();
    assert.deepEqual(v.players.map(p => p.name).sort(), ['Ben', 'Cy', 'Di', 'José']);
    assert.ok(v.games.every(g => [...g.teams[0], ...g.teams[1]].every(n => n === n.normalize('NFC'))), 'stored names are NFC');
    ok(await call(roster, 'POST', { body: { code: nc, name: '  josé   ' } })); // same key: not a new player, no prompt
    assert.equal((await names()).length, 4);
  });
  await step('names: a near duplicate is held back with a "did you mean" until confirmed, on roster and claim', async () => {
    let r = await call(roster, 'POST', { body: { code: nc, name: 'Jose' } });
    assert.equal(r.status, 409); assert.deepEqual(r.json.similar, ['José']); assert.match(r.json.error, /Did you mean José/);
    r = await P({ action: 'claim', name: 'Jose' }, {});
    assert.equal(r.status, 409); assert.deepEqual(r.json.similar, ['José']);
    assert.equal((await names()).length, 4, 'nothing was added');
    ok(await call(roster, 'POST', { body: { code: nc, name: 'Jose', confirmNew: true } }));
    assert.deepEqual((await names()).filter(n => n.startsWith('Jos')).sort(), ['Jose', 'José']);
    ok(await call(roster, 'POST', { body: { code: nc, name: 'Zoe' } })); // not similar to anyone
    ok(await call(roster, 'DELETE', { query: `?code=${nc}&name=Zoe`, headers: { 'x-club-pin': PIN } }));
  });
  let joseToken;
  await step('names: rename and merge are organizer only', async () => {
    joseToken = ok(await P({ action: 'claim', name: 'José', confirmNew: true }, {})).playerToken;
    for (const creds of [{}, { pin: '000000' }, { ownerToken: 'f'.repeat(48) }, { playerToken: joseToken, playerName: 'José' }]) {
      assert.equal((await P({ action: 'rename', name: 'Cy', newName: 'Cyrus' }, creds)).status, 403);
      assert.equal((await P({ action: 'merge', name: 'Jose', into: 'José' }, creds)).status, 403);
    }
    assert.ok((await names()).includes('Cy'), 'nothing changed');
  });
  await step('names: rename carries games, events and the phone link; the old phone name follows it', async () => {
    const ev = ok(await call(events, 'POST', { body: { code: nc, action: 'create', event: { name: 'Ben cup', format: 'roundrobin', rotation: 'auto', courts: 1, players: ['Ben', 'Cy', 'Di', 'Ed', 'Flo', 'Gus'], seed: 'n' }, ...org } }), 201).event;
    const m = ev.rounds[0].matches[0];
    ok(await call(events, 'POST', { body: { code: nc, action: 'result', id: ev.id, matchId: m.id, score: [11, 3], endedAt: Date.now(), startedAt: Date.now() - 60000, ...org } }));
    const before = JSON.stringify((await view()).games);
    const r = ok(await P({ action: 'rename', name: 'ben', newName: '  Benjamín ' }));
    assert.equal(r.name, 'Benjamín');
    const v = await view();
    assert.ok(!JSON.stringify(v.games).includes('"Ben"') && JSON.stringify(v.games).includes('Benjamín'));
    assert.equal(JSON.stringify(v.games).split('Benjamín').length, before.split('"Ben"').length, 'every occurrence was renamed');
    assert.ok(v.players.some(p => p.name === 'Benjamín') && !v.players.some(p => p.name === 'Ben'));
    const e = ok(await call(events, 'GET', { query: `?code=${nc}&id=${ev.id}` })).event;
    assert.ok(e.players.includes('Benjamín') && !JSON.stringify(e).includes('"Ben"'));
    assert.equal(e.name, 'Ben cup', 'a title that contains the old name is not a player name');
    assert.equal(v.renamed.ben, 'Benjamín');
    assert.ok(v.progress.players.benjamín || Object.keys(v.progress.players).includes('benjamín'), 'achievements follow the new name');
    // a claimed player keeps their link through a rename
    ok(await P({ action: 'rename', name: 'José', newName: 'Joseph' }));
    ok(await P({ action: 'avatar', name: 'Joseph', playerToken: joseToken, avatar: { type: 'emoji', value: '🏓' } }, {}));
  });
  await step('names: renaming onto an existing player is a collision and points to merge; casing-only rename is fine', async () => {
    const r = await P({ action: 'rename', name: 'Cy', newName: 'DI' });
    assert.equal(r.status, 409); assert.equal(r.json.mergeInto, 'Di');
    assert.equal((await P({ action: 'rename', name: 'Cy', newName: 'Player 3' })).status, 400);
    assert.equal((await P({ action: 'rename', name: 'Nobody', newName: 'Cyrus' })).status, 404);
    ok(await P({ action: 'rename', name: 'Cy', newName: 'CY' }));
    assert.ok((await names()).includes('CY'));
    const sim = await P({ action: 'rename', name: 'CY', newName: 'Joseph' }); // Joseph is taken
    assert.equal(sim.status, 409);
    const near = await P({ action: 'rename', name: 'CY', newName: 'Josephe' });
    assert.equal(near.status, 409); assert.deepEqual(near.json.similar, ['Joseph']);
    ok(await P({ action: 'rename', name: 'CY', newName: 'Josephe', confirmNew: true }));
    ok(await P({ action: 'rename', name: 'Josephe', newName: 'Cy' }));
  });
  await step('names: merge folds games, link, picture and purchases into one player; ratings follow from the games', async () => {
    // "Jose" (a guest typed twice, never linked) is the same person as Joseph (linked, with a picture)
    await G('n-g003', [['Jose', 'Cy'], ['Di', 'Ed']]);
    ok(await P({ action: 'set-role', name: 'Joseph', role: 'organizer' }));
    const mid = await view();
    const r = await P({ action: 'merge', name: 'Joseph', into: 'Jose' }); // from is claimed, into is not: the claim moves over
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const v = await view();
    assert.ok(!v.players.some(p => p.name === 'Joseph'));
    const kept = v.players.find(p => p.name === 'Jose');
    assert.ok(kept.claimed && kept.avatar && kept.avatar.value, 'phone link and picture followed');
    assert.equal(kept.role, 'organizer', 'organizer role followed the phone link');
    assert.ok(!JSON.stringify(v.games).includes('Joseph') && !JSON.stringify(v.games).includes('José'));
    assert.ok(v.games.filter(g => g.teams.flat().includes('Jose')).length >= 3, 'all of their games are under the kept name');
    assert.equal(v.renamed.joseph, 'Jose');
    assert.equal(mid.games.length, v.games.length, 'no game was lost or duplicated');
    // the old phone token still works for the kept player: it is the same link
    ok(await P({ action: 'avatar', name: 'Jose', playerToken: joseToken, avatar: { type: 'initials' } }, {}));
  });
  await step('names: merge refuses two linked players, two players in the same game, and itself', async () => {
    const t = ok(await P({ action: 'claim', name: 'Cy' })).playerToken;
    ok(await P({ action: 'claim', name: 'Di' }));
    assert.equal((await P({ action: 'merge', name: 'Cy', into: 'Di' })).status, 409, 'both linked');
    ok(await P({ action: 'release', name: 'Di' }));
    const same = await P({ action: 'merge', name: 'Di', into: 'Cy' });
    assert.equal(same.status, 409); assert.match(same.json.error, /same game/);
    assert.equal((await P({ action: 'merge', name: 'Cy', into: 'cy' })).status, 400);
    assert.equal((await P({ action: 'merge', name: 'Cy', into: 'Nobody' })).status, 404);
    assert.ok(t && (await names()).includes('Cy') && (await names()).includes('Di'), 'nothing changed');
  });
}
await step('roles: co-organizers, removal, leaving, blocking, audit, per-role authorization', async () => {
  const c = ok(await call(club, 'POST', { body: { name: 'Roles club', pin: '246810' } }), 201);
  const rc = c.club.code, own = c.ownerToken, pin = '246810';
  const P = (body, headers) => call(playersApi, 'POST', { body: { code: rc, ...body }, headers });
  const claim = async name => ok(await P({ action: 'claim', name, ownerToken: own })).playerToken;
  const tok = { Ana: await claim('Ana'), Ben: await claim('Ben'), Cy: await claim('Cy') };
  await P({ action: 'claim', name: 'Dee', ownerToken: own }); // claimed below, then left unclaimed
  const cred = n => `${tok[n]}:${n}`; // a co-organizer's credential, sent where the owner token goes
  const role = async n => (ok(await call(club, 'GET', { query: '?code=' + rc })).players.find(p => p.name === n) || {}).role;
  // a plain member and a stranger can't do any of it
  assert.equal((await P({ action: 'set-role', name: 'Ana', role: 'organizer', ownerToken: cred('Ben') })).status, 403);
  assert.equal((await P({ action: 'members', ownerToken: cred('Ben') })).status, 403, 'a member is not an organizer');
  assert.equal((await P({ action: 'set-role', name: 'Ana', role: 'organizer', pin: '000000' })).status, 403);
  // the owner promotes Ana; the PIN works too
  ok(await P({ action: 'set-role', name: 'Ana', role: 'organizer', ownerToken: own }));
  assert.equal(await role('Ana'), 'organizer');
  assert.equal(await role('Ben'), undefined);
  // Ana can use organizer-only actions, with her credential, on a phone that has no PIN
  ok(await P({ action: 'members', ownerToken: cred('Ana') }));
  ok(await P({ action: 'clear-avatar', name: 'Ben', ownerToken: cred('Ana') }).then(r => (r.status === 200 || r.status === 404 ? { ...r, status: 200 } : r)));
  const del = await call(games, 'POST', { body: { code: rc, restore: 'nope1234', ownerToken: cred('Ana') } });
  assert.notEqual(del.status, 403, 'a co-organizer passes the organizer gate on games');
  // a wrong token for Ana's name, or someone else's token under her name, is refused
  assert.equal((await P({ action: 'members', ownerToken: `${tok.Ben}:Ana` })).status, 403);
  // Ana can't change roles, remove an organizer, or promote
  assert.equal((await P({ action: 'set-role', name: 'Ben', role: 'organizer', ownerToken: cred('Ana') })).status, 403);
  ok(await P({ action: 'set-role', name: 'Cy', role: 'organizer', pin }));
  assert.equal((await P({ action: 'remove', name: 'Cy', ownerToken: cred('Ana') })).status, 403);
  assert.equal((await P({ action: 'release', name: 'Cy', ownerToken: cred('Ana') })).status, 403);
  // an unclaimed name can't be promoted
  assert.equal((await P({ action: 'set-role', name: 'Zed', role: 'organizer', pin })).status, 404);
  // Ana removes Ben (a member): his token stops working, his games stay
  ok(await call(games, 'POST', { body: { code: rc, games: [{ id: 'roleg001', mode: 'singles', teams: [['Ben'], ['Cy']], score: [11, 5], endedAt: Date.now() - 1000 }], playerName: 'Ben', playerToken: tok.Ben } }));
  ok(await P({ action: 'remove', name: 'Ben', block: true, ownerToken: cred('Ana') }));
  assert.equal((await P({ action: 'avatar', name: 'Ben', playerToken: tok.Ben, avatar: { type: 'initials' } })).status, 403, 'his token is dead');
  assert.equal((await P({ action: 'claim', name: 'Ben' })).status, 403, 'a blocked name cannot be claimed');
  const after = ok(await call(club, 'GET', { query: '?code=' + rc }));
  assert.ok(after.games.some(g => g.id === 'roleg001'), 'past games stay');
  assert.equal(after.players.find(p => p.name === 'Ben').claimed, false);
  ok(await P({ action: 'unblock', name: 'Ben', ownerToken: cred('Ana') }));
  const benNew = ok(await P({ action: 'claim', name: 'Ben' })).playerToken;
  assert.ok(benNew && benNew !== tok.Ben);
  // demotion kills the credential at once; so does removal of the organizer by the owner
  ok(await P({ action: 'set-role', name: 'Ana', role: 'player', ownerToken: own }));
  assert.equal((await P({ action: 'members', ownerToken: cred('Ana') })).status, 403);
  ok(await P({ action: 'set-role', name: 'Ana', role: 'organizer', pin }));
  ok(await P({ action: 'members', ownerToken: cred('Ana') }));
  ok(await P({ action: 'remove', name: 'Ana', pin }));
  assert.equal((await P({ action: 'members', ownerToken: cred('Ana') })).status, 403);
  assert.equal(await role('Ana'), undefined);
  // a released organizer name doesn't hand the role to the next claimer
  const cyNew = ok(await P({ action: 'release', name: 'Cy', ownerToken: own })) && ok(await P({ action: 'claim', name: 'Cy', ownerToken: own })).playerToken;
  assert.equal(await role('Cy'), undefined);
  assert.equal((await P({ action: 'members', ownerToken: `${cyNew}:Cy` })).status, 403);
  // leaving: only with your own token; the role goes with you
  ok(await P({ action: 'set-role', name: 'Cy', role: 'organizer', pin }));
  assert.equal((await P({ action: 'leave', name: 'Cy', playerToken: tok.Cy })).status, 403);
  ok(await P({ action: 'leave', name: 'Cy', playerToken: cyNew }));
  assert.equal(await role('Cy'), undefined);
  assert.equal((await P({ action: 'members', ownerToken: `${cyNew}:Cy` })).status, 403);
  // the audit log says who and when
  const m = ok(await P({ action: 'members', pin }));
  const kinds = m.audit.map(a => `${a.action}:${a.target}:${a.actor}${a.actorName ? '=' + a.actorName : ''}`);
  assert.ok(kinds.includes('promote:Ana:owner'), kinds.join());
  assert.ok(kinds.includes('promote:Cy:pin'));
  assert.ok(kinds.includes('remove:Ben:organizer=Ana'));
  assert.ok(kinds.includes('demote:Ana:owner'));
  assert.ok(kinds.includes('leave:Cy:member=Cy'));
  assert.ok(m.audit.every(a => a.at > 0));
  assert.equal(m.members.find(x => x.name === 'Ben').claimed, true);
  // the audit log never reaches the club payload
  assert.ok(!JSON.stringify(ok(await call(club, 'GET', { query: '?code=' + rc }))).includes('promote'));
  // club code rotation: the old code still resolves to the same roles during the overlap
  ok(await P({ action: 'set-role', name: 'Ben', role: 'organizer', ownerToken: own }));
  const rot = ok(await call(club, 'POST', { body: { code: rc, action: 'rotate-code', ownerToken: `${benNew}:Ben` } }));
  const viaNew = await call(playersApi, 'POST', { body: { code: rot.club.code, action: 'members', ownerToken: `${benNew}:Ben` } });
  ok(viaNew);
  ok(await call(playersApi, 'POST', { body: { code: rc, action: 'members', ownerToken: `${benNew}:Ben` } }));
  // roster rows with a role and a block are additive columns on existing tables
  const cols = (await pg.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'roster' AND column_name IN ('role','blocked_at')")).rows;
  assert.equal(cols.length, 2);
});

// ---- Game confirmation, duplicates and the audit trail ----
const cf = await (async () => {
  const c = ok(await call(club, 'POST', { body: { name: 'Confirm club', pin: '731942' } }), 201);
  return { code: c.club.code, owner: c.ownerToken, pin: '731942' };
})();
const cfPost = (h, body) => call(h, 'POST', { body: { code: cf.code, ...body } });
const cfGet = async () => ok(await call(club, 'GET', { query: '?code=' + cf.code }));
const cfAudit = async (creds = { headers: { 'x-club-owner': cf.owner } }, id) => call(games, 'GET', { query: `?code=${cf.code}&audit=1${id ? '&id=' + id : ''}`, ...creds });
const now = Date.now();
const cfGame = (id, extra = {}) => ({ id, mode: 'doubles', teams: [['Ann', 'Bo'], ['Cat', 'Dee']], score: [11, 6], endedAt: now - 3600000, startedAt: now - 3700000, ...extra });
const cfTok = {};
await step('confirmation: players link their phones, a phone with a player token records a game, it starts unconfirmed', async () => {
  for (const n of ['Ann', 'Bo', 'Cat', 'Dee', 'Eve']) cfTok[n] = ok(await cfPost(playersApi, { action: 'claim', name: n, ownerToken: cf.owner })).playerToken;
  ok(await cfPost(games, { games: [cfGame('conf-1', { logged: true })], playerName: 'Ann', playerToken: cfTok.Ann }));
  const g = (await cfGet()).games.find(x => x.id === 'conf-1');
  assert.equal(g.scoredBy, 'ann'); assert.equal(g.confirmed, undefined); assert.ok(!g.hold, 'with the setting off it still counts');
});
await step('confirmation: the recorder, their partner, a bystander, a stranger and a wrong PIN cannot confirm', async () => {
  const conf = extra => cfPost(games, { confirm: 'conf-1', ...extra });
  assert.equal((await conf({})).status, 403, 'only the club code');
  assert.equal((await conf({ playerName: 'Ann', playerToken: cfTok.Ann })).status, 403, 'the recorder');
  assert.equal((await conf({ playerName: 'Bo', playerToken: cfTok.Bo })).status, 403, 'the recorder\'s partner');
  assert.equal((await conf({ playerName: 'Eve', playerToken: cfTok.Eve })).status, 403, 'a member who did not play');
  assert.equal((await conf({ playerName: 'Cat', playerToken: cfTok.Dee })).status, 403, 'someone else\'s token');
  assert.equal((await conf({ playerName: 'Cat', playerToken: 'f'.repeat(48) })).status, 403, 'a guessed token');
  assert.equal((await conf({ pin: '000000' })).status, 403, 'a wrong PIN');
  assert.equal((await cfGet()).games.find(x => x.id === 'conf-1').confirmed, undefined);
});
await step('confirmation: a player on the other team confirms; confirming again changes nothing', async () => {
  const r = ok(await cfPost(games, { confirm: 'conf-1', playerName: 'Cat', playerToken: cfTok.Cat }));
  assert.equal(r.confirmed.by, 'cat');
  assert.equal(ok(await cfPost(games, { confirm: 'conf-1', playerName: 'Dee', playerToken: cfTok.Dee })).alreadyConfirmed, true);
  const g = (await cfGet()).games.find(x => x.id === 'conf-1');
  assert.equal(g.confirmed.by, 'cat'); assert.ok(g.confirmed.at > 0);
  assert.equal(ok(await cfAudit()).json, undefined);
});
await step('confirmation: an organizer (PIN or creating phone) can confirm any game; the creating phone\'s own games start confirmed', async () => {
  ok(await cfPost(games, { games: [cfGame('conf-2', { endedAt: now - 7200000 })] }));
  assert.equal((await cfGet()).games.find(x => x.id === 'conf-2').confirmed, undefined, 'a phone with only the club code');
  ok(await cfPost(games, { confirm: 'conf-2', pin: cf.pin }));
  assert.equal((await cfGet()).games.find(x => x.id === 'conf-2').confirmed.by, 'organizer');
  ok(await cfPost(games, { games: [cfGame('conf-3', { teams: [['Ann', 'Eve'], ['Bo', 'Dee']], endedAt: now - 9000000 })], ownerToken: cf.owner }));
  assert.equal((await cfGet()).games.find(x => x.id === 'conf-3').confirmed.by, 'organizer');
  assert.equal((await cfPost(games, { confirm: 'nope-id', pin: cf.pin })).status, 404);
});
await step('setting: only an organizer can require confirmation; unconfirmed games are held out of achievements and flagged', async () => {
  assert.equal((await cfPost(club, { action: 'set-confirmation', required: true })).status, 403);
  assert.equal((await cfPost(club, { action: 'set-confirmation', required: true, pin: '000000' })).status, 403);
  assert.equal((await cfPost(club, { action: 'set-confirmation', required: 'yes', ownerToken: cf.owner })).status, 400);
  ok(await cfPost(games, { games: [cfGame('conf-4', { teams: [['Ann', 'Bo'], ['Zed', 'Dee']], endedAt: now - 5400000 })], playerName: 'Ann', playerToken: cfTok.Ann }));
  const before = await cfGet();
  assert.equal(before.club.requireConfirmation, false);
  ok(await cfPost(club, { action: 'set-confirmation', required: true, pin: cf.pin }));
  const after = await cfGet();
  assert.equal(after.club.requireConfirmation, true);
  const held = id => after.games.find(x => x.id === id).hold;
  assert.equal(held('conf-4'), true); assert.ok(!held('conf-1')); assert.ok(!held('conf-2'));
  const has = (d, p) => !!(d.progress.players[p] && d.progress.players[p].achievements.length);
  assert.ok(has(before, 'ann') && !has(after, 'zed') && !has(before, 'zed'), 'Zed only played the held game, which never scored an achievement');
  assert.ok(has(after, 'ann'), 'confirmed games still count');
  ok(await cfPost(games, { confirm: 'conf-4', pin: cf.pin }));
  const cleared = await cfGet();
  assert.ok(!cleared.games.find(x => x.id === 'conf-4').hold);
  ok(await cfPost(club, { action: 'set-confirmation', required: false, ownerToken: cf.owner }));
});
await step('rewards: off by default, organizer only, boolean only, shown in the club payload', async () => {
  assert.equal((await cfGet()).club.rewards, false, 'a new club has rewards off');
  assert.equal((await cfPost(club, { action: 'set-rewards', on: true })).status, 403);
  assert.equal((await cfPost(club, { action: 'set-rewards', on: true, pin: '000000' })).status, 403);
  assert.equal((await cfPost(club, { action: 'set-rewards', on: 'yes', ownerToken: cf.owner })).status, 400);
  ok(await cfPost(club, { action: 'set-rewards', on: true, pin: cf.pin }));
  assert.equal((await cfGet()).club.rewards, true);
  ok(await cfPost(club, { action: 'set-rewards', on: false, ownerToken: cf.owner }));
  assert.equal((await cfGet()).club.rewards, false);
  const log = ok(await cfAudit()).audit.filter(r => r.action === 'setting' && r.after && 'rewards' in r.after);
  assert.ok(log.length >= 2 && log[0].after.rewards === false && log[0].before.rewards === true && !log[0].before.teams, 'a rewards switch is in the history read as a setting row with no teams');
});
await step('rewards ledger: server-derived from the games a linked phone saved, append-only, idempotent, off means no calls, follows a rename, gone on anonymise', async () => {
  const sync = (name, extra = {}) => cfPost(playersApi, { action: 'rewards-sync', name, playerToken: cfTok[name], tz: 0, ...extra });
  const days = async (id, back) => { await pg.query(`UPDATE games SET data = jsonb_set(data, '{receivedAt}', to_jsonb($1::bigint)) WHERE club = $2 AND id = $3`, [Date.now() - back * 864e5, cf.code, id]); };
  const rows = async name => (await pg.query(`SELECT id, kind, amount, streak FROM reward_ledger WHERE club = $1 AND name_key = $2 ORDER BY day`, [cf.code, name.toLowerCase()])).rows;
  assert.equal((await sync('Ann')).status, 403, 'rewards off for the club: no reward calls');
  ok(await cfPost(club, { action: 'set-rewards', on: true, pin: cf.pin }));
  for (const bad of [{ playerToken: undefined }, { playerToken: 'f'.repeat(48) }, { playerToken: cfTok.Bo }, { name: 'Nobody' }]) assert.equal((await sync('Ann', bad)).status, 403);
  // Ann saved conf-1 from her own phone today: 1 Dink, day 1. Saying more in the request changes nothing, and a replay adds nothing.
  let r = ok(await sync('Ann', { dinks: 999, streak: 50, amount: 500, gained: 99 }));
  assert.deepEqual([r.dinks, r.streak, r.gained], [1, 1, 1]);
  r = ok(await sync('Ann')); assert.deepEqual([r.dinks, r.gained, r.entries.length], [1, 0, 1]);
  assert.deepEqual(ok(await cfPost(playersApi, { action: 'rewards-get', name: 'Ann', playerToken: cfTok.Ann })).dinks, 1);
  // A game the organizer's phone saved for Eve is not Eve's own, and Eve saved none: nothing earned.
  ok(await cfPost(games, { games: [cfGame('conf-eve', { teams: [['Eve', 'Dee'], ['Cat', 'Bo']] })], ownerToken: cf.owner }));
  assert.equal(ok(await sync('Eve')).dinks, 0);
  // Bo saves a game on each of 3 days (the server's own arrival time, moved here by hand): a 3-day streak = 1 + 1 + (1 + 2).
  for (const [id, back] of [['bo-1', 2], ['bo-2', 1], ['bo-3', 0]]) { ok(await cfPost(games, { games: [cfGame(id, { score: [11, back + 1] })], playerName: 'Bo', playerToken: cfTok.Bo })); await days(id, back); }
  r = ok(await sync('Bo')); assert.deepEqual([r.dinks, r.streak, r.best, r.gained], [5, 3, 3, 5]);
  assert.deepEqual((await rows('Bo')).map(x => [x.kind, x.amount, x.streak]), [['earn', 1, 1], ['earn', 1, 2], ['earn', 3, 3]]);
  // A game that arrives "in the past" (clock set back, or a backdated log) lands before the last paid day and adds nothing; older than 14 days too.
  ok(await cfPost(games, { games: [cfGame('bo-4', { logged: true, score: [11, 8], endedAt: now - 40 * 864e5, startedAt: now - 40 * 864e5 }), cfGame('bo-5', { score: [11, 9] })], playerName: 'Bo', playerToken: cfTok.Bo }));
  await days('bo-4', 40); await days('bo-5', 5);
  r = ok(await sync('Bo')); assert.deepEqual([r.dinks, r.gained], [5, 0]);
  // Append-only: a deleted game does not take earned Dinks back, and the table refuses a bad row.
  ok(await call(games, 'DELETE', { query: `?code=${cf.code}&id=bo-3`, headers: { 'x-club-owner': cf.owner } }));
  assert.equal(ok(await sync('Bo')).dinks, 5);
  await assert.rejects(() => pg.query(`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason) VALUES ($1, 'bo', 'bad-1', 'earn', -3, 'x')`, [cf.code]));
  // Nothing of it reaches the club payload or another player's view.
  assert.ok(!/reward_ledger|day:20|rewardsLedger/.test(JSON.stringify(await cfGet())));
  // New players for the destructive parts, so later steps keep their cast. Each saves a game from their own phone today and syncs.
  const fresh = async (name, score) => {
    cfTok[name] = ok(await cfPost(playersApi, { action: 'claim', name, ownerToken: cf.owner })).playerToken;
    ok(await cfPost(games, { games: [cfGame('rw-' + name.toLowerCase(), { teams: [[name, 'Dee'], ['Cat', 'Eve']], score })], playerName: name, playerToken: cfTok[name] }));
    assert.equal(ok(await sync(name)).dinks, 1);
  };
  await fresh('Rex', [11, 3]); await fresh('Fay', [11, 4]); await fresh('Gus', [11, 5]);
  // A rename moves the ledger to the new name (the phone keeps its link); a merge keeps every row of both, even where the day id matched.
  ok(await cfPost(playersApi, { action: 'rename', name: 'Rex', newName: 'Remy', ownerToken: cf.owner }));
  assert.equal((await rows('Rex')).length, 0); assert.equal((await rows('Remy')).length, 1);
  assert.equal(ok(await cfPost(playersApi, { action: 'rewards-get', name: 'Remy', playerToken: cfTok.Rex })).dinks, 1);
  ok(await cfPost(playersApi, { action: 'release', name: 'Fay', ownerToken: cf.owner })); // a merge keeps one phone link, so the kept player is freed first
  ok(await cfPost(playersApi, { action: 'merge', name: 'Remy', into: 'Fay', ownerToken: cf.owner }));
  assert.equal((await rows('Remy')).length, 0);
  assert.deepEqual([(await rows('Fay')).length, (await rows('Fay')).reduce((n, x) => n + x.amount, 0)], [2, 2]);
  assert.equal(ok(await cfPost(playersApi, { action: 'rewards-get', name: 'Fay', playerToken: cfTok.Rex })).dinks, 2);
  // Anonymise removes the player's ledger.
  ok(await cfPost(playersApi, { action: 'anonymise', name: 'Gus', ownerToken: cf.owner }));
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM reward_ledger WHERE club = $1 AND name_key = 'gus'`, [cf.code])).rows[0].n, 0);
  ok(await cfPost(club, { action: 'set-rewards', on: false, ownerToken: cf.owner }));
  assert.equal((await sync('Dee')).status, 403, 'off again: no calls');
});
await step('rewards: the creating phone earns for its own claimed name only; a game it saves for others, a forged claim and a replay earn nothing more', async () => {
  const sync = (name, extra = {}) => cfPost(playersApi, { action: 'rewards-sync', name, playerToken: cfTok[name], tz: 0, ...extra });
  const stamp = async id => (await pg.query(`SELECT data->>'scoredBy' AS by, data->>'scoredByPlayer' AS pl FROM games WHERE club = $1 AND id = $2`, [cf.code, id])).rows[0];
  ok(await cfPost(club, { action: 'set-rewards', on: true, pin: cf.pin }));
  const crt = 'Cora'; // the creator's own player name
  cfTok[crt] = ok(await cfPost(playersApi, { action: 'claim', name: crt, ownerToken: cf.owner })).playerToken;
  assert.equal(ok(await sync(crt)).dinks, 0);
  // A game for others from the creating phone (its claim is sent along): organizer, with the creator's own key, but Cora is not in it.
  ok(await cfPost(games, { games: [cfGame('crt-other', { teams: [['Eve', 'Dee'], ['Cat', 'Bo']], score: [11, 7] })], ownerToken: cf.owner, playerName: crt, playerToken: cfTok[crt] }));
  assert.deepEqual(await stamp('crt-other'), { by: 'organizer', pl: 'cora' });
  assert.equal(ok(await sync(crt)).dinks, 0, 'a game the creator saved for other people earns the creator nothing');
  assert.equal(ok(await sync('Eve')).dinks, 0, 'and nothing for the players in it');
  // A forged claim: the creator token with a player name and a wrong token carries no player key and earns nobody anything.
  ok(await cfPost(games, { games: [cfGame('crt-forge', { teams: [['Cora', 'Dee'], ['Cat', 'Bo']], score: [11, 10] })], ownerToken: cf.owner, playerName: crt, playerToken: 'f'.repeat(48) }));
  assert.deepEqual(await stamp('crt-forge'), { by: 'organizer', pl: null });
  assert.equal(ok(await sync(crt)).dinks, 0, 'a claim that does not verify earns nothing');
  // The creator plays and saves from their own phone: they earn, once.
  ok(await cfPost(games, { games: [cfGame('crt-own', { teams: [['Cora', 'Dee'], ['Cat', 'Bo']], score: [11, 2] })], ownerToken: cf.owner, playerName: crt, playerToken: cfTok[crt] }));
  let r = ok(await sync(crt)); assert.deepEqual([r.dinks, r.gained, r.streak], [1, 1, 1]);
  r = ok(await sync(crt)); assert.deepEqual([r.dinks, r.gained], [1, 0]);
  assert.equal(ok(await sync('Dee')).dinks, 0, 'a teammate of the creator is not paid for it');
  // An edit that keeps the result keeps the creator key.
  ok(await cfPost(games, { edit: cfGame('crt-own', { teams: [['Cora', 'Dee'], ['Cat', 'Bo']], score: [11, 2], startedAt: now - 3800000 }), ownerToken: cf.owner }));
  assert.deepEqual(await stamp('crt-own'), { by: 'organizer', pl: 'cora' });
  // Games stored before this fix (organizer, no player key) stay unpaid: nothing is rewritten.
  await pg.query(`UPDATE games SET data = data - 'scoredByPlayer' WHERE club = $1 AND id = 'crt-own'`, [cf.code]);
  assert.equal(ok(await sync(crt)).dinks, 1, 'an old row neither pays again nor takes anything back');
  ok(await cfPost(club, { action: 'set-rewards', on: false, ownerToken: cf.owner }));
});
await step('rewards shop: server-side prices, spends through the ledger, never below zero, double buy and replay charge once, wear one per slot, follows a rename or merge, gone on anonymise', async () => {
  const post = (name, a) => cfPost(playersApi, { name, playerToken: cfTok[name], ...a });
  const spends = async name => (await pg.query(`SELECT id, amount FROM reward_ledger WHERE club = $1 AND name_key = $2 AND kind = 'spend' ORDER BY id`, [cf.code, name.toLowerCase()])).rows;
  const owned = async name => (await pg.query(`SELECT item, worn FROM reward_items WHERE club = $1 AND name_key = $2 ORDER BY item`, [cf.code, name.toLowerCase()])).rows;
  const grant = (name, n) => pg.query(`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason) VALUES ($1, $2, 'test:grant', 'earn', $3, 'test')`, [cf.code, name.toLowerCase(), n]);
  const join = async name => { cfTok[name] = ok(await cfPost(playersApi, { action: 'claim', name, ownerToken: cf.owner })).playerToken; };
  await join('Hal');
  assert.equal((await post('Hal', { action: 'rewards-catalog' })).status, 403, 'rewards off for the club: no shop calls');
  ok(await cfPost(club, { action: 'set-rewards', on: true, pin: cf.pin }));
  for (const bad of [{ playerToken: undefined }, { playerToken: 'f'.repeat(48) }, { playerToken: cfTok.Bo }, { name: 'Nobody' }]) for (const action of ['rewards-catalog', 'rewards-buy', 'rewards-wear']) assert.equal((await post('Hal', { action, item: 'frame-court', slot: 'frame', ...bad })).status, 403);
  let s = ok(await post('Hal', { action: 'rewards-catalog' }));
  assert.equal(s.items.length, 8); assert.ok(s.items.every(i => !i.owned && i.price > 0)); assert.deepEqual(s.worn, { frame: '', paddle: '' });
  // No Dinks yet: refused with a clear message, nothing charged, nothing owned.
  let r = await post('Hal', { action: 'rewards-buy', item: 'frame-court' });
  assert.equal(r.status, 409); assert.match(r.json.error, /Not enough Dinks yet: Court green ring costs 6 and you have 0/);
  assert.equal((await spends('Hal')).length + (await owned('Hal')).length, 0);
  await grant('Hal', 20);
  // The phone's own price, amount or name is ignored: the catalogue price is charged (6), the unknown item is refused.
  r = ok(await post('Hal', { action: 'rewards-buy', item: 'frame-court', price: 0, amount: -1, dinks: 999, name2: 'Free' }));
  assert.deepEqual([r.bought, r.dinks], [true, 14]);
  assert.deepEqual(await spends('Hal'), [{ id: 'buy:frame-court', amount: -6 }]);
  for (const item of ['frame-gold', '', '__proto__', 'frame-court ']) assert.equal((await post('Hal', { action: 'rewards-buy', item })).status, item === 'frame-court ' ? 400 : 400);
  // A double buy and a replay (a second device, a retry) charge nothing more.
  for (let i = 0; i < 2; i++) { r = ok(await post('Hal', { action: 'rewards-buy', item: 'frame-court' })); assert.deepEqual([r.bought, r.dinks], [false, 14]); }
  assert.equal((await spends('Hal')).length, 1);
  // Two buys at once that together cost more than the balance (8 + 8 > 14): exactly one goes through, the balance never goes below zero.
  const both = await Promise.all(['paddle-blue', 'paddle-ink'].map(item => post('Hal', { action: 'rewards-buy', item })));
  assert.deepEqual(both.map(x => x.status).sort(), [200, 409]);
  assert.equal(ok(await post('Hal', { action: 'rewards-catalog' })).dinks, 6);
  assert.equal((await owned('Hal')).length, 2);
  // Wearing: only what you own, in its own slot, one per slot, or none.
  assert.equal((await post('Hal', { action: 'rewards-wear', slot: 'frame', item: 'frame-blue' })).status, 403, 'not owned');
  assert.equal((await post('Hal', { action: 'rewards-wear', slot: 'paddle', item: 'frame-court' })).status, 400, 'wrong slot');
  assert.equal((await post('Hal', { action: 'rewards-wear', slot: 'hat', item: 'frame-court' })).status, 400);
  s = ok(await post('Hal', { action: 'rewards-wear', slot: 'frame', item: 'frame-court' })); assert.equal(s.worn.frame, 'frame-court');
  assert.equal(ok(await post('Hal', { action: 'rewards-get' })).worn.frame, 'frame-court', 'the sync answer carries what is worn');
  s = ok(await post('Hal', { action: 'rewards-wear', slot: 'frame', item: '' })); assert.equal(s.worn.frame, '');
  ok(await post('Hal', { action: 'rewards-wear', slot: 'frame', item: 'frame-court' }));
  // Nothing of it reaches the club payload or anyone else's view.
  assert.ok(!/frame-court|reward_items|paddle-blue/.test(JSON.stringify(await cfGet())));
  // A rename moves the items; a merge keeps one copy of an item both own and brings nothing worn.
  const halPaddle = (await owned('Hal')).find(x => x.item.startsWith('paddle-')).item; // whichever of the two raced buys won
  ok(await cfPost(playersApi, { action: 'rename', name: 'Hal', newName: 'Hank', ownerToken: cf.owner }));
  assert.deepEqual([(await owned('Hal')).length, (await owned('Hank')).length], [0, 2]);
  assert.equal(ok(await cfPost(playersApi, { action: 'rewards-catalog', name: 'Hank', playerToken: cfTok.Hal })).items.filter(i => i.owned).length, 2);
  await join('Ivy'); await grant('Ivy', 20);
  ok(await post('Ivy', { action: 'rewards-buy', item: 'frame-court' })); ok(await post('Ivy', { action: 'rewards-buy', item: 'frame-ink' }));
  ok(await post('Ivy', { action: 'rewards-wear', slot: 'frame', item: 'frame-ink' }));
  ok(await cfPost(playersApi, { action: 'release', name: 'Ivy', ownerToken: cf.owner }));
  ok(await cfPost(playersApi, { action: 'merge', name: 'Hank', into: 'Ivy', ownerToken: cf.owner }));
  assert.deepEqual((await owned('Ivy')).map(x => [x.item, x.worn]), [['frame-court', false], ['frame-ink', true], [halPaddle, false]]);
  assert.equal((await owned('Hank')).length, 0);
  assert.equal(ok(await cfPost(playersApi, { action: 'rewards-catalog', name: 'Ivy', playerToken: cfTok.Hal })).dinks, 12, 'the merged balance: both ledgers (20 - 14 each), every spend kept');
  // Anonymise removes the player's items with the ledger.
  ok(await cfPost(playersApi, { action: 'anonymise', name: 'Ivy', ownerToken: cf.owner }));
  assert.equal((await owned('Ivy')).length + (await spends('Ivy')).length, 0);
  ok(await cfPost(club, { action: 'set-rewards', on: false, ownerToken: cf.owner }));
  assert.equal((await post('Hal', { action: 'rewards-catalog' })).status, 403, 'off again: no calls');
});
await step('rewards club looks: off means 403, opt-in default false hides it, sharing exposes only allow-listed worn ids to members, rename/merge/leave/anonymise keep it safe', async () => {
  const post = (name, a) => cfPost(playersApi, { name, playerToken: cfTok[name], ...a });
  const looks = () => cfPost(playersApi, { action: 'rewards-looks' }); // any club member (no playerToken needed)
  const grant = (name, n) => pg.query(`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason) VALUES ($1, $2, 'test:looks', 'earn', $3, 'test') ON CONFLICT DO NOTHING`, [cf.code, name.toLowerCase(), n]);
  const join = async name => { cfTok[name] = ok(await cfPost(playersApi, { action: 'claim', name, ownerToken: cf.owner })).playerToken; };
  await join('Leo'); await join('Mia');
  // Rewards off for the club: nothing fetched or leaked.
  assert.equal((await looks()).status, 403, 'off: rewards-looks refused');
  assert.equal((await post('Leo', { action: 'rewards-share', share: true })).status, 403, 'off: rewards-share refused');
  ok(await cfPost(club, { action: 'set-rewards', on: true, pin: cf.pin }));
  await grant('Leo', 30); await grant('Mia', 30);
  ok(await post('Leo', { action: 'rewards-buy', item: 'frame-court' }));
  ok(await post('Leo', { action: 'rewards-buy', item: 'frame-blue' }));
  ok(await post('Leo', { action: 'rewards-buy', item: 'paddle-stripe' }));
  ok(await post('Leo', { action: 'rewards-wear', slot: 'frame', item: 'frame-court' }));
  ok(await post('Leo', { action: 'rewards-wear', slot: 'paddle', item: 'paddle-stripe' }));
  // Default share is false (hidden): nothing leaks to other club members.
  assert.equal(ok(await post('Leo', { action: 'rewards-catalog' })).share, false);
  assert.deepEqual(ok(await looks()), { looks: {} }, 'default hidden: nothing leaks');
  // Bad auth or bad share type refused.
  assert.equal((await post('Leo', { action: 'rewards-share', share: 'yes' })).status, 400);
  assert.equal((await post('Leo', { action: 'rewards-share', share: true, playerToken: cfTok.Mia })).status, 403);
  // Turn sharing on: another member sees ONLY the worn allow-listed item ids (never balance, streak, or unworn items like frame-blue).
  const shared = ok(await post('Leo', { action: 'rewards-share', share: true }));
  assert.equal(shared.share, true);
  assert.equal(ok(await post('Leo', { action: 'rewards-get' })).share, true);
  const pub = ok(await looks());
  assert.deepEqual(pub, { looks: { leo: { frame: 'frame-court', paddle: 'paddle-stripe' } } });
  const pubStr = JSON.stringify(pub);
  assert.ok(!/dinks|streak|frame-blue|price|ledger|entries|items/.test(pubStr), 'no balance, streak, or purchase history leaks');
  assert.ok(!/frame-court|paddle-stripe|rewards_public/.test(JSON.stringify(await cfGet())), 'GET /api/club stays free of economy data');
  // Unwearing removes that slot; hiding removes the player completely.
  ok(await post('Leo', { action: 'rewards-wear', slot: 'paddle', item: '' }));
  assert.deepEqual(ok(await looks()), { looks: { leo: { frame: 'frame-court' } } });
  ok(await post('Leo', { action: 'rewards-share', share: false }));
  assert.deepEqual(ok(await looks()), { looks: {} }, 'hidden again: nothing leaks');
  // Rename preserves both worn ring and rewards_public.
  ok(await post('Leo', { action: 'rewards-share', share: true }));
  ok(await cfPost(playersApi, { action: 'rename', name: 'Leo', newName: 'Leon', ownerToken: cf.owner }));
  assert.deepEqual(ok(await looks()), { looks: { leon: { frame: 'frame-court' } } }, 'rename keeps worn item and share choice');
  // Merge into an unclaimed row carries rewards_public from the claimed player; into's own worn choice stands.
  ok(await post('Mia', { action: 'rewards-buy', item: 'frame-ink' }));
  ok(await post('Mia', { action: 'rewards-wear', slot: 'frame', item: 'frame-ink' }));
  ok(await cfPost(playersApi, { action: 'release', name: 'Mia', ownerToken: cf.owner }));
  ok(await cfPost(playersApi, { action: 'merge', name: 'Leon', into: 'Mia', ownerToken: cf.owner }));
  assert.deepEqual(ok(await looks()), { looks: { mia: { frame: 'frame-ink' } } }, 'merge carries share choice from claimed player and keeps target worn look');
  // Leave clears rewards_public so the look stops showing.
  ok(await cfPost(playersApi, { action: 'leave', name: 'Mia', playerToken: cfTok.Leo }));
  assert.deepEqual(ok(await looks()), { looks: {} }, 'leaving clears look visibility');
  // Re-claim, share, then anonymise: gone completely.
  const miaTok2 = ok(await cfPost(playersApi, { action: 'claim', name: 'Mia', ownerToken: cf.owner })).playerToken;
  ok(await cfPost(playersApi, { action: 'rewards-share', name: 'Mia', playerToken: miaTok2, share: true }));
  assert.deepEqual(ok(await looks()), { looks: { mia: { frame: 'frame-ink' } } });
  ok(await cfPost(playersApi, { action: 'anonymise', name: 'Mia', ownerToken: cf.owner }));
  assert.deepEqual(ok(await looks()), { looks: {} }, 'anonymised player no longer shows');
  // Turning club rewards off stops everything immediately.
  ok(await cfPost(club, { action: 'set-rewards', on: false, ownerToken: cf.owner }));
  assert.equal((await looks()).status, 403, 'off again: nothing leaks');
});
await step('rewards mystery box: off means refused, odds match server table, insufficient balance, duplicate refund, replay idempotent, daily limit, atomic balance floor', async () => {
  const { boxOdds, BOX_PRICE, BOX_DUPLICATE_REFUND, BOX_DAILY_LIMIT } = await import(pathToFileURL(path.join(root, 'api', '_economybox.js')).href);
  const { CATALOGUE } = await import(pathToFileURL(path.join(root, 'api', '_economyshop.js')).href);
  const post = (name, a) => cfPost(playersApi, { name, playerToken: cfTok[name], ...a });
  const grant = (name, id, n) => pg.query(`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason) VALUES ($1, $2, $3, 'earn', $4, 'test') ON CONFLICT DO NOTHING`, [cf.code, name.toLowerCase(), id, n]);
  const join = async name => { cfTok[name] = ok(await cfPost(playersApi, { action: 'claim', name, ownerToken: cf.owner })).playerToken; };
  await join('Noa'); await join('Oli'); await join('Pia');
  // Off by default, organizer-only, boolean-only, audited as a setting row.
  assert.equal((await cfGet()).club.mysteryBox, false, 'a new club has mysteryBox off');
  assert.equal((await cfPost(club, { action: 'set-mystery-box', on: true })).status, 403);
  assert.equal((await cfPost(club, { action: 'set-mystery-box', on: true, pin: '000000' })).status, 403);
  assert.equal((await cfPost(club, { action: 'set-mystery-box', on: 'yes', ownerToken: cf.owner })).status, 400);
  // Both switches off -> refused.
  assert.equal((await cfPost(playersApi, { action: 'rewards-box-odds' })).status, 403);
  assert.equal((await post('Noa', { action: 'rewards-box-open', openId: 'box_off_0001' })).status, 403);
  // Rewards on, mysteryBox off -> refused, and catalog omits box.
  ok(await cfPost(club, { action: 'set-rewards', on: true, pin: cf.pin }));
  assert.equal((await cfPost(playersApi, { action: 'rewards-box-odds' })).status, 403);
  assert.equal((await post('Noa', { action: 'rewards-box-open', openId: 'box_off_0002' })).status, 403);
  assert.equal('box' in ok(await post('Noa', { action: 'rewards-catalog' })), false);
  // MysteryBox on, rewards off -> still refused!
  ok(await cfPost(club, { action: 'set-mystery-box', on: true, pin: cf.pin }));
  assert.equal((await cfGet()).club.mysteryBox, true);
  ok(await cfPost(club, { action: 'set-rewards', on: false, ownerToken: cf.owner }));
  assert.equal((await cfPost(playersApi, { action: 'rewards-box-odds' })).status, 403);
  assert.equal((await post('Noa', { action: 'rewards-box-open', openId: 'box_off_0003' })).status, 403);
  // Both switches on: odds endpoint equals server draw table and matches catalog.box.
  ok(await cfPost(club, { action: 'set-rewards', on: true, ownerToken: cf.owner }));
  const odds = ok(await cfPost(playersApi, { action: 'rewards-box-odds' }));
  assert.deepEqual(odds, boxOdds(), 'odds endpoint equals the server draw table');
  const cat = ok(await post('Noa', { action: 'rewards-catalog' }));
  assert.deepEqual(cat.box, { ...boxOdds(), openedToday: 0 });
  // Bad auth and bad openId refused.
  assert.equal((await post('Noa', { action: 'rewards-box-open', openId: 'box_auth_01', playerToken: 'f'.repeat(48) })).status, 403);
  assert.equal((await post('Noa', { action: 'rewards-box-open', openId: 'bad' })).status, 400);
  // Insufficient balance -> 409, nothing charged or granted.
  await grant('Noa', 'test:box-low', BOX_PRICE - 1);
  const low = await post('Noa', { action: 'rewards-box-open', openId: 'box_low_0001' });
  assert.equal(low.status, 409);
  assert.match(low.json.error, /Not enough Dinks/);
  assert.equal(ok(await post('Noa', { action: 'rewards-catalog' })).dinks, BOX_PRICE - 1);
  // Fund Noa and open once -> spends BOX_PRICE, grants one cosmetic item, returns result.
  await grant('Noa', 'test:box-top', 30);
  const bal0 = BOX_PRICE - 1 + 30;
  const first = ok(await post('Noa', { action: 'rewards-box-open', openId: 'box_open_001' }));
  assert.equal(first.result.openId, 'box_open_001');
  assert.equal(first.result.duplicate, false);
  assert.equal(first.result.refund, 0);
  assert.equal(first.result.replayed, false);
  assert.equal(first.dinks, bal0 - BOX_PRICE);
  assert.equal(first.box.openedToday, 1);
  assert.ok(first.items.find(i => i.id === first.result.item.id).owned, 'drawn item is now owned');
  // Replay with the same openId -> exact same result, replayed=true, balance and daily count unchanged.
  const replay1 = ok(await post('Noa', { action: 'rewards-box-open', openId: 'box_open_001' }));
  assert.deepEqual(replay1.result, { ...first.result, replayed: true });
  assert.equal(replay1.dinks, first.dinks);
  assert.equal(replay1.box.openedToday, 1);
  // Duplicate refund: Oli already owns every catalogue item, so any draw is a duplicate and refunds BOX_DUPLICATE_REFUND.
  await grant('Oli', 'test:oli-fund', 40);
  for (const it of CATALOGUE) await pg.query(`INSERT INTO reward_items (club, name_key, item, slot) VALUES ($1, 'oli', $2, $3) ON CONFLICT DO NOTHING`, [cf.code, it.id, it.slot]);
  const dup = ok(await post('Oli', { action: 'rewards-box-open', openId: 'box_dup_0001' }));
  assert.equal(dup.result.duplicate, true);
  assert.equal(dup.result.refund, BOX_DUPLICATE_REFUND);
  assert.equal(dup.result.replayed, false);
  assert.equal(dup.dinks, 40 - BOX_PRICE + BOX_DUPLICATE_REFUND);
  assert.equal(dup.box.openedToday, 1);
  // Refund row keeps day=null so it never fakes a daily streak.
  assert.equal(ok(await post('Oli', { action: 'rewards-get' })).streak, 0, 'duplicate refund never touches daily streak');
  // Replaying the duplicate openId returns the exact same duplicate result without refunding twice.
  const dupReplay = ok(await post('Oli', { action: 'rewards-box-open', openId: 'box_dup_0001' }));
  assert.deepEqual(dupReplay.result, { ...dup.result, replayed: true });
  assert.equal(dupReplay.dinks, dup.dinks);
  assert.equal(dupReplay.box.openedToday, 1);
  // Daily limit: open the remaining boxes up to BOX_DAILY_LIMIT, then the next distinct openId is refused (429).
  for (let i = 2; i <= BOX_DAILY_LIMIT; i++) {
    const r = ok(await post('Oli', { action: 'rewards-box-open', openId: 'box_dup_000' + i }));
    assert.equal(r.box.openedToday, i);
  }
  const balAtLimit = ok(await post('Oli', { action: 'rewards-catalog' })).dinks;
  const over = await post('Oli', { action: 'rewards-box-open', openId: 'box_over_001' });
  assert.equal(over.status, 429);
  assert.match(over.json.error, /Daily limit reached/);
  assert.equal(ok(await post('Oli', { action: 'rewards-catalog' })).dinks, balAtLimit, 'refused open charges nothing');
  // Replaying an earlier openId from today still returns its original idempotent result even at the daily limit!
  const replayAtLimit = ok(await post('Oli', { action: 'rewards-box-open', openId: 'box_dup_0001' }));
  assert.deepEqual(replayAtLimit.result, { ...dup.result, replayed: true });
  // Concurrent opens with balance == BOX_PRICE: exactly one succeeds, balance never goes below zero.
  await grant('Pia', 'test:pia-exact', BOX_PRICE);
  const race = await Promise.all(['box_race_001', 'box_race_002'].map(openId => post('Pia', { action: 'rewards-box-open', openId })));
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  assert.equal(ok(await post('Pia', { action: 'rewards-catalog' })).dinks, 0);
  // Club payload stays free of box opens and ledger rows; setting audit logged.
  assert.ok(!/box_open_001|box_dup_0001|boxref:/.test(JSON.stringify(await cfGet())));
  const mlog = ok(await cfAudit()).audit.filter(r => r.action === 'setting' && r.after && 'mysteryBox' in r.after);
  assert.ok(mlog.length >= 1 && mlog[0].after.mysteryBox === true);
  // Turn both switches off cleanly.
  ok(await cfPost(club, { action: 'set-mystery-box', on: false, ownerToken: cf.owner }));
  ok(await cfPost(club, { action: 'set-rewards', on: false, ownerToken: cf.owner }));
  assert.equal((await cfGet()).club.mysteryBox, false);
});
await step('rewards season pass: server-derived from verified games in club season, idempotent claims, forged claims ignored, follows season-end, rename, merge and anonymise', async () => {
  const pc = ok(await call(club, 'POST', { body: { name: 'Season pass club', pin: '357911' } }), 201);
  const pcode = pc.club.code, powner = pc.ownerToken, ppin = '357911';
  const pPost = (h, b) => call(h, 'POST', { body: { code: pcode, ...b } });
  const pGet = () => call(club, 'GET', { query: '?code=' + pcode });
  const ptok = {};
  const join = async name => { ptok[name] = ok(await pPost(playersApi, { action: 'claim', name, ownerToken: powner })).playerToken; };
  const post = (name, a) => pPost(playersApi, { name, playerToken: ptok[name], ...a });
  const passRows = async name => (await pg.query(`SELECT id, amount FROM reward_ledger WHERE club = $1 AND name_key = $2 AND id LIKE 'pass:%' ORDER BY id`, [pcode, name.toLowerCase()])).rows;
  const owned = async name => (await pg.query(`SELECT item FROM reward_items WHERE club = $1 AND name_key = $2 ORDER BY item`, [pcode, name.toLowerCase()])).rows.map(r => r.item);
  await join('Noa'); await join('Ollie'); await join('Pat');
  // Rewards off: refused with 403.
  assert.equal((await post('Noa', { action: 'rewards-pass' })).status, 403, 'off: rewards-pass refused');
  assert.equal((await post('Noa', { action: 'rewards-pass-claim', tier: 1 })).status, 403, 'off: rewards-pass-claim refused');
  ok(await pPost(club, { action: 'set-rewards', on: true, pin: ppin }));
  // Auth checks: unlinked / wrong token refused.
  for (const bad of [{ playerToken: undefined }, { playerToken: 'f'.repeat(48) }, { playerToken: ptok.Ollie }, { name: 'Nobody' }]) {
    assert.equal((await post('Noa', { action: 'rewards-pass', ...bad })).status, 403);
    assert.equal((await post('Noa', { action: 'rewards-pass-claim', tier: 1, ...bad })).status, 403);
  }
  // Start with 0 games this season: nothing unlocked, claim refused (409), invalid tier refused (400).
  let p = ok(await post('Noa', { action: 'rewards-pass' }));
  assert.equal(p.games, 0); assert.equal(p.tiers.length, 10); assert.equal(p.claimable, 0);
  const seasonId = p.season.id;
  assert.equal((await post('Noa', { action: 'rewards-pass-claim', tier: 1 })).status, 409, 'not yet earned');
  for (const bad of [0, 11, 1.5, '1', null, '__proto__']) assert.equal((await post('Noa', { action: 'rewards-pass-claim', tier: bad })).status, 400);
  // Forged client fields (games: 99, amount: 999, dinks: 999, item: 'frame-double') are completely ignored.
  assert.equal((await post('Noa', { action: 'rewards-pass-claim', tier: 1, games: 99, amount: 999, dinks: 999, item: 'frame-double' })).status, 409);
  // A game saved by Ollie's phone where Noa played does NOT count for Noa; a game saved by Noa's phone where Noa lost DOES count.
  const saveAs = (who, id, teams, score, agoMs = 60000) => pPost(games, { games: [cfGame(id, { teams, score, endedAt: now - agoMs })], playerName: who, playerToken: ptok[who] });
  ok(await saveAs('Ollie', 'pass-other-1', [['Noa', 'Ollie'], ['Ana', 'Ben']], [11, 4], 90000000));
  assert.equal(ok(await post('Noa', { action: 'rewards-pass' })).games, 0, 'another phone saving does not count');
  assert.equal(ok(await post('Ollie', { action: 'rewards-pass' })).games, 1, 'counts for Ollie who saved it');
  // Save 5 games as Noa (all losses: scores/results never matter) + 1 game backdated to an earlier season in DB.
  for (let i = 1; i <= 5; i++) ok(await saveAs('Noa', 'pass-noa-' + i, [['Noa', 'Ollie'], ['Ana', 'Ben']], [i, 11], (i + 1) * 7200e3));
  await pg.query(`INSERT INTO games (club, id, data, ended_at) VALUES ($1, 'pass-old-season', $2::jsonb, $3)`,
    [pcode, JSON.stringify({ id: 'pass-old-season', mode: 'doubles', teams: [['Noa', 'Ollie'], ['Ana', 'Ben']], score: [11, 2], winner: 0, endedAt: p.season.start - 86400e3, receivedAt: p.season.start - 86400e3, scoredBy: 'noa' }), p.season.start - 86400e3]);
  p = ok(await post('Noa', { action: 'rewards-pass' }));
  assert.equal(p.games, 5, 'only current-season verified games count');
  assert.equal(p.claimable, 3, 'tiers 1, 2 and 3 unlocked');
  // Claim tier 1 once (with forged amount/dinks ignored -> pays exact tier 1 Dinks = 2).
  let c1 = ok(await post('Noa', { action: 'rewards-pass-claim', tier: 1, seasonId, amount: 999, dinks: 999 }));
  assert.deepEqual([c1.claimed, c1.gained, c1.dinks, c1.granted], [true, 2, 2, null]);
  assert.deepEqual(await passRows('Noa'), [{ id: `pass:${seasonId}:1`, amount: 2 }]);
  // Replay and concurrent double-claim add nothing.
  const rep = ok(await post('Noa', { action: 'rewards-pass-claim', tier: 1, seasonId }));
  assert.deepEqual([rep.claimed, rep.gained, rep.dinks], [false, 0, 2]);
  const race = await Promise.all([post('Noa', { action: 'rewards-pass-claim', tier: 2, seasonId }), post('Noa', { action: 'rewards-pass-claim', tier: 2, seasonId })]);
  assert.deepEqual(race.map(r => r.status), [200, 200]);
  assert.deepEqual(race.map(r => r.json.claimed).sort(), [false, true], 'concurrent claim pays once only');
  assert.equal(ok(await post('Noa', { action: 'rewards-pass' })).dinks, 5);
  // Tier 3 grants free cosmetic item (frame-court) + 2 Dinks, and the shop sees it as owned immediately.
  const c3 = ok(await post('Noa', { action: 'rewards-pass-claim', tier: 3, seasonId }));
  assert.equal(c3.claimed, true); assert.equal(c3.gained, 2); assert.equal(c3.granted.id, 'frame-court'); assert.equal(c3.dinks, 7);
  assert.deepEqual(await owned('Noa'), ['frame-court']);
  assert.equal(ok(await post('Noa', { action: 'rewards-catalog' })).items.find(i => i.id === 'frame-court').owned, true);
  // Tier 4 still needs 8 games -> refused with 409.
  assert.equal((await post('Noa', { action: 'rewards-pass-claim', tier: 4, seasonId })).status, 409);
  // Nothing leaks into GET /api/club.
  assert.ok(!/pass:|rewards-pass|frame-court/.test(JSON.stringify(ok(await pGet()))), 'GET /api/club stays free of pass data');
  // Ending the club season starts a fresh pass track; stale seasonId is refused with 409; already-owned cosmetic tier pays item price in Dinks.
  const ended = ok(await pPost(club, { action: 'season-end', seasonId, name: 'Pass Season 2', ownerToken: powner }));
  const s2 = ended.season.id;
  assert.notEqual(s2, seasonId);
  assert.equal((await post('Noa', { action: 'rewards-pass-claim', tier: 1, seasonId })).status, 409, 'stale seasonId refused');
  assert.equal(ok(await post('Noa', { action: 'rewards-pass' })).games, 0, 'new season starts at 0 games');
  for (let i = 1; i <= 5; i++) ok(await saveAs('Noa', 'pass-s2-' + i, [['Noa', 'Ollie'], ['Ana', 'Ben']], [11, i], (i + 10) * 7200e3));
  const c3Again = ok(await post('Noa', { action: 'rewards-pass-claim', tier: 3, seasonId: s2 }));
  assert.deepEqual([c3Again.claimed, c3Again.gained, c3Again.granted], [true, 6, null], 'already-owned cosmetic tier pays its Dinks price instead');
  // Rename preserves season games, claimed tiers and granted items.
  ok(await pPost(playersApi, { action: 'rename', name: 'Noa', newName: 'Nora', ownerToken: powner }));
  const afterRen = ok(await pPost(playersApi, { action: 'rewards-pass', name: 'Nora', playerToken: ptok.Noa }));
  assert.equal(afterRen.games, 5);
  assert.equal(afterRen.tiers[2].claimed, true, 'tier 3 stays claimed after rename');
  assert.equal(afterRen.dinks, 13);
  assert.deepEqual(await owned('Nora'), ['frame-court']);
  // Merge into an unclaimed player preserves pass claims, games and items without allowing a double claim.
  ok(await pPost(playersApi, { action: 'release', name: 'Pat', ownerToken: powner }));
  ok(await pPost(playersApi, { action: 'merge', name: 'Nora', into: 'Pat', ownerToken: powner }));
  const afterMerge = ok(await pPost(playersApi, { action: 'rewards-pass', name: 'Pat', playerToken: ptok.Noa }));
  assert.equal(afterMerge.games, 5);
  assert.equal(afterMerge.tiers[2].claimed, true, 'tier 3 stays claimed after merge');
  assert.deepEqual(await owned('Pat'), ['frame-court']);
  const mergedRep = ok(await pPost(playersApi, { action: 'rewards-pass-claim', name: 'Pat', playerToken: ptok.Noa, tier: 3, seasonId: s2 }));
  assert.equal(mergedRep.claimed, false, 'cannot re-claim merged tier');
  // Anonymise removes pass ledger rows and items and blocks further pass calls.
  ok(await pPost(playersApi, { action: 'anonymise', name: 'Pat', ownerToken: powner }));
  assert.equal((await passRows('Pat')).length + (await owned('Pat')).length, 0);
  assert.equal((await pPost(playersApi, { action: 'rewards-pass', name: 'Pat', playerToken: ptok.Noa })).status, 403);
  ok(await pPost(club, { action: 'set-rewards', on: false, ownerToken: powner }));
  assert.equal((await post('Ollie', { action: 'rewards-pass' })).status, 403, 'off again: refused');
});
await step('pay link and pinned note: organizer only, validated, members read them, both can be cleared', async () => {
  const link = 'https://pay.example.com/dues';
  assert.equal((await cfPost(club, { action: 'set-pay-link', link })).status, 403);
  assert.equal((await cfPost(club, { action: 'set-note', note: 'Hi', pin: '000000' })).status, 403);
  assert.equal((await cfPost(club, { action: 'set-pay-link', link: 'http://pay.example.com', ownerToken: cf.owner })).status, 400);
  assert.equal((await cfPost(club, { action: 'set-pay-link', link: 'javascript:alert(1)', pin: cf.pin })).status, 400);
  assert.equal((await cfPost(club, { action: 'set-note', note: 'x'.repeat(501), pin: cf.pin })).status, 400);
  const none = await cfGet();
  assert.ok(!('payLink' in none.club) && !('note' in none.club), 'nothing set yet');
  assert.equal(ok(await cfPost(club, { action: 'set-pay-link', link, ownerToken: cf.owner })).payLink, link);
  assert.equal(ok(await cfPost(club, { action: 'set-note', note: '  Dues are due Friday.\nThanks!  ', pin: cf.pin })).note, 'Dues are due Friday.\nThanks!');
  const seen = await cfGet(); // a member with only the club code sees both
  assert.equal(seen.club.payLink, link); assert.equal(seen.club.note, 'Dues are due Friday.\nThanks!');
  ok(await cfPost(club, { action: 'set-pay-link', link: '', pin: cf.pin }));
  ok(await cfPost(club, { action: 'set-note', note: '', ownerToken: cf.owner }));
  const gone = await cfGet();
  assert.ok(!('payLink' in gone.club) && !('note' in gone.club));
});
await step('duplicates: a live game and a logged copy are flagged; keep both clears the flag; deleting one clears it too', async () => {
  const live = cfGame('dup-live', { teams: [['Fay', 'Gil'], ['Hal', 'Ivy']], score: [11, 9], endedAt: now - 1800000 });
  const logged = cfGame('dup-logged', { teams: [['Hal', 'Ivy'], ['Gil', 'Fay']], score: [9, 11], endedAt: now - 1500000, logged: true });
  ok(await cfPost(games, { games: [live, logged] }));
  assert.deepEqual((await cfGet()).dupes, [['dup-live', 'dup-logged']]);
  assert.equal((await cfPost(games, { keepBoth: ['dup-live', 'dup-logged'], pin: '000000' })).status, 403);
  assert.equal((await cfPost(games, { keepBoth: ['dup-live', 'dup-live'], pin: cf.pin })).status, 400);
  ok(await cfPost(games, { keepBoth: ['dup-live', 'dup-logged'], pin: cf.pin }));
  assert.deepEqual((await cfGet()).dupes, []);
  const again = cfGame('dup-again', { teams: [['Fay', 'Gil'], ['Hal', 'Ivy']], score: [11, 9], endedAt: now - 1700000 });
  ok(await cfPost(games, { games: [again] }));
  assert.deepEqual((await cfGet()).dupes.length, 2, 'a third record is flagged against the ones not yet cleared');
  const del = await call(games, 'DELETE', { query: `?code=${cf.code}&id=dup-again`, headers: { 'x-club-pin': cf.pin } });
  ok(del);
  assert.deepEqual((await cfGet()).dupes, []);
});
await step('audit: create, edit, confirm, delete and restore are on the record with who and before/after; the replay note is kept', async () => {
  const log = (await cfAudit()).json.audit;
  const of = id => log.filter(e => e.game === id).map(e => e.action).reverse();
  assert.deepEqual(of('conf-1'), ['create', 'confirm']);
  assert.equal(log.find(e => e.game === 'conf-1' && e.action === 'create').actor, 'player:ann');
  assert.equal(log.find(e => e.game === 'conf-1' && e.action === 'confirm').actor, 'player:cat');
  assert.equal(log.find(e => e.game === 'conf-3' && e.action === 'create').actor, 'creator');
  assert.equal(log.find(e => e.game === 'conf-2' && e.action === 'create').actor, 'anonymous');
  assert.equal(log.find(e => e.game === 'conf-2' && e.action === 'confirm').actor, 'organizer-pin');
  assert.ok(log.some(e => e.action === 'setting' && e.after.requireConfirmation === true && e.actor === 'organizer-pin'));
  assert.ok(log.some(e => e.action === 'keep-both'));
  const edit = await cfPost(games, { edit: cfGame('conf-1', { score: [11, 8], logged: true }), pin: cf.pin });
  ok(edit);
  const g = (await cfGet()).games.find(x => x.id === 'conf-1');
  assert.equal(g.confirmed.by, 'organizer', 'an organizer changing the result vouches for the new one');
  ok(await cfPost(games, { edit: cfGame('conf-4', { teams: [['Ann', 'Bo'], ['Zed', 'Dee']], score: [11, 4], endedAt: now - 5400000 }), pin: cf.pin }));
  ok(await call(games, 'DELETE', { query: `?code=${cf.code}&id=conf-2`, headers: { 'x-club-owner': cf.owner } }));
  ok(await cfPost(games, { restore: 'conf-2', pin: cf.pin }));
  const one = (await cfAudit(undefined, 'conf-1')).json.audit;
  const e = one.find(x => x.action === 'edit');
  assert.deepEqual(e.before.score, [11, 6]); assert.deepEqual(e.after.score, [11, 8]); assert.equal(e.actor, 'organizer-pin'); assert.ok(e.at > 0);
  const two = (await cfAudit(undefined, 'conf-2')).json.audit.map(x => [x.action, x.actor]).reverse();
  assert.deepEqual(two, [['create', 'anonymous'], ['confirm', 'organizer-pin'], ['delete', 'creator'], ['restore', 'organizer-pin']]);
  assert.deepEqual((await cfAudit(undefined, 'conf-2')).json.audit.find(x => x.action === 'delete').before.score, [11, 6]);
});
await step('audit: an edit that changes the result by a non-organizer does not keep the confirmation (no PIN club)', async () => {
  const c2 = ok(await call(club, 'POST', { body: { name: 'Open edit', pin: '551234' } }), 201);
  await pg.query('UPDATE clubs SET pin_hash = NULL WHERE code = $1', [c2.club.code]);
  const p2 = b => call(games, 'POST', { body: { code: c2.club.code, ...b } });
  ok(await p2({ games: [cfGame('open-1')] }));
  ok(await p2({ confirm: 'open-1', ownerToken: c2.ownerToken }));
  assert.equal((await pg.query("SELECT confirmed_by FROM games WHERE id = 'open-1'")).rows[0].confirmed_by, 'organizer');
  ok(await p2({ edit: cfGame('open-1', { score: [11, 2] }) }));
  assert.equal((await pg.query("SELECT confirmed_by FROM games WHERE id = 'open-1'")).rows[0].confirmed_by, null, 'anyone can edit here, so the old confirmation no longer stands');
  ok(await p2({ edit: cfGame('open-1', { score: [11, 2], endedAt: now - 3000000 }) }));
  const a = await call(games, 'GET', { query: `?code=${c2.club.code}&audit=1` });
  assert.equal(a.status, 403, 'a club without a PIN shows its history only to the creating phone');
  assert.equal((await call(games, 'GET', { query: `?code=${c2.club.code}&audit=1`, headers: { 'x-club-owner': c2.ownerToken } })).status, 200);
});
await step('audit: the history is organizer-only and never reveals itself to the club code alone', async () => {
  assert.equal((await cfAudit({})).status, 403, 'club code only');
  assert.equal((await cfAudit({ headers: { 'x-club-pin': '000000' } })).status, 403, 'wrong PIN');
  assert.equal((await cfAudit({ headers: { 'x-club-owner': 'f'.repeat(48) } })).status, 403, 'wrong creator token');
  assert.equal((await cfAudit({ headers: { 'x-club-pin': cf.pin } })).status, 200, 'the PIN');
  const player = await cfAudit({ headers: { 'x-club-pin': 'x' } });
  assert.equal(player.status, 403);
  const text = JSON.stringify((await cfGet()));
  assert.ok(!text.includes('game_audit') && !text.includes('"actor"'), 'the club payload carries no history');
});
await step('audit: event matches are recorded too, event games count even when confirmation is required', async () => {
  ok(await cfPost(club, { action: 'set-confirmation', required: true, ownerToken: cf.owner }));
  const e = ok(await cfPost(events, { action: 'create', event: { name: 'Cf cup', format: 'roundrobin', rotation: 'auto', courts: 1, players: ['Pa', 'Pb', 'Pc', 'Pd'], seed: 'cf' }, ownerToken: cf.owner }), 201).event;
  const m = e.rounds[0].matches[0];
  ok(await cfPost(events, { action: 'result', id: e.id, matchId: m.id, score: [11, 3], endedAt: Date.now(), ownerToken: cf.owner }));
  const gid = `${e.id}-${m.id}`;
  const g = (await cfGet()).games.find(x => x.id === gid);
  assert.ok(g.event && !g.hold);
  ok(await cfPost(events, { action: 'correct', id: e.id, matchId: m.id, score: [11, 5], ownerToken: cf.owner }));
  const log = (await cfAudit(undefined, gid)).json.audit.map(x => [x.action, x.note]).reverse();
  assert.deepEqual(log, [['create', 'event match'], ['edit', 'event score corrected']]);
  ok(await cfPost(club, { action: 'set-confirmation', required: false, ownerToken: cf.owner }));
});
await step('confirmation: a co-organizer can confirm and read the history, and is named in it', async () => {
  ok(await cfPost(playersApi, { action: 'set-role', name: 'Eve', role: 'organizer', ownerToken: cf.owner }));
  const co = `${cfTok.Eve}:Eve`;
  ok(await cfPost(games, { games: [cfGame('conf-co', { endedAt: now - 11000000 })], playerName: 'Ann', playerToken: cfTok.Ann }));
  assert.equal((await cfPost(games, { confirm: 'conf-co', playerName: 'Bo', playerToken: cfTok.Bo })).status, 403); // a teammate of the scorer still can't
  ok(await cfPost(games, { confirm: 'conf-co', ownerToken: co }));
  const h = ok(await cfAudit({ headers: { 'x-club-owner': co } }, 'conf-co'));
  assert.ok(JSON.stringify(h).includes('co-organizer:eve'));
});
await step('confirmation: the new columns and table are additive', async () => {
  const cols = (await pg.query("SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE (table_name = 'games' AND column_name IN ('confirmed_by','confirmed_at','dup_ok')) OR (table_name = 'clubs' AND column_name = 'require_confirmation')")).rows;
  assert.equal(cols.length, 4);
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'game_audit'")).rows[0].n, 1);
});

// ---- Open play court board ----
const cb = await (async () => {
  const c = ok(await call(club, 'POST', { body: { name: 'Court board club', pin: '582913' } }), 201);
  return { code: c.club.code, owner: c.ownerToken, pin: '582913' };
})();
const cbPost = (body) => call(live, 'POST', { body: { code: cb.code, ...body } });
const cbOrg = { ownerToken: cb.owner };
const cbGet = async () => ok(await call(live, 'GET', { query: `?code=${cb.code}&board=1` }));
const cbTok = {};
await step('court board: off until an organizer turns it on, and then only an organizer can set it up', async () => {
  assert.equal((await cbGet()).board, null);
  assert.equal((await cbPost({ action: 'board-config', courts: 2 })).status, 403, 'no credentials');
  assert.equal((await cbPost({ action: 'board-config', courts: 2, pin: '000000' })).status, 403, 'wrong PIN');
  assert.equal((await cbPost({ action: 'board-checkin', name: 'Ann' })).status, 403);
  assert.equal((await cbPost({ action: 'board-checkin', name: 'Ann', ...cbOrg })).status, 404, 'no board yet');
  for (const n of ['Ann', 'Bo', 'Cat', 'Dee', 'Eve', 'Fay']) cbTok[n] = ok(await call(playersApi, 'POST', { body: { code: cb.code, action: 'claim', name: n, ownerToken: cb.owner } })).playerToken;
  assert.equal((await cbPost({ action: 'board-config', courts: 2, name: 'Ann', playerToken: cbTok.Ann })).status, 403, 'a player is not an organizer');
  assert.equal((await cbPost({ action: 'board-config', courts: 99, ...cbOrg })).status, 400);
  const r = ok(await cbPost({ action: 'board-config', courts: 2, ...cbOrg }));
  assert.equal(r.board.courts.length, 2);
  assert.equal(r.board.config.control, 'players');
});
await step('court board: players check themselves in; organizers check anyone in; strangers cannot', async () => {
  assert.equal((await cbPost({ action: 'board-checkin', name: 'Ann', playerToken: cbTok.Bo })).status, 403, 'someone else\'s token');
  assert.equal((await cbPost({ action: 'board-checkin', name: 'Ann', playerToken: 'a'.repeat(48) })).status, 403);
  for (const n of ['Ann', 'Bo', 'Cat']) ok(await cbPost({ action: 'board-checkin', name: n, playerToken: cbTok[n] }));
  const r = ok(await cbPost({ action: 'board-checkin', names: ['dee', 'Eve', 'Guest One', 'Guest Two'], ...cbOrg }));
  assert.deepEqual(r.board.queue, ['Ann', 'Bo', 'Cat', 'Dee', 'Eve', 'Guest One', 'Guest Two'], 'saved spelling is used, guests as typed');
  assert.equal(ok(await cbPost({ action: 'board-checkin', name: 'Ann', playerToken: cbTok.Ann })).board.present.length, 7, 'checking in twice changes nothing');
  assert.equal((await cbPost({ action: 'board-checkout', name: 'Bo', target: 'Ann', playerToken: cbTok.Bo })).status, 403, 'a player checks out only themself');
  assert.equal(ok(await cbPost({ action: 'board-checkin', name: 'Fay', playerToken: cbTok.Fay })).board.present.length, 8);
  assert.equal(ok(await cbPost({ action: 'board-checkout', name: 'Fay', playerToken: cbTok.Fay })).board.present.length, 7);
});
await step('court board: a checked-in player calls a group; one who is not checked in cannot', async () => {
  assert.equal((await cbPost({ action: 'board-call', court: 1, name: 'Fay', playerToken: cbTok.Fay })).status, 403);
  const r = ok(await cbPost({ action: 'board-call', court: 1, name: 'Eve', playerToken: cbTok.Eve }));
  assert.equal(r.board.courts[0].teams.flat().length, 4);
  assert.ok(r.board.courts[0].teams.flat().includes('Ann'), 'the longest wait plays');
  assert.equal(r.board.queue.length, 3);
  assert.equal((await cbPost({ action: 'board-call', court: 1, ...cbOrg })).status, 409, 'court in use');
  assert.equal((await cbPost({ action: 'board-checkout', name: 'Ann', playerToken: cbTok.Ann })).status, 409, 'on a court');
  assert.equal((await cbGet()).version, r.version);
});
await step('court board: the live game being scored for those players shows on the court and decides the winner', async () => {
  const court = (await cbGet()).board.courts[0];
  const [A, B] = court.teams;
  const state = (score, winner) => ({ score, winner, serving: 0, serverNum: 1, startedAt: Date.now(), cfg: { mode: 'doubles', scoring: 'rally', target: 11, teams: [B, A] } });
  ok(await cbPost({ action: 'state', id: 'live-cb1', secret: 'secretcb1', state: state([5, 3], null) }));
  let c = (await cbGet()).board.courts[0];
  assert.deepEqual(c.live.score, [3, 5], 'the score follows the court\'s team order, however the scorer set the sides');
  assert.equal(c.live.winner, null);
  ok(await cbPost({ action: 'state', id: 'live-cb1', secret: 'secretcb1', state: state([4, 11], 1) })); // A (second in the scorer's order) won
  c = (await cbGet()).board.courts[0];
  assert.equal(c.live.winner, 0);
  // the caller says team 1 won, but the referee's own game says team 0: the game wins
  const r = ok(await cbPost({ action: 'board-finish', court: 1, winner: 1, name: 'Ann', playerToken: cbTok.Ann }));
  assert.equal(r.board.courts[0].court, 1);
  assert.ok(!r.board.courts[0].teams, 'court is free');
  assert.deepEqual(r.board.queue.slice(-4), [...A, ...B], 'rotate: the winners go to the back first');
  ok(await cbPost({ action: 'end', id: 'live-cb1', secret: 'secretcb1' }));
});
await step('court board: finishing without a live game needs the winner; the board never saves a game', async () => {
  ok(await cbPost({ action: 'board-call', court: 2, ...cbOrg }));
  assert.equal((await cbPost({ action: 'board-finish', court: 2, ...cbOrg })).status, 400);
  assert.equal((await cbPost({ action: 'board-finish', court: 2, winner: 0, name: 'Fay', playerToken: cbTok.Fay })).status, 403);
  const r = ok(await cbPost({ action: 'board-finish', court: 2, winner: 0, ...cbOrg }));
  assert.ok(!r.board.courts[1].teams);
  assert.equal((await call(club, 'GET', { query: '?code=' + cb.code })).json.games.length, 0, 'no game reached the club record');
  assert.equal((await cbPost({ action: 'board-finish', court: 2, winner: 0, ...cbOrg })).status, 409, 'nothing to finish');
});
await step('court board: organizer-only control keeps players off the courts, then the setting can change back', async () => {
  ok(await cbPost({ action: 'board-config', control: 'organizer', ...cbOrg }));
  const r = await cbPost({ action: 'board-call', court: 1, name: 'Eve', playerToken: cbTok.Eve });
  assert.equal(r.status, 403);
  ok(await cbPost({ action: 'board-call', court: 1, ...cbOrg }));
  assert.equal((await cbPost({ action: 'board-cancel', court: 1, name: 'Ann', playerToken: cbTok.Ann })).status, 403);
  const c = ok(await cbPost({ action: 'board-cancel', court: 1, pin: cb.pin }));
  assert.equal(c.board.courts[0].teams, undefined);
  assert.equal(c.board.queue.length, 7, 'everyone is back in the queue');
  assert.equal(ok(await cbPost({ action: 'board-checkin', name: 'Fay', playerToken: cbTok.Fay })).board.present.length, 8, 'checking in is still open to players');
  ok(await cbPost({ action: 'board-config', control: 'players', ...cbOrg }));
});
await step('court board: settings that would strand a game are refused; winners-stay holds the court', async () => {
  ok(await cbPost({ action: 'board-config', mode: 'winners-stay', stayLimit: 2, ...cbOrg }));
  ok(await cbPost({ action: 'board-call', court: 2, ...cbOrg }));
  assert.equal((await cbPost({ action: 'board-config', courts: 1, ...cbOrg })).status, 409);
  assert.equal((await cbPost({ action: 'board-config', format: 'singles', ...cbOrg })).status, 409);
  const before = (await cbGet()).board.courts[1].teams;
  const r = ok(await cbPost({ action: 'board-finish', court: 2, winner: 0, ...cbOrg }));
  assert.deepEqual(r.board.courts[1].hold, before[0]);
  assert.equal(r.board.suggestions.find(s => s.court === 2).teams[0].join(), before[0].join(), 'the winners are the first team of the next call');
});
await step('court board: two phones changing it at once never lose a change', async () => {
  const results = await Promise.all(['Cat', 'Dee', 'Eve'].map(n => cbPost({ action: 'board-rest', name: n, playerToken: cbTok[n] })));
  for (const r of results) assert.ok(r.status === 200 || r.status === 409, JSON.stringify(r.json));
  const b = (await cbGet()).board;
  const all = [...b.queue, ...b.courts.flatMap(c => (c.teams ? c.teams.flat() : c.hold || []))];
  assert.equal(new Set(all).size, all.length);
});
await step('court board: a renamed player is renamed on the board; an anonymised one loses their name there', async () => {
  const names = async () => { const b = (await cbGet()).board; return [...b.present, ...b.queue, ...b.courts.flatMap(c => (c.teams ? c.teams.flat() : c.hold || []))]; };
  assert.ok((await names()).includes('Cat'));
  ok(await call(playersApi, 'POST', { body: { code: cb.code, action: 'rename', name: 'Cat', newName: 'Cathy', ...cbOrg } }));
  let all = await names();
  assert.ok(all.includes('Cathy') && !all.includes('Cat'), 'rename reaches present, queue and courts');
  const who = ok(await call(playersApi, 'POST', { body: { code: cb.code, action: 'anonymise', name: 'Dee', ...cbOrg } }));
  all = await names();
  assert.ok(!all.includes('Dee') && all.includes(who.label), 'anonymise relabels the board');
  assert.equal((await cbGet()).board.config.format, 'doubles', 'settings are never rewritten as names');
});
await step('court board: end of session clears it, only for organizers; courts and players stay inside limits', async () => {
  assert.equal((await cbPost({ action: 'board-reset', name: 'Ann', playerToken: cbTok.Ann })).status, 403);
  const r = ok(await cbPost({ action: 'board-reset', ...cbOrg }));
  assert.equal(r.board.present.length, 0);
  assert.equal(r.board.courts.length, 2);
  const many = Array.from({ length: 81 }, (_, i) => 'Walk-in ' + i);
  assert.equal((await cbPost({ action: 'board-checkin', names: many, ...cbOrg })).status, 400, 'a batch is capped');
  const bad = await cbPost({ action: 'board-checkin', names: many.slice(0, 40), ...cbOrg });
  assert.equal(bad.status, 200);
  const bad2 = await cbPost({ action: 'board-checkin', names: many.slice(40, 80), ...cbOrg });
  assert.equal(bad2.status, 200);
  assert.equal((await cbPost({ action: 'board-checkin', name: 'One too many', ...cbOrg })).status, 409);
});
await step('court board: the new table is additive and goes with the club', async () => {
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'court_boards'")).rows[0].n, 1);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM court_boards')).rows[0].n, 1);
  const fk = (await pg.query("SELECT confdeltype FROM pg_constraint WHERE conrelid = 'court_boards'::regclass AND contype = 'f'")).rows;
  assert.equal(fk[0].confdeltype, 'c', 'cascades from clubs');
});

// ---- public result pages (X11): a game or session shared as a read-only link ----
const resultApi = bracket; // the public page rides on api/bracket.js, the management calls on api/club.js
const sc = await (async () => { const c = ok(await call(club, 'POST', { body: { name: 'Share check club' } }), 201); return { code: c.club.code, owner: c.ownerToken, name: 'Share check club' }; })();
const scPost = (h, body) => call(h, 'POST', { body: { code: sc.code, ...body } });
const scOrg = { ownerToken: sc.owner };
const scGame = (id, extra = {}) => ({ id, mode: 'doubles', teams: [['Ann', 'Bo'], ['Cat', 'Dee']], score: [11, 6], endedAt: now - 3600000, startedAt: now - 3700000, ...extra });
const scLog = playLog(dcfg, 0.6, 11);
const pubGet = (token, fmt, headers) => call(resultApi, 'GET', { query: `?result=1&token=${token}${fmt ? '&fmt=' + fmt : ''}`, headers });
const pubRaw = async (token, fmt) => { // the page and the image are not JSON
  const req = { method: 'GET', url: `/api/bracket?result=1&token=${token}&fmt=${fmt}`, headers: { 'x-real-ip': '10.9.9.' + (++ip % 200), host: 'dink.example' } };
  const out = { headers: {} }; const res = { statusCode: 0, setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, end(b) { out.status = res.statusCode; out.body = b; } };
  await resultApi(req, res); return out;
};
const NOTFOUND = 'This link is not active.';
const sc404 = r => { assert.equal(r.status, 404); assert.equal(r.json.error, NOTFOUND); };
let scTok = {}, scSession;
await step('public results: off by default, so nobody can make a link and unknown tokens are a uniform 404', async () => {
  ok(await scPost(games, { games: [scGame('sc-live', { rallyLog: scLog.raw, ...dcfg, score: scLog.score, rallies: scLog.wins.length, teams: [['Ann', 'Bo'], ['Cat', 'Dee']] }), scGame('sc-hand', { logged: true })] }));
  assert.equal((await scPost(club, { action: 'results-create', game: 'sc-live' })).status, 403);
  sc404(await pubGet('A'.repeat(32))); sc404(await pubGet('short')); sc404(await pubGet(''));
  assert.equal((await call(club, 'GET', { query: `?code=${sc.code}` })).json.club.publicResults, false);
});
await step('public results: only an organizer turns them on; members and strangers cannot', async () => {
  assert.equal((await scPost(club, { action: 'results-set', enabled: true })).status, 403);
  assert.equal((await scPost(club, { action: 'results-set', enabled: true, pin: '000000' })).status, 403);
  assert.equal((await scPost(club, { action: 'results-set', enabled: 'yes', ...scOrg })).status, 400);
  ok(await scPost(club, { action: 'results-set', enabled: true, ...scOrg }));
  assert.equal((await call(club, 'GET', { query: `?code=${sc.code}` })).json.club.publicResults, true);
});
await step('public results: a member makes one link per game (same link again), and it needs a real, shareable game', async () => {
  const a = ok(await scPost(club, { action: 'results-create', game: 'sc-live' })), b = ok(await scPost(club, { action: 'results-create', game: 'sc-live' }));
  assert.match(a.token, /^[A-Za-z0-9_-]{32}$/); assert.equal(a.token, b.token); assert.equal(a.path, '/r/' + a.token);
  scTok.live = a.token; scTok.hand = ok(await scPost(club, { action: 'results-create', game: 'sc-hand' })).token;
  assert.notEqual(scTok.live, scTok.hand);
  assert.equal((await scPost(club, { action: 'results-create', game: 'nope' })).status, 404);
  assert.equal((await call(club, 'POST', { body: { code: 'ZZZZZ2', action: 'results-create', game: 'sc-live' } })).status, 404);
});
await step('public results: the public JSON is the allow-list, with the chart numbers, and no club identity', async () => {
  const r = await pubGet(scTok.live), text = JSON.stringify(r.json);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.teams, [['Ann', 'Bo'], ['Cat', 'Dee']]);
  assert.deepEqual(r.json.score, scLog.score);
  assert.equal(r.json.flow.n, scLog.wins.length);
  for (const leak of [sc.code, sc.name, sc.owner, 'sc-live', 'rallyLog', 'receivedAt', 'scoredBy', 'ownerToken', 'pin']) assert.ok(!text.includes(leak), 'leaked ' + leak);
  assert.equal((await pubGet(scTok.hand)).json.flow, null, 'a hand-logged game has no chart');
});
await step('public results: the page has preview tags and no inline script; the card is a PNG; both are cached briefly and noindex', async () => {
  const h = await pubRaw(scTok.live, 'html');
  assert.equal(h.status, 200); assert.match(h.headers['content-type'], /text\/html/);
  assert.match(h.body, new RegExp(`og:image" content="https://dink.example/r/${scTok.live}/card.png"`));
  assert.ok(!h.body.includes(sc.code) && !h.body.includes(sc.name));
  assert.match(h.headers['cache-control'], /s-maxage=20/); assert.match(h.headers['x-robots-tag'], /noindex/);
  const p = await pubRaw(scTok.live, 'png');
  assert.equal(p.headers['content-type'], 'image/png'); assert.deepEqual([...p.body.subarray(1, 4)], [80, 78, 71]);
  const dead = await pubRaw('B'.repeat(32), 'html'); assert.equal(dead.status, 404); assert.match(dead.body, /not active/);
});
await step('public results: a session link covers one day of games; the span is limited and it must hold a game', async () => {
  const from = now - 86400000, to = now;
  scSession = ok(await scPost(club, { action: 'results-create', from, to }));
  assert.equal(ok(await scPost(club, { action: 'results-create', from, to })).token, scSession.token);
  const s = await pubGet(scSession.token);
  assert.equal(s.json.kind, 'session'); assert.equal(s.json.games.length, 2);
  assert.ok(!JSON.stringify(s.json).includes('sc-live'));
  assert.equal((await scPost(club, { action: 'results-create', from, to: from + 40 * 3600000 })).status, 400);
  assert.equal((await scPost(club, { action: 'results-create', from: from - 5 * 86400000, to: from - 4 * 86400000 })).status, 404);
  assert.equal((await pubRaw(scSession.token, 'png')).headers['content-type'], 'image/png');
});
await step('public results: only organizers list or revoke; revoking ends that link at once and no other', async () => {
  assert.equal((await call(club, 'GET', { query: `?code=${sc.code}&results=list` })).status, 403);
  assert.equal((await scPost(club, { action: 'results-revoke', token: scTok.live })).status, 403);
  assert.equal((await pubGet(scTok.live)).status, 200, 'a refused revoke changes nothing');
  const list = ok(await call(club, 'GET', { query: `?code=${sc.code}&results=list`, headers: { 'x-club-owner': sc.owner } }));
  assert.equal(list.links.length, 3); assert.equal(list.enabled, true);
  ok(await scPost(club, { action: 'results-revoke', token: scTok.live, ...scOrg }));
  sc404(await pubGet(scTok.live)); assert.equal((await pubRaw(scTok.live, 'png')).status, 404);
  assert.equal((await pubGet(scTok.hand)).status, 200);
  assert.equal((await scPost(club, { action: 'results-revoke', token: scTok.live, ...scOrg })).status, 404);
  const again = ok(await scPost(club, { action: 'results-create', game: 'sc-live' }));
  assert.notEqual(again.token, scTok.live, 'a revoked link is never reissued'); sc404(await pubGet(scTok.live)); scTok.live = again.token;
});
await step('public results: a deleted game, an edit and the history are respected', async () => {
  ok(await call(games, 'DELETE', { query: `?code=${sc.code}&id=sc-hand`, headers: { 'x-club-owner': sc.owner } }));
  sc404(await pubGet(scTok.hand));
  assert.equal((await pubGet(scSession.token)).json.games.length, 1, 'a deleted game leaves the session page too');
  const audit = ok(await call(games, 'GET', { query: `?code=${sc.code}&audit=1`, headers: { 'x-club-owner': sc.owner } })).audit;
  assert.ok(audit.some(a => a.action === 'share') && audit.some(a => a.action === 'unshare') && audit.some(a => a.action === 'setting'));
});
await step('public results: a game held for confirmation is not shared; anonymised names stay anonymous', async () => {
  ok(await scPost(club, { action: 'set-confirmation', required: true, ...scOrg }));
  assert.equal((await scPost(club, { action: 'results-create', game: 'sc-live' })).json.token, undefined);
  sc404(await pubGet(scTok.live)); sc404(await pubGet(scSession.token));
  ok(await scPost(club, { action: 'set-confirmation', required: false, ...scOrg }));
  assert.equal((await pubGet(scTok.live)).status, 200);
  const claim = ok(await scPost(playersApi, { action: 'claim', name: 'Ann', ...scOrg })).playerToken;
  ok(await scPost(playersApi, { action: 'anonymise', name: 'Ann', playerToken: claim }));
  const r = (await pubGet(scTok.live)).json, text = JSON.stringify(r);
  assert.ok(!text.includes('Ann'), 'the old name is gone'); assert.match(r.teams[0][0], /^Former player [A-Z0-9]{5}$/);
});
await step('public results: a club waiting to be deleted shows nothing; undoing brings its links back', async () => {
  ok(await scPost(club, { action: 'delete-club', confirm: sc.name, ...scOrg }));
  sc404(await pubGet(scTok.live)); sc404(await pubGet(scSession.token));
  ok(await scPost(club, { action: 'cancel-delete-club', ...scOrg }));
  assert.equal((await pubGet(scTok.live)).status, 200);
});
await step('public results: turning the feature off ends every link for good, and on again starts empty', async () => {
  ok(await scPost(club, { action: 'results-set', enabled: false, ...scOrg }));
  sc404(await pubGet(scTok.live)); sc404(await pubGet(scSession.token));
  assert.equal((await scPost(club, { action: 'results-create', game: 'sc-live' })).status, 403);
  ok(await scPost(club, { action: 'results-set', enabled: true, ...scOrg }));
  sc404(await pubGet(scTok.live));
  assert.equal(ok(await call(club, 'GET', { query: `?code=${sc.code}&results=list`, headers: { 'x-club-owner': sc.owner } })).links.length, 0);
});
await step('public results: the public endpoint is rate limited per network and only reads', async () => {
  const same = { 'x-real-ip': '10.77.0.1' };
  let last;
  for (let i = 0; i < 61; i++) last = await pubGet('C'.repeat(32), '', same);
  assert.equal(last.status, 429);
  assert.equal((await pubGet('C'.repeat(32), '', { 'x-real-ip': '10.77.0.2' })).status, 404, 'another network is not affected');
  assert.equal((await call(resultApi, 'POST', { body: {} })).status, 405);
});
await step('public results: the new column and table are additive and cascade from the club', async () => {
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'clubs' AND column_name = 'public_results' AND column_default = 'false'")).rows[0].n, 1);
  const fk = (await pg.query("SELECT rc.delete_rule FROM information_schema.referential_constraints rc JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name WHERE tc.table_name = 'result_shares'")).rows;
  assert.ok(fk.length && fk.every(r => r.delete_rule === 'CASCADE'));
});

// ---- Pickup sessions (api/_sessions.js, reached through api/live.js) ----
const pk = (body, headers) => call(live, 'POST', { body, headers });
const pkGet = (c, headers) => call(live, 'GET', { query: '?session=' + c, headers });
const pkGame = (id, extra = {}) => ({ id, mode: 'doubles', teams: [['Ann', 'Bo'], ['Cat', 'Dee']], score: [11, 6], endedAt: Date.now() - 60000, startedAt: Date.now() - 600000, ...extra });
const sessionRows = async () => (await pg.query('SELECT (SELECT count(*)::int FROM pickup_sessions) AS s, (SELECT count(*)::int FROM pickup_players) AS p, (SELECT count(*)::int FROM pickup_games) AS g')).rows[0];
let ps;
await step('pickup: anyone can start a session; it gets an 8 character code and a host token, and lasts 24 hours', async () => {
  const before = Date.now();
  ps = ok(await pk({ action: 'session-create', name: 'Saturday pickup' }));
  assert.match(ps.session.code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.match(ps.hostToken, /^[0-9a-f]{48}$/);
  assert.ok(Math.abs(ps.session.expiresAt - (before + 864e5)) < 5000);
  assert.deepEqual(ps.players, []); assert.deepEqual(ps.games, []);
  assert.equal(JSON.stringify(ps).includes('host_hash'), false);
  const got = ok(await pkGet(ps.session.code.toLowerCase()));
  assert.equal(got.session.name, 'Saturday pickup');
  assert.equal(JSON.stringify(got).includes(ps.hostToken), false, 'the host token only ever comes back at creation');
});
await step('pickup: bad, unknown and club-shaped codes are refused, and a session code is no club code', async () => {
  assert.equal((await pkGet('ABC')).status, 400);
  assert.equal((await pkGet('A'.repeat(8))).status, 404);
  assert.equal((await call(club, 'GET', { query: '?code=' + ps.session.code })).status, 400);
  assert.equal((await pk({ action: 'session-join', code: code, name: 'Zed' })).status, 400, 'a club code is not a session code');
});
await step('pickup: joining adds a name once (case and spacing ignored); games add their players', async () => {
  const c = ps.session.code;
  ok(await pk({ action: 'session-join', code: c, name: 'Sam  Lee' }));
  const r = ok(await pk({ action: 'session-join', code: c, name: 'sam lee' }));
  assert.deepEqual(r.players, ['Sam Lee']);
  assert.equal((await pk({ action: 'session-join', code: c, name: '   ' })).status, 400);
  const g = ok(await pk({ action: 'session-game', code: c, game: pkGame('pk-one') }));
  assert.equal(g.saved, 1);
  assert.deepEqual(g.players.sort(), ['Ann', 'Bo', 'Cat', 'Dee', 'Sam Lee']);
  assert.equal(g.games.length, 1);
  assert.equal(g.games[0].winner, 0);
});
await step('pickup: a game is validated like a club game, a retry adds nothing, and the cap holds', async () => {
  const c = ps.session.code;
  assert.equal((await pk({ action: 'session-game', code: c, game: pkGame('pk-bad', { score: [11, 11] }) })).status, 400);
  assert.equal((await pk({ action: 'session-game', code: c, game: pkGame('x') })).status, 400);
  assert.equal(ok(await pk({ action: 'session-game', code: c, game: pkGame('pk-one', { score: [2, 11] }) })).saved, 0, 'same id: the first result stands');
  assert.equal(ok(await pkGet(c)).games.length, 1);
  await pg.query(`INSERT INTO pickup_games (session, id, data, ended_at) SELECT $1, 'fill' || g, '{}'::jsonb, g FROM generate_series(1, 99) g`, [c]);
  assert.equal((await pk({ action: 'session-game', code: c, game: pkGame('pk-over') })).status, 400, 'a hundred games is the most');
  await pg.query("DELETE FROM pickup_games WHERE id LIKE 'fill%'");
  for (let i = 0; i < 25; i++) ok(await pk({ action: 'session-join', code: c, name: 'Extra ' + i }));
  assert.equal((await pk({ action: 'session-join', code: c, name: 'One too many' })).status, 400, 'thirty players is the most');
  assert.equal(ok(await pkGet(c)).players.length, 30);
});
await step('pickup: only the starting phone can remove a game or end the session', async () => {
  const c = ps.session.code;
  assert.equal((await pk({ action: 'session-game-delete', code: c, id: 'pk-one' })).status, 403);
  assert.equal((await pk({ action: 'session-game-delete', code: c, id: 'pk-one', hostToken: 'a'.repeat(48) })).status, 403);
  assert.equal((await pk({ action: 'session-end', code: c, hostToken: owner })).status, 403, 'a club creator token is not a host token');
  assert.equal(ok(await pk({ action: 'session-game-delete', code: c, id: 'pk-one', hostToken: ps.hostToken })).games.length, 0);
  assert.equal((await pk({ action: 'session-end', code: c })).status, 403);
});
await step('pickup: nothing about a session reaches a club', async () => {
  const before = await clubGames();
  const rosterBefore = ok(await call(club, 'GET', { query: '?code=' + code })).roster;
  const c = ok(await pk({ action: 'session-create' })).session.code;
  ok(await pk({ action: 'session-game', code: c, game: pkGame('pk-leak', { teams: [['Leak One', 'Leak Two'], ['Leak Three', 'Leak Four']] }) }));
  const after = ok(await call(club, 'GET', { query: '?code=' + code }));
  assert.equal(after.games.length, before.length);
  assert.deepEqual(after.roster, rosterBefore);
  assert.equal(JSON.stringify(after).includes('Leak'), false);
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM games WHERE id = 'pk-leak'")).rows[0].n, 0);
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM roster WHERE name LIKE 'Leak%'")).rows[0].n, 0);
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM live_games WHERE id = 'pk-leak'")).rows[0].n, 0);
});
await step('pickup: a member saves a session into a club through the normal games route, once however often it is sent', async () => {
  const lk = (await pg.query("SELECT session FROM pickup_games WHERE id = 'pk-leak'")).rows[0].session;
  const [g] = ok(await pkGet(lk)).games;
  const body = { code, games: [g], ownerToken: owner };
  assert.equal(ok(await call(games, 'POST', { body })).saved, 1);
  assert.equal(ok(await call(games, 'POST', { body })).saved, 0);
  assert.equal((await clubGames()).filter(x => x.id === 'pk-leak').length, 1);
});
await step('pickup: the server ends a session after 24 hours, whatever any page says', async () => {
  const c = ps.session.code;
  await pg.query("UPDATE pickup_sessions SET expires_at = now() + interval '1 minute' WHERE code = $1", [c]);
  assert.equal((await pkGet(c)).status, 200);
  await pg.query("UPDATE pickup_sessions SET expires_at = now() - interval '1 second' WHERE code = $1", [c]);
  const rowsBefore = await sessionRows();
  assert.ok(rowsBefore.p > 0 && rowsBefore.g > 0);
  assert.equal((await pkGet(c)).status, 404);
  assert.equal((await pk({ action: 'session-join', code: c, name: 'Late' })).status, 404);
  assert.equal((await pk({ action: 'session-game', code: c, game: pkGame('pk-late') })).status, 404);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM pickup_sessions WHERE code = $1', [c])).rows[0].n, 0, 'the expired session is deleted when asked for');
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM pickup_players WHERE session = $1', [c])).rows[0].n, 0);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM pickup_games WHERE session = $1', [c])).rows[0].n, 0);
});
await step('pickup: ending a session deletes it and everything in it at once', async () => {
  const s = ok(await pk({ action: 'session-create' }));
  ok(await pk({ action: 'session-game', code: s.session.code, game: pkGame('pk-end') }));
  assert.equal(ok(await pk({ action: 'session-end', code: s.session.code, hostToken: s.hostToken })).ended, true);
  assert.equal((await pkGet(s.session.code)).status, 404);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM pickup_games WHERE session = $1', [s.session.code])).rows[0].n, 0);
});
await step('pickup: wrong codes are limited per network like club codes, and starting sessions is limited', async () => {
  const same = { 'x-real-ip': '10.88.0.1' };
  let last;
  for (let i = 0; i < 22; i++) last = await pkGet('B'.repeat(8), same);
  assert.equal(last.status, 429);
  const real = ok(await pk({ action: 'session-create' }, { 'x-real-ip': '10.88.3.1' })).session.code;
  assert.equal((await pkGet(real, same)).status, 429, 'a locked network is refused even for a real code');
  assert.equal((await pkGet('B'.repeat(8), { 'x-real-ip': '10.88.0.2' })).status, 404, 'another network is not affected');
  const mk = { 'x-real-ip': '10.88.1.1' };
  for (let i = 0; i < 10; i++) ok(await pk({ action: 'session-create' }, mk));
  assert.equal((await pk({ action: 'session-create' }, mk)).status, 429);
  const live1 = ok(await pk({ action: 'session-create' }, { 'x-real-ip': '10.88.2.1' })).session.code;
  assert.equal((await pk({ action: 'session-bogus', code: live1 }, { 'x-real-ip': '10.88.2.1' })).status, 400);
});
await step('pickup: the tables are additive, hold no club key and cascade from the session', async () => {
  const cols = (await pg.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('pickup_sessions', 'pickup_players', 'pickup_games')")).rows.map(r => r.column_name);
  assert.ok(!cols.includes('club'), 'no column ties a session to a club');
  const fk = (await pg.query("SELECT tc.table_name, rc.delete_rule FROM information_schema.referential_constraints rc JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name WHERE tc.table_name IN ('pickup_players', 'pickup_games')")).rows;
  assert.equal(fk.length, 2); assert.ok(fk.every(r => r.delete_rule === 'CASCADE'));
});

// Sync v2 (api/_sync.js): ETag + 304 on the polled GETs, never across clubs, never stale.
const cget = (c, extra = {}) => call(club, 'GET', { query: '?code=' + c, headers: extra });
await step('sync: a club answer carries an ETag; the held tag gets an empty 304, and no tag gets the full answer as before', async () => {
  const full = await cget(code);
  assert.equal(full.status, 200);
  assert.match(full.headers.etag, /^W\/"/);
  assert.equal(full.headers['cache-control'], 'no-store');
  assert.ok(Array.isArray(full.json.games) && full.json.club.code === code, 'old clients still get the whole shape');
  const same = await cget(code, { 'if-none-match': full.headers.etag });
  assert.equal(same.status, 304);
  assert.equal(same.bytes, 0);
  assert.equal(same.headers.etag, full.headers.etag);
  assert.equal((await cget(code)).status, 200, 'a caller without the tag is never short-changed');
});
await step('sync: any change to games, roster, settings or deletions ends the 304', async () => {
  const held = (await cget(code)).headers.etag;
  const stale = async why => { const r = await cget(code, { 'if-none-match': held }); assert.equal(r.status, 200, why); return r; };
  const g = id => ({ id, mode: 'doubles', teams: [['Ana', 'Ben'], ['Cy', 'Di']], score: [11, 7], endedAt: Date.now(), startedAt: Date.now() - 600000 });
  ok(await call(games, 'POST', { body: { code, games: [g('sync-g1')] } }));
  const afterAdd = await stale('a new game');
  const t1 = afterAdd.headers.etag;
  assert.equal((await cget(code, { 'if-none-match': t1 })).status, 304);
  ok(await call(club, 'POST', { body: { code, action: 'set-note', note: 'Court 3 is wet', ownerToken: owner } }));
  const t2 = (await cget(code, { 'if-none-match': t1 })); assert.equal(t2.status, 200, 'the pinned note is part of the answer');
  await pg.query("UPDATE roster SET avatar = '{\"type\":\"emoji\",\"value\":\"x\"}'::jsonb WHERE club = $1 AND name_key = 'ana'", [code]);
  const t3 = await cget(code, { 'if-none-match': t2.headers.etag }); assert.equal(t3.status, 200, 'an avatar change');
  await pg.query("UPDATE games SET deleted_at = now() WHERE club = $1 AND id = 'sync-g1'", [code]);
  const t4 = await cget(code, { 'if-none-match': t3.headers.etag }); assert.equal(t4.status, 200, 'a deleted game');
  assert.equal((await cget(code, { 'if-none-match': t4.headers.etag })).status, 304);
});
await step('sync: one club\'s tag never matches another club, even with identical content', async () => {
  const other = ok(await call(club, 'POST', { body: { name: 'Other sync club' } }), 201);
  const a = await cget(code), b = await cget(other.club.code);
  assert.notEqual(a.headers.etag, b.headers.etag);
  assert.equal((await cget(other.club.code, { 'if-none-match': a.headers.etag })).status, 200, "club A's tag must not 304 club B");
  assert.equal((await cget(code, { 'if-none-match': b.headers.etag })).status, 200);
  const l1 = await call(live, 'GET', { query: '?code=' + code }), l2 = await call(live, 'GET', { query: '?code=' + other.club.code });
  assert.equal(l1.json.games.length, 0); assert.equal(l2.json.games.length, 0);
  assert.notEqual(l1.headers.etag, l2.headers.etag, 'two empty live lists are still scoped per club');
  assert.equal((await call(live, 'GET', { query: '?code=' + other.club.code, headers: { 'if-none-match': l1.headers.etag } })).status, 200);
});
await step('sync: a wrong club code still gets its 404 and no tag, with or without If-None-Match', async () => {
  const full = await cget(code);
  const r = await cget('ZZZZZZ', { 'if-none-match': full.headers.etag });
  assert.equal(r.status, 404);
  assert.equal(r.headers.etag, undefined);
});
await step('sync: live, board and event answers 304 when unchanged and wake up on change', async () => {
  const lv = () => call(live, 'GET', { query: '?code=' + code });
  const l0 = await lv();
  assert.equal((await call(live, 'GET', { query: '?code=' + code, headers: { 'if-none-match': l0.headers.etag } })).status, 304);
  const st = { cfg: { teams: [['Ana', 'Ben'], ['Cy', 'Di']], mode: 'doubles', scoring: 'side-out', target: 11 }, score: [0, 0], serving: 0, serverNum: 1, winner: null, startedAt: Date.now() };
  ok(await call(live, 'POST', { body: { code, action: 'state', id: 'live-sync1', secret: 'abcdef12', state: st, ack: 0 } }));
  assert.equal((await call(live, 'GET', { query: '?code=' + code, headers: { 'if-none-match': l0.headers.etag } })).status, 200, 'a new live game');
  const one = await call(live, 'GET', { query: '?code=' + code + '&id=live-sync1&secret=abcdef12' });
  assert.equal((await call(live, 'GET', { query: '?code=' + code + '&id=live-sync1&secret=abcdef12', headers: { 'if-none-match': one.headers.etag } })).status, 304);
  assert.equal((await call(live, 'GET', { query: '?code=' + code + '&id=live-sync1&secret=wrong999', headers: { 'if-none-match': one.headers.etag } })).status, 403, 'the right tag does not replace the secret');
  const bd = await call(live, 'GET', { query: '?code=' + code + '&board=1' });
  assert.equal((await call(live, 'GET', { query: '?code=' + code + '&board=1', headers: { 'if-none-match': bd.headers.etag } })).status, 304);
  const ev = await call(events, 'GET', { query: '?code=' + code });
  assert.match(ev.headers.etag, /^W\//);
  assert.equal((await call(events, 'GET', { query: '?code=' + code, headers: { 'if-none-match': ev.headers.etag } })).status, 304);
});
await step('sync: photo avatars revalidate with an ETag and a private cache, and change when a photo does', async () => {
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(200);
  await pg.query("UPDATE roster SET avatar = jsonb_build_object('type', 'photo', 'value', $2::text) WHERE club = $1 AND name_key = 'ben'", [code, photo]);
  const a = await call(club, 'GET', { query: '?code=' + code + '&avatars=1' });
  assert.equal(a.status, 200); assert.equal(a.headers['cache-control'], 'private, no-cache');
  assert.equal(a.json.photos.Ben.value, photo);
  const same = await call(club, 'GET', { query: '?code=' + code + '&avatars=1', headers: { 'if-none-match': a.headers.etag } });
  assert.equal(same.status, 304); assert.equal(same.bytes, 0);
  await pg.query("UPDATE roster SET avatar = jsonb_build_object('type', 'photo', 'value', $2::text) WHERE club = $1 AND name_key = 'ben'", [code, photo + 'B']);
  assert.equal((await call(club, 'GET', { query: '?code=' + code + '&avatars=1', headers: { 'if-none-match': a.headers.etag } })).status, 200);
  const main = await cget(code);
  assert.ok(!JSON.stringify(main.json).includes('AAAAAAAA'), 'the main answer still carries a fingerprint, never the photo');
});

// Dink Rating v2: stored history rebuilt from the full game list, one-time changelog, history line, provisional label.
await step('Dink Rating v2: stored ratings, provisional label, one changelog row, history line, dropped on rename', async () => {
  const mkc = ok(await call(club, 'POST', { body: { name: 'Rating v2 club', pin: '246810' } }), 201);
  const rc = mkc.club.code, pin = { pin: '246810' };
  const t0 = Date.now() - 40 * 36e5;
  const rg = (i, score) => ({ id: 'rv2-' + i, mode: 'singles', teams: [['Rae'], ['Sol']], score, endedAt: t0 + i * 36e5 });
  ok(await call(games, 'POST', { body: { code: rc, games: Array.from({ length: 12 }, (_, i) => rg(i, i === 0 ? [11, 0] : [11, 6])) } }));
  const get = () => call(club, 'GET', { query: '?code=' + rc });
  const a = ok(await get());
  assert.equal(a.ratings.version, 2);
  assert.equal(a.ratings.provisionalBelow, 10);
  assert.equal(a.ratings.players.singles.rae.games, 12);
  assert.equal(a.ratings.players.singles.rae.provisional, false);
  assert.ok(a.ratings.players.singles.rae.rating > 2 && a.ratings.players.singles.sol.rating === 2);
  assert.ok(a.ratings.changelog && a.ratings.changelog.version === 2 && a.ratings.changelog.moves.singles.rae[1] < a.ratings.changelog.moves.singles.rae[0], 'the 11-0 is capped, so Rae moved down from the old rating');
  const first = a.ratings.changelog.at;
  // same answer again: one changelog row, nothing rebuilt; a new game rebuilds history but not the changelog
  ok(await call(games, 'POST', { body: { code: rc, games: [rg(13, [4, 11])] } }));
  const b = ok(await get());
  assert.equal(b.ratings.players.singles.rae.games, 13);
  assert.equal(b.ratings.changelog.at, first);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM rating_changelog WHERE club = $1`, [rc])).rows[0].n, 1);
  // the stored copy matches the engine over the club's games
  const eng = await import(pathToFileURL(path.join(root, 'api', '_rating.js')).href);
  const want = eng.compute(b.games).tables.singles.get('rae').rating;
  assert.ok(Math.abs(b.ratings.players.singles.rae.rating - Math.round(want * 100) / 100) < 1e-9);
  const h = ok(await call(games, 'GET', { query: `?code=${rc}&rating=Rae&mode=singles` }));
  assert.equal(h.points.length, 13);
  assert.equal(h.points.at(-1)[1], b.ratings.players.singles.rae.rating);
  // fewer than 10 games is provisional
  const tp = ok(await call(games, 'POST', { body: { code: rc, games: [{ id: 'rv2-p', mode: 'singles', teams: [['New'], ['Rae']], score: [11, 9], endedAt: t0 + 30 * 36e5 }] } }));
  assert.equal(ok(await get()).ratings.players.singles.new.provisional, true);
  // renaming drops the stored copy (it carries names) and the next read rebuilds it under the new name
  ok(await call(playersApi, 'POST', { body: { code: rc, action: 'rename', name: 'New', newName: 'Fresh', ...pin } }));
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM rating_history WHERE club = $1`, [rc])).rows[0].n, 0);
  const c = ok(await get());
  assert.ok(c.ratings.players.singles.fresh && !c.ratings.players.singles.new);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM rating_changelog WHERE club = $1`, [rc])).rows[0].n, 1, 'no second changelog row after a rebuild');
  void tp;
});

// ---- organizer analytics (L7): totals for organizers only ----
await step('analytics: organizers only, totals only, no player named', async () => {
  const a = ok(await call(club, 'POST', { body: { name: 'Analytics check club' } }), 201);
  const q = `?code=${a.club.code}&analytics=1&tz=Europe/London`;
  const t = Date.now() - 36e5;
  ok(await call(games, 'POST', { body: { code: a.club.code, games: [{ id: 'an-g1', mode: 'singles', teams: [['Ivy'], ['Jon']], score: [11, 4], endedAt: t, startedAt: t - 6e5 }] } }));
  assert.equal((await call(club, 'GET', { query: q })).status, 403, 'a member with only the code');
  assert.equal((await call(club, 'GET', { query: q, headers: { 'x-club-pin': '000000' } })).status, 403, 'wrong PIN');
  const d = ok(await call(club, 'GET', { query: q, headers: { 'x-club-owner': a.ownerToken } }));
  assert.equal(d.games, 1);
  assert.equal(d.weeks.reduce((n, w) => n + w.players, 0), 2);
  assert.equal(d.tz, 'Europe/London');
  assert.ok(!/Ivy|Jon/.test(JSON.stringify(d)), 'no player names in the answer');
  assert.equal(ok(await call(club, 'GET', { query: `?code=${a.club.code}&analytics=1&tz=Bad/Zone`, headers: { 'x-club-owner': a.ownerToken } })).tz, 'UTC');
});

// Event seeding and divisions from Dink Rating (L8): ratings are read on the server, never sent by the phone.
await step('seeding: server ratings seed fixed teams, split divisions, preview writes nothing, phone-sent ratings are ignored', async () => {
  const sc = ok(await call(club, 'POST', { body: { name: 'Seeding club', pin: '246810' } }), 201);
  const scode = sc.club.code, creds = { pin: '246810' };
  const ev = (action, extra) => call(events, 'POST', { body: { code: scode, action, ...extra, ...creds } });
  const t0 = Date.now() - 40 * 864e5, strong = ['Ann', 'Bo', 'Cy', 'Di'], weak = ['Ed', 'Flo', 'Gus', 'Hal'];
  const gs = Array.from({ length: 12 }, (_, i) => ({ id: 'sd-' + i, mode: 'doubles', teams: [strong.slice(0, 2), weak.slice(0, 2)], score: [11, 4], winner: 0, endedAt: t0 + i * 36e5 }))
    .concat(Array.from({ length: 6 }, (_, i) => ({ id: 'sd2-' + i, mode: 'doubles', teams: [strong.slice(2), weak.slice(2)], score: [11, 6], winner: 0, endedAt: t0 + 20 * 36e5 + i * 36e5 })));
  ok(await call(games, 'POST', { body: { code: scode, games: gs } }));
  const players = [...weak, ...strong];
  // preview: ranked by the stored rating, strongest first, nothing created
  const pv = ok(await ev('seed-preview', { players, divisions: 2, partners: 'fixed' }));
  assert.deepEqual(pv.players.slice(0, 2).map(p => p.name).sort(), ['Ann', 'Bo']);
  assert.equal(pv.divisions.length, 2);
  assert.deepEqual(pv.divisions[0].players.map(p => p.name).sort(), [...strong].sort());
  assert.ok(pv.players.find(p => p.name === 'Ann').rating > pv.players.find(p => p.name === 'Hal').rating);
  assert.equal(ok(await call(events, 'GET', { query: '?code=' + scode })).events.length, 0);
  assert.equal((await call(events, 'POST', { body: { code: scode, action: 'seed-preview', players } })).status, 403);
  // a seeded bracket: team ratings come from the server, a phone's own numbers change nothing
  const lie = Object.fromEntries(players.map((p, i) => [p, i]));
  const seeded = ok(await ev('create', { event: { name: 'Seeded cup', format: 'single_elim', rotation: 'manual', teams: [['Ed', 'Flo'], ['Gus', 'Hal'], ['Cy', 'Di'], ['Ann', 'Bo']], players, seeding: 'rating', ratings: lie, courts: 2 } }), 201).event;
  assert.deepEqual(seeded.teams[0].slice().sort(), ['Ann', 'Bo']);
  assert.deepEqual(seeded.teams[1].slice().sort(), ['Cy', 'Di']);
  assert.equal(seeded.seeding, 'rating');
  assert.ok(seeded.seeds[0] > seeded.seeds[3]);
  // divisions: one event per division, strongest in A
  const split = ok(await ev('create', { event: { name: 'Club cup', format: 'single_elim', rotation: 'auto', players, divisions: 2, courts: 2 } }), 201);
  assert.equal(split.events.length, 2);
  assert.deepEqual(split.events.map(e => e.name), ['Club cup · Division A', 'Club cup · Division B']);
  assert.deepEqual(split.events[0].players.slice().sort(), [...strong].sort());
  assert.equal(split.events[1].division.label, 'Division B');
  const list = ok(await call(events, 'GET', { query: '?code=' + scode })).events;
  assert.equal(list.length, 3);
  assert.ok(list.some(e => e.division && e.division.n === 2));
  // too few players for the divisions asked: refused, nothing created
  assert.equal((await ev('create', { event: { name: 'Too thin', format: 'roundrobin', rotation: 'auto', players: strong, divisions: 2 } })).status, 400);
  assert.equal(ok(await call(events, 'GET', { query: '?code=' + scode })).events.length, 3);
  // the public bracket carries no rating or division numbers
  const share = ok(await ev('share', { id: seeded.id })).shareToken;
  assert.ok(!/seeds|seeding|rating/.test(JSON.stringify(ok(await call(bracket, 'GET', { query: '?token=' + share })))));
});

await step('leagues and ladders: organizers create, results reach the record once, ranks and seasons move', async () => {
  const lc = ok(await call(club, 'POST', { body: { name: 'League check club' } }), 201), lcode = lc.club.code, lown = { ownerToken: lc.ownerToken };
  const lg = (action, extra = {}, creds = lown) => call(events, 'POST', { body: { code: lcode, action, ...extra, ...creds } });
  const lgames = async () => ok(await call(club, 'GET', { query: '?code=' + lcode })).games;
  const six = ['Ann', 'Bo', 'Cat', 'Dev', 'Eli', 'Fay'];
  // organizers only, and the details are checked
  assert.equal((await lg('league-create', { league: { kind: 'league', name: 'Nope', mode: 'singles', players: six } }, {})).status, 403);
  assert.equal((await lg('league-create', { league: { kind: 'league', name: 'Thin', mode: 'singles', players: six, divisions: 3 } })).status, 400);
  assert.equal((await lg('league-create', { league: { kind: 'league', name: 'BadTB', mode: 'singles', players: six, tiebreak: ['nope'] } })).status, 400);
  const league = ok(await lg('league-create', { league: { kind: 'league', name: 'Tuesday league', season: 'Autumn 1', mode: 'singles', players: six, divisions: 2, target: 11, move: 0, tiebreak: ['h2h', 'diff', 'pf'] } }), 201).league;
  assert.equal(league.tables.length, 2);
  assert.deepEqual(league.tiebreak, ['h2h', 'diff', 'pf']);
  assert.equal(league.move, 0);
  assert.equal(league.maxMove, 1);
  assert.equal(league.weeks.flatMap(w => w.matches).length, 6);
  assert.equal(ok(await call(club, 'GET', { query: '?code=' + lcode })).roster.length, 6, 'players join the roster');
  // a match: scored once, retried safely, never twice in the record
  const m = league.weeks[0].matches[0], body = { id: league.id, matchId: m.id, score: [11, 4], endedAt: Date.now() };
  const done = ok(await lg('league-result', body)).league;
  assert.equal(done.tables.flatMap(t => t.rows).filter(r => r.played).length, 2);
  ok(await lg('league-result', body));
  let g = await lgames();
  assert.equal(g.length, 1);
  assert.equal(g[0].id, `${league.id}-${m.id}`);
  assert.equal(g[0].event.name, 'Tuesday league');
  assert.equal(g[0].mode, 'singles');
  assert.equal((await lg('league-result', { ...body, score: [2, 11] })).status, 409);
  // an unlinked phone can't score a match it is not in; a correction is organizer-only and updates the same game
  assert.equal((await call(events, 'POST', { body: { code: lcode, action: 'league-result', id: league.id, matchId: league.weeks[0].matches[1].id, score: [11, 1] } })).status, 403);
  assert.equal((await lg('league-correct', { id: league.id, matchId: m.id, score: [3, 11] }, {})).status, 403);
  ok(await lg('league-correct', { id: league.id, matchId: m.id, score: [3, 11] }));
  g = await lgames();
  assert.equal(g.length, 1); assert.deepEqual(g[0].score, [3, 11]);
  // play the rest, season finishes, next season moves people between divisions
  for (const w of league.weeks) for (const x of w.matches) if (x.id !== m.id) ok(await lg('league-result', { id: league.id, matchId: x.id, score: [11, 5], endedAt: Date.now() }));
  const fin = ok(await call(events, 'GET', { query: `?code=${lcode}&league=${league.id}` })).league;
  assert.equal(fin.status, 'done');
  assert.equal((await lgames()).length, 6);
  const next = ok(await lg('league-next-season', { id: league.id, move: 1 }), 201).league;
  assert.equal(next.season, 'Autumn 2'); assert.equal(next.status, 'live'); assert.equal(next.previous, league.id);
  assert.equal(next.move, 1); assert.deepEqual(next.tiebreak, ['h2h', 'diff', 'pf']);
  assert.equal((await lg('league-next-season', { id: league.id })).status, 409, 'only one next season');
  // a ladder: challenge rules, retry key, order, season close
  const ladder = ok(await lg('league-create', { league: { kind: 'ladder', name: 'Ladder', mode: 'singles', players: six, jump: 2 } }), 201).league;
  const top = ladder.rows.map(r => r.name);
  const ch = (key, c, d, score) => lg('league-result', { id: ladder.id, key, challenger: [c], defender: [d], score, endedAt: Date.now() });
  assert.equal((await ch('key1', top[5], top[0], [11, 3])).status, 409, 'too far up');
  const after = ok(await ch('key2', top[2], top[0], [11, 3])).league;
  assert.equal(after.rows[0].name, top[2]);
  ok(await ch('key2', top[2], top[0], [11, 3]));
  assert.equal((await lgames()).length, 7, 'a retry adds no game');
  assert.equal(ok(await call(events, 'GET', { query: `?code=${lcode}&league=${ladder.id}` })).league.results.length, 1);
  const closed = ok(await lg('league-end', { id: ladder.id })).league;
  assert.equal(closed.season, 'Season 2'); assert.equal(closed.results.length, 0); assert.equal(closed.rows[0].name, top[2]);
  assert.equal(ladder.decayDays, 0); assert.ok(ladder.rows.every(r => r.dropsAt === null), 'decay is off by default');
  // the list, 304 when nothing changed, export, rename, delete
  const list = await call(events, 'GET', { query: `?code=${lcode}&leagues=1` });
  assert.equal(ok(list).leagues.length, 3);
  assert.equal((await call(events, 'GET', { query: `?code=${lcode}&leagues=1`, headers: { 'if-none-match': list.headers.etag } })).status, 304);
  const exp = ok(await call(club, 'POST', { body: { code: lcode, action: 'export', ...lown } }));
  assert.equal(exp.leagues.length, 3);
  ok(await call(playersApi, 'POST', { body: { code: lcode, action: 'rename', name: top[2], newName: 'Zed Renamed', ...lown } }));
  const renamed = ok(await call(events, 'GET', { query: `?code=${lcode}&league=${ladder.id}` })).league;
  assert.equal(renamed.rows[0].name, 'Zed Renamed');
  assert.ok(!JSON.stringify(renamed).includes(`"${top[2]}"`));
  ok(await lg('league-delete', { id: ladder.id }));
  assert.equal(ok(await call(events, 'GET', { query: `?code=${lcode}&leagues=1` })).leagues.length, 2);
  assert.equal((await lg('league-delete', { id: ladder.id })).status, 404);
  // idle decay: set at creation, stored, kept through the read; a fresh ladder shows when the first drop is due
  const decayed = ok(await lg('league-create', { league: { kind: 'ladder', name: 'Idle ladder', mode: 'singles', players: six, decayDays: 7 } }), 201).league;
  assert.equal(decayed.decayDays, 7);
  const dread = ok(await call(events, 'GET', { query: `?code=${lcode}&league=${decayed.id}` })).league;
  assert.ok(dread.rows[0].dropsAt > Date.now() && dread.rows.at(-1).dropsAt === null);
  // open challenges: sent, read back, answered, played (which settles it); a phone with no proof of who it is is refused
  const dn = dread.rows.map(r => r.name), dkey = 'dc' + Date.now().toString(36);
  assert.equal((await lg('league-challenge', { id: decayed.id, key: dkey, challenger: [dn[1]], defender: [dn[0]] }, {})).status, 403);
  const sent = ok(await lg('league-challenge', { id: decayed.id, key: dkey, challenger: [dn[1]], defender: [dn[0]] })).league;
  assert.equal(sent.open.length, 1); assert.equal(sent.open[0].state, 'open'); assert.ok(sent.open[0].expiresAt > Date.now());
  assert.equal(ok(await lg('league-challenge', { id: decayed.id, key: dkey, challenger: [dn[1]], defender: [dn[0]] })).league.open.length, 1, 'a retry adds none');
  assert.equal((await lg('league-answer', { id: decayed.id, challengeId: dkey, answer: 'maybe' })).status, 400);
  assert.equal(ok(await lg('league-answer', { id: decayed.id, challengeId: dkey, answer: 'accept' })).league.open[0].state, 'accepted');
  const played = ok(await lg('league-result', { id: decayed.id, key: 'dp' + dkey, challenger: [dn[1]], defender: [dn[0]], score: [11, 5], endedAt: Date.now() })).league;
  assert.equal(played.open.length, 0, 'playing settles the open challenge');
  ok(await lg('league-challenge', { id: decayed.id, key: dkey + 'b', challenger: [dn[2]], defender: [dn[1]] }));
  assert.equal(ok(await lg('league-answer', { id: decayed.id, challengeId: dkey + 'b', answer: 'decline' })).league.open.length, 0);
  assert.equal((await lg('league-answer', { id: decayed.id, challengeId: dkey + 'b', answer: 'accept' })).status, 404);
  ok(await lg('league-delete', { id: decayed.id }));
});

await step('league weeks: plan, bye, move, forfeit; a new week tells the opted-in players once, a forfeit is no game', async () => {
  const { createECDH } = await import('node:crypto'), { setSender } = await import('../api/_push.js');
  const e = createECDH('prime256v1'); e.generateKeys();
  Object.assign(process.env, { VAPID_PUBLIC_KEY: e.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), e.getPrivateKey()]).subarray(-32).toString('base64url'), VAPID_SUBJECT: 'mailto:test@example.invalid' });
  const sent = [], results = []; // 'result in' pushes (a played match) are counted apart from the week and move pushes
  setSender(async (sub, message) => { (/: result in$/.test(message.title) ? results : sent).push({ to: sub.endpoint.split('/').pop(), ...message }); return 201; });
  try {
    const lc = ok(await call(club, 'POST', { body: { name: 'League weeks club' } }), 201), lcode = lc.club.code, lown = { ownerToken: lc.ownerToken };
    const lg = (action, extra = {}, creds = lown) => call(events, 'POST', { body: { code: lcode, action, ...extra, ...creds } });
    const five = ['Ann', 'Bo', 'Cat', 'Dev', 'Eli'];
    const L0 = ok(await lg('league-create', { league: { kind: 'league', name: 'Weeks league', mode: 'singles', players: five, target: 11 } }), 201).league;
    assert.equal(L0.weeks.length, 5); assert.ok(L0.weeks.every(w => w.byes.length === 1), 'five players: one rests each week');
    for (const n of ['ann', 'bo']) { // two players opted in on their phones
      await pg.query(`UPDATE roster SET claim_hash = 'h' WHERE club = $1 AND name_key = $2`, [lcode, n]);
      await pg.query(`INSERT INTO push_subs (club, endpoint, name_key, p256dh, auth) VALUES ($1, $2, $3, 'p', 'a')`, [lcode, 'https://fcm.googleapis.com/x/' + n, n]);
    }
    // organizers only, and the input is checked
    assert.equal((await lg('league-schedule', { id: L0.id, week: 1, date: '2026-03-14' }, {})).status, 403);
    assert.equal((await lg('league-schedule', { id: L0.id, week: 1, date: '2026-02-30' })).status, 400);
    const planned = ok(await lg('league-schedule', { id: L0.id, week: 1, date: '2026-03-14', time: '10:00', courts: 2 })).league;
    assert.deepEqual([planned.weeks[0].date, planned.weeks[0].time, planned.weeks[0].matches.map(m => m.when.court)], ['2026-03-14', '10:00', [1, 2]]);
    assert.equal(sent.length, 0, 'planning alone tells nobody');
    // the organizer's button: both opted-in players hear their line once, a second press is held back
    assert.equal((await lg('league-notify', { id: L0.id, week: 1 }, {})).status, 403);
    const told = ok(await lg('league-notify', { id: L0.id, week: 1 }));
    assert.equal(told.sent, 2); assert.equal(told.on, true);
    assert.deepEqual(sent.map(s => s.to).sort(), ['ann', 'bo']);
    assert.ok(sent.every(s => s.title === 'Weeks league: week 1' && /on Sat 14 Mar at 10:00, court \d\.$|you have a bye this week\.$/.test(s.body)), JSON.stringify(sent));
    assert.equal((await lg('league-notify', { id: L0.id, week: 1 })).status, 429);
    // playing the last match of week 1 opens week 2: its players hear it, and a retried result does not say it twice
    sent.length = 0;
    const res = (id, m, score = [11, 5]) => lg('league-result', { id, matchId: m.id, score, endedAt: Date.now() });
    const [a, b] = L0.weeks[0].matches;
    ok(await res(L0.id, a)); assert.equal(sent.length, 0, 'half the week is not a new week');
    assert.ok(results.every(s => ['ann', 'bo'].includes(s.to) && /^(Ann|Bo|Cat|Dev|Eli), the result of your match is in\./.test(s.body) && !/11|5/.test(s.body)), JSON.stringify(results));
    const nr = results.length; ok(await res(L0.id, a)); assert.equal(results.length, nr, 'a retried result is not announced twice');
    const w2 = ok(await res(L0.id, b)).league; assert.equal(w2.current, 2);
    assert.deepEqual(sent.map(s => s.to).sort(), ['ann', 'bo']); assert.ok(sent.every(s => s.title === 'Weeks league: week 2'));
    ok(await res(L0.id, b)); assert.equal(sent.length, 2, 'a retry tells nobody again');
    // a forfeit settles a match, is not a game, and the other match then opens week 3
    const games = async () => ok(await call(club, 'GET', { query: '?code=' + lcode })).games.length;
    const before = await games();
    sent.length = 0;
    const [c, d] = w2.weeks[1].matches;
    assert.equal((await lg('league-forfeit', { id: L0.id, matchId: c.id, winner: 1 }, {})).status, 403);
    assert.equal((await lg('league-forfeit', { id: L0.id, matchId: c.id, winner: 5 })).status, 400);
    const ff = ok(await lg('league-forfeit', { id: L0.id, matchId: c.id, winner: 1 })).league;
    assert.deepEqual(ff.weeks[1].matches[0].score, [0, 11]); assert.equal(ff.weeks[1].matches[0].forfeit, true);
    assert.equal(await games(), before, 'a forfeit never reaches the club record');
    assert.equal((await res(L0.id, c)).status, 409, 'a forfeit blocks a score');
    assert.equal((await lg('league-correct', { id: L0.id, matchId: c.id, score: [11, 3] })).status, 409);
    assert.equal(sent.length, 0);
    ok(await lg('league-forfeit', { id: L0.id, matchId: c.id, winner: null })); // undone: pending again
    ok(await lg('league-forfeit', { id: L0.id, matchId: c.id, winner: 0 }));
    const w3 = ok(await res(L0.id, d)).league; assert.equal(w3.current, 3);
    assert.equal(await games(), before + 1, 'only the played match is a game');
    assert.ok(sent.length === 2 && sent.every(s => s.title === 'Weeks league: week 3'));
    // moving a match tells its players the new slot; moving nothing tells nobody
    sent.length = 0;
    const m3 = w3.weeks[2].matches.find(m => m.teams.flat().some(p => p === 'Ann' || p === 'Bo'));
    const moved = ok(await lg('league-reschedule', { id: L0.id, matchId: m3.id, date: '2026-03-21', time: '18:30', court: 4 })).league;
    assert.deepEqual(moved.weeks[2].matches.find(m => m.id === m3.id).when, { date: '2026-03-21', time: '18:30', moved: true, court: 4 });
    assert.ok(sent.length >= 1 && sent.every(s => s.title === 'Weeks league: match moved' && /on Sat 21 Mar at 18:30, court 4\.$/.test(s.body)), JSON.stringify(sent));
    const n = sent.length;
    ok(await lg('league-reschedule', { id: L0.id, matchId: m3.id, date: '2026-03-21', time: '18:30', court: 4 })); assert.equal(sent.length, n);
    assert.equal((await lg('league-reschedule', { id: L0.id, matchId: a.id, date: '2026-03-22' })).status, 409, 'a played match cannot move');
    // the public page shows the day, court and bye, never the ids
    const share = ok(await lg('league-share', { id: L0.id })).shareToken;
    const pub = ok(await call(bracket, 'GET', { query: '?league=' + share }));
    assert.equal(pub.weeks[2].matches.find(m => m.when.moved).when.court, 4); assert.equal(pub.weeks[2].byes.length, 1);
    assert.ok(!JSON.stringify(pub).includes(L0.id));
    // nobody opted in, nobody is sent anything, and the action still works
    await pg.query(`DELETE FROM push_subs WHERE club = $1`, [lcode]);
    sent.length = 0;
    assert.equal(ok(await lg('league-notify', { id: L0.id, week: 4 })).sent, 0); assert.equal(sent.length, 0);
  } finally { setSender(null); for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k]; }
});

await step('the public league link: organizer makes it, a spectator sees only allowed fields, revoking and deleting end it', async () => {
  const lc = ok(await call(club, 'POST', { body: { name: 'League link club' } }), 201), lcode = lc.club.code, lown = { ownerToken: lc.ownerToken };
  const lg = (action, extra = {}, creds = lown) => call(events, 'POST', { body: { code: lcode, action, ...extra, ...creds } });
  const spectator = token => call(bracket, 'GET', { query: '?league=' + encodeURIComponent(token) });
  const made = async (kind, name) => ok(await lg('league-create', { league: { kind, name, mode: 'singles', players: ['Ann', 'Bo', 'Cat', 'Dev'], target: 11 } }), 201).league;
  const league = await made('league', 'Link league'), ladder = await made('ladder', 'Link ladder');
  assert.equal((await lg('league-share', { id: league.id }, {})).status, 403, 'organizers only');
  const t1 = ok(await lg('league-share', { id: league.id })).shareToken;
  assert.match(t1, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(ok(await lg('league-share', { id: league.id })).shareToken, t1, 'asking again returns the same link');
  const first = league.weeks[0].matches[0];
  ok(await lg('league-result', { id: league.id, matchId: first.id, score: [11, 4], endedAt: Date.now() }));
  const pub = ok(await spectator(t1));
  assert.equal(pub.kind, 'league'); assert.equal(pub.name, 'Link league'); assert.equal(pub.divisions[0].rows.length, 4);
  const text = JSON.stringify(pub);
  for (const secret of [lcode, lc.ownerToken, league.id, first.id, 'resultsBy', 'canChallenge', 'seeds']) assert.ok(!text.includes(secret), `public view leaks ${secret}`);
  assert.equal((await call(bracket, 'GET', { query: '?token=' + t1 })).status, 404, 'a league token is not a bracket token');
  const answers = new Set();
  for (const bad of ['nope', 'a'.repeat(32), t1.slice(0, -1), t1 + 'x', "x' OR '1'='1"]) { const r = await spectator(bad); assert.equal(r.status, 404, `bad token ${bad}`); answers.add(JSON.stringify(r.json)); }
  assert.equal(answers.size, 1);
  assert.equal((await call(bracket, 'POST', { body: { league: t1 } })).status, 405);
  // a ladder shows its order and recent results
  const tl = ok(await lg('league-share', { id: ladder.id })).shareToken;
  ok(await lg('league-result', { id: ladder.id, key: 'pub1', challenger: [ladder.rows[1].name], defender: [ladder.rows[0].name], score: [11, 2], endedAt: Date.now() }));
  const lpub = ok(await spectator(tl));
  assert.equal(lpub.kind, 'ladder'); assert.equal(lpub.rows.length, 4); assert.equal(lpub.results.length, 1);
  assert.ok(!JSON.stringify(lpub).includes('pub1'), 'result keys stay private');
  // replacing the link kills the old one; stopping ends it; so does deleting
  const t2 = ok(await lg('league-share-new', { id: league.id })).shareToken;
  assert.notEqual(t2, t1); assert.equal((await spectator(t1)).status, 404); assert.equal((await spectator(t2)).status, 200);
  assert.equal(ok(await lg('league-share-off', { id: league.id })).shareToken, null); assert.equal((await spectator(t2)).status, 404);
  ok(await lg('league-delete', { id: ladder.id })); assert.equal((await spectator(tl)).status, 404);
  assert.equal((await lg('league-share', { id: ladder.id })).status, 404);
});

// ---- Apple Watch linking and scoring (api/_watch.js and _livecore.js, reached through api/live.js) ----
{
  const { randomBytes } = await import('node:crypto');
  const Wr = await import(pathToFileURL(path.join(root, 'api', '_watchrules.js')).href);
  const wc = ok(await call(club, 'POST', { body: { name: 'Watch check club', pin: '482913' } }), 201);
  const wcode = wc.club.code, wowner = wc.ownerToken, WPIN = '482913';
  const hex = n => randomBytes(n).toString('hex');
  const state = () => ({ cfg: { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, teams: [['Ana', 'Ben'], ['Cy', 'Di']] }, score: [0, 0], serving: 0, serverNum: 2, right: [0, 0], server: 0, rallies: 0, switched: false, justSwitched: false, winner: null, startedAt: 789, endedAt: null });
  const publish = async (id, secret, cd = wcode) => ok(await call(live, 'POST', { body: { code: cd, action: 'state', id, secret, state: state(), ack: 0 } }));
  const mk = () => { const pairId = hex(16); return { pairId, pollSecret: hex(16), confirm4: String(1000 + (randomBytes(2).readUInt16BE() % 9000)), short: Wr.shortCode(pairId) }; };
  const other = c => (c === '0000' ? '1111' : '0000');
  const reg = (w, extra = {}, headers = {}) => call(live, 'POST', { headers, body: { action: 'watch-register', idHash: Wr.pairHash(w.pairId), pollHash: Wr.pollHash(w.pollSecret), shortHash: Wr.shortHash(w.short), confirm4: w.confirm4, label: "Ana's Apple Watch", ...extra } });
  const claim = (w, extra = {}, cd = wcode) => call(live, 'POST', { body: { code: cd, action: 'watch-claim', pair: w.pairId, confirm4: w.confirm4, ...extra } });
  const pollW = (w, extra = {}) => call(live, 'POST', { body: { action: 'watch-poll', pairId: w.pairId, pollSecret: w.pollSecret, ...extra } });
  const as = (token, action, extra = {}, headers = {}) => call(live, 'POST', { headers: { authorization: 'Bearer ' + token, ...headers }, body: { action, ...extra } });
  const wstate = (token, headers = {}) => call(live, 'GET', { query: '?watch=state', headers: { authorization: 'Bearer ' + token, ...headers } });
  const link = async (extra = {}, cd = wcode) => { const w = mk(); ok(await reg(w)); const c = ok(await claim(w, extra, cd)); const p = ok(await pollW(w)); return { w, c, p, token: p.token, id: c.link.id }; };
  const row = async id => (await pg.query('SELECT * FROM watch_links WHERE id = $1', [id])).rows[0];
  const liveLinks = async id => (await pg.query('SELECT watch_links FROM live_games WHERE id = $1', [id])).rows[0].watch_links;

  await step('watch link: registering is validated, and one id cannot be registered twice', async () => {
    const w = mk();
    for (const bad of [{ idHash: 'nope' }, { pollHash: 'a'.repeat(63) }, { confirm4: '12' }, { confirm4: 1234.5 }, { shortHash: 'xyz' }]) assert.equal((await reg(w, bad)).status, 400, JSON.stringify(bad));
    assert.equal(ok(await reg(w)).expiresInMinutes, 5);
    assert.equal((await reg(w)).status, 409);
    const dump = JSON.stringify((await pg.query('SELECT * FROM watch_pairings')).rows);
    assert.ok(!dump.includes(w.pairId) && !dump.includes(w.pollSecret), 'only hashes are stored');
  });

  await step('watch link: the watch waits, the phone needs the 4 numbers, and the third wrong try ends the pairing', async () => {
    const w = mk(); ok(await reg(w));
    assert.equal(ok(await pollW(w)).status, 'waiting');
    assert.equal((await pollW(w, { pollSecret: hex(16) })).status, 403, 'another poll secret is refused');
    assert.equal((await pollW({ ...w, pairId: hex(16) })).status, 404, 'an unknown pairing is a 404');
    assert.equal((await claim(w, { confirm4: other(w.confirm4) })).status, 403);
    assert.equal((await claim(w, { confirm4: other(w.confirm4) })).status, 403);
    assert.equal((await claim(w, { pair: 'not a code' })).status, 400);
    ok(await claim(w)); // the right numbers still work on the third try
    const dead = mk(); ok(await reg(dead));
    for (let i = 0; i < 3; i++) assert.equal((await claim(dead, { confirm4: other(dead.confirm4) })).status, 403);
    assert.equal((await claim(dead)).status, 404, 'a spent pairing cannot be rescued by the right numbers');
    assert.equal((await pollW(dead)).status, 404);
  });

  await step('watch link: the typed 6 characters link a watch like the QR does', async () => {
    const w = mk(); ok(await reg(w));
    const typed = w.short.slice(0, 3).toLowerCase() + ' - ' + w.short.slice(3).toLowerCase();
    assert.equal((await claim({ ...w }, { pair: Wr.shortCode(hex(16)) })).status, 404, 'a wrong code finds nothing');
    const c = ok(await claim(w, { pair: typed }));
    assert.ok(c.link.id && c.revokeKey);
    assert.match(ok(await pollW(w)).token, /^w_[0-9a-f]{64}$/);
  });

  let A, B;
  await step('watch link: the token is handed over once, and only its hash is stored', async () => {
    const w = mk(); ok(await reg(w));
    const c = ok(await claim(w));
    assert.equal(c.attached, null);
    assert.equal((await as('w_' + hex(32), 'watch-state')).status, 401, 'a link that was claimed but not collected has no token yet');
    const p = ok(await pollW(w));
    assert.equal(p.status, 'linked'); assert.equal(p.club.name, 'Watch check club'); assert.equal(p.link.id, c.link.id); assert.equal(p.link.label, "Ana's Apple Watch");
    assert.equal((await pollW(w)).status, 404, 'a second poll gets nothing: the token is single use');
    const dump = JSON.stringify((await pg.query('SELECT * FROM watch_links')).rows) + JSON.stringify((await pg.query('SELECT * FROM watch_pairings')).rows) + JSON.stringify((await pg.query('SELECT * FROM lookup_fails')).rows);
    assert.ok(!dump.includes(p.token) && !dump.includes(c.revokeKey) && !dump.includes(w.pollSecret), 'no secret is stored as given');
    const first = await link(), second = await link();
    A = first; B = second;
    assert.notEqual(A.token, B.token);
  });

  await step('watch link: the phone lists linked watches without any secrets', async () => {
    const l = ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-list' } })).links;
    assert.ok(l.length >= 2 && l.some(x => x.id === A.id) && l.every(x => x.label && x.createdAt && x.expiresAt));
    assert.ok(!/token|hash|revoke/i.test(JSON.stringify(l)));
    assert.equal((await call(live, 'POST', { body: { code: 'ZZZZZZ', action: 'watch-list' } })).status, 404);
  });

  const S1 = 'watchSecret111', S2 = 'watchSecret222';
  await step('attach: a watch scores only the games the phone sent to it', async () => {
    await publish('live-w1', S1); await publish('live-w2', S2);
    assert.equal(ok(await as(A.token, 'watch-state')).game, null, 'nothing attached yet');
    assert.equal((await as(A.token, 'watch-rally', { opId: 'tap-attach-1', side: 0 })).status, 404);
    const w = mk(); ok(await reg(w));
    assert.equal((await claim(w, { game: 'live-w1', secret: 'wrongSecret1' })).status, 403, 'attaching needs the game secret');
    assert.equal((await claim(w, { game: 'live-nope', secret: S1 })).status, 404);
    const c = ok(await claim(w, { game: 'live-w1', secret: S1 })); // the pairing was not spent by the failed tries
    assert.equal(c.attached, 'live-w1');
    const token = ok(await pollW(w)).token;
    const s = ok(await as(token, 'watch-state'));
    assert.equal(s.game.id, 'live-w1'); assert.equal(s.club.name, 'Watch check club'); assert.equal(s.link.id, c.link.id);
    assert.deepEqual(s.game.teams, [['Ana', 'Ben'], ['Cy', 'Di']]); assert.deepEqual(s.game.call, [0, 0, 2]); assert.equal(s.game.version, 0);
    assert.ok(!/secret|stack|intents|ops/i.test(JSON.stringify(s)));
    assert.deepEqual(await liveLinks('live-w1'), [c.link.id]);
    A = { ...A, token, id: c.link.id };
    assert.equal((await as(token, 'watch-rally', { opId: 'tap-attach-2', side: 0, game: 'live-w2' })).status, 404, 'a game that is not attached is out of reach, named or not');
    // The phone sends a game to a watch it linked earlier.
    const at = (link, game, secret) => call(live, 'POST', { body: { code: wcode, action: 'watch-attach', link, game, secret } });
    assert.equal((await at(B.id, 'live-w1', 'wrongSecret1')).status, 403);
    assert.equal((await at('0'.repeat(16), 'live-w1', S1)).status, 404);
    ok(await at(B.id, 'live-w1', S1)); ok(await at(B.id, 'live-w1', S1));
    assert.deepEqual((await liveLinks('live-w1')).sort(), [A.id, B.id].sort(), 'attaching twice adds it once');
    assert.equal(ok(await as(B.token, 'watch-state')).game.id, 'live-w1');
  });

  await step('watch state: a quiet poll is an empty 304 and a rally changes the tag', async () => {
    const r1 = await wstate(A.token);
    assert.equal(r1.status, 200); assert.ok(r1.headers.etag);
    const r2 = await wstate(A.token, { 'if-none-match': r1.headers.etag });
    assert.equal(r2.status, 304); assert.equal(r2.bytes, 0);
    ok(await as(A.token, 'watch-rally', { opId: 'tap-state-001', side: 0 }));
    const r3 = await wstate(A.token, { 'if-none-match': r1.headers.etag });
    assert.equal(r3.status, 200); assert.notEqual(r3.headers.etag, r1.headers.etag); assert.deepEqual(r3.json.game.score, [1, 0]);
    ok(await as(A.token, 'watch-unrally', { opId: 'tap-state-002' }));
  });

  await step('tap ids: a retried tap changes nothing, even with a stale base, and an undo that did nothing cannot undo a later point', async () => {
    const rl = (token, opId, side = 0, extra = {}) => as(token, 'watch-rally', { opId, side, ...extra });
    const v0 = ok(await as(A.token, 'watch-state')).game.version;
    let r = ok(await rl(A.token, 'tap-dup-0001'));
    assert.deepEqual(r.score, [1, 0]); assert.equal(r.version, v0 + 1); assert.ok(!r.duplicate);
    r = ok(await rl(A.token, 'tap-dup-0001'));
    assert.equal(r.duplicate, true); assert.deepEqual(r.score, [1, 0]); assert.equal(r.version, v0 + 1);
    r = ok(await rl(A.token, 'tap-dup-0001', 0, { base: v0 })); // a retry that still carries the old base is a duplicate, not a conflict
    assert.equal(r.duplicate, true); assert.ok(!r.conflict);
    r = ok(await rl(A.token, 'tap-dup-0002', 1, { base: v0 }));
    assert.equal(r.conflict, true, 'a new tap with a stale base still conflicts'); assert.deepEqual(r.state.score, [1, 0]);
    r = ok(await rl(A.token, 'tap-dup-0002', 1, { base: v0 + 1 }));
    assert.equal(r.ok, true); assert.equal(r.version, v0 + 2);
    r = ok(await as(A.token, 'watch-unrally', { opId: 'tap-undo-0001' }));
    assert.equal(r.version, v0 + 3);
    r = ok(await as(A.token, 'watch-unrally', { opId: 'tap-undo-0001' }));
    assert.equal(r.duplicate, true); assert.equal(r.version, v0 + 3, 'a repeated undo takes back nothing more');
    ok(await as(A.token, 'watch-unrally', { opId: 'tap-undo-0002' })); // back to 0-0
    r = ok(await as(A.token, 'watch-unrally', { opId: 'tap-undo-empty' }));
    assert.equal(r.unchanged, true);
    ok(await rl(A.token, 'tap-after-001'));
    r = ok(await as(A.token, 'watch-unrally', { opId: 'tap-undo-empty' }));
    assert.equal(r.duplicate, true); assert.deepEqual(r.score, [1, 0], 'the late retry of an undo that did nothing leaves the new point alone');
    assert.equal((await as(A.token, 'watch-rally', { side: 0 })).status, 400, 'a tap without an id is refused');
    assert.equal((await rl(A.token, 'tap-badside-1', 2)).status, 400);
    assert.equal((await as(A.token, 'watch-rally', { opId: 'bad id!', side: 0 })).status, 400);
  });

  await step('tap ids: copies of one tap arriving together count once, and different taps all count', async () => {
    const before = ok(await as(A.token, 'watch-state')).game.score[0];
    const same = await Promise.all([1, 2, 3, 4, 5].map(() => as(A.token, 'watch-rally', { opId: 'tap-race-0001', side: 0 })));
    for (const r of same) assert.equal(r.status, 200);
    assert.equal(ok(await as(A.token, 'watch-state')).game.score[0], before + 1);
    const many = await Promise.all([1, 2, 3].map(i => as(A.token, 'watch-rally', { opId: 'tap-race-100' + i, side: 0 })));
    for (const r of many) assert.equal(r.status, 200);
    assert.equal(ok(await as(A.token, 'watch-state')).game.score[0], before + 4);
  });

  await step('tap ids work on the phone route too, and a game that is over refuses another point', async () => {
    const SC = 'watchSecret333';
    await publish('live-w3', SC);
    const rl = (opId, side = 0) => call(live, 'POST', { body: { code: wcode, action: 'rally', game: 'live-w3', secret: SC, side, opId } });
    ok(await rl('phone-tap-0001')); assert.equal(ok(await rl('phone-tap-0001')).duplicate, true);
    assert.deepEqual(ok(await call(live, 'GET', { query: `?code=${wcode}&id=live-w3&secret=${SC}` })).state.score, [1, 0], 'the phone route applied it once');
    const w = mk(); ok(await reg(w)); ok(await claim(w, { game: 'live-w3', secret: SC }));
    const t = ok(await pollW(w)).token;
    for (let i = 0; i < 30 && (ok(await as(t, 'watch-state')).game.winner === null); i++) ok(await as(t, 'watch-rally', { opId: 'tap-win-' + String(i).padStart(4, '0'), side: 0 }));
    const over = ok(await as(t, 'watch-state')).game;
    assert.equal(over.winner, 0); assert.equal(over.say, 'Game over');
    assert.equal((await as(t, 'watch-rally', { opId: 'tap-late-0001', side: 0 })).status, 409);
    assert.equal(ok(await as(t, 'watch-rally', { opId: 'tap-win-0000', side: 0 })).duplicate, true, 'a retry of the winning point is still an answer, not an error');
  });

  await step('unlinking: the phone that linked it, an organizer, or the watch itself; nobody else', async () => {
    const L1 = await link(), L2 = await link(), L3 = await link({ game: 'live-w2', secret: S2 });
    assert.equal((await call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: L1.id } })).status, 403, 'a member with no key cannot unlink');
    assert.equal((await call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: L1.id, revokeKey: L2.c.revokeKey } })).status, 403, 'another watch\'s key does not open this one');
    assert.equal((await call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: L1.id, pin: '000000' } })).status, 403);
    ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: L1.id, revokeKey: L1.c.revokeKey } }));
    assert.equal((await as(L1.token, 'watch-state')).status, 401);
    assert.equal((await call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: L1.id, revokeKey: L1.c.revokeKey } })).status, 404, 'already unlinked');
    assert.ok((await liveLinks('live-w2')).includes(L3.id));
    ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: L3.id, pin: WPIN } }));
    assert.ok(!(await liveLinks('live-w2')).includes(L3.id), 'an unlinked watch is taken off its games');
    ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: L2.id, ownerToken: wowner } }));
    assert.equal((await as(L2.token, 'watch-rally', { opId: 'tap-revoked-1', side: 0 })).status, 401);
    const L4 = await link();
    ok(await as(L4.token, 'watch-unlink'));
    assert.equal((await as(L4.token, 'watch-state')).status, 401);
    assert.ok(!ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-list' } })).links.some(x => [L1.id, L2.id, L3.id, L4.id].includes(x.id)));
    assert.ok((await row(L1.id)).revoked_at);
  });

  await step('token life: it slides 90 days from the last call, at most once an hour, and never past a year', async () => {
    const L = await link(), t0 = Date.now(), near = (a, b) => Math.abs(new Date(a).getTime() - b) < 60e3;
    assert.ok(near((await row(L.id)).expires_at, t0 + 90 * 86400e3), 'collecting the token starts the 90 days');
    await pg.query(`UPDATE watch_links SET last_seen_at = now() - interval '30 minutes', expires_at = now() + interval '10 days' WHERE id = $1`, [L.id]);
    ok(await as(L.token, 'watch-state'));
    assert.ok(near((await row(L.id)).expires_at, t0 + 10 * 86400e3), 'under an hour since the last call: nothing is written');
    await pg.query(`UPDATE watch_links SET last_seen_at = now() - interval '2 hours' WHERE id = $1`, [L.id]);
    ok(await as(L.token, 'watch-state'));
    assert.ok(near((await row(L.id)).expires_at, t0 + 90 * 86400e3));
    await pg.query(`UPDATE watch_links SET last_seen_at = now() - interval '2 hours', created_at = now() - interval '300 days' WHERE id = $1`, [L.id]);
    ok(await as(L.token, 'watch-state'));
    assert.ok(near((await row(L.id)).expires_at, t0 + 65 * 86400e3), 'the year from when it was made is the ceiling');
    await pg.query(`UPDATE watch_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [L.id]);
    assert.equal((await as(L.token, 'watch-state')).status, 401, 'an expired link is refused');
  });

  await step('abuse limits: wrong tokens lock a network, registrations are limited per network, a club holds 20 links', async () => {
    const L = await link(), net = { 'x-real-ip': '10.77.0.1' };
    for (let i = 0; i < 30; i++) assert.equal((await as('w_' + hex(32), 'watch-state', {}, net)).status, 401);
    assert.equal((await as(L.token, 'watch-state', {}, net)).status, 429, 'a locked network is refused, right token or wrong');
    assert.equal((await as(L.token, 'watch-state', {}, { 'x-real-ip': '10.77.0.2' })).status, 200, 'other networks are not affected');
    assert.equal((await call(live, 'POST', { body: { action: 'watch-state' } })).status, 401, 'no token');
    assert.equal((await call(live, 'POST', { headers: { authorization: 'Bearer ' + wowner }, body: { action: 'watch-state' } })).status, 401, 'an owner token is not a watch token');
    const reg2 = { 'x-real-ip': '10.77.0.3' };
    // A tournament: 100 distinct watches behind one venue address, each on the QR screen for an hour (a new QR every 5 minutes = 12 an hour).
    await pg.query(`DELETE FROM watch_pairings`);
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 100; i++) ok(await reg(mk(), {}, reg2));
      await pg.query(`UPDATE watch_pairings SET expires_at = now() - interval '1 second'`);   // 5 minutes later the old QRs have expired
    }
    // A flood from that same address is stopped at the hourly ceiling, and a refused attempt leaves no mark.
    await pg.query(`INSERT INTO lookup_fails (ip) SELECT 'watch-new:10.77.0.3' FROM generate_series(1, 299)`);   // 1200 + 299 = one short of 1500
    ok(await reg(mk(), {}, reg2));
    for (let i = 0; i < 3; i++) assert.equal((await reg(mk(), {}, reg2)).status, 429, 'a flood is stopped');
    assert.equal((await pg.query(`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = 'watch-new:10.77.0.3'`)).rows[0].n, 1500);
    // Many addresses at once: the cap on live QR codes holds, and frees as they expire.
    await pg.query(`DELETE FROM watch_pairings`);
    await pg.query(`INSERT INTO watch_pairings (id_hash, poll_hash, confirm, expires_at) SELECT 'fill' || g, 'x', '1234', now() + interval '5 minutes' FROM generate_series(1, 2000) g`);
    assert.equal((await reg(mk(), {}, { 'x-real-ip': '10.77.1.1' })).status, 429, 'the app-wide cap on live QR codes');
    assert.equal((await pg.query(`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = 'watch-new:10.77.1.1'`)).rows[0].n, 0, 'a refused attempt leaves no mark');
    await pg.query(`UPDATE watch_pairings SET expires_at = now() - interval '1 second'`);
    ok(await reg(mk(), {}, { 'x-real-ip': '10.77.1.1' }));
    await pg.query(`DELETE FROM watch_pairings`);
    const stuck = { 'x-real-ip': '10.77.0.5' };   // marks stored under the old limit of 10 no longer block
    await pg.query(`INSERT INTO lookup_fails (ip) SELECT 'watch-new:10.77.0.5' FROM generate_series(1, 10)`);
    ok(await reg(mk(), {}, stuck));
    assert.equal((await reg(mk(), {}, { 'x-real-ip': '10.77.0.4' })).status, 200);
    const full = ok(await call(club, 'POST', { body: { name: 'Full watch club', pin: '135790' } }), 201).club.code;
    for (let i = 0; i < 20; i++) await link({}, full);
    const w = mk(); ok(await reg(w));
    assert.equal((await claim(w, {}, full)).status, 409);
    assert.equal((await claim(w, {}, wcode)).status, 200, 'another club is unaffected');
  });

  await step('publish: the watches the phone names are attached once the game secret is right, and only live links of this club', async () => {
    const L1 = await link(), L2 = await link(), foreign = ok(await call(club, 'POST', { body: { name: 'Other watch club', pin: '135790' } }), 201).club.code;
    const F = await link({}, foreign), gone = await link();
    ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: gone.id, revokeKey: gone.c.revokeKey } }));
    const pub = (id, secret, watch, cd = wcode) => call(live, 'POST', { body: { code: cd, action: 'state', id, secret, state: state(), ack: 0, watch } });
    assert.equal((await as(L1.token, 'watch-state')).status, 200);
    assert.equal((await pub('live-pa', 'pubSecret111', [L1.id, L2.id, F.id, gone.id, 'nope', L1.id])).status, 200);
    assert.deepEqual((await liveLinks('live-pa')).sort(), [L1.id, L2.id].sort(), 'this club\'s live links only, each once');
    assert.equal(ok(await as(L1.token, 'watch-state')).game.id, 'live-pa');
    assert.equal((await pub('live-pa', 'pubSecret111', [L1.id])).status, 200);
    assert.equal((await liveLinks('live-pa')).length, 2, 'a republish adds nothing twice and takes nothing away');
    assert.equal((await pub('live-pa', 'wrongSecret99', [F.id])).status, 403);
    assert.ok(!(await liveLinks('live-pa')).includes(F.id), 'a wrong secret attaches nothing');
    assert.equal((await pub('live-pb', 'pubSecret222', 'not a list')).status, 200);
    assert.deepEqual(await liveLinks('live-pb'), []);
  });

  await step('watch-finish: the server saves a finished game once, under the live id, whoever saves it first', async () => {
    const done = (extra = {}) => ({ ...state(), score: [11, 4], winner: 0, rallies: 15, startedAt: 5000, endedAt: Date.now(), ...extra });
    const pubDone = async (id, secret, st, cd = wcode) => ok(await call(live, 'POST', { body: { code: cd, action: 'state', id, secret, state: st, ack: 0 } }));
    const F = await link();
    await publish('live-f1', 'finSecret111'); ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-attach', link: F.id, game: 'live-f1', secret: 'finSecret111' } }));
    assert.equal((await as(F.token, 'watch-finish')).status, 409, 'a game that is not over is not saved');
    await pubDone('live-f1', 'finSecret111', done());
    const r = ok(await as(F.token, 'watch-finish'));
    assert.deepEqual([r.id, r.saved], ['live-f1', true]);
    const saved = async id => (await pg.query('SELECT data, confirmed_by, rally_log FROM games WHERE club = $1 AND id = $2', [wcode, id])).rows;
    let g = await saved('live-f1');
    assert.equal(g.length, 1);
    assert.deepEqual([g[0].data.teams, g[0].data.score, g[0].data.winner, g[0].data.rallies, g[0].data.startedAt], [[['Ana', 'Ben'], ['Cy', 'Di']], [11, 4], 0, 15, 5000]);
    assert.ok(!('scoredBy' in g[0].data) && g[0].confirmed_by === null && g[0].rally_log === null, 'nobody is verified and there is no replay');
    const aud = (await pg.query('SELECT action, actor, note FROM game_audit WHERE club = $1 AND game = $2', [wcode, 'live-f1'])).rows;
    assert.deepEqual(aud, [{ action: 'create', actor: 'anonymous', note: 'watch' }]);
    assert.ok((await pg.query('SELECT 1 FROM roster WHERE club = $1 AND name_key = $2', [wcode, 'ana'])).rows.length === 1, 'the players join the roster');
    const again = ok(await as(F.token, 'watch-finish'));
    assert.deepEqual([again.id, again.saved], ['live-f1', false], 'finishing again changes nothing');
    assert.equal((await saved('live-f1')).length, 1);
    // The phone saves the same game afterwards, under the same id: stored once.
    const rec = { id: 'live-f1', startedAt: 5000, endedAt: g[0].data.endedAt, mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, teams: [['Ana', 'Ben'], ['Cy', 'Di']], score: [11, 4], winner: 0, rallies: 15 };
    const p = ok(await call(games, 'POST', { body: { code: wcode, games: [rec], ownerToken: wowner } }));
    assert.deepEqual([p.saved, p.alreadySaved], [0, 1]);
    assert.equal((await saved('live-f1')).length, 1);
    // And the other way round: the phone saves first, then the watch finishes.
    await publish('live-f2', 'finSecret222'); await pubDone('live-f2', 'finSecret222', done({ startedAt: 6000 }));
    ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-attach', link: F.id, game: 'live-f2', secret: 'finSecret222' } }));
    const first = ok(await call(games, 'POST', { body: { code: wcode, games: [{ ...rec, id: 'live-f2', startedAt: 6000 }], ownerToken: wowner } }));
    assert.equal(first.saved, 1);
    assert.equal(ok(await as(F.token, 'watch-finish', { game: 'live-f2' })).saved, false);
    assert.equal((await saved('live-f2')).length, 1);
    // Nothing else: a game that is not sent to this watch, an unknown token, a revoked watch.
    await pubDone('live-f3', 'finSecret333', done());
    assert.equal((await as(F.token, 'watch-finish', { game: 'live-f3' })).status, 404);
    assert.equal((await as('w_' + hex(32), 'watch-finish')).status, 401);
    ok(await as(F.token, 'watch-unlink'));
    assert.equal((await as(F.token, 'watch-finish', { game: 'live-f2' })).status, 401);
  });

  await step('watch-finish: a game name the games table cannot hold is refused, not half saved', async () => {
    const F = await link();
    const longId = 'live-' + 'x'.repeat(50);
    ok(await call(live, 'POST', { body: { code: wcode, action: 'state', id: longId, secret: 'longSecret11', state: { ...state(), score: [11, 2], winner: 0, endedAt: Date.now() }, ack: 0, watch: [F.id] } }));
    assert.equal((await as(F.token, 'watch-finish')).status, 400);
    assert.equal((await pg.query('SELECT 1 FROM games WHERE club = $1 AND id = $2', [wcode, longId])).rows.length, 0);
  });

  // ---- single-game links: a watch holds one game and nothing else ----
  const offerOf = async (game, secret, cd = wcode) => ok(await call(live, 'POST', { body: { code: cd, action: 'watch-offer', game, secret } })).offer;
  const joinW = (o, extra = {}) => call(live, 'POST', { body: { action: 'watch-join', code: o.short, confirm4: o.confirm4, label: "Cy's Apple Watch", ...extra } });
  const gameLinkRow = async id => (await pg.query('SELECT game_id, club, revoked_at, expires_at FROM watch_links WHERE id = $1', [id])).rows[0];
  const hours = (a, b) => Math.round((new Date(a) - new Date(b)) / 360000) / 10;

  await step('single game, scanned in the app: the link holds that one game, no club name, no other game', async () => {
    await publish('live-g1', 'gameSecret111'); await publish('live-g2', 'gameSecret222');
    const G = await link({ game: 'live-g1', secret: 'gameSecret111', single: true });
    assert.deepEqual(G.c.link, { id: G.id, label: "Ana's Apple Watch", game: 'live-g1' });
    assert.equal(G.p.link.game, 'live-g1'); assert.equal(G.p.club.name, '', 'the club is not named to a single-game link');
    const st = ok(await as(G.token, 'watch-state'));
    assert.equal(st.club.name, ''); assert.equal(st.link.game, 'live-g1'); assert.equal(st.game.id, 'live-g1');
    assert.equal((await as(G.token, 'watch-rally', { opId: 'tap-single-01', side: 1, game: 'live-g2' })).status, 404, 'another game of the club is out of reach, named or not');
    assert.equal((await as(G.token, 'watch-finish', { game: 'live-g2' })).status, 404);
    assert.equal(ok(await as(G.token, 'watch-rally', { opId: 'tap-single-02', side: 0 })).state.score[0], 1);
    assert.equal(ok(await as(G.token, 'watch-rally', { opId: 'tap-single-03', side: 0, game: 'live-g1' })).state.score[0], 2);
    // A club-wide link on the same club still sees the games sent to it, and a phone's publish never adds a single-game link to another game.
    const C = await link();
    ok(await call(live, 'POST', { body: { code: wcode, action: 'state', id: 'live-g2', secret: 'gameSecret222', state: state(), ack: 0, watch: [C.id, G.id] } }));
    assert.deepEqual(await liveLinks('live-g2'), [C.id]);
    assert.equal(ok(await as(G.token, 'watch-state')).game.id, 'live-g1');
    // The listing says which watches belong to a game; an old club link has no `game`.
    const l = ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-list' } })).links;
    assert.equal(l.find(x => x.id === G.id).game, 'live-g1'); assert.equal('game' in l.find(x => x.id === C.id), false);
    assert.equal((await call(live, 'POST', { body: { code: wcode, action: 'watch-attach', link: G.id, game: 'live-g2', secret: 'gameSecret222' } })).status, 404, 'a single-game link cannot be sent a second game');
    // It needs the game's secret to make one.
    const w = mk(); ok(await reg(w));
    assert.equal((await claim(w, { game: 'live-g1', secret: 'wrongSecret1', single: true })).status, 403);
    assert.equal((await claim(w, { single: true })).status, 400, 'single needs a game');
    assert.equal((await claim(w, { game: 'live-nope', secret: 'gameSecret111', single: true })).status, 404);
  });

  await step('single game: it lasts GAME_LINK_HOURS from when the watch collects it and does not slide', async () => {
    await publish('live-g3', 'gameSecret333');
    const G = await link({ game: 'live-g3', secret: 'gameSecret333', single: true });
    const r = await gameLinkRow(G.id);
    assert.ok(Math.abs(hours(r.expires_at, new Date()) - Wr.GAME_LINK_HOURS) < 0.2);
    await pg.query(`UPDATE watch_links SET last_seen_at = now() - interval '3 hours' WHERE id = $1`, [G.id]);
    ok(await as(G.token, 'watch-state'));
    assert.equal((await gameLinkRow(G.id)).expires_at.getTime(), r.expires_at.getTime(), 'using it does not extend it');
    await pg.query(`UPDATE watch_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [G.id]);
    assert.equal((await as(G.token, 'watch-state')).status, 401);
  });

  await step('single game: finishing saves the game once and the link lapses soon after; the phone ending the game ends it at once', async () => {
    await publish('live-g4', 'gameSecret444');
    const done = { ...state(), score: [11, 3], winner: 0, endedAt: Date.now() };
    ok(await call(live, 'POST', { body: { code: wcode, action: 'state', id: 'live-g4', secret: 'gameSecret444', state: done, ack: 0 } }));
    const G = await link({ game: 'live-g4', secret: 'gameSecret444', single: true });
    assert.equal(ok(await as(G.token, 'watch-finish')).saved, true);
    assert.equal(ok(await as(G.token, 'watch-finish')).saved, false, 'a retry after a lost answer still works and saves nothing twice');
    assert.ok(hours((await gameLinkRow(G.id)).expires_at, new Date()) <= 0.3, 'about a quarter of an hour left');
    await publish('live-g5', 'gameSecret555');
    const H = await link({ game: 'live-g5', secret: 'gameSecret555', single: true }), O = await offerOf('live-g5', 'gameSecret555');
    assert.equal((await call(live, 'POST', { body: { code: wcode, action: 'end', id: 'live-g5', secret: 'wrongSecret1' } })).status, 403);
    assert.equal((await as(H.token, 'watch-state')).status, 200, 'a refused end changes nothing');
    ok(await call(live, 'POST', { body: { code: wcode, action: 'end', id: 'live-g5', secret: 'gameSecret555' } }));
    assert.equal((await as(H.token, 'watch-state')).status, 401, 'the game is over, so is the link');
    assert.equal((await joinW(O)).status, 404, 'and its code');
  });

  await step('game code: the scoring phone shows it, the watch types it with the 4 numbers, three wrong numbers end it, one use', async () => {
    await publish('live-o1', 'offerSecret11');
    assert.equal((await call(live, 'POST', { body: { code: wcode, action: 'watch-offer', game: 'live-o1', secret: 'wrongSecret1' } })).status, 403, 'the game secret is needed');
    assert.equal((await call(live, 'POST', { body: { code: wcode, action: 'watch-offer', game: 'live-none', secret: 'offerSecret11' } })).status, 404);
    const O = await offerOf('live-o1', 'offerSecret11');
    assert.match(O.short, /^[A-Z2-7]{6}$/); assert.match(O.confirm4, /^[0-9]{4}$/); assert.match(O.id, /^[0-9a-f]{32}$/); assert.equal(O.short, Wr.shortCode(O.id));
    const dump = JSON.stringify((await pg.query('SELECT * FROM watch_offers')).rows);
    assert.ok(!dump.includes(O.id) && !dump.includes(O.short), 'only hashes of the code are stored');
    assert.equal((await joinW(O, { confirm4: 'abcd' })).status, 400); assert.equal((await joinW({ short: 'AB', confirm4: O.confirm4 })).status, 400);
    assert.equal((await joinW({ short: 'ZZZZZZ', confirm4: O.confirm4 })).status, 404, 'a code nobody showed');
    assert.equal((await joinW(O, { confirm4: other(O.confirm4) })).status, 403);
    assert.equal((await joinW(O, { confirm4: other(O.confirm4) })).status, 403);
    assert.equal((await joinW(O, { confirm4: other(O.confirm4) })).status, 403, 'the third wrong try');
    assert.equal((await joinW(O)).status, 404, 'the code is gone, even with the right numbers');
    const O2 = await offerOf('live-o1', 'offerSecret11');
    assert.notEqual(O2.id, O.id);
    const J = ok(await joinW(O2));
    assert.equal(J.status, 'linked'); assert.match(J.token, /^w_[0-9a-f]{64}$/); assert.deepEqual(J.link, { id: J.link.id, label: "Cy's Apple Watch", game: 'live-o1' }); assert.equal(J.club.name, '');
    const st = ok(await as(J.token, 'watch-state'));
    assert.equal(st.game.id, 'live-o1'); assert.equal(st.club.name, '');
    assert.equal((await joinW(O2)).status, 404, 'one watch per code');
    assert.ok(!JSON.stringify((await pg.query('SELECT * FROM watch_links')).rows).includes(J.token), 'only the token hash is stored');
    ok(await as(J.token, 'watch-rally', { opId: 'tap-join-001', side: 0 }));
    // A new code replaces the last, and a code lapses.
    const A = await offerOf('live-o1', 'offerSecret11'), B = await offerOf('live-o1', 'offerSecret11');
    assert.equal((await joinW(A)).status, 404); 
    await pg.query(`UPDATE watch_offers SET expires_at = now() - interval '1 second'`);
    assert.equal((await joinW(B)).status, 404, 'lapsed');
  });

  await step('game code: a link to a game that is gone, or a game with 8 watches already, is refused and the code is kept', async () => {
    await publish('live-o2', 'offerSecret22');
    for (let i = 0; i < Wr.MAX_GAME_LINKS; i++) ok(await joinW(await offerOf('live-o2', 'offerSecret22')));
    const O = await offerOf('live-o2', 'offerSecret22');
    assert.equal((await joinW(O)).status, 409);
    assert.equal((await pg.query('SELECT 1 FROM watch_offers WHERE game_id = $1', ['live-o2'])).rows.length, 1, 'not used up by a refusal');
    // The same ceiling is per game: the club's own 20 club-wide links are untouched by them.
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM watch_links WHERE club = $1 AND game_id IS NULL AND revoked_at IS NULL', [wcode])).rows[0].n < Wr.MAX_LINKS_PER_CLUB, true);
    await pg.query(`UPDATE live_games SET updated_at = now() - interval '7 hours' WHERE id = 'live-o2'`);
    assert.equal((await joinW(O)).status, 404, 'a game nobody has published for six hours is not live');
  });

  await step('game code, from a page with no club: the watch code and the game code meet in either order', async () => {
    await publish('live-o3', 'offerSecret33');
    const claimGame = (offer, w, extra = {}) => call(live, 'POST', { body: { action: 'watch-claim-game', offer, pair: w.pairId, confirm4: w.confirm4, ...extra } });
    // The watch's QR opened by the Camera app: the page has the watch's id and numbers, the person types the game's 6 characters and 4 numbers.
    const O = await offerOf('live-o3', 'offerSecret33'), w = mk(); ok(await reg(w));
    assert.equal((await claimGame(O.short, w)).status, 400, 'a typed game code needs its numbers');
    assert.equal((await claimGame(O.short, w, { offerConfirm: other(O.confirm4) })).status, 403);
    assert.equal(ok(await pollW(w)).status, 'waiting', 'nothing was linked');
    ok(await claimGame(O.short, w, { offerConfirm: O.confirm4 }));
    const p = ok(await pollW(w));
    assert.equal(p.status, 'linked'); assert.equal(p.link.game, 'live-o3'); assert.equal(p.club.name, '');
    assert.equal(ok(await as(p.token, 'watch-state')).game.id, 'live-o3');
    assert.equal((await claimGame(O.short, mk(), { offerConfirm: O.confirm4 })).status, 404, 'a game code is good for one watch');
    // The game link opened in Safari: the game's id, and the watch's typed 6 characters with its 4 numbers.
    const O2 = await offerOf('live-o3', 'offerSecret33'), w2 = mk(); ok(await reg(w2));
    assert.equal((await call(live, 'POST', { body: { action: 'watch-claim-game', offer: O2.id, pair: w2.short, confirm4: other(w2.confirm4) } })).status, 403);
    ok(await call(live, 'POST', { body: { action: 'watch-claim-game', offer: O2.id, pair: w2.short, confirm4: w2.confirm4 } }));
    assert.equal(ok(await pollW(w2)).link.game, 'live-o3');
    // Three wrong watch numbers end the watch's code, three wrong game numbers end the game's.
    const O3 = await offerOf('live-o3', 'offerSecret33'), w3 = mk(); ok(await reg(w3));
    for (let i = 0; i < 3; i++) assert.equal((await claimGame(O3.id, { ...w3, confirm4: other(w3.confirm4) })).status, 403);
    assert.equal((await claimGame(O3.id, w3)).status, 404, 'the watch code is gone');
    const O4 = await offerOf('live-o3', 'offerSecret33'), w4 = mk(); ok(await reg(w4));
    for (let i = 0; i < 3; i++) assert.equal((await claimGame(O4.short, w4, { offerConfirm: other(O4.confirm4) })).status, 403);
    assert.equal((await claimGame(O4.id, w4)).status, 404, 'the game code is gone');
    assert.equal((await claimGame('nothing', w4)).status, 400);
  });

  await step('single game: unlinking by the watch, the scorer (game secret) or an organizer; a stranger cannot', async () => {
    await publish('live-u1', 'unlinkSecret1');
    const J = ok(await joinW(await offerOf('live-u1', 'unlinkSecret1'))), id = J.link.id;
    const revoke = extra => call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: id, ...extra } });
    assert.equal((await revoke({})).status, 403);
    assert.equal((await revoke({ secret: 'wrongSecret1' })).status, 403, 'not the scorer');
    ok(await revoke({ secret: 'unlinkSecret1' }));
    assert.equal((await as(J.token, 'watch-state')).status, 401);
    const K = ok(await joinW(await offerOf('live-u1', 'unlinkSecret1')));
    ok(await as(K.token, 'watch-unlink')); assert.equal((await as(K.token, 'watch-state')).status, 401);
    const M = ok(await joinW(await offerOf('live-u1', 'unlinkSecret1')));
    ok(await call(live, 'POST', { body: { code: wcode, action: 'watch-revoke', link: M.link.id, pin: WPIN } }));
    assert.equal((await as(M.token, 'watch-state')).status, 401);
  });

  await step('tournament: many games on one Wi-Fi each link watches, with no network ceiling on honest use', async () => {
    const t = ok(await call(club, 'POST', { body: { name: 'Tournament check club', pin: '135790' } }), 201).club.code;
    await pg.query(`DELETE FROM lookup_fails`);
    for (let g = 0; g < 18; g++) {
      const id = 'live-t' + g, secret = 'tourSecret' + String(g).padStart(2, '0');
      await publish(id, secret, t);
      for (let k = 0; k < 2; k++) assert.equal(ok(await as(ok(await joinW(await offerOf(id, secret, t))).token, 'watch-state')).game.id, id);
    }
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM watch_links WHERE club = $1 AND game_id IS NOT NULL', [t])).rows[0].n, 36, 'more than the 20 club-wide links');
    // A venue of people mistyping: 40 wrong codes in a row still leave the network able to link.
    for (let i = 0; i < 40; i++) assert.equal((await joinW({ short: 'AAAAAA', confirm4: '1234' })).status, 404);
    ok(await joinW(await offerOf('live-t3', 'tourSecret03', t)));
  });

  await step('quick game room: a phone with no club gets a throwaway room, links a watch by code or scan, and the room goes with the game', async () => {
    await pg.query(`DELETE FROM lookup_fails`);
    const r = ok(await call(club, 'POST', { body: { room: true } }), 201).room;
    assert.match(r, /^[A-Z0-9]{6}$/);
    const q = (await pg.query('SELECT name, quick, pin_hash, owner_hash, delete_at FROM clubs WHERE code = $1', [r])).rows[0];
    assert.equal(q.quick, true); assert.equal(q.pin_hash, null, 'no organizer PIN'); assert.equal(q.owner_hash, null, 'no organizer phone');
    assert.ok(hours(q.delete_at, new Date()) > 23.5 && hours(q.delete_at, new Date()) <= 24, 'it expires in a day at the latest');
    assert.equal((await call(club, 'POST', { body: { code: r, action: 'delete-club', confirm: 'Quick game', pin: '000000' } })).status >= 400, true, 'nobody can organize a room');
    await publish('live-q1', 'quickSecret11', r);
    const A = await link({ game: 'live-q1', secret: 'quickSecret11', single: true }, r);
    assert.equal(A.p.link.game, 'live-q1');
    const B = await joinW(await offerOf('live-q1', 'quickSecret11', r)).then(ok);
    ok(await as(B.token, 'watch-rally', { opId: 'tap-quick-001', side: 0 }));
    assert.deepEqual(ok(await as(A.token, 'watch-state')).game.score, [1, 0], 'both watches see the same game');
    ok(await call(live, 'POST', { body: { code: r, action: 'end', id: 'live-q1', secret: 'quickSecret11' } }));
    assert.equal((await pg.query('SELECT 1 FROM clubs WHERE code = $1', [r])).rows.length, 0, 'the room is removed with its game');
    assert.equal((await pg.query('SELECT 1 FROM watch_links WHERE club = $1', [r])).rows.length, 0);
    assert.equal((await as(A.token, 'watch-state')).status, 401);
    // A real club is never removed by an end.
    await publish('live-q2', 'quickSecret22'); ok(await call(live, 'POST', { body: { code: wcode, action: 'end', id: 'live-q2', secret: 'quickSecret22' } }));
    assert.equal((await pg.query('SELECT 1 FROM clubs WHERE code = $1', [wcode])).rows.length, 1);
    // A venue: 100 rooms from one network in an hour are fine; the limit still exists.
    const venue = { 'x-real-ip': '198.51.100.40' };
    for (let i = 0; i < 100; i++) ok(await call(club, 'POST', { headers: venue, body: { room: true } }), 201);
    let blocked = 0; for (let i = 0; i < 30; i++) if ((await call(club, 'POST', { headers: venue, body: { room: true } })).status === 429) blocked++;
    assert.ok(blocked > 0, 'rooms are throttled per network');
    assert.equal((await call(club, 'POST', { headers: venue, body: { name: 'Still allowed', pin: '112233' } })).status, 201, 'rooms do not use up club creation');
    await pg.query(`DELETE FROM clubs WHERE quick`); await pg.query(`DELETE FROM lookup_fails`);
  });

  await step('club deletion removes its watch links and the token stops working; other clubs keep theirs', async () => {
    const gone = ok(await call(club, 'POST', { body: { name: 'Doomed watch club', pin: '246810' } }), 201).club.code;
    await publish('live-gone', 'goneSecret111', gone);
    const L = await link({ game: 'live-gone', secret: 'goneSecret111' }, gone), keep = await link();
    assert.equal(ok(await as(L.token, 'watch-state')).game.id, 'live-gone');
    await pg.query('DELETE FROM clubs WHERE code = $1', [gone]);
    assert.equal((await pg.query('SELECT 1 FROM watch_links WHERE club = $1', [gone])).rows.length, 0);
    assert.equal((await as(L.token, 'watch-state')).status, 401);
    assert.equal((await as(keep.token, 'watch-state')).status, 200);
  });
}

// Reactions on finished games (L12): auth, toggle, caps, ETag invalidation, rename/merge, soft-delete/restore, code rotation, rate limit.
{
  const rc = ok(await call(club, 'POST', { body: { name: 'Reactions check club', pin: '739152' } }), 201);
  const rcode = rc.club.code, rowner = rc.ownerToken;
  const claim = async name => ok(await call(playersApi, 'POST', { body: { code: rcode, action: 'claim', name, ownerToken: rowner } })).playerToken;
  const tokA = await claim('Ana'), tokB = await claim('Ben'), tokC = await claim('Cy');
  const now = Date.now();
  ok(await call(games, 'POST', { body: { code: rcode, games: [
    { id: 'rx-g1', mode: 'doubles', teams: [['Ana', 'Ben'], ['Cy', 'Di']], score: [11, 8], startedAt: now - 600e3, endedAt: now - 1000 },
    { id: 'rx-g2', mode: 'singles', teams: [['Ana'], ['Ben']], score: [11, 5], startedAt: now - 500e3, endedAt: now - 500 }
  ] } }));
  const react = (gameId, reaction, creds, useCode = rcode, headers = {}) =>
    call(games, 'POST', { headers, body: { code: useCode, react: gameId, reaction, ...creds } });

  await step('reactions: only claimed unblocked members can react; unknown reactions and games are refused', async () => {
    assert.equal((await react('rx-g1', 'fire', {})).status, 403);
    assert.equal((await react('rx-g1', 'fire', { playerName: 'Di', playerToken: tokA })).status, 403, 'unclaimed guest cannot react');
    assert.equal((await react('rx-g1', 'fire', { playerName: 'Ana', playerToken: tokB })).status, 403, 'wrong token refused');
    assert.equal((await react('rx-g1', 'heart', { playerName: 'Ana', playerToken: tokA })).status, 400, 'non-allow-listed reaction refused');
    assert.equal((await react('rx-nope', 'fire', { playerName: 'Ana', playerToken: tokA })).status, 404, 'missing game refused');
    assert.equal((await call(games, 'GET', { query: `?code=${rcode}&reactions=rx-nope` })).status, 404);
    // Blocked member cannot react
    ok(await call(playersApi, 'POST', { body: { code: rcode, action: 'remove', name: 'Cy', block: true, ownerToken: rowner } }));
    assert.equal((await react('rx-g1', 'fire', { playerName: 'Cy', playerToken: tokC })).status, 403, 'blocked member refused');
    ok(await call(playersApi, 'POST', { body: { code: rcode, action: 'unblock', name: 'Cy', ownerToken: rowner } }));
  });

  await step('reactions: toggle on/off, club sync ETag invalidates cleanly, soft-delete hides and restore brings them back', async () => {
    const first = await call(club, 'GET', { query: '?code=' + rcode });
    assert.equal(first.status, 200);
    assert.equal(first.json.games.find(g => g.id === 'rx-g1').reactions, undefined, 'games without reactions omit the field');
    const tag0 = first.headers.etag;
    assert.equal((await call(club, 'GET', { query: '?code=' + rcode, headers: { 'if-none-match': tag0 } })).status, 304);

    const add = ok(await react('rx-g1', 'fire', { playerName: 'Ana', playerToken: tokA }));
    assert.equal(add.added, true);
    assert.deepEqual(add.reactions, { fire: ['Ana'] });
    const afterAdd = await call(club, 'GET', { query: '?code=' + rcode, headers: { 'if-none-match': tag0 } });
    assert.equal(afterAdd.status, 200, 'adding a reaction invalidates the club ETag');
    assert.deepEqual(afterAdd.json.games.find(g => g.id === 'rx-g1').reactions, { fire: ['Ana'] });
    const tag1 = afterAdd.headers.etag;
    assert.equal((await call(club, 'GET', { query: '?code=' + rcode, headers: { 'if-none-match': tag1 } })).status, 304);

    const direct = ok(await call(games, 'GET', { query: `?code=${rcode}&reactions=rx-g1` }));
    assert.deepEqual(direct.reactions, { fire: ['Ana'] });

    // Soft-delete hides reactions from club and blocks toggling; restore brings them back
    ok(await call(games, 'DELETE', { query: `?code=${rcode}&id=rx-g1`, headers: { 'x-club-owner': rowner } }));
    assert.equal((await react('rx-g1', 'clap', { playerName: 'Ana', playerToken: tokA })).status, 404);
    assert.equal((await call(games, 'GET', { query: `?code=${rcode}&reactions=rx-g1` })).status, 404);
    ok(await call(games, 'POST', { body: { code: rcode, restore: 'rx-g1', ownerToken: rowner } }));
    assert.deepEqual(ok(await call(games, 'GET', { query: `?code=${rcode}&reactions=rx-g1` })).reactions, { fire: ['Ana'] });

    // Toggle off
    const rem = ok(await react('rx-g1', 'fire', { playerName: 'Ana', playerToken: tokA }));
    assert.equal(rem.added, false);
    assert.deepEqual(rem.reactions, {});
    const afterRem = await call(club, 'GET', { query: '?code=' + rcode, headers: { 'if-none-match': tag1 } });
    assert.equal(afterRem.status, 200, 'removing a reaction invalidates the ETag');
    assert.equal(afterRem.json.games.find(g => g.id === 'rx-g1').reactions, undefined);
  });

  await step('reactions: per-member cap (3) and per-game cap (60); removing still works at cap', async () => {
    ok(await react('rx-g1', 'clap', { playerName: 'Ana', playerToken: tokA }));
    ok(await react('rx-g1', 'fire', { playerName: 'Ana', playerToken: tokA }));
    ok(await react('rx-g1', 'pickle', { playerName: 'Ana', playerToken: tokA }));
    assert.equal((await react('rx-g1', 'sweat', { playerName: 'Ana', playerToken: tokA })).status, 409, '4th reaction by same member refused');
    // Removing at cap still works, and frees a slot
    const off = ok(await react('rx-g1', 'pickle', { playerName: 'Ana', playerToken: tokA }));
    assert.equal(off.added, false);
    const fourth = ok(await react('rx-g1', 'sweat', { playerName: 'Ana', playerToken: tokA }));
    assert.equal(fourth.added, true);
    assert.deepEqual(Object.keys(fourth.reactions), ['clap', 'fire', 'sweat']);

    // Per-game cap (60 total): fill rx-g2 to 60 reactions across synthetic members, then verify Ben cannot add 61st but can remove his own
    ok(await react('rx-g2', 'fire', { playerName: 'Ben', playerToken: tokB }));
    for (let i = 0; i < 59; i++) {
      await pg.query(`INSERT INTO game_reactions (club, game_id, name_key, name, reaction) VALUES ($1, 'rx-g2', $2, $3, 'clap')`, [rcode, 'bot' + i, 'Bot ' + i]);
    }
    assert.equal((await react('rx-g2', 'trophy', { playerName: 'Ana', playerToken: tokA })).status, 409, '61st reaction on a game refused');
    const freed = ok(await react('rx-g2', 'fire', { playerName: 'Ben', playerToken: tokB }));
    assert.equal(freed.added, false, 'removing at per-game cap still works');
    assert.equal(ok(await react('rx-g2', 'trophy', { playerName: 'Ana', playerToken: tokA })).added, true, 'adding succeeds once below cap');
  });

  await step('reactions: club code rotation resolves to permanent club key', async () => {
    const rot = ok(await call(club, 'POST', { body: { code: rcode, action: 'rotate-code', ownerToken: rowner, graceMinutes: 30 } }));
    const nextCode = rot.club.code;
    assert.notEqual(nextCode, rcode);
    const viaNew = ok(await react('rx-g1', 'fire', { playerName: 'Ben', playerToken: tokB }, nextCode));
    assert.deepEqual(viaNew.reactions.fire, ['Ana', 'Ben']);
    const viaOld = ok(await call(games, 'GET', { query: `?code=${rcode}&reactions=rx-g1` }));
    assert.deepEqual(viaOld.reactions.fire, ['Ana', 'Ben']);
  });

  await step('reactions: rename and merge update names, dedupe overlaps, and keep per-member cap', async () => {
    // Rename Ana -> Ana M
    ok(await call(playersApi, 'POST', { body: { code: rcode, action: 'rename', name: 'Ana', newName: 'Ana M', ownerToken: rowner } }));
    const afterRen = ok(await call(games, 'GET', { query: `?code=${rcode}&reactions=rx-g1` }));
    assert.deepEqual(afterRen.reactions.fire, ['Ana M', 'Ben']);
    assert.deepEqual(afterRen.reactions.clap, ['Ana M']);

    // Prepare merge: add unclaimed alias 'Benji' with reactions overlapping Ben's ('fire') plus 2 new ones ('pickle', 'trophy'),
    // while Ben already has 'fire' and 'clap' (combined unique = 4 -> must dedupe 'fire' and cap at 3).
    ok(await react('rx-g1', 'clap', { playerName: 'Ben', playerToken: tokB }));
    ok(await call(roster, 'POST', { body: { code: rcode, name: 'Benji' } }));
    await pg.query(`INSERT INTO game_reactions (club, game_id, name_key, name, reaction) VALUES
      ($1, 'rx-g1', 'benji', 'Benji', 'fire'),
      ($1, 'rx-g1', 'benji', 'Benji', 'pickle'),
      ($1, 'rx-g1', 'benji', 'Benji', 'trophy')`, [rcode]);
    ok(await call(playersApi, 'POST', { body: { code: rcode, action: 'merge', name: 'Benji', into: 'Ben', ownerToken: rowner } }));
    const afterMerge = ok(await call(games, 'GET', { query: `?code=${rcode}&reactions=rx-g1` }));
    assert.ok(!JSON.stringify(afterMerge).includes('Benji'), 'merged name is gone');
    const benCount = Object.values(afterMerge.reactions).reduce((n, list) => n + list.filter(x => x === 'Ben').length, 0);
    assert.equal(benCount, 3, 'merged member reactions are deduped and capped at 3 per game');
  });

  await step('reactions: rate limit blocks bursts from one member (429)', async () => {
    await pg.query(`DELETE FROM lookup_fails WHERE ip LIKE 'react%'`);
    const burstIp = { 'x-real-ip': '198.51.100.77' };
    let limited = 0;
    for (let i = 0; i < 65; i++) {
      const r = await react('rx-g1', 'trophy', { playerName: 'Ana M', playerToken: tokA }, rcode, burstIp);
      if (r.status === 429) { limited++; break; }
    }
    assert.ok(limited > 0, 'member reaction burst hits 429');
    await pg.query(`DELETE FROM lookup_fails WHERE ip LIKE 'react%'`);
  });

  await step('reactions: public result page never leaks reactions', async () => {
    ok(await call(club, 'POST', { body: { code: rcode, action: 'results-set', enabled: true, ownerToken: rowner } }));
    const link = ok(await call(club, 'POST', { body: { code: rcode, action: 'results-create', game: 'rx-g1' } }));
    const token = link.path.split('/').pop();
    const html = await new Promise(async resolve => {
      const req = { method: 'GET', url: `/api/bracket?result=1&token=${token}&fmt=html`, headers: { host: 'example.test', 'x-real-ip': '10.0.0.199' } };
      let text = '';
      const res = { statusCode: 0, setHeader() {}, end(t) { text = t || ''; resolve({ status: res.statusCode, text }); } };
      await bracket(req, res);
    });
    assert.equal(html.status, 200);
    assert.ok(!/reactions|On fire|Great game|Nice dink/i.test(html.text), 'public result page has no reaction data');
  });
}

// Game nights with In / Maybe / Out RSVPs (L11, api/_gamenights.js via api/club.js).
{
  const gnc = ok(await call(club, 'POST', { body: { name: 'Game night club', pin: '246810' } }), 201);
  const gcode = gnc.club.code, GORG = { ownerToken: gnc.ownerToken };
  const gtok = {};
  for (const n of ['Ana', 'Ben', 'Cy']) gtok[n] = ok(await call(playersApi, 'POST', { body: { code: gcode, action: 'claim', name: n, ...GORG } })).playerToken;
  const GN = (action, body) => call(club, 'POST', { body: { code: gcode, action, ...body } });
  const future = Date.now() + 2 * 864e5;
  let nightId;

  await step('game nights: organizer schedules and edits; non-organizers are refused', async () => {
    assert.equal((await GN('night-create', { night: { title: 'Tuesday play', startsAt: future }, playerName: 'Ana', playerToken: gtok.Ana })).status, 403);
    assert.equal((await GN('night-create', { ...GORG, night: { title: 'Past night', startsAt: Date.now() - 3600_000 } })).status, 400);
    const made = ok(await GN('night-create', { ...GORG, night: { title: 'Tuesday play', startsAt: future, location: 'Courts 1-2', note: 'Bring balls', cap: 2 } }), 201).night;
    nightId = made.id;
    assert.equal(made.title, 'Tuesday play');
    assert.equal(made.cap, 2);
    assert.deepEqual(made.counts, { in: 0, maybe: 0, out: 0 });
    assert.equal((await GN('night-edit', { id: nightId, night: { title: 'Hacked', startsAt: future }, playerName: 'Ana', playerToken: gtok.Ana })).status, 403);
    const edited = ok(await GN('night-edit', { ...GORG, id: nightId, night: { title: 'Tuesday lights', startsAt: future + 3600_000, location: 'West Park', note: 'Outdoor balls', cap: 2 } })).night;
    assert.equal(edited.title, 'Tuesday lights');
    assert.equal(edited.location, 'West Park');
  });

  await step('game nights: members RSVP In/Maybe/Out, cap is enforced, clear works, and club ETag updates', async () => {
    assert.equal((await GN('night-rsvp', { id: nightId, status: 'in' })).status, 403, 'unlinked caller refused');
    assert.equal((await GN('night-rsvp', { id: nightId, status: 'in', playerName: 'Ana', playerToken: gtok.Ben })).status, 403, 'wrong player token refused');
    const c1 = await call(club, 'GET', { query: '?code=' + gcode });
    assert.equal(c1.status, 200);
    const tag1 = c1.headers.etag;
    assert.equal(c1.json.nights.length, 1);

    ok(await GN('night-rsvp', { id: nightId, status: 'in', playerName: 'Ana', playerToken: gtok.Ana }));
    ok(await GN('night-rsvp', { id: nightId, status: 'in', playerName: 'Ben', playerToken: gtok.Ben }));
    // Cap is 2: third player cannot mark In, but can mark Maybe or Out.
    assert.equal((await GN('night-rsvp', { id: nightId, status: 'in', playerName: 'Cy', playerToken: gtok.Cy })).status, 409);
    const afterMaybe = ok(await GN('night-rsvp', { id: nightId, status: 'maybe', playerName: 'Cy', playerToken: gtok.Cy })).night;
    assert.deepEqual(afterMaybe.counts, { in: 2, maybe: 1, out: 0 });
    assert.deepEqual(afterMaybe.rsvps.in, ['Ana', 'Ben']);
    // Club ETag changed after RSVPs.
    const c2 = await call(club, 'GET', { query: '?code=' + gcode, headers: { 'if-none-match': tag1 } });
    assert.equal(c2.status, 200);
    assert.deepEqual(c2.json.nights[0].counts, { in: 2, maybe: 1, out: 0 });
    // Ben switches to Out -> frees a spot so Cy can switch to In.
    ok(await GN('night-rsvp', { id: nightId, status: 'out', playerName: 'Ben', playerToken: gtok.Ben }));
    const afterCyIn = ok(await GN('night-rsvp', { id: nightId, status: 'in', playerName: 'Cy', playerToken: gtok.Cy })).night;
    assert.deepEqual(afterCyIn.counts, { in: 2, maybe: 0, out: 1 });
    assert.deepEqual(afterCyIn.rsvps.in, ['Ana', 'Cy']);
    // Clearing RSVP works.
    const afterClear = ok(await GN('night-rsvp', { id: nightId, status: 'none', playerName: 'Ben', playerToken: gtok.Ben })).night;
    assert.deepEqual(afterClear.counts, { in: 2, maybe: 0, out: 0 });
  });

  await step('game nights: rename and merge update RSVPs cleanly without PK conflicts', async () => {
    ok(await call(playersApi, 'POST', { body: { code: gcode, action: 'rename', name: 'Ana', newName: 'Anastasia', ...GORG } }));
    const list1 = ok(await call(club, 'GET', { query: `?code=${gcode}&nights=1` })).nights;
    assert.ok(list1[0].rsvps.in.includes('Anastasia') && !list1[0].rsvps.in.includes('Ana'));
    // Add a guest RSVP then merge guest into Cy (both already RSVPed on the same night).
    ok(await call(roster, 'POST', { body: { code: gcode, name: 'Cy Guest' } }));
    ok(await GN('night-rsvp', { ...GORG, id: nightId, name: 'Cy Guest', status: 'maybe' }));
    ok(await call(playersApi, 'POST', { body: { code: gcode, action: 'merge', name: 'Cy Guest', into: 'Cy', ...GORG } }));
    const list2 = ok(await call(club, 'GET', { query: `?code=${gcode}&nights=1` })).nights;
    assert.deepEqual(list2[0].rsvps.in, ['Anastasia', 'Cy']);
    assert.deepEqual(list2[0].rsvps.maybe, []);
  });

  await step('game nights: cancel blocks new RSVPs and hides from upcoming; delete removes it', async () => {
    const cancelled = ok(await GN('night-cancel', { ...GORG, id: nightId })).night;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await GN('night-rsvp', { id: nightId, status: 'in', playerName: 'Ben', playerToken: gtok.Ben })).status, 409);
    assert.equal(ok(await call(club, 'GET', { query: '?code=' + gcode })).nights.length, 0, 'cancelled night leaves upcoming list');
    assert.equal(ok(await call(club, 'GET', { query: `?code=${gcode}&nights=1` })).nights[0].status, 'cancelled');
    ok(await GN('night-delete', { ...GORG, id: nightId }));
    assert.equal(ok(await call(club, 'GET', { query: `?code=${gcode}&nights=1` })).nights.length, 0);
  });
}

// Ending a club season early (L21, api/_seasons.js via api/club.js).
{
  const sec = ok(await call(club, 'POST', { body: { name: 'Season end club', pin: '246810' } }), 201);
  const scode = sec.club.code, SORG = { ownerToken: sec.ownerToken };
  const stok = {};
  for (const n of ['Ana', 'Ben', 'Cy', 'Di']) stok[n] = ok(await call(playersApi, 'POST', { body: { code: scode, action: 'claim', name: n, ...SORG } })).playerToken;
  const SE = (body) => call(club, 'POST', { body: { code: scode, action: 'season-end', ...body } });
  const sget = async (headers = {}) => call(club, 'GET', { query: '?code=' + scode, headers });
  const sgames = Array.from({ length: 5 }, (_, i) => ({ id: 'se-' + i, mode: 'doubles', teams: [['Ana', 'Ben'], ['Cy', 'Di']], score: [11, 4], endedAt: Date.now() - 5000 + i, startedAt: Date.now() - 600000 }));
  ok(await call(games, 'POST', { body: { code: scode, games: sgames, ...SORG } }));
  let first, tag;

  await step('season end: only an organizer can do it, and the season shown must still be the current one', async () => {
    first = ok(await sget());
    const cur = first.progress.season;
    assert.match(cur.id, /^\d{4}-Q[1-4]$/, 'a club that never ended a season has its calendar quarter');
    assert.equal(cur.custom, undefined);
    assert.equal((await SE({ seasonId: cur.id, playerName: 'Ana', playerToken: stok.Ana })).status, 403);
    assert.equal((await SE({ seasonId: cur.id })).status, 403);
    assert.equal((await SE({ seasonId: cur.id, pin: '000000' })).status, 403);
    assert.equal((await SE({ ...SORG })).status, 400, 'the season id is required');
    assert.equal((await SE({ ...SORG, seasonId: '1999-Q1' })).status, 409, 'a stale season id is refused');
    assert.equal((await sget()).json.progress.season.id, cur.id, 'refused attempts changed nothing');
    assert.equal(first.progress.players.ana.trophies.length, 0);
  });
  await step('season end: closes the season, awards the usual trophies and starts the named one; the club tag changes', async () => {
    const before = await sget(); tag = before.headers.etag;
    assert.ok(tag);
    assert.equal((await sget({ 'if-none-match': tag })).status, 304);
    await new Promise(r => setTimeout(r, 10)); // games received this millisecond would count as the new season's
    const r = ok(await SE({ ...SORG, seasonId: first.progress.season.id, name: '  Autumn   ladder\u0000  ' }));
    assert.equal(r.closed.id, first.progress.season.id);
    assert.equal(r.closed.end, r.season.start);
    assert.equal(r.season.name, 'Autumn ladder');
    const after = await sget({ 'if-none-match': tag });
    assert.equal(after.status, 200, 'the old tag no longer matches');
    assert.notEqual(after.headers.etag, tag);
    const pg2 = after.json.progress;
    assert.equal(pg2.season.name, 'Autumn ladder');
    assert.equal(pg2.season.custom, true);
    assert.equal(pg2.season.start, r.season.start);
    assert.ok(pg2.season.end > pg2.season.start);
    const ana = pg2.players.ana.trophies;
    assert.deepEqual(ana.map(t => [t.season, t.mode, t.place]), [[first.progress.season.id, 'doubles', 1]]);
    assert.equal(pg2.players.cy.trophies[0].place, 3, 'a tie for third goes to the player with the name first');
    assert.equal(pg2.players.di.trophies.length, 0, 'only the top three win');
    assert.equal(after.json.games.length, 5, 'games stay');
  });
  await step('season end: a second close right away is refused, a later one gets a default name, and past champions stay', async () => {
    const cur = ok(await sget()).progress.season;
    assert.equal((await SE({ ...SORG, seasonId: cur.id })).status, 409, 'a season has to run for a minute first');
    // Pretend that happened an hour ago: the new season's start and the games received before the close move back together.
    await pg.query(`UPDATE club_seasons SET starts_at = starts_at - 3600000 WHERE club = $1`, [scode]);
    await pg.query(`UPDATE games SET data = jsonb_set(data, '{receivedAt}', to_jsonb((data->>'receivedAt')::bigint - 3600000)) WHERE club = $1`, [scode]);
    const now = ok(await sget()).progress.season;
    const r = ok(await SE({ ...SORG, seasonId: now.id }));
    assert.equal(r.season.name, 'Autumn ladder, part 2');
    assert.equal(r.closed.name, 'Autumn ladder');
    const done = ok(await sget()).progress;
    assert.equal(done.season.name, 'Autumn ladder, part 2');
    assert.equal(done.players.ana.trophies.length, 1, 'earlier trophies are kept');
    assert.equal((await SE({ ...SORG, seasonId: now.id })).status, 409, 'a stale season id is refused after the close');
  });
  await step('season end: it is in the audit log and the club export, and the club code answers for a PIN holder too', async () => {
    const ex = ok(await call(club, 'POST', { body: { code: scode, action: 'export', pin: '246810' } }));
    assert.equal(ex.seasons.length, 2);
    assert.deepEqual(ex.seasons.map(x => x.name), ['Autumn ladder', 'Autumn ladder, part 2']);
    assert.ok(ex.memberLog.some(l => l.action === 'season-end' && l.target && l.detail.next.name === 'Autumn ladder'));
    const pinned = await SE({ pin: '246810', seasonId: 'nope' });
    assert.equal(pinned.status, 409, 'the organizer PIN is accepted (the stale id is what is refused)');
    assert.ok(ex.memberLog.every(l => !/246810/.test(JSON.stringify(l))));
  });
}

// Linking friendly clubs into one leaderboard (L15, api/_clublinks.js via api/club.js).
{
  const mk = async (name, pin) => { const c = ok(await call(club, 'POST', { body: { name, pin } }), 201); return { code: c.club.code, ORG: { ownerToken: c.ownerToken } }; };
  const A = await mk('Link club A', '246810'), B = await mk('Link club B', '135790'), C = await mk('Link club C', '112233');
  const LK = (c, action, body = {}) => call(club, 'POST', { body: { code: c.code, action, ...body } });
  const lget = (c, q = '', headers = {}) => call(club, 'GET', { query: `?code=${c.code}&links=1${q}`, headers });
  const lgames = (pre, p1, p2) => Array.from({ length: 6 }, (_, i) => ({ id: pre + i, mode: 'doubles', teams: [p1, p2], score: [11, 4], endedAt: Date.now() - 5000 + i, startedAt: Date.now() - 600000 }));
  const tokA = {}, tokB = {};
  for (const n of ['Ana', 'Ben', 'Cy', 'Di']) tokA[n] = ok(await call(playersApi, 'POST', { body: { code: A.code, action: 'claim', name: n, ...A.ORG } })).playerToken;
  for (const n of ['Eve', 'Fay', 'Gus', 'Hal']) tokB[n] = ok(await call(playersApi, 'POST', { body: { code: B.code, action: 'claim', name: n, ...B.ORG } })).playerToken;
  ok(await call(games, 'POST', { body: { code: A.code, games: lgames('la-', ['Ana', 'Ben'], ['Cy', 'Di']), ...A.ORG } }));
  ok(await call(games, 'POST', { body: { code: B.code, games: lgames('lb-', ['Eve', 'Fay'], ['Gus', 'Hal']), ...B.ORG } }));
  let invite, linkId;

  await step('club links: only an organizer can make an invite; players and the code alone are refused', async () => {
    assert.equal((await LK(A, 'link-invite')).status, 403);
    assert.equal((await LK(A, 'link-invite', { playerName: 'Ana', playerToken: tokA.Ana })).status, 403);
    assert.equal((await LK(A, 'link-invite', { pin: '000000' })).status, 403);
    const r = ok(await LK(A, 'link-invite', { pin: '246810' }), 201);
    assert.match(r.invite, /^[A-HJKMNP-Z2-9]{8}$/);
    assert.ok(r.expiresAt > Date.now());
    invite = r.invite; linkId = r.id;
  });
  await step('club links: the invite is seen by A\'s organizers only, and nothing is linked yet', async () => {
    assert.deepEqual(ok(await lget(A)).links, []);
    assert.equal(ok(await lget(A)).pending, undefined, 'a plain member never sees the code');
    assert.deepEqual(ok(await lget(A, '', { 'x-club-owner': A.ORG.ownerToken })).pending.map(p => p.invite), [invite]);
    assert.equal((await lget(A, `&link=${linkId}`)).status, 404, 'an invite is not a link');
  });
  await step('club links: preview and accept need B\'s organizer, show only the name, and say nothing for a bad code', async () => {
    assert.equal((await LK(B, 'link-preview', { invite })).status, 403);
    assert.equal((await LK(B, 'link-accept', { invite, playerName: 'Eve', playerToken: tokB.Eve })).status, 403);
    assert.deepEqual(ok(await LK(B, 'link-preview', { invite: invite.toLowerCase().replace(/^(....)/, '$1-'), pin: '135790' })), { clubName: 'Link club A' });
    const bad = await LK(B, 'link-accept', { invite: 'AAAAAAAA', pin: '135790' });
    assert.equal(bad.status, 404);
    assert.equal((await LK(B, 'link-accept', { invite: 'nope', pin: '135790' })).status, 404);
    assert.equal(bad.json.error, (await LK(B, 'link-accept', { invite: 'nope', pin: '135790' })).json.error, 'a malformed and an unknown code answer the same');
    assert.equal((await LK(A, 'link-accept', { invite, pin: '246810' })).status, 400, 'a club cannot accept its own invite');
    assert.equal((await lget(B)).json.links.length, 0, 'previews and refusals linked nothing');
  });
  await step('club links: an expired invite no longer works', async () => {
    await pg.query(`UPDATE club_links SET invite_expires = now() - interval '1 minute' WHERE id = $1`, [linkId]);
    assert.equal((await LK(B, 'link-preview', { invite, pin: '135790' })).status, 404);
    assert.equal((await LK(B, 'link-accept', { invite, pin: '135790' })).status, 404);
    assert.deepEqual(ok(await lget(A, '', { 'x-club-owner': A.ORG.ownerToken })).pending, [], 'expired invites are not listed');
    await pg.query(`UPDATE club_links SET invite_expires = now() + interval '1 day' WHERE id = $1`, [linkId]);
  });
  await step('club links: accepting makes the link live for both clubs, once', async () => {
    const r = ok(await LK(B, 'link-accept', { invite, pin: '135790' }));
    assert.equal(r.club, 'Link club A'); assert.equal(r.id, linkId);
    assert.equal((await LK(C, 'link-accept', { invite, pin: '112233' })).status, 404, 'the code is spent');
    assert.deepEqual(ok(await lget(A)).links.map(l => [l.id, l.club]), [[linkId, 'Link club B']]);
    assert.deepEqual(ok(await lget(B)).links.map(l => [l.id, l.club]), [[linkId, 'Link club A']]);
    assert.deepEqual(ok(await lget(A, '', { 'x-club-owner': A.ORG.ownerToken })).pending, []);
    const again = ok(await LK(B, 'link-invite', { pin: '135790' }), 201);
    assert.equal((await LK(A, 'link-accept', { invite: again.invite, pin: '246810' })).status, 409, 'the same two clubs cannot link twice');
    ok(await LK(B, 'link-leave', { id: again.id, pin: '135790' }));
  });
  await step('club links: members of either club see one combined standing, own club first, nothing else', async () => {
    const a = ok(await lget(A, `&link=${linkId}`)), b = ok(await lget(B, `&link=${linkId}`));
    assert.deepEqual(a.clubs, ['Link club A', 'Link club B']);
    assert.deepEqual(b.clubs, ['Link club B', 'Link club A']);
    assert.equal(a.rows.length, 8);
    assert.deepEqual(new Set(a.rows.map(r => r.name)), new Set(['Ana', 'Ben', 'Cy', 'Di', 'Eve', 'Fay', 'Gus', 'Hal']));
    assert.deepEqual(a.rows.filter(r => r.club === 1).map(r => r.name).sort(), ['Eve', 'Fay', 'Gus', 'Hal']);
    assert.deepEqual(b.rows.filter(r => r.club === 1).map(r => r.name).sort(), ['Ana', 'Ben', 'Cy', 'Di']);
    for (const r of a.rows) assert.deepEqual(Object.keys(r).sort(), ['club', 'games', 'name', 'provisional', 'rank', 'rating']);
    assert.deepEqual(Object.keys(a).sort(), ['clubs', 'mode', 'rows', 'v']);
    assert.ok(!/246810|135790|ownerToken|code/i.test(JSON.stringify([a, b])), 'no PIN, token or club code leaves');
    const text = JSON.stringify(a);
    assert.ok(!text.includes(A.code) && !text.includes(B.code));
    assert.equal((await lget(C, `&link=${linkId}`)).status, 404, 'a third club cannot read it');
    assert.equal((await call(club, 'GET', { query: `?links=1&link=${linkId}` })).status === 200, false, 'no club code, no standing');
    assert.equal(ok(await lget(A, `&link=${linkId}&mode=singles`)).rows.length, 0, 'singles has its own table');
  });
  await step('club links: a removed player drops out of the standing', async () => {
    ok(await call(playersApi, 'POST', { body: { code: B.code, action: 'remove', name: 'Hal', block: true, pin: '135790' } }));
    const a = ok(await lget(A, `&link=${linkId}`));
    assert.ok(!a.rows.some(r => r.name === 'Hal'));
    assert.equal(a.rows.length, 7);
  });
  await step('club links: either organizer can leave and it ends at once for both; players cannot', async () => {
    assert.equal((await LK(B, 'link-leave', { id: linkId, playerName: 'Eve', playerToken: tokB.Eve })).status, 403);
    assert.equal((await LK(C, 'link-leave', { id: linkId, pin: '112233' })).status, 404, 'a stranger cannot end it');
    assert.equal(ok(await lget(A)).links.length, 1, 'refusals changed nothing');
    ok(await LK(B, 'link-leave', { id: linkId, pin: '135790' }));
    assert.deepEqual(ok(await lget(A)).links, []);
    assert.equal((await lget(A, `&link=${linkId}`)).status, 404);
    assert.equal((await LK(A, 'link-leave', { id: linkId, pin: '246810' })).status, 404, 'already gone');
  });
  await step('club links: at most five per club, and deleting a club removes its links', async () => {
    for (let i = 0; i < 5; i++) ok(await LK(A, 'link-invite', { pin: '246810' }), 201);
    assert.equal((await LK(A, 'link-invite', { pin: '246810' })).status, 400);
    const ex = ok(await call(club, 'POST', { body: { code: A.code, action: 'export', pin: '246810' } }));
    assert.deepEqual(ex.linkedClubs, [], 'an invite is not a link');
    await pg.query(`UPDATE clubs SET delete_at = now() - interval '1 minute' WHERE code = $1`, [A.code]);
    await call(club, 'GET', { query: '?code=' + B.code });
    await pg.query(`DELETE FROM clubs WHERE delete_at IS NOT NULL AND delete_at <= now()`);
    assert.equal((await pg.query(`SELECT count(*)::int AS n FROM club_links WHERE club_a = $1 OR club_b = $1`, [A.code])).rows[0].n, 0);
  });
  await step('club links: a quick game room cannot link', async () => {
    const room = ok(await call(club, 'POST', { body: { room: true } }), 201).room;
    assert.equal((await call(club, 'POST', { body: { code: room, action: 'link-invite' } })).status, 400);
  });
}

// Ask an organizer to approve instead of sharing the PIN (L17, api/_approvals.js via api/players.js).
{
  const ap = ok(await call(club, 'POST', { body: { name: 'Approval club', pin: '246810' } }), 201);
  const acode = ap.club.code, AORG = { ownerToken: ap.ownerToken };
  const atok = {};
  for (const n of ['Ana', 'Ben', 'Cy', 'Di']) atok[n] = ok(await call(playersApi, 'POST', { body: { code: acode, action: 'claim', name: n, ...AORG } })).playerToken;
  const AP = (action, body) => call(playersApi, 'POST', { body: { code: acode, action, ...body } });
  const fresh = () => Array.from({ length: 48 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const state = async (id, t) => ok(await AP('approval-status', { id, playerToken: t })).status;
  const mine = async (name, t) => (await AP('export', { name, playerToken: t })).status; // 200 only for the phone the name is linked to
  const log = async () => ok(await AP('members', AORG)).audit;

  await step('approvals: asking needs a made-up key and a saved name, and only one request per name waits at a time', async () => {
    assert.equal((await AP('approval-request', { name: 'Ana', playerToken: 'nope' })).status, 400);
    assert.equal((await AP('approval-request', { name: 'Nobody', playerToken: fresh() })).status, 404);
    const t = fresh();
    const r = ok(await AP('approval-request', { name: 'Ana', playerToken: t }));
    assert.match(r.id, /^ap-/);
    assert.ok(r.expiresAt > Date.now() + 14 * 60e3 && r.expiresAt < Date.now() + 16 * 60e3, 'about 15 minutes');
    assert.equal(await state(r.id, t), 'pending');
    assert.equal((await AP('approval-request', { name: 'ana', playerToken: fresh() })).status, 409, 'a second ask for the same name is refused');
    assert.equal((await AP('approval-status', { id: r.id, playerToken: fresh() })).status, 404, 'another phone cannot read it');
    assert.equal((await AP('approval-status', { id: r.id })).status, 404);
    const [row] = (await pg.query(`SELECT token_hash FROM approval_requests WHERE id = $1`, [r.id])).rows;
    assert.ok(row.token_hash && !row.token_hash.includes(t), 'only a hash of the key is kept');
  });

  await step('approvals: organizers see the waiting request; a member without credentials cannot decide', async () => {
    const [pend] = ok(await AP('members', AORG)).requests;
    assert.equal(pend.name, 'Ana'); assert.equal(pend.linked, true);
    assert.equal((await AP('members', {})).status, 403, 'the list is for organizers');
    assert.equal((await AP('approval-decide', { id: pend.id, decision: 'approve' })).status, 403);
    assert.equal((await AP('approval-decide', { id: pend.id, decision: 'approve', pin: '000000' })).status, 403);
    assert.equal((await AP('approval-decide', { id: pend.id, decision: 'maybe', ...AORG })).status, 400);
    assert.equal((await AP('approval-decide', { id: 'ap-none', decision: 'deny', ...AORG })).status, 404);
    assert.equal(await mine('Ana', atok.Ana), 200, 'still linked to the first phone');
  });

  await step('approvals: a denial changes nothing, is logged with who made it, and the name can be asked for again', async () => {
    const [pend] = ok(await AP('members', AORG)).requests;
    assert.equal(ok(await AP('approval-decide', { id: pend.id, decision: 'deny', ...AORG })).status, 'denied');
    assert.equal((await AP('approval-decide', { id: pend.id, decision: 'approve', ...AORG })).status, 409, 'already decided');
    assert.equal(await mine('Ana', atok.Ana), 200);
    assert.deepEqual(ok(await AP('members', AORG)).requests, []);
    const l = (await log()).find(a => a.action === 'deny-claim');
    assert.equal(l.target, 'Ana'); assert.equal(l.actor, 'owner'); assert.equal(l.detail.request, pend.id);
  });

  await step('approvals: an approval moves the name to the asking phone, clears the old link, role and devices, and is logged', async () => {
    ok(await AP('set-role', { name: 'Ben', role: 'organizer', ...AORG }));
    await pg.query(`INSERT INTO push_subs (club, endpoint, name_key, p256dh, auth) VALUES ($1, 'https://fcm.googleapis.com/x/ben', 'ben', 'p', 'a')`, [acode]);
    const t = fresh();
    const r = ok(await AP('approval-request', { name: 'Ben', playerToken: t }));
    const co = { ownerToken: atok.Ben + ':Ben' };
    assert.equal((await AP('approval-decide', { id: r.id, decision: 'approve', ...co })).status, 403, 'a co-organizer cannot hand over an organizer');
    assert.equal(await state(r.id, t), 'pending');
    assert.equal(ok(await AP('approval-decide', { id: r.id, decision: 'approve', pin: '246810' })).status, 'approved');
    assert.equal(await state(r.id, t), 'approved');
    assert.equal(await mine('Ben', atok.Ben), 403, 'the old phone no longer acts as Ben');
    assert.equal(await mine('Ben', t), 200, 'the asking phone does');
    const [b] = ok(await AP('members', AORG)).members.filter(m => m.name === 'Ben');
    assert.equal(b.role, 'player'); assert.equal(b.claimed, true);
    assert.equal((await pg.query(`SELECT count(*)::int AS n FROM push_subs WHERE club = $1 AND name_key = 'ben'`, [acode])).rows[0].n, 0, 'the old phone stops hearing Ben');
    const l = (await log()).find(a => a.action === 'approve-claim');
    assert.equal(l.target, 'Ben'); assert.equal(l.actor, 'pin'); assert.equal(l.detail.request, r.id);
    assert.ok((await log()).every(a => !/246810/.test(JSON.stringify(a)) && !JSON.stringify(a).includes(t)), 'no PIN or key in the log');
  });

  await step('approvals: a request that runs out cannot be approved, and is gone from the list', async () => {
    const t = fresh();
    const r = ok(await AP('approval-request', { name: 'Cy', playerToken: t }));
    await pg.query(`UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.id]);
    assert.equal(await state(r.id, t), 'expired');
    assert.deepEqual(ok(await AP('members', AORG)).requests, []);
    assert.equal((await AP('approval-decide', { id: r.id, decision: 'approve', ...AORG })).status, 409);
    assert.equal(await mine('Cy', atok.Cy), 200, 'nothing moved');
    ok(await AP('approval-request', { name: 'Cy', playerToken: fresh() })); // an expired one does not block asking again
  });

  await step('approvals: a removed (blocked) name cannot be asked for, and renaming a name drops its waiting request', async () => {
    ok(await AP('remove', { name: 'Di', block: true, ...AORG }));
    assert.equal((await AP('approval-request', { name: 'Di', playerToken: fresh() })).status, 403);
    const [pend] = ok(await AP('members', AORG)).requests;
    assert.equal(pend.name, 'Cy');
    ok(await AP('rename', { name: 'Cy', newName: 'Cyrus', ...AORG }));
    assert.deepEqual(ok(await AP('members', AORG)).requests, []);
    assert.equal((await pg.query(`SELECT count(*)::int AS n FROM approval_requests WHERE club = $1 AND status = 'pending'`, [acode])).rows[0].n, 0);
  });

  await step('approvals: asks are limited per network, and the table is additive and cascades from the club', async () => {
    const same = { 'x-real-ip': '10.9.9.9' };
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await call(playersApi, 'POST', { headers: same, body: { code: acode, action: 'approval-request', name: 'Nobody', playerToken: fresh() } })).status;
    assert.equal(last, 404, 'unknown names are refused before they count');
    let limited = 0;
    for (let i = 0; i < 8; i++) limited = (await call(playersApi, 'POST', { headers: same, body: { code: acode, action: 'approval-request', name: 'Ana', playerToken: fresh() } })).status;
    assert.equal(limited, 429, 'a network that keeps asking is slowed down');
    const [fk] = (await pg.query(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'approval_requests'::regclass AND contype = 'f'`)).rows;
    assert.equal(fk.confdeltype, 'c');
  });
}

// Per-phone organizer keys: unlock, list, remove, lock, upgrade from the old club-wide key, PIN change (api/_orgkeys.js, _devices.js).
{
  const PIN0 = '482913';
  const dc = ok(await call(club, 'POST', { body: { name: 'Phones club', pin: PIN0 } }), 201);
  const dcode = dc.club.code, downer = dc.ownerToken;
  const DC = (action, body) => call(club, 'POST', { body: { code: dcode, action, ...body } });
  const unlock = async (extra = {}) => ok(await DC('verify-pin', { pin: PIN0, device: true, ...extra }));
  const list = async creds => ok(await DC('device-list', creds)).devices;
  const marks = async () => (await pg.query(`SELECT count(*)::int AS n FROM lookup_fails`)).rows[0].n;
  let A, B;

  await step('phone keys: unlocking with device:true returns a private key (not the club-wide one); old apps still get the club-wide key', async () => {
    A = (await unlock()).organizerKey; B = (await unlock()).organizerKey;
    assert.match(A, /^[0-9a-f]{80}$/); assert.notEqual(A, B);
    const v = await unlock();
    assert.equal(v.deviceKey, undefined, 'a current app is never handed the club-wide key');
    const old = ok(await DC('verify-pin', { pin: PIN0 }));
    assert.match(old.deviceKey, /^[0-9a-f]{64}$/); assert.equal(old.organizerKey, undefined);
    ok(await DC('set-confirmation', { required: false, pin: PIN0 + ':' + old.deviceKey }), 200); // the old club-wide key keeps working
    assert.equal(ok(await DC('verify-pin', { pin: PIN0, device: true })).shortPin, false);
    await pg.query(`DELETE FROM organizer_devices WHERE club = $1 AND id <> $2 AND id <> $3`, [dcode, A.slice(0, 16), B.slice(0, 16)]);
  });

  await step('phone keys: only the hash is stored; a key works on its own, a wrong secret or a removed id is refused without counting as a wrong PIN', async () => {
    const rows = (await pg.query(`SELECT * FROM organizer_devices WHERE club = $1`, [dcode])).rows;
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes(A.slice(16)) && !JSON.stringify(rows).includes(PIN0), 'the table holds no key and no PIN');
    ok(await DC('set-confirmation', { required: true, pin: ':' + A }));
    const before = await marks();
    const bad = await DC('set-confirmation', { required: true, pin: ':' + A.slice(0, 16) + '0'.repeat(64) });
    assert.equal(bad.status, 403); assert.equal(bad.json.removed, true);
    assert.equal((await DC('set-confirmation', { required: true, pin: ':' + 'f'.repeat(80) })).status, 403);
    assert.equal(await marks(), before, 'a refused key leaves no mark against the network or the club');
    assert.equal((await DC('set-confirmation', { required: true, pin: ':' + A.slice(0, 40) })).status, 403, 'a malformed key is just a wrong PIN');
    assert.equal((await DC('device-list', {})).status, 403, 'strangers cannot list');
  });

  await step('who is an organizer: the list shows linked name, dates and which phone is yours; remove cuts one phone and leaves the rest', async () => {
    const dee = ok(await call(playersApi, 'POST', { body: { code: dcode, action: 'claim', name: 'Dee', ownerToken: downer } })).playerToken;
    const C1 = (await unlock({ playerName: 'Dee', playerToken: dee })).organizerKey;
    const stranger = (await unlock({ playerName: 'Dee', playerToken: 'a'.repeat(48) })).organizerKey; // a token that does not check out: unnamed
    const l = await list({ pin: ':' + A });
    assert.equal(l.length, 4);
    assert.deepEqual(l.map(d => d.name).sort((a, b) => String(a).localeCompare(String(b))), [null, null, null, 'Dee'].sort((a, b) => String(a).localeCompare(String(b))));
    assert.deepEqual(l.filter(d => d.you).map(d => d.id), [A.slice(0, 16)]);
    assert.ok(l.every(d => /^[0-9a-f]{16}$/.test(d.id) && d.createdAt > 0 && d.lastUsedAt >= d.createdAt - 1000));
    assert.ok(!JSON.stringify(l).includes(A.slice(16)), 'ids only, never keys');
    assert.equal(l.find(d => d.name === 'Dee').you, false);
    assert.equal((await list({ ownerToken: downer })).length, 4, 'the creating phone lists too');
    ok(await DC('device-remove', { id: B.slice(0, 16), pin: ':' + A }));
    assert.equal((await DC('set-confirmation', { required: true, pin: ':' + B })).status, 403, 'the removed phone is out at once');
    ok(await DC('set-confirmation', { required: true, pin: ':' + A })); ok(await DC('set-confirmation', { required: true, pin: ':' + C1 }));
    ok(await DC('verify-pin', { pin: PIN0 })); // the PIN itself is untouched, nobody has to change it
    assert.equal((await DC('device-remove', { id: B.slice(0, 16), pin: ':' + A })).status, 404);
    assert.equal((await DC('device-remove', { id: 'zz', pin: ':' + A })).status, 400);
    assert.equal((await DC('device-remove', { id: A.slice(0, 16), pin: ':' + B })).status, 403, 'a removed phone cannot remove another');
    // renaming the linked player follows; anonymising it unnames the phone
    ok(await call(playersApi, 'POST', { body: { code: dcode, action: 'rename', name: 'Dee', newName: 'Dina', ownerToken: downer } }));
    assert.ok((await list({ pin: ':' + A })).some(d => d.name === 'Dina'));
    ok(await DC('device-remove', { id: stranger.slice(0, 16), ownerToken: downer }));
  });

  await step('lock this phone: revokes its own key with only that key, idempotent, and a wrong secret revokes nothing', async () => {
    const D = (await unlock()).organizerKey;
    const before = (await list({ pin: ':' + A })).length;
    ok(await DC('device-lock', { pin: ':' + D.slice(0, 16) + '1'.repeat(64) }));
    assert.equal((await list({ pin: ':' + A })).length, before, 'a wrong secret does not lock anyone');
    ok(await DC('device-lock', { pin: ':' + D }));
    assert.equal((await DC('set-confirmation', { required: true, pin: ':' + D })).status, 403);
    assert.equal((await list({ pin: ':' + A })).length, before - 1);
    ok(await DC('device-lock', { pin: ':' + D })); ok(await DC('device-lock', { pin: PIN0 })); ok(await DC('device-lock', {}));
    // guessing the PIN is paused for the club, but a phone that is locked or unlocked by key still works
    for (let i = 0; i < 25; i++) await DC('verify-pin', { pin: '000000', device: true });
    assert.equal((await DC('verify-pin', { pin: PIN0, device: true })).status, 429);
    ok(await DC('device-lock', { pin: ':' + (await list({ pin: ':' + A })).length })); // junk keys are still accepted quietly
    ok(await DC('set-confirmation', { required: true, pin: ':' + A }));
    await pg.query(`DELETE FROM lookup_fails`);
  });

  await step('upgrade: an old raw PIN or club-wide key trades for a phone key; a PIN change ends every key and gives the changing phone a fresh one', async () => {
    const old = ok(await DC('verify-pin', { pin: PIN0 })).deviceKey;
    const viaKey = ok(await DC('verify-pin', { pin: PIN0 + ':' + old, device: true }));
    const viaPin = ok(await DC('verify-pin', { pin: PIN0, device: true }));
    assert.ok(viaKey.organizerKey && viaPin.organizerKey);
    const NEW = '735190';
    const changed = ok(await DC('set-pin', { pin: NEW, oldPin: ':' + viaKey.organizerKey, device: true }));
    assert.match(changed.organizerKey, /^[0-9a-f]{80}$/);
    for (const k of [A, viaKey.organizerKey, viaPin.organizerKey]) assert.equal((await DC('set-confirmation', { required: true, pin: ':' + k })).status, 403);
    assert.equal((await DC('set-confirmation', { required: true, pin: PIN0 + ':' + old })).status, 403, 'the club-wide key ends with the old PIN');
    ok(await DC('set-confirmation', { required: true, pin: ':' + changed.organizerKey }));
    assert.equal((await list({ pin: ':' + changed.organizerKey })).length, 1);
    A = changed.organizerKey;
  });

  await step('phone keys: capped per club (the club-wide key is the fallback), long-unused phones are forgotten', async () => {
    const PIN1 = '735190';
    let issued = 1, last;
    for (let i = 0; i < 30 && issued < 25; i++) { last = ok(await DC('verify-pin', { pin: PIN1, device: true })); if (last.organizerKey) issued++; }
    const over = ok(await DC('verify-pin', { pin: PIN1, device: true }));
    assert.equal(over.organizerKey, undefined); assert.match(over.deviceKey, /^[0-9a-f]{64}$/, 'a full club still unlocks the phone, with the club-wide key');
    assert.equal((await list({ pin: ':' + A })).length, 25);
    await pg.query(`UPDATE organizer_devices SET last_used_at = now() - interval '181 days' WHERE club = $1 AND id <> $2`, [dcode, A.slice(0, 16)]);
    assert.ok(ok(await DC('verify-pin', { pin: PIN1, device: true })).organizerKey);
    assert.equal((await list({ pin: ':' + A })).length, 2, 'the stale phones were forgotten');
  });

  await step('phone keys: every unlock, removal, lock and PIN change is in the club history, with ids and names but no key or PIN', async () => {
    const rows = (await pg.query(`SELECT actor, actor_name, action, target, detail FROM club_audit WHERE club = $1 ORDER BY id`, [dcode])).rows;
    const kinds = new Set(rows.map(r => r.action));
    for (const a of ['device-unlock', 'device-remove', 'device-lock', 'pin-change']) assert.ok(kinds.has(a), a + ' is logged');
    const s = JSON.stringify(rows);
    assert.ok(!/[0-9a-f]{80}/.test(s) && !s.includes('482913') && !s.includes('735190') && !/[0-9a-f]{64}/.test(s.replace(/"device":"[0-9a-f]{16}"/g, '')), 'no key or PIN in the log');
    assert.ok(rows.some(r => r.action === 'device-unlock' && r.target === 'Dee' || r.target === 'Dina'));
    assert.equal(rows.find(r => r.action === 'pin-change').detail.phonesRemoved >= 1, true);
    const hist = ok(await call(playersApi, 'POST', { body: { code: dcode, action: 'members', ownerToken: downer } })).audit;
    assert.ok(hist.some(e => e.action === 'device-remove'), 'organizers read it in the member history');
  });

  await step('phone keys: the table is additive and cascades from the club', async () => {
    const [fk] = (await pg.query(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'organizer_devices'::regclass AND contype = 'f'`)).rows;
    assert.equal(fk.confdeltype, 'c');
  });
}

console.log(`\n${passed} API checks passed against a throwaway in-memory Postgres.`);
server.close(); await pg.close(); process.exit(0);
