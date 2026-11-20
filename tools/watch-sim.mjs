// Plays an Apple Watch against the club API on a throwaway in-memory Postgres (PGlite), start to finish: link by QR, collect the
// token, follow a game, score with tap ids, lose answers and replay the outbox, undo, get unlinked. It is the executable spec the
// Swift client is written against: every request below is exactly what the watch sends. Same harness as api-check.mjs; no real database.
//   npm ci && npm i --no-save @electric-sql/pglite && node tools/watch-sim.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
const R = await import(pathToFileURL(path.join(root, 'api', '_watchrules.js')).href);
const [club, live] = await Promise.all(['club', 'live'].map(load));

// One HTTP request to a handler, as Vercel would deliver it.
async function http_(handler, method, { query = '', body, headers = {} } = {}) {
  const req = { method, url: '/api/live' + query, headers: { 'x-real-ip': '10.2.0.1', ...headers }, body };
  const out = { status: 0, json: null, headers: {} };
  const res = { statusCode: 0, setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, end(t) { out.status = res.statusCode; out.json = t ? JSON.parse(t) : null; } };
  await handler(req, res);
  return out;
}
const say = (who, what) => console.log(who.padEnd(6) + what);

// ---- the phone: a club and a live game being scored ----
const PHONE = { code: '', secret: 'simSecret123', game: 'live-sim1' };
const made = (await http_(club, 'POST', { body: { name: 'Watch sim club' } })).json;
PHONE.code = made.club.code;
const state = { cfg: { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, teams: [['Ana', 'Ben'], ['Cy', 'Di']] }, score: [0, 0], serving: 0, serverNum: 2, right: [0, 0], server: 0, rallies: 0, switched: false, justSwitched: false, winner: null, startedAt: 1, endedAt: null };
await http_(live, 'POST', { body: { code: PHONE.code, action: 'state', id: PHONE.game, secret: PHONE.secret, state, ack: 0 } });
say('phone', 'scoring ' + PHONE.game + ' in a made-up club');

// ---- the watch ----
const watch = { token: null, outbox: [] };
const post = (action, extra = {}) => http_(live, 'POST', { headers: watch.token ? { authorization: 'Bearer ' + watch.token } : {}, body: { action, ...extra } });

// 1. Not linked: make the pairing and show the QR.
const pairId = randomBytes(16).toString('hex'), pollSecret = randomBytes(16).toString('hex'), confirm4 = String(1000 + (randomBytes(2).readUInt16BE() % 9000));
const reg = await post('watch-register', { idHash: R.pairHash(pairId), pollHash: R.pollHash(pollSecret), shortHash: R.shortHash(R.shortCode(pairId)), confirm4, label: 'Sim Watch' });
assert.equal(reg.status, 200);
say('watch', `QR  https://dinkscore.example/#watch=${pairId}.${confirm4}   digits ${confirm4}   typed ${R.shortCode(pairId)}`);
assert.equal((await post('watch-poll', { pairId, pollSecret })).json.status, 'waiting');

// 2. The phone scans it, types the 4 digits and sends its current game along.
const claim = await http_(live, 'POST', { body: { code: PHONE.code, action: 'watch-claim', pair: pairId, confirm4, game: PHONE.game, secret: PHONE.secret } });
assert.equal(claim.status, 200);
say('phone', `linked ${claim.json.link.id}, game ${claim.json.attached} sent to it`);

// 3. The watch collects its token once and keeps it (Keychain).
const linked = (await post('watch-poll', { pairId, pollSecret })).json;
assert.equal(linked.status, 'linked');
watch.token = linked.token;
say('watch', `linked to "${linked.club.name}", token ${watch.token.slice(0, 6)}...`);
assert.equal((await post('watch-poll', { pairId, pollSecret })).status, 404, 'the token is handed over once');

// 4. Follow the game: a quiet poll is an empty 304.
const get = tag => http_(live, 'GET', { query: '?watch=state', headers: { authorization: 'Bearer ' + watch.token, ...(tag ? { 'if-none-match': tag } : {}) } });
const s1 = await get();
assert.equal(s1.json.game.id, PHONE.game);
assert.equal((await get(s1.headers.etag)).status, 304);
say('watch', `shows ${s1.json.game.say}; a second poll with the tag was an empty 304`);

// 5. Tap: every tap has its own id. This is the watch's outbox; the answer to tap 3 is lost on the way back.
const tap = (opId, side) => ({ kind: 'watch-rally', opId, side });
watch.outbox = [tap('sim-tap-0001', 0), tap('sim-tap-0002', 0), tap('sim-tap-0003', 0), tap('sim-tap-0004', 0)];
for (const t of watch.outbox) { const r = await post(t.kind, { opId: t.opId, side: t.side }); assert.equal(r.status, 200); if (t.opId === 'sim-tap-0003') say('watch', 'tap 3 landed, but its answer never arrived'); }
say('watch', 'back online: replays the whole outbox from tap 3 (it cannot know which landed)');
for (const t of watch.outbox.slice(2)) { const r = await post(t.kind, { opId: t.opId, side: t.side }); assert.equal(r.json.duplicate, true); }
const s2 = (await get()).json.game;
assert.deepEqual(s2.score, [4, 0]);
say('watch', `server says ${s2.say}: four taps, four points, no double count`);

// 6. The phone scores a point too; an undo from the watch takes back whatever came last, here the phone's point.
await http_(live, 'POST', { body: { code: PHONE.code, action: 'rally', game: PHONE.game, secret: PHONE.secret, side: 0, opId: 'phone-sim-0001' } });
const undone = (await post('watch-unrally', { opId: 'sim-undo-0001' })).json;
assert.deepEqual(undone.score, [4, 0]);
say('watch', `undo -> ${undone.say}`);

// 7. A tap with a stale base is a conflict that carries the fresh state; a tap for a game that was not sent is refused.
const stale = (await post('watch-rally', { opId: 'sim-tap-0005', side: 0, base: 0 })).json;
assert.equal(stale.conflict, true);
assert.equal((await post('watch-rally', { opId: 'sim-tap-0006', side: 0, game: 'live-other' })).status, 404);
say('watch', 'stale base -> conflict with the latest state; a game nobody sent -> 404');

// 7b. The game ends on the watch (the team on top reaches 11). Finish saves it on the server, once, under the live id: the phone
// being closed loses nothing, and the phone saving the same game later is a no-op.
for (let i = 7; i < 14; i++) await post('watch-rally', { opId: 'sim-tap-' + String(i).padStart(4, '0'), side: 0 });
const over = (await get()).json.game;
assert.equal(over.say, 'Game over');
const fin = await post('watch-finish', {});
assert.equal(fin.status, 200); assert.deepEqual([fin.json.id, fin.json.saved], [PHONE.game, true]);
assert.equal((await post('watch-finish', {})).json.saved, false);
assert.equal((await pg.query('SELECT count(*)::int AS n FROM games WHERE club = $1 AND id = $2', [PHONE.code, PHONE.game])).rows[0].n, 1);
say('watch', 'Finish -> saved once as ' + PHONE.game + '; a second Finish saves nothing more');

// 8. The phone unlinks the watch: the watch's next call is a 401, so it clears the Keychain and shows the QR again.
await http_(live, 'POST', { body: { code: PHONE.code, action: 'watch-revoke', link: claim.json.link.id, revokeKey: claim.json.revokeKey } });
assert.equal((await get()).status, 401);
watch.token = null;
say('watch', '401 -> token cleared, back to the QR screen');

// 9. A watch with no club at tournament: two games on the same Wi-Fi, each with its own watch. The scoring phone shows a game code,
// the watch types it, and each watch holds one game only. The phone ending the game ends its watch's link.
const second = { game: 'live-sim2', secret: 'simSecret456' };
await http_(live, 'POST', { body: { code: PHONE.code, action: 'state', id: second.game, secret: second.secret, state: { ...state, startedAt: 2 }, ack: 0 } });
const pair = async (id, secret) => (await http_(live, 'POST', { body: { code: PHONE.code, action: 'watch-offer', game: id, secret } })).json.offer;
const o1 = await pair(second.game, second.secret);
say('phone', `shows game code ${o1.short.slice(0, 3)} ${o1.short.slice(3)} and numbers ${o1.confirm4} for ${second.game}`);
const typed = await http_(live, 'POST', { body: { action: 'watch-join', code: o1.short, confirm4: o1.confirm4, label: 'Sim Watch 2' } });
assert.equal(typed.status, 200); assert.equal(typed.json.club.name, '', 'a single-game link is not told the club');
watch.token = typed.json.token;
say('watch', 'typed the code: linked to ' + typed.json.link.game + ' only, no club name, ' + watch.token.slice(0, 6) + '...');
assert.equal((await get()).json.game.id, second.game);
assert.equal((await post('watch-rally', { opId: 'sim-solo-0001', side: 0, game: PHONE.game })).status, 404, 'the other game is out of reach');
assert.equal((await post('watch-rally', { opId: 'sim-solo-0002', side: 0 })).json.score[0], 1);
say('watch', 'scores its own game; the other game on the same court is a 404');
assert.equal((await http_(live, 'POST', { body: { action: 'watch-join', code: o1.short, confirm4: o1.confirm4 } })).status, 404, 'a game code is good for one watch');
await http_(live, 'POST', { body: { code: PHONE.code, action: 'end', id: second.game, secret: second.secret } });
assert.equal((await get()).status, 401);
watch.token = null;
say('watch', 'the phone ended the game -> 401, the watch says the link has ended');

console.log('\nwatch simulation passed');
server.close(); await pg.close(); process.exit(0);
