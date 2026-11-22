// Web Push (opt-in "you're up" notifications). Standard VAPID + aes128gcm (RFC 8030, 8188, 8291, 8292) with node:crypto only, no dependency.
// Reached through /api/live (push-* actions, see live.js; the function count is at its limit). Off until VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and
// VAPID_SUBJECT are set in the environment: every route then answers that notifications are not set up, and nothing is ever sent.
// A subscription belongs to one club and one claimed player name (proven by that phone's player token), so a notification only goes to the
// phone of a member of the affected club. The text carries a first name as typed in the club and a court number, nothing else (league messages
// add the league's name, the opponents and the day, and go only to the players in that week or match, through the same opt-in rules in notify).
import { createPrivateKey, createPublicKey, createECDH, createCipheriv, hkdfSync, randomBytes, sign } from 'node:crypto';
import { nameKey } from './_names.js';
import { suggest } from './_court.js';
import { slotOf, weekByes } from './_league.js';

export const PUSH_ACTIONS = ['push-status', 'push-subscribe', 'push-unsubscribe', 'push-categories'];
// What a phone can switch on or off, per club and per device. push_subs.categories is null for "all on" (every device made before categories existed);
// a message with no category (organizer requests, _approvals.js) is never filtered.
export const PUSH_CATEGORIES = ['nights', 'confirm', 'events', 'league'];
export function cleanCategories(v) {
  if (!Array.isArray(v)) throw fail(400, 'Pick which notifications you want.');
  return PUSH_CATEGORIES.filter(c => v.includes(c));
}
const wants = (cats, category) => !category || !cats || cats.includes(category);
const fail = (status, message) => Object.assign(new Error(message), { status }); // _db.js is only loaded inside the routes, so the pure parts below run under `npm test` without an install
const MAX_PER_PLAYER = 5, MAX_PER_CLUB = 500, MAX_CALLS_PER_HOUR = 30;
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');

export function vapidFromEnv(env = process.env) {
  const pub = String(env.VAPID_PUBLIC_KEY || '').trim(), priv = String(env.VAPID_PRIVATE_KEY || '').trim(), subject = String(env.VAPID_SUBJECT || '').trim();
  if (!pub || !priv || !/^(mailto:|https:\/\/)/.test(subject) || unb64u(pub).length !== 65 || unb64u(priv).length !== 32) return null;
  return { pub, priv, subject };
}

// Only the browsers' own push services may be called: the endpoint comes from a phone, so anything else would let a client aim this server at any address.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
export function validEndpoint(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  return String(raw).length <= 600 && u.protocol === 'https:' && !u.port && !u.username && PUSH_HOSTS.some(r => r.test(u.hostname));
}
export function cleanSubscription(sub) {
  const s = sub && typeof sub === 'object' ? sub : {}, k = s.keys || {};
  if (!validEndpoint(s.endpoint)) throw fail(400, 'That notification address was not accepted. Try turning notifications on again.');
  if (unb64u(k.p256dh).length !== 65 || unb64u(k.auth).length !== 16) throw fail(400, 'That notification key was not accepted. Try turning notifications on again.');
  return { endpoint: String(s.endpoint), p256dh: String(k.p256dh), auth: String(k.auth) };
}

// ---- encryption and the signed request ----
const hk = (salt, ikm, info, len) => Buffer.from(hkdfSync('sha256', ikm, salt, info, len));

// RFC 8291: one aes128gcm record. Returns the request body.
export function encrypt(payload, p256dh, auth, { salt = randomBytes(16), ephemeral } = {}) {
  const ua = unb64u(p256dh), as = ephemeral || createECDH('prime256v1');
  if (!ephemeral) as.generateKeys();
  const asPub = as.getPublicKey(), secret = as.computeSecret(ua);
  const prk = hk(unb64u(auth), secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const cek = hk(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hk(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head); head.writeUInt32BE(4096, 16); head[20] = asPub.length;
  return Buffer.concat([head, asPub, body]);
}

// RFC 8292: ES256 token naming the push service, valid 12 hours.
export function vapidHeader(vapid, endpoint, now = Date.now()) {
  const pub = unb64u(vapid.pub);
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: vapid.priv, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  const data = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject }));
  return `vapid t=${data}.${b64u(sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }))}, k=${vapid.pub}`;
}

// The real sender: returns the push service's status (201 sent, 404/410 the subscription is gone).
export async function sendWebPush(sub, message, vapid, fetchFn = globalThis.fetch) {
  const res = await fetchFn(sub.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
    headers: { Authorization: vapidHeader(vapid, sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' },
    body: encrypt(JSON.stringify(message), sub.p256dh, sub.auth) });
  return res.status;
}
let sender = sendWebPush;
export const setSender = fn => { sender = fn || sendWebPush; }; // tests swap in a mock; nothing else calls this

// ---- who gets what (pure) ----
const short = (s, n) => String(s).slice(0, n);
// A round went live: every player in a match hears their court.
export function roundMessages(event, round) {
  const out = new Map();
  for (const m of round.matches || []) for (const name of (m.teams || []).flat()) {
    if (typeof name === 'string') out.set(name, { title: short(event.name || 'Dink Score', 40) + ': round ' + round.n, body: `${short(name, 30)}, you're up on court ${m.court}.`, tag: 'round-' + event.id, category: 'events' });
  }
  return out;
}
// A game ended on the open play board: whoever is next in line for a court that just came free hears it (the suggested group, as the board shows it).
export function courtFreeMessages(before, after) {
  const out = new Map();
  for (const g of suggest(after)) {
    const was = before.courts[g.court - 1];
    if (!was || !was.teams) continue; // only courts that were in a game a moment ago
    for (const name of g.teams.flat()) out.set(name, { title: 'Court free', body: `${short(name, 30)}, court ${g.court} is free. You're up next.`, tag: 'court-' + g.court, category: 'events' });
  }
  return out;
}

// 'Sat 14 Mar at 10:00, court 2' from a league slot ({ date, time, court }); the date is read as a calendar date, never through a time zone.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function whenText(slot) {
  const d = slot.date && new Date(slot.date + 'T00:00:00Z');
  const day = d && !isNaN(d) ? `on ${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${slot.time ? ' at ' + slot.time : ''}` : 'this week';
  return day + (slot.court ? `, court ${slot.court}` : '');
}
const versus = (m, name) => { const i = m.teams.findIndex(t => t.includes(name)); return m.teams[1 - i].map(p => short(p, 30)).join(' & '); };
// A league week opened (or the organizer pressed "tell the players"): everyone with a match hears who, when and where; whoever rests hears the bye.
export function leagueWeekMessages(league, week) {
  const out = new Map(), tag = 'league-' + league.id, title = short(league.name || 'League', 40) + ': ' + week.title.toLowerCase();
  for (const m of week.matches) {
    if (m.status === 'done') continue;
    for (const name of m.teams.flat()) out.set(name, { title, body: `${short(name, 30)}, you play ${versus(m, name)} ${whenText(slotOf(week, m))}.`, tag, category: 'league' });
  }
  for (const b of weekByes(league, week)) for (const name of b.members) out.set(name, { title, body: `${short(name, 30)}, you have a bye this week.`, tag, category: 'league' });
  return out;
}
// One match was moved by the organizer: its players hear the new day, time and court.
export function leagueMovedMessages(league, week, m) {
  const out = new Map(), title = short(league.name || 'League', 40) + ': match moved';
  for (const name of m.teams.flat()) out.set(name, { title, body: `${short(name, 30)}, you play ${versus(m, name)} ${whenText(slotOf(week, m))}.`, tag: `league-${league.id}-${m.id}`, category: 'league' });
  return out;
}
// A league match was played: its players hear that the result is in, never the score or who won (the one who entered it is not told about their own entry).
export function leagueResultMessages(league, m, by) {
  const out = new Map(), title = short(league.name || 'League', 40) + ': result in', skip = by ? nameKey(by) : null;
  for (const name of (m.teams || []).flat()) if (typeof name === 'string' && nameKey(name) !== skip) out.set(name, { title, body: `${short(name, 30)}, the result of your match is in. Open the league to see the standings.`, tag: `league-${league.id}-${m.id}`, category: 'league' });
  return out;
}

// Sends `messages` (Map name -> {title, body, tag}) to the phones subscribed in this club by those players. Never throws and never waits long:
// a dead subscription (404/410) is removed, anything else is left for next time. Returns how many were sent.
export async function notify(sql, clubCode, messages, vapid = vapidFromEnv()) {
  if (!vapid || !messages.size) return 0;
  try {
    const keys = [...messages.keys()].map(nameKey);
    const rows = await sql`SELECT s.endpoint, s.p256dh, s.auth, s.name_key, s.categories FROM push_subs s JOIN roster r ON r.club = s.club AND r.name_key = s.name_key
      WHERE s.club = ${clubCode} AND r.claim_hash IS NOT NULL AND r.blocked_at IS NULL AND s.name_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))`;
    const byKey = new Map([...messages].map(([n, m]) => [nameKey(n), m]));
    let sent = 0;
    await Promise.all(rows.map(async r => {
      const { category, ...message } = byKey.get(r.name_key);
      if (!wants(r.categories, category)) return; // this device switched that kind of message off
      try {
        const status = await sender({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, { ...message, url: '/' }, vapid);
        if (status === 404 || status === 410) await sql`DELETE FROM push_subs WHERE club = ${clubCode} AND endpoint = ${r.endpoint}`;
        else if (status >= 200 && status < 300) sent++;
      } catch { /* the push service is down or slow: skip this phone */ }
    }));
    return sent;
  } catch { return 0; } // a failed notification never fails the action that caused it
}

// ---- routes (POST /api/live {code, action: 'push-*'}) ----
async function throttle(sql, req) {
  const { clientIp } = await import('./_db.js');
  const key = 'push:' + clientIp(req);
  await sql`INSERT INTO lookup_fails (ip) VALUES (${key})`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '1 hour'`;
  if (Number(n) > MAX_CALLS_PER_HOUR) throw fail(429, 'Too many notification changes from this network. Try again in an hour.');
}

export async function pushAction(sql, club, body, req) {
  const vapid = vapidFromEnv();
  if (!vapid) return { enabled: false, message: 'Notifications are not set up on this server yet.' };
  await throttle(sql, req);
  const { tokenMatches } = await import('./_db.js');
  const code = club.code, action = body.action;
  // A linked player: the phone that claimed this name, proven by its player token.
  const [who] = body.playerName && body.playerToken ? await sql`SELECT name_key, claim_hash FROM roster WHERE club = ${code} AND name_key = ${nameKey(body.playerName)} AND blocked_at IS NULL` : [];
  if (!who || !who.claim_hash || !tokenMatches(who.claim_hash, body.playerToken)) throw fail(403, 'Pick your name in the club on this phone first to get notifications.');
  const key = who.name_key;
  if (action === 'push-status') {
    // A device the creating phone subscribed before organizer requests existed gets its flag here (_approvals.js).
    if (body.endpoint && club.owner_hash && tokenMatches(club.owner_hash, body.ownerToken)) await sql`UPDATE push_subs SET organizer = true WHERE club = ${code} AND name_key = ${key} AND endpoint = ${String(body.endpoint)}`;
    const [row] = body.endpoint ? await sql`SELECT 1 AS x FROM push_subs WHERE club = ${code} AND name_key = ${key} AND endpoint = ${String(body.endpoint)}` : [];
    const [cur] = row && body.endpoint ? await sql`SELECT categories FROM push_subs WHERE club = ${code} AND name_key = ${key} AND endpoint = ${String(body.endpoint)}` : [];
    return { enabled: true, publicKey: vapid.pub, subscribed: !!row, categories: row ? (cur && cur.categories) || PUSH_CATEGORIES : null };
  }
  if (action === 'push-categories') {
    // This device only (this name, this club, this endpoint); a device that is not subscribed has nothing to change.
    const cats = cleanCategories(body.categories);
    const rows = await sql`UPDATE push_subs SET categories = ${cats}::text[] WHERE club = ${code} AND name_key = ${key} AND endpoint = ${String(body.endpoint || '')} RETURNING endpoint`;
    if (!rows.length) throw fail(404, 'Turn notifications on for this phone first.');
    return { enabled: true, categories: cats };
  }
  if (action === 'push-subscribe') {
    const s = cleanSubscription(body.subscription);
    const [{ mine, club: total, has }] = await sql`SELECT count(*) FILTER (WHERE name_key = ${key})::int AS mine, count(*)::int AS club, count(*) FILTER (WHERE endpoint = ${s.endpoint})::int AS has FROM push_subs WHERE club = ${code}`;
    if (!Number(has) && Number(mine) >= MAX_PER_PLAYER) throw fail(409, `You already get notifications on ${MAX_PER_PLAYER} devices. Turn one off first.`);
    if (!Number(has) && Number(total) >= MAX_PER_CLUB) throw fail(409, 'This club has as many notification devices as it can hold.');
    const organizer = !!(club.owner_hash && tokenMatches(club.owner_hash, body.ownerToken)); // the creating phone: it hears organizer requests too (_approvals.js)
    await sql`INSERT INTO push_subs (club, endpoint, name_key, p256dh, auth, organizer) VALUES (${code}, ${s.endpoint}, ${key}, ${s.p256dh}, ${s.auth}, ${organizer})
      ON CONFLICT (club, endpoint) DO UPDATE SET name_key = EXCLUDED.name_key, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, organizer = EXCLUDED.organizer`;
    return { enabled: true, subscribed: true };
  }
  if (action === 'push-unsubscribe') {
    // Your own device (this name) in this club; the endpoint alone is not enough.
    await sql`DELETE FROM push_subs WHERE club = ${code} AND name_key = ${key} AND endpoint = ${String(body.endpoint || '')}`;
    return { enabled: true, subscribed: false };
  }
  throw fail(400, 'Unknown action.');
}
