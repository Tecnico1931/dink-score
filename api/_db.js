// Shared helpers for the club API. Files starting with "_" are not routes.
import { neon } from '@neondatabase/serverless';
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { cleanName, nameKey } from './_names.js';
import { reportError } from './_report.js';
import { netKey, lockSeconds, waitText } from './_limits.js';

let sql = null;
let ready = null;

export function db() {
  if (!sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw Object.assign(new Error('Database is not configured'), { status: 500 });
    sql = neon(url);
  }
  return sql;
}

// Creates the tables on first use. Safe to run repeatedly.
export function ensureSchema() {
  if (!ready) {
    const q = db();
    ready = (async () => {
      await q`CREATE TABLE IF NOT EXISTS clubs (
        code text PRIMARY KEY,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS games (
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        id text NOT NULL,
        data jsonb NOT NULL,
        ended_at bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        PRIMARY KEY (club, id)
      )`;
      await q`CREATE TABLE IF NOT EXISTS roster (
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        name_key text NOT NULL,
        name text NOT NULL,
        PRIMARY KEY (club, name_key)
      )`;
      await q`CREATE INDEX IF NOT EXISTS games_club_ended ON games (club, ended_at DESC)`;
      await q`CREATE TABLE IF NOT EXISTS lookup_fails (
        ip text NOT NULL,
        at timestamptz NOT NULL DEFAULT now()
      )`;
      await q`CREATE INDEX IF NOT EXISTS lookup_fails_ip_at ON lookup_fails (ip, at)`;
      await q`ALTER TABLE lookup_fails ADD COLUMN IF NOT EXISTS id bigserial`;
      // Per-club counters for the game limits, updated atomically in reserveGames().
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS window_start timestamptz NOT NULL DEFAULT now()`;
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS window_count int NOT NULL DEFAULT 0`;
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS total_count int NOT NULL DEFAULT 0`;
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS pin_hash text`; // organizer PIN, salted scrypt hash
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS owner_hash text`; // hash of the creating phone's token
      // Moving to a new phone (api/transfer.js): encrypted one-time bundles, and a hashed single-use creator recovery code.
      await q`CREATE TABLE IF NOT EXISTS transfers (
        id_hash text PRIMARY KEY,
        blob text NOT NULL,
        expires_at timestamptz NOT NULL
      )`;
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS recovery_hash text`;
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS recovery_expires timestamptz`;
      // UNUSED LEGACY (Dinks, the shop, levels and prestige were removed): clubs.shop, roster.equipped, roster.prestige and the
      // purchases table are no longer read or written. Kept, with their data, for a possible later cleanup. roster.claim_hash/avatar/dupr are live.
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS shop jsonb`;
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS claim_hash text`; // hash of the token on the phone that claimed this name
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS equipped jsonb NOT NULL DEFAULT '{}'::jsonb`;
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS avatar jsonb`; // {type: emoji|icon|photo, value}; none means initials
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS prestige jsonb`; // unused legacy: {count, xpAt}
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS dupr_rating numeric(4,3)`; // self-reported, display only (see _dupr.js)
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS dupr_set_at timestamptz`;
      await q`CREATE TABLE IF NOT EXISTS purchases (
        id bigserial PRIMARY KEY,
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        name_key text NOT NULL,
        item_id text NOT NULL,
        item_name text NOT NULL,
        price int NOT NULL,
        is_reward boolean NOT NULL DEFAULT false,
        given_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await q`CREATE INDEX IF NOT EXISTS purchases_club_name ON purchases (club, name_key)`;
      // Events (tournaments and rotating-partner sessions): one JSON document per event. `version` lets two phones
      // saving different matches at once take turns (see mutate() in events.js). Finished matches also become
      // ordinary rows in `games`, so the record, ratings and leaderboard need no changes.
      await q`CREATE TABLE IF NOT EXISTS events (
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        id text NOT NULL,
        data jsonb NOT NULL,
        version int NOT NULL DEFAULT 1,
        status text NOT NULL DEFAULT 'live',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        PRIMARY KEY (club, id)
      )`;
      await q`CREATE INDEX IF NOT EXISTS events_club_updated ON events (club, updated_at DESC)`;
      // The public, read-only link to an event's bracket (see _share.js and bracket.js). Null means not shared.
      await q`ALTER TABLE events ADD COLUMN IF NOT EXISTS share_token text`;
      await q`CREATE UNIQUE INDEX IF NOT EXISTS events_share_token ON events (share_token) WHERE share_token IS NOT NULL`;
      // Watch scoring (prototype): one row per live game being scored on a phone. The phone publishes
      // its state; a watch appends point/undo intents (numbered by seq) that the phone then applies.
      await q`CREATE TABLE IF NOT EXISTS live_games (
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        id text NOT NULL,
        state jsonb NOT NULL,
        intents jsonb NOT NULL DEFAULT '[]'::jsonb,
        seq int NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (club, id)
      )`;

      await q`ALTER TABLE live_games ADD COLUMN IF NOT EXISTS secret_hash text`; // sha256 of the per-game secret that watch intents must carry
      await q`ALTER TABLE live_games ADD COLUMN IF NOT EXISTS stack jsonb NOT NULL DEFAULT '[]'::jsonb`; // states before each server-applied rally, for server-side undo
      await q`ALTER TABLE live_games ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 0`; // bumps on every server-held change; scorers pass the version they saw
      // Private reference data typed into an imported sheet: { "player name": "DUPR ID" }. Kept out of `data` on purpose, so no
      // event view, spectator page or export can include it. Only an organizer can read it (events.js, action 'refs').
      await q`ALTER TABLE events ADD COLUMN IF NOT EXISTS refs jsonb`;

      // Club code rotation. A club keeps its original `code` as a permanent internal key; the code people type is
      // `public_code` once one has been generated. Retired codes stay in club_aliases until `expires_at`, then stop working.
      await q`ALTER TABLE games ADD COLUMN IF NOT EXISTS rally_log text`; // who won each rally (see _rallylog.js); only for games scored live
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS public_code text`;
      await q`CREATE UNIQUE INDEX IF NOT EXISTS clubs_public_code ON clubs (public_code) WHERE public_code IS NOT NULL`;
      await q`CREATE TABLE IF NOT EXISTS club_aliases (
        code text PRIMARY KEY,
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL
      )`;
      // Optional accounts (passkeys; see account.js). Nothing here is read by the no-login paths.
      await q`CREATE TABLE IF NOT EXISTS accounts (
        id text PRIMARY KEY,
        display_name text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS passkeys (
        id text PRIMARY KEY,
        account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        public_key text NOT NULL,
        alg int NOT NULL,
        sign_count bigint NOT NULL DEFAULT 0,
        transports text[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz
      )`;
      await q`CREATE INDEX IF NOT EXISTS passkeys_account ON passkeys (account_id)`;
      // The RP ID a passkey was created under; null = the deployment's legacy RP ID (see account.js), so older passkeys keep verifying.
      await q`ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS rp_id text`;
      // Only the SHA-256 of the session token is stored, so a copy of the table can't be used to sign in.
      await q`CREATE TABLE IF NOT EXISTS sessions (
        id_hash text PRIMARY KEY,
        account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )`;
      await q`CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id)`;
      await q`CREATE TABLE IF NOT EXISTS auth_challenges (
        id text PRIMARY KEY,
        challenge text NOT NULL,
        kind text NOT NULL,
        account_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      // A club identity (a claimed player name, or the club creator's phone) an account has proven it holds. `proof` is the
      // stored token hash at link time: if an organizer later releases the name, it no longer matches and the link is stale.
      await q`CREATE TABLE IF NOT EXISTS account_identities (
        account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        kind text NOT NULL,
        name_key text NOT NULL DEFAULT '',
        proof text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (club, kind, name_key)
      )`;
      await q`CREATE INDEX IF NOT EXISTS account_identities_account ON account_identities (account_id)`;
      // Where a renamed or merged player went, so a phone that still holds the old name can follow it (see players.js).
      await q`CREATE TABLE IF NOT EXISTS name_changes (
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        old_key text NOT NULL,
        new_name text NOT NULL,
        at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (club, old_key)
      )`;
      // Roles and membership (see _members.js). `role` is null for an ordinary member or 'organizer' for a co-organizer; the club's
      // creating phone and the PIN are the other ways to organize. `blocked_at` keeps a removed name from being claimed again.
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS role text`;
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS blocked_at timestamptz`;
      await q`CREATE TABLE IF NOT EXISTS club_audit (
        id bigserial PRIMARY KEY,
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        at timestamptz NOT NULL DEFAULT now(),
        actor text NOT NULL,
        actor_name text,
        action text NOT NULL,
        target text,
        detail jsonb
      )`;
      await q`CREATE INDEX IF NOT EXISTS club_audit_club_at ON club_audit (club, at DESC)`;
      // Game confirmation, duplicate marks and the audit trail (see _confirm.js and _audit.js). All additive.
      await q`ALTER TABLE games ADD COLUMN IF NOT EXISTS confirmed_by text`; // 'organizer' or the confirming player's name key
      await q`ALTER TABLE games ADD COLUMN IF NOT EXISTS confirmed_at timestamptz`;
      await q`ALTER TABLE games ADD COLUMN IF NOT EXISTS dup_ok boolean NOT NULL DEFAULT false`; // an organizer said "these are two different games"
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS require_confirmation boolean NOT NULL DEFAULT false`; // true: unconfirmed games don't count toward ratings and achievements
      await q`CREATE TABLE IF NOT EXISTS game_audit (
        id bigserial PRIMARY KEY,
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        game text NOT NULL DEFAULT '',
        action text NOT NULL,
        actor text NOT NULL,
        at timestamptz NOT NULL DEFAULT now(),
        before jsonb,
        after jsonb,
        note text
      )`;
      await q`CREATE INDEX IF NOT EXISTS game_audit_club_at ON game_audit (club, at DESC)`;
      // Delete club (club.js): when set, the club and everything in it is removed once this time passes. Until then an organizer can undo it.
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS delete_at timestamptz`;
      // Open play court board (_courtboard.js): one row per club, the whole board as JSON; version guards concurrent changes.
      await q`CREATE TABLE IF NOT EXISTS court_boards (
        club text PRIMARY KEY REFERENCES clubs(code) ON DELETE CASCADE,
        data jsonb NOT NULL,
        version int NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      // Public result pages (results.js, result.js). Off per club until an organizer turns it on; a link is one row, revoking deletes it.
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS public_results boolean NOT NULL DEFAULT false`;
      // Organizer-posted extras (club.js set-pay-link, set-note): an https "how to pay" link and a pinned note. Empty = none.
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS pay_link text`;
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS pinned_note text`;
      await q`CREATE TABLE IF NOT EXISTS result_shares (
        token text PRIMARY KEY,
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        kind text NOT NULL,
        game text,
        from_ms bigint,
        to_ms bigint,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await q`CREATE UNIQUE INDEX IF NOT EXISTS result_shares_game ON result_shares (club, game) WHERE game IS NOT NULL`;
      await q`CREATE UNIQUE INDEX IF NOT EXISTS result_shares_session ON result_shares (club, from_ms, to_ms) WHERE game IS NULL`;
      // Pickup sessions (_sessions.js): 24 hours, their own code, no link to any club (so no club cascade or export involves them).
      // Rows are refused once expires_at has passed and deleted as the app is used; the children go with the session.
      await q`CREATE TABLE IF NOT EXISTS pickup_sessions (
        code text PRIMARY KEY,
        name text NOT NULL DEFAULT '',
        host_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )`;
      await q`CREATE INDEX IF NOT EXISTS pickup_sessions_expires ON pickup_sessions (expires_at)`;
      await q`CREATE TABLE IF NOT EXISTS pickup_players (
        session text NOT NULL REFERENCES pickup_sessions(code) ON DELETE CASCADE,
        name_key text NOT NULL,
        name text NOT NULL,
        joined_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (session, name_key)
      )`;
      await q`CREATE TABLE IF NOT EXISTS pickup_games (
        session text NOT NULL REFERENCES pickup_sessions(code) ON DELETE CASCADE,
        id text NOT NULL,
        data jsonb NOT NULL,
        ended_at bigint NOT NULL,
        PRIMARY KEY (session, id)
      )`;
    })().catch(err => { ready = null; throw err; });
  }
  return ready;
}

export function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw fail(413, 'That upload is too large.');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw fail(400, 'The request was not valid JSON.'); }
}

// Club codes: 6 characters from a 31-letter alphabet without look-alikes (no 0/O, 1/I/L): about 887 million codes.
// Guessing is throttled per network address (see requireClub), which makes enumerating codes impractical.
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode(len = 6) { // pickup sessions ask for 8 (see _sessions.js)
  let out = '';
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < 248 && out.length < len) out += ALPHA[b % 31]; // 248 = 8 x 31, so every letter is equally likely
    }
  }
  return out;
}
export function cleanCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{6}$/.test(code)) throw fail(400, 'Club codes are 6 letters and numbers.');
  return code;
}
// The caller's address as Vercel's edge reports it. Vercel sets x-vercel-forwarded-for and x-real-ip itself and
// overwrites any value a client sends, so callers can't pick a fresh address to dodge the limits.
export function clientIp(req) {
  const h = req.headers || {};
  const raw = h['x-vercel-forwarded-for'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',').pop() || 'unknown';
  return netKey(String(raw).split(',')[0]); // an IPv6 caller is limited as a whole /64, not per address
}
// Rate-limit marks live in lookup_fails and only matter for a day, so old ones are dropped now and then. The same sweep
// removes clubs whose delete-club undo window has run out (the rows that belong to a club go with it: ON DELETE CASCADE).
export async function purgeMarks(sql) {
  if (Math.random() < 0.05) {
    await sql`DELETE FROM lookup_fails WHERE at < now() - interval '1 day'`;
    await sql`DELETE FROM clubs WHERE delete_at IS NOT NULL AND delete_at <= now()`;
  }
}
// Club creation: at most 10 per network (per /64 for IPv6) per hour, and 300 per hour across the whole app.
// Attempts are recorded before counting, and a refused one takes its own mark back off.
const MAX_CREATES_PER_NET = 10, MAX_CREATES_GLOBAL = 300;
export async function throttleClubCreate(req) {
  const sql = db();
  await purgeMarks(sql);
  for (const [key, max] of [['mkclub:' + clientIp(req), MAX_CREATES_PER_NET], ['mkclub:*', MAX_CREATES_GLOBAL]]) {
    const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '1 hour'`;
    if (Number(n) > max) {
      await sql`DELETE FROM lookup_fails WHERE id = ${id}`;
      throw fail(429, 'Too many clubs were created just now. Try again in an hour.');
    }
  }
}
const MAX_FAILS = 20; // wrong codes allowed per network address per 15 minutes
export async function requireClub(code, req) {
  const sql = db();
  const ip = clientIp(req);
  // Record the attempt first, then count, so simultaneous guesses all see each other.
  // A correct code removes its own record, so only wrong codes count toward the limit.
  const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${ip}) RETURNING id`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${ip} AND at > now() - interval '15 minutes'`;
  if (n > MAX_FAILS) throw fail(429, 'Too many wrong club codes. Wait 15 minutes and try again.');
  // The code people type is the current public code (or, for a club never rotated, its original code), or a retired
  // code still inside its overlap. `code` on the returned row is always the permanent key: use it for every query.
  let rows = await sql`SELECT code, name, pin_hash, owner_hash, public_code, require_confirmation, public_results, pay_link, pinned_note, delete_at FROM clubs WHERE coalesce(public_code, code) = ${code}`;
  if (!rows.length) {
    rows = await sql`SELECT c.code, c.name, c.pin_hash, c.owner_hash, c.public_code, c.require_confirmation, c.public_results, c.pay_link, c.pinned_note, c.delete_at, a.expires_at AS old_code_until
      FROM club_aliases a JOIN clubs c ON c.code = a.club WHERE a.code = ${code} AND a.expires_at > now()`;
  }
  // A club whose undo window has run out is gone: remove it now, and answer as for any unknown code.
  if (rows.length && rows[0].delete_at && new Date(rows[0].delete_at).getTime() <= Date.now()) {
    await sql`DELETE FROM clubs WHERE code = ${rows[0].code} AND delete_at <= now()`;
    rows = [];
  }
  await purgeMarks(sql);
  if (!rows.length) {
    throw fail(404, 'No club has that code. Check it and try again.');
  }
  await sql`DELETE FROM lookup_fails WHERE id = ${id}`;
  return rows[0]; // includes pin_hash: use publicClub() before sending a club to the app
}
// openClaim: an older club with no creator on record and no PIN yet, where any member may set the first PIN.
// `code` is the one people use now; oldCodeUntil (ms) is set when the request came in on a retired code that is about to stop working.
export const publicClub = c => ({ code: c.public_code || c.code, name: c.name, hasPin: !!c.pin_hash, openClaim: !c.pin_hash && !c.owner_hash, requireConfirmation: !!c.require_confirmation, publicResults: !!c.public_results,
  ...(c.pay_link ? { payLink: c.pay_link } : {}), ...(c.pinned_note ? { note: c.pinned_note } : {}),
  ...(c.old_code_until ? { oldCodeUntil: new Date(c.old_code_until).getTime() } : {}),
  ...(c.delete_at ? { deleteAt: new Date(c.delete_at).getTime() } : {}) }); // deleteAt: the club is scheduled for deletion at that time

// True when `code` is already a club's key, current code, or a retired code (retired codes are never reused).
export async function codeTaken(sql, code) {
  const [r] = await sql`SELECT (EXISTS (SELECT 1 FROM clubs WHERE code = ${code} OR public_code = ${code}) OR EXISTS (SELECT 1 FROM club_aliases WHERE code = ${code})) AS taken`;
  return !!r.taken;
}

// Organizer PIN: 6 to 8 digits for a new or changed PIN. Only its salted scrypt hash is stored.
// PINs set before the 6-digit minimum (4 or 5 digits) still unlock; the app nudges their organizers to change them.
export function cleanPin(raw) {
  const pin = String(raw ?? '').trim();
  if (!/^\d{6,8}$/.test(pin)) throw fail(400, 'Organizer PINs are 6 to 8 digits.');
  return pin;
}
// A phone that has entered the right PIN is handed a device key (an HMAC of the stored hash, so it stops working when
// the PIN changes). The app keeps it with the PIN as "123456:<key>", so every place that already sends the PIN carries it.
// A phone with a valid key is never slowed down by other people's wrong guesses.
export const deviceKey = club => createHmac('sha256', String(club.pin_hash)).update('device:' + club.code).digest('hex');
function deviceKeyMatches(club, key) {
  const want = Buffer.from(deviceKey(club), 'hex'), got = Buffer.from(/^[0-9a-f]{64}$/.test(key || '') ? key : '', 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}
export function hashPin(pin) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pin, salt, 32).toString('hex');
}
function pinMatches(stored, pin) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = scryptSync(String(pin), Buffer.from(salt, 'hex'), want.length);
  return want.length === got.length && timingSafeEqual(want, got);
}
// Allows an organizer action. Clubs without a PIN let anyone through.
// - The creating phone's private token always works (48 hex characters, not guessable): it is the recovery path
//   and lets that phone reset a forgotten PIN. A phone holding a valid device key (see deviceKey) works too.
// - Anyone else is checked against the PIN under an escalating backoff, per network (per /64) and per club:
//   the first few wrong tries are free, then each one doubles the wait (per network up to 24 hours, per club up to
//   1 hour, so a flood can pause new organizers only briefly and never the phones above). A refused request takes
//   its own mark back off, and a locked network or club refuses every PIN, right or wrong, so guessing learns nothing.
//   Marks are recorded before counting, so simultaneous guesses see each other. A right PIN removes its marks.
const PIN_LIMITS = [['pin:', 5, 30, 86400], ['pinclub:', 20, 60, 3600]]; // key prefix, free tries, base wait (s), longest wait (s)
// Returns who was let in, for the audit log: {by: 'open' | 'owner' | 'organizer' (a co-organizer, with name) | 'pin'}.
export async function requirePin(club, pin, req, ownerToken) {
  if (!club.pin_hash) return { by: 'open' };
  if (club.owner_hash && tokenMatches(club.owner_hash, ownerToken)) return { by: 'owner' };
  const co = await coOrganizer(club, ownerToken);
  if (co) return { by: 'organizer', name: co };
  const [digits, key] = String(pin ?? '').split(':');
  if (key && deviceKeyMatches(club, key)) return { by: 'pin' };
  const sql = db();
  const keys = [PIN_LIMITS[0][0] + clientIp(req), PIN_LIMITS[1][0] + club.code];
  const marks = [];
  const drop = async ids => { for (const id of ids) await sql`DELETE FROM lookup_fails WHERE id = ${id}`; };
  for (let i = 0; i < PIN_LIMITS.length; i++) {
    const [, free, base, cap] = PIN_LIMITS[i];
    const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${keys[i]}) RETURNING id`;
    marks.push(id);
    const [{ n, age }] = await sql`SELECT count(*)::int AS n, extract(epoch FROM now() - max(at)) AS age FROM lookup_fails
      WHERE ip = ${keys[i]} AND at > now() - interval '24 hours' AND id <> ${id}`;
    const wait = Number(n) ? lockSeconds(Number(n), free, base, cap) - Number(age) : 0;
    if (wait > 0) {
      await drop(marks);
      throw fail(429, i === 0
        ? `Too many wrong PINs from this network. Try again in ${waitText(wait)}.`
        : `Too many wrong PINs have been tried for this club. Organizer PINs are paused for ${waitText(wait)}, except on phones that are already unlocked and the one that created the club.`);
    }
  }
  if (!/^\d{4,8}$/.test(digits) || !pinMatches(club.pin_hash, digits)) throw fail(403, 'That organizer PIN is wrong.');
  await drop(marks);
  await sql`DELETE FROM lookup_fails WHERE ip = ${keys[0]}`; // this network proved it knows the PIN, so its earlier wrong tries are forgiven
  return { by: 'pin' };
}
// A co-organizer's credential travels where the creating phone's owner token does: "<their player token>:<their name>".
// It only counts while the name is still claimed by that token, still holds the organizer role, and isn't blocked, so
// removing or demoting someone stops it at once. Returns the member's name, or null.
export async function coOrganizer(club, cred) {
  const m = /^([0-9a-f]{48}):(.{1,60})$/s.exec(String(cred ?? ''));
  if (!m) return null;
  const [row] = await db()`SELECT name, claim_hash FROM roster WHERE club = ${club.code} AND name_key = ${cleanName(m[2]).toLowerCase()} AND role = 'organizer' AND blocked_at IS NULL`;
  return row && row.claim_hash && tokenMatches(row.claim_hash, m[1]) ? row.name : null;
}
export const ownerFrom = req => (req.headers || {})['x-club-owner'];

// Organizer-only settings (releasing names, running events) need the creating phone or, once set, the PIN.
// A club without a PIN can't hand these to anyone with the code, so it needs the creating phone.
export async function requireOrganizer(club, pin, req, ownerToken) {
  if (club.owner_hash && tokenMatches(club.owner_hash, ownerToken)) return { by: 'owner' };
  const co = await coOrganizer(club, ownerToken);
  if (co) return { by: 'organizer', name: co };
  if (!club.pin_hash) throw fail(403, 'Only organizers can do that. Set an organizer PIN from the phone that created the club.');
  return requirePin(club, pin, req, ownerToken);
}

// Proof of ownership for setting a club's first PIN: a random token handed only to the phone that created the club.
export const newOwnerToken = () => randomBytes(24).toString('hex');
export const hashToken = t => scryptSync(String(t), 'dink-score-owner', 32).toString('hex');
export function tokenMatches(stored, token) {
  if (!stored || !/^[0-9a-f]{48}$/.test(String(token ?? ''))) return false;
  const a = Buffer.from(stored, 'hex'), b = Buffer.from(hashToken(token), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const pinFrom = req => (req.headers || {})['x-club-pin'];

// Who is sending these games: a player's name key (their phone's player token checks out), 'organizer' (the club
// creator's phone), or null. Never trusted from the game data itself.
export async function verifiedSender(sql, club, code, body) {
  if (club.owner_hash && tokenMatches(club.owner_hash, body.ownerToken)) return 'organizer';
  if (!body.playerName || !body.playerToken) return null;
  const k = nameKey(body.playerName);
  const [row] = await sql`SELECT claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
  return row && row.claim_hash && tokenMatches(row.claim_hash, body.playerToken) ? k : null;
}

// Reserves room for `count` new games in one atomic update: at most 1,200 per club per 10-minute window
// (enough for a phone's whole history of up to 1,000 games), 20,000 games that are not deleted, and 40,000 stored
// rows including deleted ones (so add-and-delete can't grow a club without end). Deleting games makes room again.
// The row lock on the club makes simultaneous requests take turns on the window; the stored-games counts are read
// at that moment, so at worst a few simultaneous requests overshoot by one window's worth.
// Photo avatars are the big part of a player (up to 60,000 characters each), so a club keeps at most 50 of them.
export const MAX_PHOTOS = 50;
export const MAX_LIVE_GAMES = 20000, MAX_STORED_GAMES = 40000;
export async function reserveGames(code, count) {
  const sql = db();
  const rows = await sql`UPDATE clubs SET
      window_count = CASE WHEN window_start < now() - interval '10 minutes' THEN ${count} ELSE window_count + ${count} END,
      window_start = CASE WHEN window_start < now() - interval '10 minutes' THEN now() ELSE window_start END
    WHERE code = ${code}
      AND (CASE WHEN window_start < now() - interval '10 minutes' THEN 0 ELSE window_count END) + ${count} <= 1200
      AND (SELECT count(*) FROM games WHERE club = ${code} AND deleted_at IS NULL) + ${count} <= ${MAX_LIVE_GAMES}
      AND (SELECT count(*) FROM games WHERE club = ${code}) + ${count} <= ${MAX_STORED_GAMES}
    RETURNING window_start::text AS window_key`;
  // The window this reservation was charged to, as exact text (a JS Date would drop the microseconds).
  if (rows.length) return rows[0].window_key;
  const [n] = await sql`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS live, count(*)::int AS stored FROM games WHERE club = ${code}`;
  if (n && Number(n.live) + count > MAX_LIVE_GAMES) throw fail(400, `This club has reached its limit of ${MAX_LIVE_GAMES.toLocaleString('en-US')} games. An organizer can delete old games to make room.`);
  if (n && Number(n.stored) + count > MAX_STORED_GAMES) throw fail(400, 'This club has stored too many games, including deleted ones. Ask the app owner to clear them.');
  throw fail(429, 'Too many games were added just now. Wait a few minutes and try again.');
}
// An organizer's way out of a "too many games just now" pause: starts a fresh 10-minute window.
export async function resetAllowance(code) {
  await db()`UPDATE clubs SET window_count = 0, window_start = now(), total_count = 0 WHERE code = ${code}`;
}
// Returns unused window allowance, so the counter only ever reflects games actually stored.
// The window refund only applies if the same 10-minute window is still open; a newer window keeps its own count.
export async function releaseGames(code, count, windowStart) {
  if (count <= 0) return;
  await db()`UPDATE clubs SET
      window_count = CASE WHEN window_start::text = ${String(windowStart)} THEN GREATEST(0, window_count - ${count}) ELSE window_count END
    WHERE code = ${code}`;
}

// Player and club names: see _names.js.
// Validates one game from the app and returns a safe copy.
export function cleanGame(g) {
  if (!g || typeof g !== 'object') throw fail(400, 'A game is missing.');
  const id = String(g.id || '');
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) throw fail(400, 'A game has an invalid id.');
  const mode = g.mode === 'singles' ? 'singles' : 'doubles';
  const n = mode === 'doubles' ? 2 : 1;
  if (!Array.isArray(g.teams) || g.teams.length !== 2) throw fail(400, 'A game needs two teams.');
  const teams = g.teams.map(t => {
    if (!Array.isArray(t) || t.length !== n) throw fail(400, `Each ${mode} team needs ${n} player${n > 1 ? 's' : ''}.`);
    return t.map(cleanName).map(x => { if (!x) throw fail(400, 'Every player needs a name.'); return x; });
  });
  const score = Array.isArray(g.score) ? g.score.map(v => Math.trunc(Number(v))) : [];
  if (score.length !== 2 || score.some(v => !Number.isFinite(v) || v < 0 || v > 99)) throw fail(400, 'Scores must be from 0 to 99.');
  if (score[0] === score[1]) throw fail(400, "Scores can't be tied.");
  const endedAt = Math.trunc(Number(g.endedAt));
  const startedAt = Math.trunc(Number(g.startedAt)) || endedAt;
  const now = Date.now();
  if (!Number.isFinite(endedAt) || endedAt < Date.UTC(2015, 0, 1) || endedAt > now + 864e5) throw fail(400, 'A game has an invalid date.');
  return {
    id, mode, teams, score,
    winner: score[0] > score[1] ? 0 : 1,
    scoring: g.scoring === 'rally' ? 'rally' : 'sideout',
    target: [11, 15, 21].includes(Number(g.target)) ? Number(g.target) : 11,
    winBy: Number(g.winBy) === 1 ? 1 : 2,
    rallies: Math.max(0, Math.min(999, Math.trunc(Number(g.rallies)) || 0)),
    startedAt: Math.min(startedAt, endedAt), endedAt,
    logged: !!g.logged
  };
}
export { cleanName };
export { nameKey, similarNames } from './_names.js';

export function handler(fn) {
  return async (req, res) => {
    try {
      await ensureSchema();
      await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) { console.error(err); await reportError('server', { message: err && err.message, stack: err && err.stack }); }
      send(res, status, { error: status === 500 ? 'Something went wrong on the server. Try again in a moment.' : err.message, ...(status !== 500 && err.extra ? err.extra : {}) });
    }
  };
}
