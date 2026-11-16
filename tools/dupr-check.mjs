// Runs the DUPR API (api/dupr.js) against a throwaway in-memory Postgres (PGlite) and a LOCAL MOCK of DUPR
// (tools/dupr-mock.mjs). No real DUPR host, credential or database is touched.
//   npm ci && npm i --no-save @electric-sql/pglite && node tools/dupr-check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMock, KEY, SECRET } from './dupr-mock.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { console.error('Install the test database first: npm i --no-save @electric-sql/pglite'); process.exit(2); }
const neon = await import('@neondatabase/serverless');

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
delete process.env.DUPR_CLIENT_KEY; delete process.env.DUPR_CLIENT_SECRET; delete process.env.DUPR_ENV;

const load = async name => (await import(pathToFileURL(path.join(root, 'api', name + '.js')).href)).default;
const [club, games, events, playersApi, dupr] = await Promise.all(['club', 'games', 'events', 'players', 'dupr'].map(load));
const { __test } = await import(pathToFileURL(path.join(root, 'api', '_duprapi.js')).href);
let ip = 0;
async function call(handler, method, { query = '', body, headers = {} } = {}) {
  const req = { method, url: '/api/x' + query, headers: { 'x-real-ip': '10.1.0.' + (++ip % 250), ...headers }, body };
  let status = 0, text = '';
  const res = { statusCode: 0, setHeader() {}, end(t) { status = res.statusCode; text = t; } };
  await handler(req, res);
  return { status, json: JSON.parse(text), text };
}
const ok = (r, want = 200) => { assert.equal(r.status, want, r.text); return r.json; };
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('ok  ' + name); };
const tableExists = async n => (await pg.query('SELECT to_regclass($1) AS t', [n])).rows[0].t !== null;
const dbRows = async (sqlText, params = []) => (await pg.query(sqlText, params)).rows;

const created = ok(await call(club, 'POST', { body: { name: 'DUPR check club' } }), 201);
const code = created.club.code, owner = created.ownerToken;
const names = ['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal'];
const gamesBefore = async () => ok(await call(club, 'GET', { query: '?code=' + code })).games;

// ---------- switched off ----------
await step('without keys everything is inert: {enabled:false}, no tables, no other API changes', async () => {
  assert.deepEqual(ok(await call(dupr, 'GET', { query: '?code=' + code })), { enabled: false });
  assert.equal((await call(dupr, 'POST', { body: { code, action: 'link' } })).status, 404);
  assert.equal(await tableExists('dupr_matches'), false);
  assert.equal(await tableExists('dupr_state'), false);
  const cols = (await dbRows("SELECT column_name FROM information_schema.columns WHERE table_name = 'roster'")).map(r => r.column_name);
  assert.ok(!cols.includes('dupr_id'));
  const c = ok(await call(club, 'GET', { query: '?code=' + code }));
  assert.ok(!JSON.stringify(c).includes('loginUrl'));
});

// ---------- switched on, against the mock ----------
const mock = await startMock();
process.env.DUPR_CLIENT_KEY = KEY; process.env.DUPR_CLIENT_SECRET = SECRET; process.env.DUPR_ENV = 'uat';
__test.set({ hosts: mock.hosts, sleep: async () => {} });
const st = mock.state;
names.forEach((n, i) => st.addUser(`sso-token-${n.toLowerCase()}-0000000`, `${n.toUpperCase()}00${i + 1}`, { doubles: (3 + i / 10).toFixed(3), singles: '3.610' }));
const tok = n => `sso-token-${n.toLowerCase()}-0000000`;
const id = n => `${n.toUpperCase()}00${names.indexOf(n) + 1}`;
const D = (action, extra = {}, creds = { ownerToken: owner }) => call(dupr, 'POST', { body: { code, action, ...extra, ...creds } });

let ev, anaToken, benToken;
await step('config: the browser gets the login iframe URL and no secret', async () => {
  const cfg = ok(await call(dupr, 'GET', { query: '?code=' + code }));
  assert.equal(cfg.enabled, true); assert.equal(cfg.loginOrigin, mock.origin);
  assert.equal(cfg.loginUrl, `${mock.origin}/sso/login-external-app/${encodeURIComponent(Buffer.from(KEY).toString('base64'))}`);
  assert.ok(!JSON.stringify(cfg).includes(SECRET));
  assert.equal((await call(dupr, 'GET', { query: '?code=ZZZZZZ' })).status, 404);
  assert.ok(await tableExists('dupr_matches'));
});

await step('set up an 8 player rotating event and claim two names', async () => {
  ev = ok(await call(events, 'POST', { body: { code, action: 'create', ownerToken: owner, event: { name: 'Sunday rotation', format: 'roundrobin', rotation: 'auto', courts: 2, players: names, seed: 'dupr' } } }), 201).event;
  anaToken = ok(await call(playersApi, 'POST', { body: { code, action: 'claim', name: 'Ana' } })).playerToken;
  benToken = ok(await call(playersApi, 'POST', { body: { code, action: 'claim', name: 'Ben' } })).playerToken;
});

await step('link: only the claiming phone or an organizer, verified with DUPR, tokens never kept', async () => {
  const L = (extra, creds = {}) => call(dupr, 'POST', { body: { code, action: 'link', ...extra, ...creds } });
  assert.equal((await L({ playerName: 'Ana', userToken: tok('Ana') }, { playerToken: benToken })).status, 403, "Ben's phone can't link Ana");
  assert.equal((await L({ playerName: 'Ana', userToken: 'short' }, { playerToken: anaToken })).status, 400);
  assert.equal((await L({ playerName: 'Ana', userToken: 'sso-unknown-token-0000000' }, { playerToken: anaToken })).status, 502, 'DUPR rejects the token');
  const r = ok(await L({ playerName: 'Ana', userToken: tok('Ana') }, { playerToken: anaToken }));
  assert.equal(r.linked, true); assert.equal(r.duprId, id('Ana')); assert.equal(r.snapshot.rating.doubles, 3); assert.equal(r.basic, true);
  assert.ok(!r.snapshot.duprId);
  const row = (await dbRows("SELECT dupr_id, dupr_snapshot FROM roster WHERE name_key = 'ana'"))[0];
  assert.equal(row.dupr_id, id('Ana'));
  const stored = JSON.stringify(row) + JSON.stringify(await dbRows('SELECT * FROM dupr_matches'));
  assert.ok(!stored.includes(tok('Ana')) && !stored.includes('r-' + tok('Ana')), 'no user token is stored');
  // a client-supplied duprId is ignored: the server asks DUPR
  ok(await L({ playerName: 'Ben', userToken: tok('Ben'), duprId: 'ANA001' }, { playerToken: benToken }));
  assert.equal((await dbRows("SELECT dupr_id FROM roster WHERE name_key = 'ben'"))[0].dupr_id, id('Ben'));
});

await step('a DUPR account already linked to another name in the club is refused', async () => {
  const r = await call(dupr, 'POST', { body: { code, action: 'link', playerName: 'Cy', userToken: tok('Ana'), ownerToken: owner } });
  assert.equal(r.status, 409); assert.match(r.json.error, /already linked to Ana/);
  assert.equal((await dbRows("SELECT dupr_id FROM roster WHERE name_key = 'cy'"))[0].dupr_id, null);
});

await step('relinking the same account is fine; unlink clears it; consent revoked asks to connect again', async () => {
  ok(await call(dupr, 'POST', { body: { code, action: 'link', playerName: 'Ana', userToken: tok('Ana'), playerToken: anaToken } }));
  ok(await call(dupr, 'POST', { body: { code, action: 'unlink', playerName: 'Ana', playerToken: anaToken } }));
  assert.deepEqual((await dbRows("SELECT dupr_id, dupr_linked_at, dupr_snapshot FROM roster WHERE name_key = 'ana'"))[0], { dupr_id: null, dupr_linked_at: null, dupr_snapshot: null });
  assert.equal((await call(dupr, 'POST', { body: { code, action: 'unlink', playerName: 'Ana', playerToken: benToken } })).status, 403);
  st.users.get(tok('Ana')).consent = false;
  const r = await call(dupr, 'POST', { body: { code, action: 'link', playerName: 'Ana', userToken: tok('Ana'), playerToken: anaToken } });
  assert.equal(r.status, 409); assert.match(r.json.error, /Connect DUPR again/);
  st.users.get(tok('Ana')).consent = true;
  ok(await call(dupr, 'POST', { body: { code, action: 'link', playerName: 'Ana', userToken: tok('Ana'), playerToken: anaToken } }));
});

await step('the club listing shows ratings to members, never DUPR ids; club and events APIs carry no DUPR data', async () => {
  const g = ok(await call(dupr, 'GET', { query: '?code=' + code }));
  assert.equal(g.players.ana.rating.doubles, 3); assert.equal(g.players.ben.rating.doubles, 3.1);
  assert.ok(!JSON.stringify(g).includes('ANA001'));
  const blob = JSON.stringify(ok(await call(club, 'GET', { query: '?code=' + code }))) + JSON.stringify(ok(await call(events, 'GET', { query: `?code=${code}&id=${ev.id}` })));
  assert.ok(!/ANA001|dupr_id|loginUrl/.test(blob));
});

await step('refresh: cached for 15 minutes, then reads DUPR; a lost connection asks to relink', async () => {
  const R = n => call(dupr, 'POST', { body: { code, action: 'refresh', playerName: n } });
  assert.equal(ok(await R('Ana')).cached, true);
  st.ratings.set(id('Ana'), { doubles: '3.987', singles: '3.700' });
  await pg.query("UPDATE roster SET dupr_snapshot = jsonb_set(dupr_snapshot, '{at}', to_jsonb((extract(epoch from now()) * 1000)::bigint - 3600000)) WHERE name_key = 'ana'");
  const r = ok(await R('Ana'));
  assert.equal(r.cached, false); assert.equal(r.snapshot.rating.doubles, 3.987); assert.equal(r.snapshot.rating.singles, 3.7);
  st.connected.delete(id('Ana')); // the player disconnected from this app on DUPR: user detail answers 403
  await pg.query("UPDATE roster SET dupr_snapshot = jsonb_set(dupr_snapshot, '{at}', to_jsonb(0)) WHERE name_key = 'ana'");
  assert.equal(ok(await R('Ana')).needsRelink, true);
  assert.equal(ok(await call(dupr, 'GET', { query: '?code=' + code })).players.ana.needsRelink, true);
  st.connected.add(id('Ana'));
  assert.equal((await R('Zed')).status, 404);
  // ratings never feed the app's own numbers
  assert.ok(!JSON.stringify(ok(await call(club, 'GET', { query: '?code=' + code })).progress).includes('3.987'));
});

// ---------- sending ----------
const score = async (event, matchId, s, extra = {}) => ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: event.id, matchId, score: s, endedAt: Date.now(), ...extra } })).event;
const fresh = async () => ok(await call(events, 'GET', { query: `?code=${code}&id=${ev.id}` })).event;
let gameCount;

await step('review lists every finished match as ready or blocked with the reason; organizer only', async () => {
  ev = await score(ev, ev.rounds[0].matches[0].id, [11, 5]);
  ev = await score(ev, ev.rounds[0].matches[1].id, [11, 9]);
  assert.equal((await D('review', { id: ev.id }, {})).status, 403);
  const r = ok(await D('review', { id: ev.id }));
  assert.equal(r.items.length, 2);
  assert.ok(r.items.every(i => i.state === 'blocked' && i.reasons[0].code === 'unlinked'));
  const unlinked = r.items[0].reasons[0].players;
  assert.ok(unlinked.length >= 1 && !unlinked.includes('Ana') && !unlinked.includes('Ben'));
  assert.ok(!r.items[0].reasons[0].text.includes('00'), 'no DUPR ids in the review');
  assert.equal(r.paused, null);
  gameCount = (await gamesBefore()).length;
});

await step('link the rest (an organizer can link on a player\'s behalf); a tie or a winner under 6 stays blocked', async () => {
  for (const n of names.slice(2)) ok(await call(dupr, 'POST', { body: { code, action: 'link', playerName: n, userToken: tok(n), ownerToken: owner } }));
  ev = await fresh();
  const next = ok(await call(events, 'POST', { body: { code, action: 'next-round', id: ev.id, ownerToken: owner } })).event;
  ev = await score(next, next.rounds[1].matches[0].id, [4, 2]);
  ev = await score(ev, ev.rounds[1].matches[1].id, [11, 3]);
  const r = ok(await D('review', { id: ev.id }));
  const by = Object.fromEntries(r.items.map(i => [i.matchId, i]));
  assert.equal(by[ev.rounds[0].matches[0].id].state, 'ready');
  assert.equal(by[ev.rounds[0].matches[1].id].state, 'ready');
  const low = by[ev.rounds[1].matches[0].id];
  assert.equal(low.state, 'blocked'); assert.equal(low.reasons[0].code, 'low-score');
  assert.equal(by[ev.rounds[1].matches[1].id].state, 'ready');
  assert.deepEqual(r.summary, { ready: 3, blocked: 1, sent: 0, failed: 0, skipped: 0 });
  assert.deepEqual(r.rounds, ['Round 1', 'Round 2']);
  assert.equal(st.live().length, 0, 'reviewing sends nothing');
});

await step('sending needs an explicit confirm and the organizer; it sends only the ready matches', async () => {
  assert.equal((await D('send', { id: ev.id })).status, 400);
  assert.equal((await D('send', { id: ev.id, confirm: true }, {})).status, 403);
  assert.equal(st.live().length, 0);
  const r = ok(await D('send', { id: ev.id, confirm: true, tz: 'UTC' }));
  assert.equal(r.results.created, 3); assert.equal(st.live().length, 3);
  assert.equal(st.calls.filter(c => c.path === '/api/match/v1.0/batch').length, 1, 'one batch call');
  const row = (await dbRows("SELECT * FROM dupr_matches ORDER BY game_id"))[0];
  assert.equal(row.status, 'sent'); assert.match(row.match_code, /^\d{10}$/); assert.match(row.identifier, new RegExp(`^dink-${code}-${ev.id}-r\\dm\\d-r1$`));
  const sentBody = st.live()[0].body;
  assert.equal(sentBody.format, 'DOUBLES'); assert.equal(sentBody.matchSource, 'PARTNER'); assert.equal(sentBody.event, 'Sunday rotation'); assert.equal(sentBody.matchCompletionType, 'COMPLETED');
  assert.equal(sentBody.matchPlayType, 'RECREATIONAL'); assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(sentBody.matchDate));
  assert.equal(r.summary.sent, 3); assert.equal(r.summary.ready, 0);
  assert.equal(JSON.stringify(r).includes(SECRET), false);
  assert.equal((await gamesBefore()).length, gameCount + 2, 'sending never touches the club games');
});

await step('sending again creates nothing new (no duplicates at DUPR)', async () => {
  const r = ok(await D('send', { id: ev.id, confirm: true }));
  assert.deepEqual([r.results.created, r.results.updated, r.results.deleted], [0, 0, 0]);
  assert.equal(st.live().length, 3);
  assert.equal(st.calls.filter(c => c.path === '/api/match/v1.0/batch').length, 1);
});

await step('a score fixed after sending is sent as an update with DUPR\'s match code; nothing is duplicated', async () => {
  ev = await fresh();
  const m = ev.rounds[0].matches[0];
  ok(await call(events, 'POST', { body: { code, action: 'correct', id: ev.id, matchId: m.id, score: [11, 8], ownerToken: owner } }));
  const r1 = ok(await D('review', { id: ev.id }));
  const it = r1.items.find(i => i.matchId === m.id);
  assert.deepEqual([it.state, it.action], ['ready', 'update']);
  const before = st.tokenCalls; st.expireTokenNow();
  const r = ok(await D('send', { id: ev.id, confirm: true }));
  assert.equal(r.results.updated, 1); assert.equal(st.tokenCalls, before + 1, 'token renewed after expiring');
  assert.equal(st.live().length, 3);
  const updated = st.live().find(x => x.body.identifier.includes(`-${m.id}-r`)).body;
  assert.deepEqual([updated.teamA.game1, updated.teamB.game1], [11, 8]);
  assert.ok(st.calls.find(c => c.path === '/api/match/v1.0/update'));
});

await step('deleting a game removes it from DUPR (identifier burned); restoring sends a new revision', async () => {
  const m = (await fresh()).rounds[0].matches[1], gid = `${ev.id}-${m.id}`;
  ok(await call(games, 'DELETE', { query: `?code=${code}&id=${encodeURIComponent(gid)}`, headers: { 'x-club-owner': owner } }));
  const it = ok(await D('review', { id: ev.id })).items.find(i => i.gameId === gid);
  assert.deepEqual([it.state, it.action], ['ready', 'delete']);
  const r = ok(await D('send', { id: ev.id, confirm: true }));
  assert.equal(r.results.deleted, 1); assert.equal(st.live().length, 2);
  assert.equal((await dbRows('SELECT status FROM dupr_matches WHERE game_id = $1', [gid]))[0].status, 'deleted');
  assert.equal(ok(await D('review', { id: ev.id })).items.find(i => i.gameId === gid).state, 'skipped');
  ok(await call(games, 'POST', { body: { code, restore: gid, ownerToken: owner } }));
  const again = ok(await D('review', { id: ev.id })).items.find(i => i.gameId === gid);
  assert.deepEqual([again.state, again.action], ['ready', 'create']);
  const r2 = ok(await D('send', { id: ev.id, confirm: true }));
  assert.equal(r2.results.created, 1); assert.equal(st.live().length, 3);
  const row = (await dbRows('SELECT revision, identifier, status FROM dupr_matches WHERE game_id = $1', [gid]))[0];
  assert.deepEqual([row.revision, row.status, row.identifier.endsWith('-r2')], [2, 'sent', true]);
});

// ---------- failures ----------
let ev2;
await step('partial batch failure: DUPR refuses one match, the rest go through, the refused one is failed with the reason', async () => {
  ev2 = ok(await call(events, 'POST', { body: { code, action: 'create', ownerToken: owner, event: { name: 'Second', format: 'roundrobin', rotation: 'auto', courts: 2, players: names, seed: 'two' } } }), 201).event;
  const ms = ev2.rounds[0].matches;
  ev2 = ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: ev2.id, matchId: ms[0].id, score: [11, 5], endedAt: Date.now() } })).event;
  ev2 = ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: ev2.id, matchId: ms[1].id, score: [11, 3], endedAt: Date.now() } })).event;
  const lost = ev2.rounds[0].matches[1].teams.flat()[0];
  st.ratings.delete(id(lost)); // DUPR no longer knows this player
  const r = ok(await D('send', { id: ev2.id, confirm: true }));
  assert.equal(r.results.created, 1); assert.equal(r.results.failed, 1);
  const bad = r.items.find(i => i.matchId === ms[1].id);
  assert.equal(bad.state, 'failed'); assert.match(bad.note, /Unknown DUPR player/);
  // not retried automatically; retryFailed asks again (and fails again for the same reason)
  assert.equal(ok(await D('send', { id: ev2.id, confirm: true })).results.failed, 0);
  st.ratings.set(id(lost), { doubles: '3.000', singles: '3.000' });
  const r2 = ok(await D('send', { id: ev2.id, confirm: true, retryFailed: true }));
  assert.equal(r2.results.created, 1); assert.equal(r2.summary.sent, 2);
});

let ev3;
const newEvent = async (name, seed, n = 2) => {
  let e = ok(await call(events, 'POST', { body: { code, action: 'create', ownerToken: owner, event: { name, format: 'roundrobin', rotation: 'auto', courts: 2, players: names, seed } } }), 201).event;
  for (const m of e.rounds[0].matches.slice(0, n)) e = ok(await call(events, 'POST', { body: { code, action: 'result', ownerToken: owner, id: e.id, matchId: m.id, score: [11, 4], endedAt: Date.now() } })).event;
  return e;
};
await step('retryable failures (500, 429, dropped connection) keep the match pending and retry with the same identifier, once', async () => {
  ev3 = await newEvent('Third', 'three');
  st.serverError = 3; // every attempt of this send fails
  let r = ok(await D('send', { id: ev3.id, confirm: true }));
  assert.equal(r.results.created, 0); assert.equal(r.results.retryLater, 2);
  const pending = await dbRows("SELECT identifier, status FROM dupr_matches WHERE game_id LIKE $1 ORDER BY game_id", [ev3.id + '-%']);
  assert.deepEqual(pending.map(p => p.status), ['pending', 'pending']);
  st.rateLimit = 1; // one 429, retried inside the call
  r = ok(await D('send', { id: ev3.id, confirm: true }));
  assert.equal(r.results.created, 2); assert.equal(st.live().filter(x => x.body.event === 'Third').length, 2);
  const after = await dbRows("SELECT identifier, status FROM dupr_matches WHERE game_id LIKE $1 ORDER BY game_id", [ev3.id + '-%']);
  assert.deepEqual(after.map(p => p.identifier), pending.map(p => p.identifier), 'same identifiers');
});

await step('a lost reply never duplicates at DUPR: the retry finds the match already there and records it without a code', async () => {
  const e = await newEvent('Fourth', 'four');
  st.dropAfterCommit = 1; // DUPR commits the batch, then the connection is cut
  const r = ok(await D('send', { id: e.id, confirm: true }));
  assert.equal(st.live().filter(x => x.body.event === 'Fourth').length, 2, 'exactly one copy at DUPR');
  assert.equal(r.results.alreadyAtDupr, 2); assert.equal(r.results.created, 0);
  const rows = await dbRows("SELECT status, match_code, error FROM dupr_matches WHERE game_id LIKE $1", [e.id + '-%']);
  assert.ok(rows.every(x => x.status === 'sent' && x.match_code === null && /not saved/.test(x.error)));
  const items = r.items;
  assert.ok(items.every(i => i.state === 'sent'));
  // a later score fix can't be sent (no match code): blocked with an explanation, never a duplicate
  const m = e.rounds[0].matches[0];
  ok(await call(events, 'POST', { body: { code, action: 'correct', id: e.id, matchId: m.id, score: [11, 9], ownerToken: owner } }));
  const it = ok(await D('review', { id: e.id })).items.find(i => i.matchId === m.id);
  assert.equal(it.state, 'blocked'); assert.equal(it.reasons[0].code, 'code-lost');
});

await step('two phones pressing Send at once send each match once', async () => {
  const e = await newEvent('Fifth', 'five');
  const [a, b] = await Promise.all([D('send', { id: e.id, confirm: true }), D('send', { id: e.id, confirm: true })]);
  ok(a); ok(b);
  assert.equal(st.live().filter(x => x.body.event === 'Fifth').length, 2);
  assert.equal(a.json.results.created + b.json.results.created, 2);
  assert.equal(a.json.results.busy + b.json.results.busy >= 0, true);
});

await step('403 or 417 pauses all sending, then lifts after the cool-off; secrets never appear in answers', async () => {
  const e = await newEvent('Sixth', 'six');
  st.deny = 403;
  let r = ok(await D('send', { id: e.id, confirm: true }));
  assert.ok(r.paused && /403/.test(r.paused.reason) && r.results.created === 0 && r.results.retryLater === 2);
  const again = await D('send', { id: e.id, confirm: true });
  assert.equal(again.status, 503); assert.match(again.json.error, /paused/);
  assert.ok(ok(await D('review', { id: e.id })).paused);
  assert.ok(ok(await call(dupr, 'GET', { query: '?code=' + code })).paused);
  const calls = st.calls.length;
  await D('send', { id: ev.id, confirm: true });
  assert.equal(st.calls.length, calls, 'nothing is sent to DUPR while paused (other events too)');
  assert.equal(st.live().filter(x => x.body.event === 'Sixth').length, 0);
  // 417 is its own message
  await pg.query("UPDATE dupr_state SET at = now() - interval '2 hours'");
  st.deny = 417;
  r = ok(await D('send', { id: e.id, confirm: true }));
  assert.match(r.paused.reason, /expired \(417\)/);
  assert.ok(!JSON.stringify([r, again.json]).includes(SECRET));
  await pg.query("UPDATE dupr_state SET at = now() - interval '2 hours'");
  st.deny = null;
  r = ok(await D('send', { id: e.id, confirm: true }));
  assert.equal(r.results.created, 2); assert.equal(r.paused, null);
});

await step('only matches the organizer picks are sent (a round at a time)', async () => {
  const e = await newEvent('Seventh', 'seven');
  const pick = e.rounds[0].matches[0].id;
  const r = ok(await D('send', { id: e.id, confirm: true, matchIds: [pick] }));
  assert.equal(r.results.created, 1);
  assert.equal(r.items.filter(i => i.state === 'sent').length, 1); assert.equal(r.summary.ready, 1);
});

await step('the keys never reach logs, rows or answers', async () => {
  const dump = JSON.stringify(await dbRows('SELECT * FROM dupr_matches')) + JSON.stringify(await dbRows('SELECT * FROM dupr_state')) + JSON.stringify(await dbRows('SELECT dupr_id, dupr_snapshot FROM roster'));
  for (const s of [SECRET, KEY, ...names.map(tok)]) assert.ok(!dump.includes(s), 'secret in database');
  const partnerCalls = st.calls.filter(c => c.path.startsWith('/api/') && c.path !== '/api/auth/v1.0/token');
  assert.ok(partnerCalls.every(c => /^Bearer partner-\d+$/.test(c.auth)), 'partner calls use the partner token only');
  const userCalls = st.calls.filter(c => !c.path.startsWith('/api/'));
  assert.ok(userCalls.every(c => /^Bearer sso-/.test(c.auth)), 'user calls use the user token only');
});

console.log(`\n${passed} DUPR API checks passed against a throwaway in-memory Postgres and a local mock DUPR.`);
await mock.close(); server.close(); await pg.close(); process.exit(0);
