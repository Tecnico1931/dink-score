// Runs the optional-account API (passkeys, sessions, claiming club identities) against a throwaway in-memory Postgres (PGlite),
// with a software passkey standing in for the browser. Same harness as api-check.mjs; no real database or network is used.
//   npm ci && npm i --no-save @electric-sql/pglite && node tools/account-check.mjs
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
const [account, club, players] = await Promise.all(['account', 'club', 'players'].map(load));
const ORIGIN = 'https://dinkscore.vercel.app';
let ip = 0, cookie = '';
async function call(handler, method, { body, headers = {}, keepIp = false, jar = true } = {}) {
  const req = { method, url: '/api/x', headers: { 'x-real-ip': '10.1.0.' + (keepIp ? ip : ++ip % 200), ...(jar && cookie ? { cookie } : {}), ...headers }, body };
  let status = 0, text = '', setCookie = null;
  const res = { statusCode: 0, setHeader(k, v) { if (k.toLowerCase() === 'set-cookie') setCookie = v; }, end(t) { status = res.statusCode; text = t; } };
  await handler(req, res);
  return { status, json: JSON.parse(text), setCookie };
}
const post = (body, opts = {}) => call(account, 'POST', { body, headers: { origin: ORIGIN }, ...opts });
const ok = (r, want = 200) => { assert.equal(r.status, want, JSON.stringify(r.json)); return r.json; };
const keep = r => { if (r.setCookie) cookie = r.setCookie.split(';')[0]; return r; };
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('ok  ' + name); };

const { makeAuthenticator } = await import(pathToFileURL(path.join(root, 'tools', 'fake-authenticator.mjs')).href);
const rpId = 'dinkscore.vercel.app';
async function signUp(auth, name = 'Ana P') {
  const o = ok(await post({ action: 'register-options', name }));
  return keep(await post({ action: 'register', challengeId: o.challengeId, credential: auth.create(o.options.challenge), name }));
}
async function signIn(auth, over) {
  const o = ok(await post({ action: 'login-options' }));
  return keep(await post({ action: 'login', challengeId: o.challengeId, credential: auth.get(o.options.challenge, over) }));
}

// A club and a claimed name, as a phone with no account would hold them.
const created = ok(await call(club, 'POST', { body: { name: 'Account check club' }, jar: false }), 201);
const code = created.club.code, ownerToken = created.ownerToken;
const playerToken = ok(await call(players, 'POST', { body: { code, action: 'claim', name: 'Ana', ownerToken }, jar: false })).playerToken;

const auth = makeAuthenticator({ rpId, origin: ORIGIN });

await step('signed out: GET shows config and no account; cookie is httpOnly, Secure, SameSite=Lax on sign-up', async () => {
  const r = ok(await call(account, 'GET'));
  assert.equal(r.account, null);
  assert.equal(r.config.rpId, rpId);
  const reg = await signUp(auth);
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', '__Host-']) assert.ok(reg.setCookie.includes(a), a);
  assert.ok(!/Domain=/i.test(reg.setCookie));
  assert.equal(ok(await call(account, 'GET')).account.name, 'Ana P');
});

await step('claim: this phone presents its tokens once; wrong tokens are refused; the club still works with no account', async () => {
  const bad = ok(await post({ action: 'claim', items: [{ code, ownerToken: 'nope', playerName: 'Ana', playerToken: 'nope' }] }));
  assert.equal(bad.linked.length, 0);
  assert.equal(bad.skipped.length, 1);
  const good = ok(await post({ action: 'claim', items: [{ code, ownerToken, playerName: 'Ana', playerToken }] }));
  assert.deepEqual(good.linked.map(l => l.kind).sort(), ['organizer', 'player']);
  assert.equal(good.identities.length, 2);
  // No-login use is untouched: the same tokens still work with no cookie.
  assert.equal((await call(club, 'GET', { jar: false })).status < 500, true);
});

await step('sign out ends the session; the old cookie no longer works', async () => {
  const old = cookie;
  ok(await post({ action: 'logout' }));
  cookie = '';
  assert.equal(ok(await call(account, 'GET')).account, null);
  assert.equal((await call(account, 'GET', { headers: { cookie: old }, jar: false })).json.account, null);
  assert.equal((await post({ action: 'claim', items: [] }, { jar: false, headers: { origin: ORIGIN, cookie: old } })).status, 401);
});

await step('sign in with the passkey on a "new phone"; restore hands back fresh tokens and the old ones stop working', async () => {
  const r = await signIn(auth, { userHandle: undefined });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.identities.length, 2);
  const rest = ok(await post({ action: 'restore', items: r.json.identities.map(i => ({ code: i.code, kind: i.kind, name: i.name })) }));
  assert.equal(rest.restored.length, 2);
  const newOwner = rest.restored.find(x => x.kind === 'organizer').token, newPlayer = rest.restored.find(x => x.kind === 'player').token;
  assert.notEqual(newOwner, ownerToken);
  const mine = (t, n = 'Ana') => call(players, 'POST', { body: { code, action: 'avatar', name: n, playerToken: t, avatar: { type: 'initials' } }, jar: false });
  assert.equal((await mine(newPlayer)).status, 200);
  assert.equal((await mine(playerToken)).status, 403);
});

await step('a replayed assertion (counter not advancing) and a reused challenge are refused', async () => {
  const o = ok(await post({ action: 'login-options' }));
  const cred = auth.get(o.options.challenge);
  assert.equal((await post({ action: 'login', challengeId: o.challengeId, credential: cred })).status, 200);
  assert.equal((await post({ action: 'login', challengeId: o.challengeId, credential: cred })).status, 400); // challenge is single use
  const o2 = ok(await post({ action: 'login-options' }));
  auth.setCounter(0);
  assert.equal((await post({ action: 'login', challengeId: o2.challengeId, credential: auth.get(o2.options.challenge) })).status, 401);
});

await step('an unknown passkey, wrong origin header and a wrong-origin ceremony are refused', async () => {
  const stranger = makeAuthenticator({ rpId, origin: ORIGIN });
  assert.equal((await signIn(stranger)).status, 401);
  assert.equal((await call(account, 'POST', { body: { action: 'logout' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(account, 'POST', { body: { action: 'logout' } })).status, 403); // no Origin at all
  const evil = makeAuthenticator({ rpId, origin: 'https://evil.example' });
  const o = ok(await post({ action: 'register-options' }));
  assert.equal((await post({ action: 'register', challengeId: o.challengeId, credential: evil.create(o.options.challenge) })).status, 400);
});

await step('a second account cannot take over a link the first still holds', async () => {
  const other = makeAuthenticator({ rpId, origin: ORIGIN });
  cookie = '';
  await signUp(other, 'Ben');
  const r = ok(await post({ action: 'claim', items: [{ code, ownerToken: 'x' }] }));
  assert.equal(r.linked.length, 0);
  // Ben holds the old (rotated-away) tokens only: they no longer prove anything.
  const r2 = ok(await post({ action: 'claim', items: [{ code, ownerToken, playerName: 'Ana', playerToken }] }));
  assert.equal(r2.linked.length, 0);
});

await step('add a second passkey; delete account removes sessions and links but leaves the club', async () => {
  const second = makeAuthenticator({ rpId, origin: ORIGIN });
  const o = ok(await post({ action: 'passkey-options' }));
  assert.equal(ok(await post({ action: 'passkey-add', challengeId: o.challengeId, credential: second.create(o.options.challenge) })).account.passkeys, 2);
  ok(await post({ action: 'delete-account' }));
  cookie = '';
  assert.equal((await signIn(second)).status, 401);
  assert.equal((await call(club, 'GET', { jar: false })).status !== 500, true);
});

await step('rate limits: repeated wrong sign-ins from one address are stopped', async () => {
  const stranger = makeAuthenticator({ rpId, origin: ORIGIN });
  let last = 0;
  for (let i = 0; i < 14; i++) {
    const o = ok(await post({ action: 'login-options' }, { keepIp: true }));
    last = (await post({ action: 'login', challengeId: o.challengeId, credential: stranger.get(o.options.challenge) }, { keepIp: true })).status;
  }
  assert.equal(last, 429);
});

// Email sign-in links. Resend is replaced by a stub on global fetch (every other URL, the throwaway database included, passes through):
// no real mail is ever sent.
const realFetch = globalThis.fetch;
const mails = [];
let mailStatus = 200;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.resend.com/emails') return realFetch(url, init);
  mails.push({ headers: init.headers, body: JSON.parse(init.body) });
  return { ok: mailStatus < 300, status: mailStatus };
};
const KEY = 're_test_key_not_real';
const tokenOf = m => /#signin=([A-Za-z0-9_-]+)$/.exec(m.body.text.match(/https?:\/\/\S+/)[0])[1];
const startMail = (email, opts) => post({ action: 'email-start', email }, opts);
const lastToken = () => tokenOf(mails[mails.length - 1]);
const finish = async token => keep(await post({ action: 'email-finish', token }));
delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;

await step('email sign-in is off and hidden without RESEND_API_KEY and MAIL_FROM', async () => {
  assert.equal(ok(await call(account, 'GET')).config.email, false);
  assert.equal((await startMail('ana@example.test')).status, 404);
  process.env.RESEND_API_KEY = KEY; // a key alone is not enough: there is no sender
  assert.equal(ok(await call(account, 'GET')).config.email, false);
  assert.equal((await startMail('ana@example.test')).status, 404);
  assert.equal(mails.length, 0);
});

process.env.MAIL_FROM = 'Dink Score <login@mail.example.test>';

await step('email-start: the same answer for a new and a known address; the mail carries a same-origin link and no secret is returned or stored', async () => {
  cookie = '';
  assert.equal(ok(await call(account, 'GET')).config.email, true);
  assert.equal((await startMail('not an address')).status, 400);
  assert.equal((await startMail('a@b')).status, 400);
  assert.equal((await post({ action: 'email-start', email: 'ana@example.test' }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal(mails.length, 0);
  const first = await startMail('Ana@Example.test ');
  const m = mails[0];
  assert.equal(m.headers.Authorization, 'Bearer ' + KEY);
  assert.equal(m.body.from, 'Dink Score <login@mail.example.test>');
  assert.deepEqual(m.body.to, ['ana@example.test']);
  assert.match(m.body.text, /^Open this link to sign in to Dink Score:\n\nhttps:\/\/dinkscore\.vercel\.app\/#signin=[A-Za-z0-9_-]{43}\n/);
  assert.ok(m.body.html.includes('https://dinkscore.vercel.app/#signin='));
  const token = lastToken();
  assert.equal(JSON.stringify(first).includes(token) || JSON.stringify(first).includes(KEY), false);
  const rows = (await pg.query(`SELECT * FROM email_links`)).rows;
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token); // only the hash is stored
  assert.ok(!JSON.stringify(rows[0]).includes(token));
  const mins = (await pg.query(`SELECT extract(epoch FROM expires_at - created_at) / 60 AS m FROM email_links`)).rows[0].m;
  assert.ok(Math.abs(mins - 15) < 0.1, 'expires in 15 minutes');
  const sameAsNew = await startMail('someone-else@example.test');
  assert.deepEqual(sameAsNew.json, first.json); // sign-up and sign-in answer alike
});

await step('email-finish: a new address makes an account and a session; the link works once; the address is lower-cased', async () => {
  const token = tokenOf(mails[0]);
  assert.equal((await finish('wrong')).status, 400);
  const r = await finish(token);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', '__Host-']) assert.ok(r.setCookie.includes(a), a);
  assert.deepEqual(r.json.account.emails, ['ana@example.test']);
  assert.equal(r.json.account.name, 'Dink Score player');
  assert.equal(r.json.config.email, true);
  assert.equal((await finish(token)).status, 400); // single use
  assert.deepEqual(ok(await call(account, 'GET')).account.emails, ['ana@example.test']);
});

await step('a known address signs in to the same account from another phone; an expired link is refused', async () => {
  const firstId = (await pg.query(`SELECT account_id FROM account_emails WHERE email = 'ana@example.test'`)).rows[0].account_id;
  cookie = '';
  await startMail('ANA@example.test');
  const r = await finish(lastToken());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM accounts WHERE id = '${firstId}'`)).rows[0].n, 1);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM account_emails WHERE email = 'ana@example.test'`)).rows[0].n, 1);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM sessions WHERE account_id = '${firstId}'`)).rows[0].n >= 2, true);
  cookie = '';
  await startMail('ana@example.test');
  const t = lastToken();
  await pg.query(`UPDATE email_links SET expires_at = now() - interval '1 second'`);
  assert.equal((await finish(t)).status, 400);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM sessions s JOIN account_emails e ON e.account_id = s.account_id`)).rows[0].n >= 2, true);
  assert.equal(cookie, '');
});

await step('signed in: an address is added to the same account (passkey account keeps its passkey); the last way in cannot be removed', async () => {
  cookie = '';
  const pkAuth = makeAuthenticator({ rpId, origin: ORIGIN });
  const reg = await signUp(pkAuth, 'Pat');
  assert.equal(reg.status, 201);
  await startMail('pat@example.test');
  const r = await finish(lastToken());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.account.name, 'Pat');
  assert.deepEqual(r.json.account.emails, ['pat@example.test']);
  assert.equal(r.json.account.passkeys, 1);
  cookie = '';
  await startMail('pat@example.test');
  const again = await finish(lastToken()); // signed out: the address now signs in to Pat's account
  assert.equal(again.json.account.name, 'Pat');
  assert.equal(again.json.account.passkeys, 1);
  assert.equal((await post({ action: 'email-remove', email: 'nobody@example.test' })).status, 404);
  assert.deepEqual(ok(await post({ action: 'email-remove', email: 'pat@example.test' })).account.emails, []); // a passkey remains
  // An email-only account keeps its one address.
  cookie = '';
  await startMail('solo@example.test');
  assert.equal((await finish(lastToken())).status, 201);
  assert.equal((await post({ action: 'email-remove', email: 'solo@example.test' })).status, 400);
  await startMail('solo2@example.test'); // signed in: joins this account
  assert.deepEqual((await finish(lastToken())).json.account.emails, ['solo@example.test', 'solo2@example.test']);
  assert.deepEqual(ok(await post({ action: 'email-remove', email: 'solo@example.test' })).account.emails, ['solo2@example.test']);
});

await step('export carries the address and no secrets; delete-account removes addresses and pending links', async () => {
  const ex = ok(await post({ action: 'export' }));
  assert.equal(ex.format, 'dink-score-account-export');
  assert.deepEqual(ex.emails.map(e => e.email), ['solo2@example.test']);
  const text = JSON.stringify(ex);
  assert.ok(!/token|hash|public_key|session/i.test(text.replace(/"exportedAt"/g, '')), 'no secrets in the export');
  await startMail('solo2@example.test'); // leaves a pending link for this account
  assert.ok((await pg.query(`SELECT 1 FROM email_links WHERE account_id IS NOT NULL`)).rows.length >= 1);
  const id = (await pg.query(`SELECT account_id FROM account_emails WHERE email = 'solo2@example.test'`)).rows[0].account_id;
  ok(await post({ action: 'delete-account' }));
  cookie = '';
  assert.equal((await pg.query(`SELECT 1 FROM account_emails WHERE account_id = '${id}'`)).rows.length, 0);
  assert.equal((await pg.query(`SELECT 1 FROM email_links WHERE account_id = '${id}'`)).rows.length, 0);
  assert.equal((await post({ action: 'export' })).status, 401);
});

await step('limits: one inbox is not flooded (still the same answer), one address is capped, a failed send leaves nothing behind', async () => {
  const before = mails.length;
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push((await startMail('flood@example.test')).json);
  assert.equal(mails.length - before, 3); // the fourth and fifth are dropped quietly
  assert.ok(answers.every(a => JSON.stringify(a) === JSON.stringify(answers[0])));
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await startMail(`user${i}@example.test`, { keepIp: true })).status;
  assert.equal(last, 429); // per network
  mailStatus = 500;
  const links = (await pg.query(`SELECT count(*)::int AS n FROM email_links`)).rows[0].n;
  const bad = await startMail('fails@example.test');
  mailStatus = 200;
  assert.equal(bad.status, 502);
  assert.ok(!JSON.stringify(bad.json).includes(KEY));
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM email_links`)).rows[0].n, links);
  // Wrong links count against the network too.
  last = 0;
  for (let i = 0; i < 12; i++) last = (await post({ action: 'email-finish', token: 'x' + i }, { keepIp: true })).status;
  assert.equal(last, 429);
});

delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;
await step('email sign-in is off again once the key is removed', async () => {
  assert.equal((await startMail('ana@example.test')).status, 404);
  assert.equal(ok(await call(account, 'GET')).config.email, false);
});

// Two addresses on one deployment (WEBAUTHN_ORIGINS). Each address has its own cookie jar, as browsers keep per host.
const A = ORIGIN, B = 'https://dink.example.test', hostB = 'dink.example.test';
const postAt = (origin, jarCookie, body) => call(account, 'POST', { body, jar: false, headers: { origin, ...(jarCookie ? { cookie: jarCookie } : {}) } });
const jarOf = r => r.setCookie.split(';')[0];
process.env.WEBAUTHN_ORIGINS = `${A},${B}`;

await step('two addresses: a passkey made on A signs in on A, is refused on B; a second one made on B signs in on B', async () => {
  const authA = makeAuthenticator({ rpId, origin: A });
  let o = ok(await postAt(A, null, { action: 'register-options', name: 'Two Hosts' }));
  assert.equal(o.options.rp.id, rpId);
  const reg = await postAt(A, null, { action: 'register', challengeId: o.challengeId, credential: authA.create(o.options.challenge), name: 'Two Hosts' });
  const jarA = jarOf(reg);
  assert.equal(ok(reg, 201).account.passkeysHere, 1);
  assert.equal((await pg.query(`SELECT rp_id FROM passkeys WHERE id = $1`, [authA.id])).rows[0].rp_id, rpId);
  // A passkey with no recorded RP ID (made before the column existed) counts as the legacy address.
  await pg.query(`UPDATE passkeys SET rp_id = NULL WHERE id = $1`, [authA.id]);
  const loginAt = async (origin, auth) => {
    const lo = ok(await postAt(origin, null, { action: 'login-options' }));
    return postAt(origin, null, { action: 'login', challengeId: lo.challengeId, credential: auth.get(lo.options.challenge) });
  };
  assert.equal((await loginAt(A, authA)).status, 200);
  assert.equal((await loginAt(B, authA)).status, 401); // wrong address for this passkey
  // Session on A hands a one-time code to B; B trades it for a passkey made there.
  const c = ok(await postAt(A, jarA, { action: 'passkey-code' })).code;
  assert.equal((await postAt(B, null, { action: 'handoff-options', code: 'WRONGCODE1' })).status, 400);
  const ho = ok(await postAt(B, null, { action: 'handoff-options', code: c.toLowerCase() }));
  assert.equal(ho.options.rp.id, hostB);
  assert.equal((await postAt(B, null, { action: 'handoff-options', code: c })).status, 400); // single use
  const authB = makeAuthenticator({ rpId: hostB, origin: B });
  const added = await postAt(B, null, { action: 'handoff-add', challengeId: ho.challengeId, credential: authB.create(ho.options.challenge) });
  assert.equal(ok(added).account.passkeys, 2);
  assert.equal(added.json.account.passkeysHere, 1);
  assert.equal(added.json.account.host, hostB);
  assert.equal((await loginAt(B, authB)).status, 200);
  assert.equal((await loginAt(A, authB)).status, 401);
  assert.equal((await loginAt(A, authA)).status, 200); // the old address keeps working
  // Account data is shared: the session made on B reads the same account.
  assert.equal(ok(await call(account, 'GET', { jar: false, headers: { host: hostB, cookie: jarOf(added) } })).account.name, 'Two Hosts');
  // Cookie-authenticated POSTs from an unlisted origin are refused, on either session.
  assert.equal((await postAt('https://evil.example', jarA, { action: 'passkey-code' })).status, 403);
});

await step('two addresses: an origin outside the list cannot register or sign in', async () => {
  const evil = makeAuthenticator({ rpId: 'evil.example', origin: 'https://evil.example' });
  assert.equal((await postAt('https://evil.example', null, { action: 'register-options' })).status, 403);
  assert.equal((await postAt('https://evil.example', null, { action: 'login-options' })).status, 403);
  const o = ok(await postAt(A, null, { action: 'register-options' }));
  assert.equal((await postAt(A, null, { action: 'register', challengeId: o.challengeId, credential: evil.create(o.options.challenge) })).status, 400);
});

delete process.env.WEBAUTHN_ORIGINS;
await step('legacy single pair is unchanged once WEBAUTHN_ORIGINS is unset', async () => {
  assert.equal((await postAt(B, null, { action: 'login-options' })).status, 403);
  const lo = ok(await postAt(A, null, { action: 'login-options' }));
  assert.equal(lo.options.rpId, rpId);
});

console.log(`\n${passed} account checks passed`);
process.exit(0);
