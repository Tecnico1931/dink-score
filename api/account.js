// Optional accounts: sign in with a passkey (WebAuthn) to keep your clubs and history across phones. Nothing else in the API
// depends on this file: a phone with no account works exactly as before.
//
// GET  /api/account                          -> { config, account, identities } (account is null when signed out)
// POST /api/account {action: ...}
//   register-options {name?}                 -> passkey creation options for a brand new account
//   register {challengeId, credential, name?}-> creates the account, starts a session
//   login-options                            -> passkey request options
//   login {challengeId, credential}          -> starts a session
//   logout                                   -> ends this session
//   passkey-options / passkey-add            -> (signed in) add another passkey to the account
//   claim {items: [{code, ownerToken?, playerName?, playerToken?}]}
//                                            -> (signed in) links club identities this phone can already prove it holds
//   restore {items: [{code, kind, name?}]}   -> (signed in) hands a new phone fresh tokens for identities linked earlier
//   delete-account                           -> removes the account, its passkeys, sessions and links (clubs are untouched)
//
// Sign-in is a passkey only: no passwords. RP ID and origin come from the deployment host (WEBAUTHN_RP_ID, WEBAUTHN_ORIGIN).
// Hook for email magic links (not built: needs a custom domain and a mail provider): add an `email-start` / `email-finish`
// pair that ends in startSession(res, accountId), exactly as `login` does below, and a verified `email` column on accounts.
import { createHash, randomBytes } from 'node:crypto';
import { db, handler, send, readBody, fail, cleanCode, requireClub, clientIp, cleanName, nameKey, hashToken, newOwnerToken, tokenMatches } from './_db.js';
import { b64u, newChallenge, creationOptions, requestOptions, verifyRegistration, verifyAssertion } from './_webauthn.js';

const COOKIE = '__Host-dink_session'; // __Host-: Secure, Path=/, no Domain, so no sibling host can set or read it
const SESSION_DAYS = 30;
const MAX_IDENTITIES = 100, MAX_CLAIMS_PER_CALL = 30, MAX_PASSKEYS = 10;

export function config() {
  const rpId = process.env.WEBAUTHN_RP_ID || 'dinkscore.vercel.app';
  return { rpId, origin: process.env.WEBAUTHN_ORIGIN || 'https://' + rpId, rpName: 'Dink Score' };
}

const sha = s => createHash('sha256').update(s).digest('hex');
const cleanLabel = raw => cleanName(raw).slice(0, 40);

// Per-address limits share the lookup_fails table with the club-code and PIN limits. Record first, then count, so
// simultaneous requests see each other. `forgive` removes the mark when the attempt turned out fine.
async function throttle(sql, req, kind, max, window) {
  const key = `acct-${kind}:${clientIp(req)}`;
  const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - ${window}::interval`;
  if (n > max) throw fail(429, 'Too many attempts. Wait a few minutes and try again.');
  return () => sql`DELETE FROM lookup_fails WHERE id = ${id}`;
}

function cookieOf(req) {
  for (const part of String((req.headers || {}).cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}
const setCookie = (res, value, maxAge) => res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);

async function startSession(sql, res, accountId) {
  const token = b64u(randomBytes(32));
  await sql`INSERT INTO sessions (id_hash, account_id, expires_at) VALUES (${sha(token)}, ${accountId}, now() + ${SESSION_DAYS + ' days'}::interval)`;
  if (Math.random() < 0.05) await sql`DELETE FROM sessions WHERE expires_at < now()`;
  setCookie(res, token, SESSION_DAYS * 86400);
}

async function sessionAccount(sql, req) {
  const token = cookieOf(req);
  if (!token || token.length > 100) return null;
  const [row] = await sql`SELECT a.id, a.display_name, a.created_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id_hash = ${sha(token)} AND s.expires_at > now()`;
  return row || null;
}

// Cookie-authenticated changes must come from our own page: the Origin header has to be ours.
function sameOrigin(req) {
  if ((req.headers || {}).origin !== config().origin) throw fail(403, 'That request did not come from the Dink Score page.');
}

async function newChallengeRow(sql, kind, accountId) {
  await sql`DELETE FROM auth_challenges WHERE created_at < now() - interval '10 minutes'`;
  const id = b64u(randomBytes(16)), challenge = newChallenge();
  await sql`INSERT INTO auth_challenges (id, challenge, kind, account_id) VALUES (${id}, ${challenge}, ${kind}, ${accountId || null})`;
  return { id, challenge };
}
// A challenge answers one ceremony once: taking it deletes it, whether or not the answer then checks out.
async function takeChallenge(sql, id, kind) {
  if (typeof id !== 'string' || id.length > 40) throw fail(400, 'That sign-in expired. Start again.');
  const [row] = await sql`DELETE FROM auth_challenges WHERE id = ${id} AND kind = ${kind} AND created_at > now() - interval '5 minutes' RETURNING challenge, account_id`;
  if (!row) throw fail(400, 'That sign-in expired. Start again.');
  return row;
}

const identityRows = (sql, accountId) => sql`
  SELECT i.club, i.kind, i.name_key, i.proof, c.name AS club_name, coalesce(c.public_code, c.code) AS code, c.owner_hash, r.name AS player_name, r.claim_hash
  FROM account_identities i JOIN clubs c ON c.code = i.club LEFT JOIN roster r ON r.club = i.club AND r.name_key = i.name_key AND i.kind = 'player'
  WHERE i.account_id = ${accountId} ORDER BY c.name, i.kind, i.name_key`;
const fresh = row => row.proof === (row.kind === 'organizer' ? row.owner_hash : row.claim_hash);

async function view(sql, account) {
  const rows = await identityRows(sql, account.id);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM passkeys WHERE account_id = ${account.id}`;
  return {
    account: { name: account.display_name, passkeys: n, createdAt: account.created_at },
    // `stale` = the organizer released the name or the club's creating phone changed since it was linked: it can't be restored.
    identities: rows.map(r => ({ code: r.code, club: r.club_name, kind: r.kind, name: r.kind === 'player' ? r.player_name : null, stale: !fresh(r) }))
  };
}

export default handler(async (req, res) => {
  const sql = db(), cfg = config();
  const publicConfig = { rpId: cfg.rpId, origin: cfg.origin };
  if (req.method === 'GET') {
    const account = await sessionAccount(sql, req);
    return send(res, 200, account ? { config: publicConfig, ...(await view(sql, account)) } : { config: publicConfig, account: null, identities: [] });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  sameOrigin(req);
  const body = await readBody(req);
  const action = String(body.action || '');

  if (action === 'register-options') {
    await throttle(sql, req, 'opts', 30, '15 minutes');
    const name = cleanLabel(body.name) || 'Dink Score player';
    const userId = b64u(randomBytes(16));
    const ch = await newChallengeRow(sql, 'register', userId); // the id the account will get, held until the passkey proves it
    return send(res, 200, { challengeId: ch.id, options: creationOptions({ rpId: cfg.rpId, rpName: cfg.rpName, userId, userName: name, challenge: ch.challenge }) });
  }
  if (action === 'register') {
    await throttle(sql, req, 'new', 10, '1 hour'); // every attempt counts, successful or not
    const ch = await takeChallenge(sql, body.challengeId, 'register');
    let reg;
    try { reg = verifyRegistration({ credential: body.credential, challenge: ch.challenge, origin: cfg.origin, rpId: cfg.rpId }); }
    catch { throw fail(400, 'That passkey could not be verified. Try again.'); }
    const name = cleanLabel(body.name) || 'Dink Score player';
    const [used] = await sql`SELECT 1 FROM passkeys WHERE id = ${reg.credId}`;
    if (used) throw fail(409, 'That passkey is already used by an account. Sign in instead.');
    // One statement, so an account never exists without its passkey (a clash on the passkey id fails the whole statement).
    await sql`WITH a AS (INSERT INTO accounts (id, display_name) VALUES (${ch.account_id}, ${name}) RETURNING id)
      INSERT INTO passkeys (id, account_id, public_key, alg, sign_count, transports) SELECT ${reg.credId}, a.id, ${reg.spki}, ${reg.alg}, ${reg.signCount}, ${reg.transports} FROM a`;
    await startSession(sql, res, ch.account_id);
    return send(res, 201, { config: publicConfig, ...(await view(sql, { id: ch.account_id, display_name: name, created_at: new Date() })) });
  }
  if (action === 'login-options') {
    await throttle(sql, req, 'opts', 30, '15 minutes');
    const ch = await newChallengeRow(sql, 'login', null);
    return send(res, 200, { challengeId: ch.id, options: requestOptions({ rpId: cfg.rpId, challenge: ch.challenge }) });
  }
  if (action === 'login') {
    const forgive = await throttle(sql, req, 'fail', 10, '15 minutes'); // only wrong answers keep their mark
    const ch = await takeChallenge(sql, body.challengeId, 'login');
    const cred = body.credential || {};
    const [pk] = typeof cred.id === 'string' && cred.id.length < 1400 ? await sql`SELECT id, account_id, public_key, alg, sign_count FROM passkeys WHERE id = ${cred.id}` : [];
    const bad = fail(401, 'That passkey is not linked to an account here.');
    if (!pk) throw bad;
    let out;
    try { out = verifyAssertion({ credential: cred, challenge: ch.challenge, origin: cfg.origin, rpId: cfg.rpId, spki: pk.public_key, alg: pk.alg, signCount: pk.sign_count }); }
    catch { throw bad; }
    if (out.userHandle && out.userHandle !== pk.account_id) throw bad;
    // Compare-and-set the counter, so a replayed or cloned assertion racing this one can't both succeed.
    const upd = await sql`UPDATE passkeys SET sign_count = ${out.signCount}, last_used_at = now() WHERE id = ${pk.id} AND sign_count = ${pk.sign_count} RETURNING account_id`;
    if (!upd.length) throw bad;
    await forgive();
    const [account] = await sql`SELECT id, display_name, created_at FROM accounts WHERE id = ${pk.account_id}`;
    await startSession(sql, res, account.id);
    return send(res, 200, { config: publicConfig, ...(await view(sql, account)) });
  }
  if (action === 'logout') {
    const token = cookieOf(req);
    if (token && token.length <= 100) await sql`DELETE FROM sessions WHERE id_hash = ${sha(token)}`;
    setCookie(res, '', 0);
    return send(res, 200, { ok: true });
  }

  // Everything below needs a signed-in account.
  const account = await sessionAccount(sql, req);
  if (!account) throw fail(401, 'Sign in first.');

  if (action === 'passkey-options') {
    await throttle(sql, req, 'opts', 30, '15 minutes');
    const ids = (await sql`SELECT id FROM passkeys WHERE account_id = ${account.id}`).map(r => r.id);
    if (ids.length >= MAX_PASSKEYS) throw fail(400, 'An account can have up to 10 passkeys.');
    const ch = await newChallengeRow(sql, 'passkey', account.id);
    return send(res, 200, { challengeId: ch.id, options: creationOptions({ rpId: cfg.rpId, rpName: cfg.rpName, userId: account.id, userName: account.display_name || 'Dink Score player', challenge: ch.challenge, excludeIds: ids }) });
  }
  if (action === 'passkey-add') {
    const ch = await takeChallenge(sql, body.challengeId, 'passkey');
    if (ch.account_id !== account.id) throw fail(400, 'That sign-in expired. Start again.');
    let reg;
    try { reg = verifyRegistration({ credential: body.credential, challenge: ch.challenge, origin: cfg.origin, rpId: cfg.rpId }); }
    catch { throw fail(400, 'That passkey could not be verified. Try again.'); }
    const rows = await sql`INSERT INTO passkeys (id, account_id, public_key, alg, sign_count, transports) VALUES (${reg.credId}, ${account.id}, ${reg.spki}, ${reg.alg}, ${reg.signCount}, ${reg.transports}) ON CONFLICT DO NOTHING RETURNING id`;
    if (!rows.length) throw fail(409, 'That passkey is already used by an account.');
    return send(res, 200, await view(sql, account));
  }
  if (action === 'delete-account') {
    await sql`DELETE FROM accounts WHERE id = ${account.id}`; // sessions, passkeys and links go with it
    setCookie(res, '', 0);
    return send(res, 200, { ok: true });
  }

  if (action === 'claim') {
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_CLAIMS_PER_CALL) : [];
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM account_identities WHERE account_id = ${account.id}`;
    if (n >= MAX_IDENTITIES) throw fail(400, 'An account can keep up to 100 clubs and names.');
    const linked = [], skipped = [];
    for (const it of items) {
      let club;
      try { club = await requireClub(cleanCode(it && it.code), req); } catch (err) { if (err.status === 429) throw err; skipped.push({ code: String((it && it.code) || ''), reason: 'club not found' }); continue; }
      const link = async (kind, nameKey, proof) => {
        // A link another account still holds (its proof still matches) is not taken over; a stale one is replaced.
        const rows = await sql`INSERT INTO account_identities (account_id, club, kind, name_key, proof) VALUES (${account.id}, ${club.code}, ${kind}, ${nameKey}, ${proof})
          ON CONFLICT (club, kind, name_key) DO UPDATE SET account_id = EXCLUDED.account_id, proof = EXCLUDED.proof, created_at = now()
          WHERE account_identities.account_id = EXCLUDED.account_id OR account_identities.proof <> EXCLUDED.proof RETURNING 1`;
        (rows.length ? linked : skipped).push(rows.length ? { code: it.code, kind, name: nameKey } : { code: it.code, reason: 'already linked to another account' });
      };
      let any = false;
      if (it.ownerToken && club.owner_hash && tokenMatches(club.owner_hash, it.ownerToken)) { any = true; await link('organizer', '', club.owner_hash); }
      if (it.playerName && it.playerToken) {
        const k = nameKey(it.playerName);
        const [row] = await sql`SELECT claim_hash FROM roster WHERE club = ${club.code} AND name_key = ${k}`;
        if (row && row.claim_hash && tokenMatches(row.claim_hash, it.playerToken)) { any = true; await link('player', k, row.claim_hash); }
      }
      if (!any) skipped.push({ code: String(it.code), reason: 'this phone no longer holds that name' });
    }
    return send(res, 200, { linked, skipped, ...(await view(sql, account)) });
  }

  if (action === 'restore') {
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_CLAIMS_PER_CALL) : [];
    const rows = await identityRows(sql, account.id);
    const out = [];
    for (const it of items) {
      const want = it && String(it.code || '').toUpperCase();
      const k = it && it.kind === 'player' ? nameKey(it.name) : '';
      const row = rows.find(r => r.code === want && r.kind === (it.kind === 'player' ? 'player' : 'organizer') && r.name_key === k);
      if (!row || !fresh(row)) continue;
      // A new phone gets a new token, and the one the old phone held stops working: a name or a creating phone lives on one phone at a time.
      const token = newOwnerToken(), hash = hashToken(token);
      const done = row.kind === 'organizer'
        ? await sql`UPDATE clubs SET owner_hash = ${hash} WHERE code = ${row.club} AND owner_hash = ${row.proof} RETURNING code`
        : await sql`UPDATE roster SET claim_hash = ${hash} WHERE club = ${row.club} AND name_key = ${row.name_key} AND claim_hash = ${row.proof} RETURNING name`;
      if (!done.length) continue;
      await sql`UPDATE account_identities SET proof = ${hash} WHERE account_id = ${account.id} AND club = ${row.club} AND kind = ${row.kind} AND name_key = ${row.name_key}`;
      out.push({ code: row.code, club: row.club_name, kind: row.kind, name: row.kind === 'player' ? row.player_name : null, token });
    }
    return send(res, 200, { restored: out });
  }
  throw fail(400, 'Unknown action.');
});
