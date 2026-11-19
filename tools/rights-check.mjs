// Data rights against a throwaway in-memory Postgres (PGlite): a player exports or anonymises their own data, an organizer exports
// the club and deletes it (with an undo window), and who is allowed to do each. Same harness as api-check.mjs; no real database.
//   npm ci && npm i --no-save @electric-sql/pglite && node tools/rights-check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { console.error('Install the test database first: npm i --no-save @electric-sql/pglite'); process.exit(2); }
const neon = await import('@neondatabase/serverless');

const pg = new PGlite();
const TEXT_OIDS = [16, 20, 21, 23, 25, 700, 701, 1043, 1082, 1114, 1184, 1700, 114, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map(o => [o, v => v]));
async function run(q) {
  const r = await pg.query(q.query, q.params || [], { rowMode: 'array', parsers });
  return { command: 'SELECT', rowCount: r.rows.length, rows: r.rows, fields: r.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID, tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })) };
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
const [club, games, events, players, live] = await Promise.all(['club', 'games', 'events', 'players', 'live'].map(load));
let ip = 0;
async function raw(handler, method, { query = '', body, headers = {} } = {}) {
  const req = { method, url: '/api/x' + query, headers: { 'x-real-ip': '10.1.0.' + (++ip % 200), ...headers }, body };
  const out = { status: 0, text: '', headers: {} };
  const res = { statusCode: 0, setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, end(t) { out.status = res.statusCode; out.text = t; } };
  await handler(req, res);
  return out;
}
const call = async (...a) => { const r = await raw(...a); return { status: r.status, json: JSON.parse(r.text) }; };
const ok = (r, want = 200) => { assert.equal(r.status, want, JSON.stringify(r.json)); return r.json; };

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('ok  ' + name); };

// A club with an organizer PIN, four claimed players, a guest, games, an event and a DUPR-style reference.
const PIN = '246810';
const created = ok(await call(club, 'POST', { body: { name: 'Rights check club', pin: PIN } }), 201);
const code = created.club.code, owner = created.ownerToken, ORG = { ownerToken: owner };
const names = ['Ana', 'Ben', 'Cy', 'Di'];
const tok = {};
for (const n of names) tok[n] = ok(await call(players, 'POST', { body: { code, action: 'claim', name: n, ...ORG } })).playerToken;
const P = (action, body) => call(players, 'POST', { body: { code, action, ...body } });
const C = (action, body) => call(club, 'POST', { body: { code, action, ...body } });
const t0 = Date.now() - 3600e3;
const gm = (id, teams, score, i) => ({ id, mode: 'doubles', teams, score, endedAt: t0 + i * 1000, startedAt: t0 + i * 1000 - 600e3 });
ok(await call(games, 'POST', { body: { code, games: [
  gm('g-one', [['Ana', 'Ben'], ['Cy', 'Di']], [11, 7], 1), gm('g-two', [['Ana', 'Cy'], ['Ben', 'Di']], [9, 11], 2),
  gm('g-three', [['Ben', 'Cy'], ['Di', 'Gus']], [11, 4], 3), gm('g-four', [['=SUM(1+1)', 'Gus'], ['Ben', 'Cy']], [11, 6], 4)] } }));
const ev = ok(await call(events, 'POST', { body: { code, action: 'create', ...ORG, event: { name: 'Friday round robin', format: 'roundrobin', rotation: 'auto', courts: 1, players: ['Ana', 'Ben', 'Cy', 'Di'], seed: 'r' } } }), 201).event;
ok(await call(events, 'POST', { body: { code, action: 'league-create', ...ORG, league: { kind: 'ladder', name: 'Ladder', mode: 'singles', players: ['Ana', 'Ben', 'Cy', 'Di'] } } }), 201);
await pg.query(`UPDATE events SET refs = '{"Ana":"1234567","Ben":"7654321"}'::jsonb WHERE club = (SELECT code FROM clubs LIMIT 1)`);
await pg.query(`UPDATE roster SET avatar = '{"type":"emoji","value":"🔥"}'::jsonb, dupr_rating = 3.5 WHERE name_key = 'ana'`);
await pg.query(`INSERT INTO accounts (id, display_name) VALUES ('acct1', 'x')`);
await pg.query(`INSERT INTO account_identities (account_id, club, kind, name_key, proof) SELECT 'acct1', code, 'player', 'ana', 'p' FROM clubs`);
// A linked watch with a live game sent to it: club deletion must take both, and no export may carry its hashes.
const { pairHash, pollHash, shortCode, shortHash } = await import(pathToFileURL(path.join(root, 'api', '_watchrules.js')).href);
const W = (body, headers = {}) => call(live, 'POST', { body, headers });
const liveSecret = 'rightsLive1';
ok(await W({ code, action: 'state', id: 'live-r1', secret: liveSecret, state: { cfg: { mode: 'singles', scoring: 'rally', target: 11, winBy: 2, teams: [['Ana'], ['Ben']] }, score: [0, 0], serving: 0, serverNum: 1, right: [0, 0], server: 0, rallies: 0, switched: false, winner: null, startedAt: 1, endedAt: null }, ack: 0 }));
const pair = 'ab'.repeat(16), pollSecret = 'cd'.repeat(16);
ok(await W({ action: 'watch-register', idHash: pairHash(pair), pollHash: pollHash(pollSecret), shortHash: shortHash(shortCode(pair)), confirm4: '4321', label: 'Rights check watch' }));
ok(await W({ code, action: 'watch-claim', pair, confirm4: '4321', game: 'live-r1', secret: liveSecret }));
const watchToken = ok(await W({ action: 'watch-poll', pairId: pair, pollSecret })).token;
const listGames = async () => (await pg.query(`SELECT id, data FROM games ORDER BY id`)).rows;
const text = v => JSON.stringify(v);

await step('player export: only the phone that holds the name gets it, and it has their games, picture and events', async () => {
  for (const creds of [{}, { playerToken: tok.Ben }, { playerToken: 'f'.repeat(48) }, ORG, { pin: PIN }]) assert.equal((await P('export', { name: 'Ana', ...creds })).status, 403, text(creds));
  const d = ok(await P('export', { name: 'Ana', playerToken: tok.Ana }));
  assert.equal(d.format, 'dink-score-player-export');
  assert.equal(d.player.name, 'Ana');
  assert.equal(d.player.duprSelfReported.rating ?? d.player.duprSelfReported, d.player.duprSelfReported.rating ?? 3.5);
  assert.deepEqual(d.games.map(g => g.id).sort(), ['g-one', 'g-two']);
  assert.equal(d.events.length, 1);
  assert.equal(d.leagues.length, 1);
  assert.ok(!/pin_hash|owner_hash|claim_hash|ownerToken/.test(text(d)));
});

await step('anonymise: nobody without the name\'s phone or an organizer can do it', async () => {
  for (const creds of [{}, { playerToken: tok.Ben }, { playerToken: 'f'.repeat(48) }, { pin: '000000' }]) assert.ok([403, 429].includes((await P('anonymise', { name: 'Ana', ...creds })).status), text(creds));
  assert.ok(text(await listGames()).includes('Ana'));
});

await step('seed: history rows that carry the name (game audit, member audit, a rename pointer)', async () => {
  await pg.query(`INSERT INTO game_audit (club, game, action, actor, after, note) VALUES ($1, 'g1', 'edit', 'player:ana', '{"teams":[["Ana","Ben"],["Cy","Di"]]}', 'Ana')`, [code]);
  await pg.query(`INSERT INTO club_audit (club, actor, actor_name, action, target, detail) VALUES ($1, 'organizer', 'Ana', 'promote', 'Ana', '{"who":"Ana"}')`, [code]);
  await pg.query(`INSERT INTO name_changes (club, old_key, new_name) VALUES ($1, 'anna', 'Ana'), ($1, 'ana', 'Ana B')`, [code]);
});
let label, before;
await step('anonymise: own phone replaces the name everywhere; others\' games and ratings inputs are unchanged', async () => {
  before = await listGames();
  const r = ok(await P('anonymise', { name: 'ana', playerToken: tok.Ana }));
  label = r.label;
  assert.match(label, /^Former player [A-Z0-9]{5}$/);
  assert.equal(r.games, 2);
  const after = await listGames();
  assert.equal(after.length, before.length);
  for (let i = 0; i < after.length; i++) assert.equal(text(after[i].data), text(before[i].data).replaceAll('"Ana"', `"${label}"`), after[i].id); // same games, only that name changed
  const evNow = (await pg.query(`SELECT data, refs, version FROM events`)).rows[0];
  assert.ok(!/Ana/.test(text(evNow.data)) && text(evNow.data).includes(label));
  const lgNow = (await pg.query(`SELECT data FROM leagues`)).rows[0];
  assert.ok(!/Ana/.test(text(lgNow.data)) && text(lgNow.data).includes(label), 'a ladder entry is relabelled too');
  assert.equal(text(evNow.refs), '{"Ben":"7654321"}'); // the DUPR reference for that name is gone
  assert.equal((await pg.query(`SELECT 1 FROM roster WHERE name_key = 'ana'`)).rows.length, 0); // picture, DUPR number and phone link go with it
  assert.equal((await pg.query(`SELECT 1 FROM account_identities`)).rows.length, 0);
  const shown = ok(await call(club, 'GET', { query: '?code=' + code }));
  assert.ok(!/\bAna\b/.test(text(shown)), 'the club view no longer shows the name');
  assert.ok(shown.games.some(g => g.teams.flat().includes(label)));
});
await step('anonymise: the history tables carry the label too, not the name', async () => {
  const dump = text((await pg.query(`SELECT * FROM game_audit`)).rows) + text((await pg.query(`SELECT * FROM club_audit`)).rows) + text((await pg.query(`SELECT * FROM name_changes`)).rows);
  assert.ok(!/\bAna\b/i.test(dump), dump);
  assert.ok(dump.includes(label) && dump.includes(label.toLowerCase()), 'the label is there instead');
  assert.equal((await pg.query(`SELECT 1 FROM name_changes WHERE old_key = 'ana'`)).rows.length, 0);
});
await step('anonymise: the phone no longer holds the name, so repeating it is refused; others are untouched', async () => {
  assert.equal((await P('anonymise', { name: 'Ana', playerToken: tok.Ana })).status, 403);
  assert.equal((await P('export', { name: 'Ana', playerToken: tok.Ana })).status, 403);
  assert.ok(text(await listGames()).includes('"Ben"'));
  assert.equal((await pg.query(`SELECT 1 FROM roster WHERE name_key = 'ben' AND claim_hash IS NOT NULL`)).rows.length, 1);
});
await step('anonymise: an organizer can do it for a guest who never linked a phone; an unknown name is a 404', async () => {
  const r = ok(await P('anonymise', { name: 'Gus', ...ORG }));
  assert.notEqual(r.label, label);
  assert.ok(!text(await listGames()).includes('Gus'));
  assert.equal((await P('anonymise', { name: 'Nobody Here', pin: PIN })).status, 404);
  const viaPin = ok(await P('anonymise', { name: 'Di', pin: PIN }));
  assert.match(viaPin.label, /^Former player /);
});

await step('club export: organizers only (PIN or creating phone); players, strangers and wrong PINs are refused', async () => {
  for (const creds of [{}, { playerToken: tok.Ben }, { pin: '000000' }]) assert.ok([403, 429].includes((await C('export', creds)).status), text(creds));
  const viaOwner = ok(await C('export', ORG)), viaPin = ok(await C('export', { pin: PIN }));
  assert.equal(viaOwner.format, 'dink-score-club-export');
  assert.equal(viaOwner.games.length, 4);
  assert.equal(viaOwner.events.length, 1);
  assert.equal(viaOwner.leagues.length, 1);
  assert.deepEqual(viaOwner.players.map(p => p.name).sort(), ['=SUM(1+1)', 'Ben', 'Cy']);
  assert.equal(text(viaOwner.games.map(g => g.id)), text(viaPin.games.map(g => g.id)));
  const s = text(viaOwner);
  assert.ok(!/pin_hash|owner_hash|claim_hash|share_token|dupr_id|"refs"|1234567|7654321|token_hash|revoke_hash/.test(s) && !s.includes(watchToken), 'no secrets, tokens or DUPR data');
});
await step('club export as CSV: games, with spreadsheet formulas defused', async () => {
  const r = await raw(club, 'POST', { body: { code, action: 'export', format: 'csv', ...ORG } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.headers['content-disposition'], /attachment/);
  const lines = r.text.trim().split('\r\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^id,ended_at,mode,team1,team2,score1,score2/);
  assert.ok(r.text.includes("'=SUM(1+1)"));
  assert.equal((await raw(club, 'POST', { body: { code, action: 'export', format: 'csv', playerToken: tok.Ben } })).status, 403);
});

await step('co-organizer: may export the club, may not delete it or undo a deletion; the export lists roles and history without credentials', async () => {
  ok(await P('set-role', { name: 'Ben', role: 'organizer', ...ORG }));
  const CO = { ownerToken: `${tok.Ben}:Ben` };
  const ex = ok(await C('export', CO));
  assert.equal(ex.players.find(p => p.name === 'Ben').role, 'organizer');
  assert.ok(Array.isArray(ex.memberLog) && ex.memberLog.some(r => r.action === 'promote') && Array.isArray(ex.gameLog));
  assert.ok(!text(ex).includes(tok.Ben) && !text(ex).includes(PIN) && !text(ex).includes(owner), 'no tokens or PINs in the export');
  assert.equal((await C('delete-club', { confirm: 'Rights check club', ...CO })).status, 403);
  assert.ok(!ok(await call(club, 'GET', { query: '?code=' + code })).club.deleteAt);
  ok(await C('delete-club', { confirm: 'Rights check club', ...ORG }));
  assert.equal((await C('cancel-delete-club', CO)).status, 403);
  ok(await C('cancel-delete-club', ORG));
  ok(await P('set-role', { name: 'Ben', role: 'player', ...ORG }));
});

await step('delete club: organizers only, the name must be typed, and it can be undone', async () => {
  for (const creds of [{}, { playerToken: tok.Ben }]) assert.equal((await C('delete-club', { confirm: 'Rights check club', ...creds })).status, 403);
  assert.equal((await C('delete-club', { confirm: 'rights check', ...ORG })).status, 400);
  assert.equal((await C('delete-club', { ...ORG })).status, 400);
  assert.ok(!ok(await call(club, 'GET', { query: '?code=' + code })).club.deleteAt);
  const d = ok(await C('delete-club', { confirm: 'Rights check club', ...ORG }));
  const hours = (d.deleteAt - Date.now()) / 3600e3;
  assert.ok(hours > 23.9 && hours <= 24, String(hours));
  assert.equal(ok(await call(club, 'GET', { query: '?code=' + code })).club.deleteAt, d.deleteAt); // everyone sees it is scheduled
  assert.equal((await C('delete-club', { confirm: 'Rights check club', pin: PIN })).json.deleteAt, d.deleteAt); // asking twice keeps the first deadline
  assert.equal((await C('cancel-delete-club', { playerToken: tok.Ben })).status, 403);
  assert.equal(ok(await call(club, 'GET', { query: '?code=' + code })).club.deleteAt, d.deleteAt);
  ok(await C('cancel-delete-club', { pin: PIN }));
  assert.ok(!ok(await call(club, 'GET', { query: '?code=' + code })).club.deleteAt);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM games`)).rows[0].n, 4);
});
await step('delete club: once the window has passed everything is removed, and the code answers as unknown', async () => {
  const other = ok(await call(club, 'POST', { body: { name: 'Bystander club', pin: '135790' } }), 201);
  ok(await call(games, 'POST', { body: { code: other.club.code, games: [gm('o-one', [['Zed', 'Yan'], ['Xi', 'Wu']], [11, 3], 1)] } }));
  ok(await C('delete-club', { confirm: 'Rights check club', ...ORG }));
  assert.equal((await W({ action: 'watch-state' }, { authorization: 'Bearer ' + watchToken })).status, 200, 'a club waiting out its undo window still has a working watch');
  await pg.query(`UPDATE clubs SET delete_at = now() - interval '1 minute' WHERE name = 'Rights check club'`);
  assert.equal((await W({ action: 'watch-state' }, { authorization: 'Bearer ' + watchToken })).status, 401, 'once the window has passed the watch is refused too');
  assert.equal((await call(club, 'GET', { query: '?code=' + code })).status, 404);
  for (const t of ['clubs', 'games', 'roster', 'events', 'leagues', 'live_games', 'account_identities', 'club_aliases', 'watch_links']) {
    const n = (await pg.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${t === 'clubs' ? 'code' : 'club'} <> '${other.club.code}'`)).rows[0].n;
    assert.equal(n, 0, t + ' still has rows from the deleted club');
  }
  assert.equal((await call(games, 'POST', { body: { code, games: [gm('late-one', [['A', 'B'], ['C', 'D']], [11, 1], 1)] } })).status, 404);
  assert.equal((await call(club, 'GET', { query: '?code=' + other.club.code })).json.games.length, 1); // other clubs are untouched
});

console.log(`\n${passed} checks passed`);
process.exit(0);
