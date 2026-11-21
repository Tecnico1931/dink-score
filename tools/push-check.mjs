// Push notifications against a throwaway in-memory Postgres (PGlite) with a mocked push sender: who may subscribe, who is notified when a round
// opens or a court frees, dead subscriptions pruned, rename/anonymise follow the name, rate limit, and the feature staying off without VAPID keys.
// Same harness as rights-check.mjs; no real database and no push service is ever contacted.
//   npm ci && npm i --no-save @electric-sql/pglite && node tools/push-check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
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
delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_SUBJECT;

const load = async name => (await import(pathToFileURL(path.join(root, 'api', name + '.js')).href));
const [club, events, players, live] = await Promise.all(['club', 'events', 'players', 'live'].map(async n => (await load(n)).default));
const push = await load('_push');
let ip = 0;
async function raw(handler, method, { query = '', body, addr } = {}) {
  const req = { method, url: '/api/x' + query, headers: { 'x-real-ip': addr || '10.2.0.' + (++ip % 200) }, body };
  const out = { status: 0, text: '', headers: {} };
  const res = { statusCode: 0, setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, end(t) { out.status = res.statusCode; out.text = t; } };
  await handler(req, res);
  return out;
}
const call = async (...a) => { const r = await raw(...a); return { status: r.status, json: JSON.parse(r.text) }; };
const ok = (r, want = 200) => { assert.equal(r.status, want, JSON.stringify(r.json)); return r.json; };
const text = v => JSON.stringify(v);
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('ok  ' + name); };

const PIN = '135790';
const created = ok(await call(club, 'POST', { body: { name: 'Push check club', pin: PIN } }), 201);
const code = created.club.code, ORG = { ownerToken: created.ownerToken };
const names = ['Ana', 'Ben', 'Cy', 'Di', 'Eve'];
const tok = {};
for (const n of names) tok[n] = ok(await call(players, 'POST', { body: { code, action: 'claim', name: n, ...ORG } })).playerToken;
const L = (action, body, opts) => call(live, 'POST', { body: { code, action, ...body }, ...opts });
const me = n => ({ playerName: n, playerToken: tok[n] });
const device = (tag) => { const e = createECDH('prime256v1'); e.generateKeys(); return { endpoint: 'https://fcm.googleapis.com/fcm/send/' + tag, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; };
const rows = async () => (await pg.query(`SELECT endpoint, name_key FROM push_subs ORDER BY endpoint`)).rows;
const sentTo = [], statusFor = {};
push.setSender(async (sub, message) => { sentTo.push({ endpoint: sub.endpoint, message }); return statusFor[sub.endpoint] || 201; });
const take = () => sentTo.splice(0);

await step('without VAPID keys the feature is off with a clear message, and stores nothing', async () => {
  for (const a of ['push-status', 'push-subscribe', 'push-unsubscribe']) {
    const r = ok(await L(a, { ...me('Ana'), subscription: device('off') }));
    assert.equal(r.enabled, false); assert.match(r.message, /not set up/);
  }
  assert.equal((await rows()).length, 0);
  assert.equal(await push.notify(await (async () => (await import('@neondatabase/serverless')).neon(process.env.DATABASE_URL))(), 'x', new Map([['Ana', { title: 'T', body: 'B' }]])), 0);
  const gnOff = ok(await call(club, 'POST', { body: { code, action: 'night-create', ...ORG, night: { title: 'Off check', startsAt: Date.now() + 864e5 } } }), 201).night;
  const remOff = ok(await call(club, 'POST', { body: { code, action: 'night-remind', id: gnOff.id, ...ORG } }));
  assert.equal(remOff.enabled, false); assert.equal(remOff.sent, 0); assert.match(remOff.message, /not set up/);
  ok(await call(club, 'POST', { body: { code, action: 'night-delete', id: gnOff.id, ...ORG } }));
});

const e = createECDH('prime256v1'); e.generateKeys();
process.env.VAPID_PUBLIC_KEY = e.getPublicKey().toString('base64url');
process.env.VAPID_PRIVATE_KEY = Buffer.concat([Buffer.alloc(32), e.getPrivateKey()]).subarray(-32).toString('base64url');
process.env.VAPID_SUBJECT = 'mailto:push-check@example.invalid';

await step('status needs a claimed name and its phone token; it hands out only the public key', async () => {
  for (const creds of [{}, { playerName: 'Ana' }, { playerName: 'Ana', playerToken: tok.Ben }, { playerName: 'Ana', playerToken: 'f'.repeat(48) }, ORG, { pin: PIN }]) assert.equal((await L('push-status', creds)).status, 403, text(creds));
  const r = ok(await L('push-status', me('Ana')));
  assert.equal(r.enabled, true); assert.equal(r.publicKey, process.env.VAPID_PUBLIC_KEY); assert.equal(r.subscribed, false);
  assert.ok(!text(r).includes(process.env.VAPID_PRIVATE_KEY));
});

await step('subscribe: bad endpoints and keys are refused; a good one is stored for that name and club', async () => {
  for (const bad of [{ ...device('x'), endpoint: 'http://fcm.googleapis.com/x' }, { ...device('x'), endpoint: 'https://127.0.0.1/x' }, { ...device('x'), endpoint: 'https://evil.example/x' }, { endpoint: device('x').endpoint, keys: { p256dh: 'AAAA', auth: 'AAAA' } }, null])
    assert.equal((await L('push-subscribe', { ...me('Ana'), subscription: bad })).status, 400, text(bad));
  assert.equal((await L('push-subscribe', { playerName: 'Ana', subscription: device('a1') })).status, 403);
  const a1 = device('a1');
  assert.equal(ok(await L('push-subscribe', { ...me('Ana'), subscription: a1 })).subscribed, true);
  ok(await L('push-subscribe', { ...me('Ana'), subscription: a1 })); // again: still one row
  assert.deepEqual(await rows(), [{ endpoint: a1.endpoint, name_key: 'ana' }]);
  assert.equal(ok(await L('push-status', { ...me('Ana'), endpoint: a1.endpoint })).subscribed, true);
  assert.equal(ok(await L('push-status', { ...me('Ben'), endpoint: a1.endpoint })).subscribed, false, 'another member never sees it');
});

await step('a member can have at most 5 devices', async () => {
  for (let i = 2; i <= 5; i++) ok(await L('push-subscribe', { ...me('Ana'), subscription: device('a' + i) }));
  assert.equal((await L('push-subscribe', { ...me('Ana'), subscription: device('a6') })).status, 409);
  assert.equal((await rows()).length, 5);
  ok(await L('push-unsubscribe', { ...me('Ana'), endpoint: device('a5').endpoint }));
  assert.equal((await rows()).length, 4);
});

const B1 = device('b1'), C1 = device('c1');
ok(await L('push-subscribe', { ...me('Ben'), subscription: B1 }));
ok(await L('push-subscribe', { ...me('Cy'), subscription: C1 }));

await step('unsubscribe: only the owner of that name removes it (the address alone is not enough)', async () => {
  assert.equal((await L('push-unsubscribe', { ...me('Cy'), endpoint: B1.endpoint })).status, 200);
  assert.equal((await rows()).filter(r => r.endpoint === B1.endpoint).length, 1, "Cy's request did not touch Ben's phone");
  assert.equal((await L('push-unsubscribe', { playerName: 'Ben', endpoint: B1.endpoint })).status, 403);
  assert.equal((await rows()).filter(r => r.endpoint === B1.endpoint).length, 1);
});

// Another club with a player of the same name, also subscribed: never told about this club's rounds.
const other = ok(await call(club, 'POST', { body: { name: 'Other club', pin: '864200' } }), 201);
const otherTok = ok(await call(players, 'POST', { body: { code: other.club.code, action: 'claim', name: 'Ana', ownerToken: other.ownerToken } })).playerToken;
ok(await call(live, 'POST', { body: { code: other.club.code, action: 'push-subscribe', playerName: 'Ana', playerToken: otherTok, subscription: device('z1') } }));

await step('publishing a manual round tells its players their court, and only subscribed members of this club', async () => {
  const ev = ok(await call(events, 'POST', { body: { code, action: 'create', ...ORG, event: { name: 'Friday mixer', format: 'roundrobin', partners: 'rotating', rotation: 'manual', courts: 1, players: ['Ana', 'Ben', 'Cy', 'Di'], rounds: 2 } } }), 201).event;
  let cur = ev;
  if (!cur.rounds.some(r => r.status === 'draft')) cur = ok(await call(events, 'POST', { body: { code, action: 'next-round', id: ev.id, ...ORG } })).event;
  const draft = cur.rounds.find(r => r.status === 'draft');
  assert.ok(draft, 'a draft round to publish');
  assert.equal(take().length, 0, 'a draft round tells nobody');
  ok(await call(events, 'POST', { body: { code, action: 'publish-round', id: ev.id, round: draft.n, ...ORG } }));
  const sent = take();
  const ends = sent.map(s => s.endpoint).sort();
  assert.deepEqual(ends, [device('a1').endpoint, device('a2').endpoint, device('a3').endpoint, device('a4').endpoint, B1.endpoint, C1.endpoint].sort());
  for (const s of sent) {
    assert.match(s.message.title, /^Friday mixer: round \d$/);
    assert.match(s.message.body, /^(Ana|Ben|Cy), you're up on court 1\.$/);
    assert.ok(!text(s.message).includes(code) && !text(s.message).includes('Push check club'), 'no club code or name in the text');
  }
  // already open: a repeat is refused and tells nobody
  assert.equal((await call(events, 'POST', { body: { code, action: 'publish-round', id: ev.id, round: draft.n, ...ORG } })).status, 409);
  assert.equal(take().length, 0);
});

await step('a dead subscription (404/410) is pruned; a failing one is kept', async () => {
  statusFor[C1.endpoint] = 410; statusFor[B1.endpoint] = 503;
  const ev = ok(await call(events, 'POST', { body: { code, action: 'create', ...ORG, event: { name: 'Second', format: 'roundrobin', partners: 'rotating', rotation: 'manual', courts: 1, players: ['Ana', 'Ben', 'Cy', 'Di'], rounds: 2 } } }), 201).event;
  let cur = ev; if (!cur.rounds.some(r => r.status === 'draft')) cur = ok(await call(events, 'POST', { body: { code, action: 'next-round', id: ev.id, ...ORG } })).event;
  ok(await call(events, 'POST', { body: { code, action: 'publish-round', id: ev.id, round: cur.rounds.find(r => r.status === 'draft').n, ...ORG } }));
  take();
  const left = (await rows()).map(r => r.endpoint);
  assert.ok(!left.includes(C1.endpoint), 'gone after a 410');
  assert.ok(left.includes(B1.endpoint), 'kept after a 503');
  delete statusFor[C1.endpoint]; delete statusFor[B1.endpoint];
  ok(await L('push-subscribe', { ...me('Cy'), subscription: C1 }));
});

await step('the court board: finishing a game tells the group next for that court, not the others', async () => {
  ok(await L('board-config', { courts: 1, mode: 'rotate', enabled: true, ...ORG }));
  for (const n of names) ok(await L('board-checkin', { name: n, ...me(n) }));
  ok(await L('board-call', { court: 1, ...ORG }));
  take();
  const b = ok(await call(live, 'GET', { query: `?code=${code}&board=1` })).board;
  const playing = b.courts[0].teams.flat(), waiting = b.queue;
  ok(await L('board-finish', { court: 1, winner: 0, ...ORG }));
  const sent = take();
  assert.ok(sent.length >= 1, 'a subscribed player next in line was told');
  assert.ok(playing.length >= 2 && waiting.length >= 1);
  for (const s of sent) {
    assert.equal(s.message.title, 'Court free');
    assert.match(s.message.body, /^\w+, court 1 is free\. You're up next\.$/);
  }
  assert.ok(!sent.some(s => s.endpoint === device('z1').endpoint), 'never another club');
});

await step('game night reminder: organizer only, respects opt-in and audience, never includes club code/name, enforces cooldown', async () => {
  const gn = ok(await call(club, 'POST', { body: { code, action: 'night-create', ...ORG, night: { title: 'Tuesday lights', startsAt: Date.now() + 864e5, location: 'Courts 1-2' } } }), 201).night;
  ok(await call(club, 'POST', { body: { code, action: 'night-rsvp', id: gn.id, status: 'in', ...me('Ana') } }));
  ok(await call(club, 'POST', { body: { code, action: 'night-rsvp', id: gn.id, status: 'out', ...me('Ben') } }));
  assert.equal((await call(club, 'POST', { body: { code, action: 'night-remind', id: gn.id, ...me('Ana') } })).status, 403, 'non-organizer refused');
  take();
  const rem = ok(await call(club, 'POST', { body: { code, action: 'night-remind', id: gn.id, audience: 'all', tz: 'UTC', ...ORG } }));
  assert.equal(rem.enabled, true);
  assert.ok(rem.sent >= 1);
  const sent = take();
  const ends = sent.map(s => s.endpoint);
  assert.ok(ends.includes(device('a1').endpoint), 'Ana (In) notified');
  assert.ok(ends.includes(C1.endpoint), 'Cy (unanswered) notified');
  assert.ok(!ends.includes(B1.endpoint), 'Ben (Out) skipped');
  assert.ok(!ends.includes(device('z1').endpoint), 'other club never notified');
  for (const s of sent) {
    assert.equal(s.message.title, 'Tuesday lights');
    assert.ok(!text(s.message).includes(code) && !text(s.message).includes('Push check club'), 'no club code or name in reminder');
  }
  assert.equal((await call(club, 'POST', { body: { code, action: 'night-remind', id: gn.id, ...ORG } })).status, 429, 'per-night cooldown enforced');
  assert.equal(take().length, 0);
});

await step('a rename keeps the notifications with the player; anonymising removes them', async () => {
  ok(await call(players, 'POST', { body: { code, action: 'rename', name: 'Ben', newName: 'Benjamin', ...ORG } }));
  assert.ok((await rows()).some(r => r.endpoint === B1.endpoint && r.name_key === 'benjamin'));
  assert.ok(!(await rows()).some(r => r.name_key === 'ben'));
  ok(await call(players, 'POST', { body: { code, action: 'anonymise', name: 'Cy', playerToken: tok.Cy } }));
  assert.ok(!(await rows()).some(r => r.name_key === 'cy'));
});

await step('a name released by an organizer stops receiving (the roster join), even if the row is still there', async () => {
  await pg.query(`UPDATE roster SET claim_hash = NULL WHERE name_key = 'ana'`);
  const sql = (await import('@neondatabase/serverless')).neon(process.env.DATABASE_URL);
  assert.equal(await push.notify(sql, (await pg.query(`SELECT code FROM clubs LIMIT 1`)).rows[0].code, new Map([['Ana', { title: 'T', body: 'B' }]])), 0);
  assert.equal(take().length, 0);
});

await step('subscribe calls are rate limited per network', async () => {
  let last;
  for (let i = 0; i < 32; i++) last = await L('push-status', me('Di'), { addr: '10.9.9.9' });
  assert.equal(last.status, 429);
  assert.equal((await L('push-status', me('Di'), { addr: '10.9.9.10' })).status, 200, 'another network is unaffected');
});

await step('approval request: only organizers hear it (co-organizer by role, creating phone by its owner token), with no club name or code', async () => {
  ok(await call(players, 'POST', { body: { code, action: 'set-role', name: 'Di', role: 'organizer', ...ORG } }));
  tok.Fay = ok(await call(players, 'POST', { body: { code, action: 'claim', name: 'Fay', ...ORG } })).playerToken;
  const D = device('org-di'), E = device('org-eve'), F = device('org-fay');
  ok(await L('push-subscribe', { ...me('Di'), subscription: D }));
  ok(await L('push-subscribe', { ...me('Eve'), ownerToken: created.ownerToken, subscription: E }));
  ok(await L('push-subscribe', { ...me('Fay'), ownerToken: 'f'.repeat(48), subscription: F })); // a wrong owner token flags nothing
  assert.deepEqual((await pg.query(`SELECT endpoint FROM push_subs WHERE organizer ORDER BY endpoint`)).rows.map(r => r.endpoint), [E.endpoint]);
  take();
  const asked = ok(await call(players, 'POST', { body: { code, action: 'approval-request', name: 'Fay', playerToken: 'a'.repeat(48) } }));
  assert.equal(asked.notified, 2);
  const sent = take();
  assert.deepEqual(sent.map(s => s.endpoint).sort(), [D.endpoint, E.endpoint].sort(), 'not Fay or any other member');
  for (const s of sent) {
    assert.equal(s.message.title, 'Approval needed'); assert.match(s.message.body, /Fay/);
    assert.ok(!s.message.body.includes(code) && !/Push check club/.test(text(s.message)), 'no club name or code');
  }
});

await step('deleting the club removes its subscriptions (they cascade)', async () => {
  await pg.query(`DELETE FROM clubs`);
  assert.equal((await rows()).length, 0);
});

console.log(`\n${passed} push checks passed`);
server.close(); await pg.close();
