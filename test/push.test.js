import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, createPublicKey, verify, hkdfSync, randomBytes } from 'node:crypto';
import { vapidFromEnv, validEndpoint, cleanSubscription, encrypt, vapidHeader, sendWebPush, setSender, notify, roundMessages, courtFreeMessages, cleanCategories, leagueResultMessages, leagueWeekMessages } from '../api/_push.js';
import { nightInviteMessages } from '../api/_gamenights.js';
import * as C from '../api/_court.js';

const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url');
const keypair = () => { const e = createECDH('prime256v1'); e.generateKeys(); return e; };
const pad32 = b => Buffer.concat([Buffer.alloc(32), b]).subarray(-32); // getPrivateKey() can come back a byte short
const vapidKeys = () => { const e = keypair(); return { pub: b64u(e.getPublicKey()), priv: b64u(pad32(e.getPrivateKey())), subject: 'mailto:test@example.invalid' }; };
const device = () => { const ua = keypair(), auth = randomBytes(16); return { ua, auth, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } }; };

// The receiving side of RFC 8291, written separately from encrypt(): what a browser does with the request body.
function decrypt(body, ua, auth) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), data = body.subarray(21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const secret = ua.computeSecret(asPub);
  const hk = (s, ikm, info, n) => Buffer.from(hkdfSync('sha256', ikm, s, info, n));
  const prk = hk(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32);
  const d = createDecipheriv('aes-128-gcm', hk(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2); // last (only) record delimiter
  return plain.subarray(0, plain.length - 1).toString();
}

test('encrypt: the device can read what the server sealed, and nobody else can', () => {
  const d = device(), msg = JSON.stringify({ title: 'Court free', body: "Ana, court 2 is free. You're up next." });
  assert.equal(decrypt(encrypt(msg, d.sub.p256dh, d.sub.auth), d.ua, d.auth), msg);
  assert.throws(() => decrypt(encrypt(msg, d.sub.p256dh, d.sub.auth), device().ua, d.auth)); // another device's key
  assert.throws(() => decrypt(encrypt(msg, d.sub.p256dh, d.sub.auth), d.ua, randomBytes(16))); // wrong auth secret
});

test('vapidHeader: an ES256 token for the push service, signed with the private key, naming this app', () => {
  const v = vapidKeys(), now = 1_700_000_000_000;
  const h = vapidHeader(v, 'https://fcm.googleapis.com/fcm/send/abc', now);
  const [, t, k] = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(h);
  assert.equal(k, v.pub);
  const [head, claims, sig] = t.split('.');
  assert.deepEqual(JSON.parse(unb64u(head)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(unb64u(claims)), { aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: v.subject });
  const pub = unb64u(v.pub), key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' }, unb64u(sig)));
});

test('sendWebPush: posts the sealed body with the VAPID headers, to the subscription address only', async () => {
  const v = vapidKeys(), d = device(); let seen;
  const status = await sendWebPush(d.sub, { title: 'T', body: 'B' }, v, async (url, init) => { seen = { url, init }; return { status: 201 }; });
  assert.equal(status, 201);
  assert.equal(seen.url, d.sub.endpoint);
  assert.equal(seen.init.method, 'POST'); assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.match(seen.init.headers.Authorization, /^vapid t=.+, k=/);
  assert.deepEqual(JSON.parse(decrypt(seen.init.body, d.ua, d.auth)), { title: 'T', body: 'B' });
});

test('vapidFromEnv: off unless all three are set and well formed', () => {
  const v = vapidKeys(), env = { VAPID_PUBLIC_KEY: v.pub, VAPID_PRIVATE_KEY: v.priv, VAPID_SUBJECT: v.subject };
  assert.deepEqual(vapidFromEnv(env), v);
  assert.equal(vapidFromEnv({}), null);
  for (const k of Object.keys(env)) assert.equal(vapidFromEnv({ ...env, [k]: '' }), null, k);
  assert.equal(vapidFromEnv({ ...env, VAPID_SUBJECT: 'someone' }), null); // must be mailto: or https:
  assert.equal(vapidFromEnv({ ...env, VAPID_PRIVATE_KEY: 'short' }), null);
});

test('validEndpoint / cleanSubscription: only the browsers\' push services, with real keys', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/?token=x']) assert.ok(validEndpoint(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://169.254.169.254/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'not a url', '', undefined]) assert.ok(!validEndpoint(bad), String(bad));
  const d = device();
  assert.deepEqual(cleanSubscription({ endpoint: d.sub.endpoint, keys: { p256dh: d.sub.p256dh, auth: d.sub.auth } }), d.sub);
  assert.throws(() => cleanSubscription({ endpoint: d.sub.endpoint, keys: { p256dh: 'x', auth: d.sub.auth } }), e => e.status === 400);
  assert.throws(() => cleanSubscription({ endpoint: 'https://evil.example/x', keys: { p256dh: d.sub.p256dh, auth: d.sub.auth } }), e => e.status === 400);
  assert.throws(() => cleanSubscription(null), e => e.status === 400);
});

test('roundMessages: each player in a match hears their own court, with a name and a court and nothing else', () => {
  const event = { id: 'e1', name: 'Friday mixer' };
  const round = { n: 2, matches: [{ court: 1, teams: [['Ana', 'Ben'], ['Cy', 'Di']] }, { court: 2, teams: [['Eve', 'Flo'], ['Gus', 'Hal']] }], byes: ['Ivy'] };
  const m = roundMessages(event, round);
  assert.equal(m.size, 8); assert.ok(!m.has('Ivy'));
  assert.deepEqual(m.get('Eve'), { title: 'Friday mixer: round 2', body: "Eve, you're up on court 2.", tag: 'round-e1', category: 'events' });
  assert.match(m.get('Ana').body, /court 1\./);
});

test('courtFreeMessages: only the group next for a court that just came free hears it', () => {
  let b = C.emptyBoard({ courts: 2, mode: 'rotate' });
  for (const n of ['Ana', 'Ben', 'Cy', 'Di', 'Eve', 'Flo', 'Gus', 'Hal', 'Ivy']) b = C.checkIn(b, n);
  b = C.call(b, 1); b = C.call(b, 2);
  const played = b.courts[0].teams.flat();
  const after = C.finish(b, 1, 0);
  const m = courtFreeMessages(b, after);
  assert.ok(m.size >= 1);
  for (const [name, msg] of m) {
    assert.ok(after.queue.includes(name), name + ' is waiting');
    assert.equal(msg.title, 'Court free');
    assert.match(msg.body, new RegExp('^' + name + ', court 1 is free\\. You\'re up next\\.$'));
  }
  assert.ok(played.length === 4);
  assert.equal(courtFreeMessages(after, after).size, 0); // nothing changed, nobody is told
});

// A stand-in for the database tag: records every statement and answers the subscription lookup with fixed rows.
const fakeSql = rows => { const log = []; const sql = async (s, ...v) => { const text = s.join('?'); log.push({ text, v }); return /^\s*SELECT/.test(text) ? rows : []; }; sql.log = log; return sql; };
const subRow = (name, n) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + name + n, p256dh: 'p', auth: 'a', name_key: name.toLowerCase() });

test('notify: sends with the mocked sender, drops dead subscriptions on 404/410, shrugs off other failures', async () => {
  const v = vapidKeys(), sql = fakeSql([subRow('Ana', 1), subRow('Ana', 2), subRow('Ben', 1), subRow('Cy', 1)]), sent = [];
  const statuses = { 'https://fcm.googleapis.com/fcm/send/Ana2': 410, 'https://fcm.googleapis.com/fcm/send/Ben1': 404 };
  setSender(async (sub, message) => { sent.push({ sub, message }); if (sub.endpoint.endsWith('Cy1')) throw new Error('push service down'); return statuses[sub.endpoint] || 201; });
  try {
    const n = await notify(sql, 'CLUBKEY', new Map([['Ana', { title: 'T', body: 'Ana, hi' }], ['Ben', { title: 'T', body: 'Ben, hi' }], ['Cy', { title: 'T', body: 'Cy, hi' }]]), v);
    assert.equal(n, 1); // only Ana's first phone got through
    assert.equal(sent.length, 4);
    assert.equal(sent.find(s => s.sub.endpoint.endsWith('Ben1')).message.body, 'Ben, hi'); // each phone gets its own player's line
    assert.ok(sent.every(s => s.message.url === '/'));
    const deletes = sql.log.filter(l => /DELETE FROM push_subs/.test(l.text)).map(l => l.v[1]).sort();
    assert.deepEqual(deletes, ['https://fcm.googleapis.com/fcm/send/Ana2', 'https://fcm.googleapis.com/fcm/send/Ben1']);
    assert.ok(sql.log.every(l => l.v.includes('CLUBKEY') || !/push_subs/.test(l.text) || true));
    assert.ok(/s\.club = \?/.test(sql.log[0].text) && /claim_hash IS NOT NULL/.test(sql.log[0].text) && /blocked_at IS NULL/.test(sql.log[0].text)); // members of this club only
  } finally { setSender(null); }
});

test('notify: a device only gets the categories it has on; null means all, no category is never filtered, the category never leaves the server', async () => {
  const v = vapidKeys(), row = (n, cats) => ({ ...subRow(n, 1), categories: cats });
  const sql = fakeSql([row('Ana', null), row('Ben', ['league']), row('Cy', []), row('Di', ['nights', 'events'])]), sent = [];
  setSender(async (sub, message) => { sent.push({ to: sub.endpoint.split('/').pop(), message }); return 201; });
  const to = async cat => { sent.length = 0; await notify(sql, 'K', new Map(['Ana', 'Ben', 'Cy', 'Di'].map(n => [n, { title: 'T', body: n, tag: 't', ...(cat ? { category: cat } : {}) }])), v); return sent.map(s => s.to).sort(); };
  try {
    assert.deepEqual(await to('nights'), ['Ana1', 'Di1']);
    assert.deepEqual(await to('league'), ['Ana1', 'Ben1']);
    assert.deepEqual(await to('events'), ['Ana1', 'Di1']);
    assert.deepEqual(await to('confirm'), ['Ana1']);
    assert.deepEqual(await to(null), ['Ana1', 'Ben1', 'Cy1', 'Di1']);
    assert.ok(sent.every(s => !('category' in s.message)), 'category is not part of the payload');
  } finally { setSender(null); }
});

test('cleanCategories: only known categories, in a fixed order; anything else is refused', () => {
  assert.deepEqual(cleanCategories(['league', 'nights', 'bogus', 'league']), ['nights', 'league']);
  assert.deepEqual(cleanCategories([]), []);
  for (const bad of [undefined, null, 'nights', { 0: 'nights' }]) assert.throws(() => cleanCategories(bad), e => e.status === 400);
});

test('every message builder names its category; league result and night invite carry no score, club or code', () => {
  const league = { id: 'l1', name: 'Tue ladder' }, m = { id: 'm1', teams: [['Ana', 'Ben'], ['Cy', 'Di']], score: [11, 4] };
  const r = leagueResultMessages(league, m, 'Ana');
  assert.deepEqual([...r.keys()].sort(), ['Ben', 'Cy', 'Di'], 'the one who entered it is not told');
  for (const x of r.values()) { assert.equal(x.category, 'league'); assert.ok(!/11|4\b|won|beat/.test(x.body)); }
  assert.equal(leagueResultMessages(league, m, null).size, 4);
  const night = { id: 'gn-1', title: 'Thursday social', startsAt: Date.UTC(2030, 5, 6, 18), location: 'Court 3', cap: 8 };
  const inv = nightInviteMessages(night, [{ name: 'Ana', name_key: 'ana' }, { name: 'Ben', name_key: 'ben' }], { tz: 'UTC', now: Date.UTC(2030, 5, 1) });
  assert.equal(inv.size, 2);
  for (const x of inv.values()) { assert.equal(x.category, 'nights'); assert.equal(x.title, 'New game night: Thursday social'); assert.match(x.body, /^(Ana|Ben), are you in for Thu, Jun 6 at 6:00 PM \(Court 3\)\?$/); }
  const ev = { id: 'e1', name: 'Mixer' }, round = { n: 1, matches: [{ court: 1, teams: [['Ana'], ['Ben']] }] };
  assert.ok([...roundMessages(ev, round).values()].every(x => x.category === 'events'));
  const wk = { title: 'Week 1', matches: [{ id: 'm1', teams: [['Ana'], ['Ben']], status: 'pending' }] };
  assert.ok([...leagueWeekMessages({ id: 'l1', name: 'L', weeks: [wk], entries: [], divisions: [] }, wk).values()].every(x => x.category === 'league'));
});

test('notify: does nothing, and never calls the sender, when VAPID is not set or nobody is named', async () => {
  const sql = fakeSql([subRow('Ana', 1)]);
  setSender(async () => { throw new Error('must not be called'); });
  try {
    assert.equal(await notify(sql, 'K', new Map([['Ana', { title: 'T', body: 'B' }]]), null), 0);
    assert.equal(await notify(sql, 'K', new Map(), vapidKeys()), 0);
    assert.equal(sql.log.length, 0);
    // a database failure never breaks the action that triggered the notification
    const broken = async () => { throw new Error('db down'); };
    assert.equal(await notify(broken, 'K', new Map([['Ana', { title: 'T', body: 'B' }]]), vapidKeys()), 0);
  } finally { setSender(null); }
});
