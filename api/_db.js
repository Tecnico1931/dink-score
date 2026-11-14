// Shared helpers for the club API. Files starting with "_" are not routes.
import { neon } from '@neondatabase/serverless';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

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
      // Shop: organizer settings on the club, claimed names and equipped items on saved players, purchases.
      await q`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS shop jsonb`;
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS claim_hash text`; // hash of the token on the phone that claimed this name
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS equipped jsonb NOT NULL DEFAULT '{}'::jsonb`;
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
export function newCode() {
  let out = '';
  while (out.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < 248 && out.length < 6) out += ALPHA[b % 31]; // 248 = 8 x 31, so every letter is equally likely
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
  return String(raw).split(',')[0].trim().slice(0, 64);
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
  const rows = await sql`SELECT code, name, pin_hash, owner_hash FROM clubs WHERE code = ${code}`;
  if (!rows.length) {
    if (Math.random() < 0.05) await sql`DELETE FROM lookup_fails WHERE at < now() - interval '1 day'`;
    throw fail(404, 'No club has that code. Check it and try again.');
  }
  await sql`DELETE FROM lookup_fails WHERE id = ${id}`;
  return rows[0]; // includes pin_hash: use publicClub() before sending a club to the app
}
// openClaim: an older club with no creator on record and no PIN yet, where any member may set the first PIN.
export const publicClub = c => ({ code: c.code, name: c.name, hasPin: !!c.pin_hash, openClaim: !c.pin_hash && !c.owner_hash });

// Organizer PIN: 4 to 8 digits. Only its salted scrypt hash is stored.
export function cleanPin(raw) {
  const pin = String(raw ?? '').trim();
  if (!/^\d{4,8}$/.test(pin)) throw fail(400, 'Organizer PINs are 4 to 8 digits.');
  return pin;
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
const MAX_PIN_FAILS = 10;       // wrong PINs allowed per network address per 15 minutes
const MAX_CLUB_PIN_FAILS = 30;  // wrong PINs allowed per club per 15 minutes, from all addresses together
// Allows an organizer action. Clubs without a PIN let anyone through.
// - The creating phone's private token always works: it can't be guessed (48 hex characters), so it is the
//   recovery path when a PIN flood has locked the club, and it lets that phone reset a forgotten PIN.
// - Otherwise the PIN is checked under two hard limits, per network address and per club. Both are checked before
//   the PIN is, and a locked club refuses every PIN, right or wrong, so guessing gets no signal while it's locked.
//   Attempts are recorded before counting (so simultaneous guesses see each other) and removed if the PIN is right.
//   Only guesses that pass the per-address limit count toward the club's lock, and a request the club lock refuses
//   takes its own mark back off, so one blocked address can't keep a club locked by spamming it.
export async function requirePin(club, pin, req, ownerToken) {
  if (!club.pin_hash) return;
  if (club.owner_hash && tokenMatches(club.owner_hash, ownerToken)) return;
  const sql = db();
  const ipKey = 'pin:' + clientIp(req), clubKey = 'pinclub:' + club.code;
  // 1. Per address first.
  const [{ id: ipId }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${ipKey}) RETURNING id`;
  const [{ byIp }] = await sql`SELECT count(*)::int AS "byIp" FROM lookup_fails WHERE ip = ${ipKey} AND at > now() - interval '15 minutes'`;
  if (byIp > MAX_PIN_FAILS) throw fail(429, 'Too many wrong PINs. Wait 15 minutes and try again.');
  // 2. Then the club, counting only guesses that got this far.
  const [{ id: clubId }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${clubKey}) RETURNING id`;
  const [{ byClub }] = await sql`SELECT count(*)::int AS "byClub" FROM lookup_fails WHERE ip = ${clubKey} AND at > now() - interval '15 minutes'`;
  if (byClub > MAX_CLUB_PIN_FAILS) {
    await sql`DELETE FROM lookup_fails WHERE id = ${clubId}`; // refused, so it doesn't extend the lock
    throw fail(429, 'Too many wrong PINs have been tried for this club. Organizer actions are paused for 15 minutes, except on the phone that created the club.');
  }
  // 3. Only now check the PIN. A right PIN clears this attempt's marks; a wrong one keeps them.
  if (!/^\d{4,8}$/.test(String(pin ?? '')) || !pinMatches(club.pin_hash, pin)) throw fail(403, 'That organizer PIN is wrong.');
  await sql`DELETE FROM lookup_fails WHERE id IN (${ipId}, ${clubId})`;
}
export const ownerFrom = req => (req.headers || {})['x-club-owner'];

// Organizer-only settings (shop prices, rewards, releasing names) need the creating phone or, once set, the PIN.
// A club without a PIN can't hand these to anyone with the code, so it needs the creating phone.
export async function requireOrganizer(club, pin, req, ownerToken) {
  if (club.owner_hash && tokenMatches(club.owner_hash, ownerToken)) return;
  if (!club.pin_hash) throw fail(403, 'Only organizers can do that. Set an organizer PIN from the phone that created the club.');
  await requirePin(club, pin, req, ownerToken);
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

// Reserves room for `count` new games in one atomic update: at most 1,200 per club per 10-minute window
// (enough for a phone's whole history of up to 1,000 games) and 20,000 per club in total.
// The row lock on the club makes simultaneous requests take turns, so they can't overshoot together.
export async function reserveGames(code, count) {
  const sql = db();
  const rows = await sql`UPDATE clubs SET
      window_count = CASE WHEN window_start < now() - interval '10 minutes' THEN ${count} ELSE window_count + ${count} END,
      window_start = CASE WHEN window_start < now() - interval '10 minutes' THEN now() ELSE window_start END,
      total_count = total_count + ${count}
    WHERE code = ${code}
      AND (CASE WHEN window_start < now() - interval '10 minutes' THEN 0 ELSE window_count END) + ${count} <= 1200
      AND total_count + ${count} <= 20000
    RETURNING window_start::text AS window_key`;
  // The window this reservation was charged to, as exact text (a JS Date would drop the microseconds).
  if (rows.length) return rows[0].window_key;
  const [club] = await sql`SELECT total_count FROM clubs WHERE code = ${code}`;
  if (club && club.total_count + count > 20000) throw fail(400, 'This club has reached its limit of 20,000 games.');
  throw fail(429, 'Too many games were added just now. Wait a few minutes and try again.');
}
// Returns unused allowance, so the counters only ever reflect games actually stored.
// The window refund only applies if the same 10-minute window is still open; a newer window keeps its own count.
export async function releaseGames(code, count, windowStart) {
  if (count <= 0) return;
  await db()`UPDATE clubs SET
      total_count = GREATEST(0, total_count - ${count}),
      window_count = CASE WHEN window_start::text = ${String(windowStart)} THEN GREATEST(0, window_count - ${count}) ELSE window_count END
    WHERE code = ${code}`;
}

const cleanName = n => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 40);

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

export function handler(fn) {
  return async (req, res) => {
    try {
      await ensureSchema();
      await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      send(res, status, { error: status === 500 ? 'Something went wrong on the server. Try again in a moment.' : err.message });
    }
  };
}
