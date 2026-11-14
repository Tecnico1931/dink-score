// Shared helpers for the club API. Files starting with "_" are not routes.
import { neon } from '@neondatabase/serverless';

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
function clientIp(req) {
  const h = req.headers || {};
  return String(h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim().slice(0, 64);
}
const MAX_FAILS = 20; // wrong codes allowed per network address per 15 minutes
export async function requireClub(code, req) {
  const sql = db();
  const ip = clientIp(req);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${ip} AND at > now() - interval '15 minutes'`;
  if (n >= MAX_FAILS) throw fail(429, 'Too many wrong club codes. Wait 15 minutes and try again.');
  const rows = await sql`SELECT code, name FROM clubs WHERE code = ${code}`;
  if (!rows.length) {
    await sql`INSERT INTO lookup_fails (ip) VALUES (${ip})`;
    if (Math.random() < 0.05) await sql`DELETE FROM lookup_fails WHERE at < now() - interval '1 day'`;
    throw fail(404, 'No club has that code. Check it and try again.');
  }
  return rows[0];
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
