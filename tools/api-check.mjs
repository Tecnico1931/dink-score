// Runs the club API against a throwaway in-memory Postgres (PGlite) instead of Neon, so the SQL in api/*.js can be
// checked without touching any real database. It answers the Neon driver's SQL-over-HTTP calls on a local port.
//   npm ci && npm i --no-save @electric-sql/pglite && node tools/api-check.mjs
// Nothing is read from .env files or the environment: the connection string below is a made-up local one.
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

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
const [club, roster, games, events, shop, bracket, live] = await Promise.all(['club', 'roster', 'games', 'events', 'shop', 'bracket', 'live'].map(load));
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
  const r = ok(await call(events, 'POST', { body: { code, action: 'result', ...body } }));
  assert.equal(r.event.rounds[0].matches[0].status, 'done');
  let g = await clubGames();
  assert.equal(g.length, 1);
  assert.equal(g[0].id, `${ev.id}-${m.id}`);
  assert.equal(g[0].event.id, ev.id);
  assert.equal(g[0].logged, false);
  ok(await call(events, 'POST', { body: { code, action: 'result', ...body } })); // a phone retrying
  assert.equal((await clubGames()).length, 1, 'a retry does not add a second game');
  const other = await call(events, 'POST', { body: { code, action: 'result', ...body, score: [3, 11] } });
  assert.equal(other.status, 409);
  assert.equal((await clubGames()).length, 1);
});
await step('two phones scoring different courts at the same moment both land', async () => {
  const [a, b] = ev.rounds[0].matches;
  const second = ev.rounds[0].matches[1];
  const [r1, r2] = await Promise.all([
    call(events, 'POST', { body: { code, action: 'result', id: ev.id, matchId: second.id, score: [11, 9], endedAt: Date.now() } }),
    call(events, 'POST', { body: { code, action: 'result', id: ev.id, matchId: a.id, score: [11, 6], endedAt: Date.now() } })
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
  assert.equal((await call(events, 'POST', { body: { code, action: 'result', id: m.id, matchId: 'r1m1', score: [11, 1] } })).status, 409);
  ok(await act('publish-round', { id: m.id, round: 1 }));
  ok(await call(events, 'POST', { body: { code, action: 'result', id: m.id, matchId: 'r1m1', score: [11, 1], endedAt: Date.now() } }));
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
    cur = ok(await call(events, 'POST', { body: { code, action: 'result', id: b.id, matchId: next.id, score: [11, 4], endedAt: Date.now() } })).event; played++;
  }
  assert.equal(cur.status, 'done'); assert.equal(played, 3); assert.equal(cur.champion.length, 2);
  assert.equal((await clubGames()).length, before + 3);
  assert.equal((await call(events, 'POST', { body: { code, action: 'result', id: b.id, matchId: 'W1-0', score: [1, 11] } })).status, 409);
});
await step('pool play then knockout through the API', async () => {
  const p = ok(await create({ name: 'Pool', format: 'pool_knockout', rotation: 'auto', courts: 2, players, rounds: 3, advance: 2, seed: 'pool' }), 201).event;
  let cur = p;
  for (let r = 1; r <= 3; r++) {
    for (const m of cur.rounds[r - 1].matches) cur = ok(await call(events, 'POST', { body: { code, action: 'result', id: p.id, matchId: m.id, score: [11, 7], endedAt: Date.now() } })).event;
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
  for (const secret of [code, owner, 'SECRET-SEED', 'ownerToken', 'pin_hash', 'owner_hash', 'purchases', 'shop', 'claim', 'Another club event', e.id]) assert.ok(!text.includes(secret), 'leaked ' + secret);
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
  ok(await call(events, 'POST', { body: { code, action: 'result', id: e.id, matchId: m.id, score: [11, 2], endedAt: Date.now() } }));
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
const PIN = '4821';
ok(await call(club, 'POST', { body: { code, action: 'set-pin', pin: PIN, ownerToken: owner } }));
const sh = (body) => call(shop, 'POST', { body: { code, ...body } });
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


await step('watch scoring: publish, point and undo intents, ack clears them, end removes the game', async () => {
  const st = { cfg: { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, teams: [['Ana', 'Ben'], ['Cy', 'Di']] }, score: [0, 0], serving: 0, serverNum: 2, server: 0, rallies: 0, winner: null, startedAt: 123 };
  let r = await call(live, 'POST', { body: { code, action: 'point', side: 0 } });
  assert.equal(r.status, 404, 'no live game yet');
  ok(await call(live, 'POST', { body: { code, action: 'state', id: 'live-t1', state: st, ack: 0 } }));
  r = ok(await call(live, 'POST', { body: { code, action: 'point', side: 1 } }));
  assert.equal(r.pending, 1);
  assert.deepEqual(r.score, [0, 0], 'an intent does not change the published score by itself');
  ok(await call(live, 'POST', { body: { code, action: 'undo' } }));
  const got = ok(await call(live, 'GET', { query: '?code=' + code + '&id=live-t1' }));
  assert.equal(got.intents.length, 2);
  assert.equal(got.intents[0].kind, 'point'); assert.equal(got.intents[0].side, 1);
  assert.equal(got.intents[1].kind, 'undo');
  ok(await call(live, 'POST', { body: { code, action: 'state', id: 'live-t1', state: { ...st, score: [0, 1] }, ack: got.intents[1].n } }));
  const got2 = ok(await call(live, 'GET', { query: '?code=' + code + '&id=live-t1' }));
  assert.equal(got2.intents.length, 0, 'acked intents are gone');
  assert.deepEqual(got2.state.score, [0, 1]);
  ok(await call(live, 'POST', { body: { code, action: 'end', id: 'live-t1' } }));
  r = await call(live, 'POST', { body: { code, action: 'point', side: 0 } });
  assert.equal(r.status, 404, 'the game ended, so points bounce off');
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

console.log(`\n${passed} API checks passed against a throwaway in-memory Postgres.`);
server.close(); await pg.close(); process.exit(0);
