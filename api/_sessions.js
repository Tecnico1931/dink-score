// Pickup sessions: a 24-hour space of its own, with its own code and QR, for playing with people who aren't in your club.
// Reached through /api/live (the hosting plan caps the function count). Nothing here touches a club: no club row, no club
// roster, no club games. A club member brings results into a club only by saving them there, through the normal games route.
//   POST /api/live {action:'session-create', name?}                       -> {code, hostToken, expiresAt, ...view}; hostToken is shown once, kept on that phone
//   GET  /api/live?session=ABCD2345                                       -> {session:{code,name,expiresAt,now}, players:[name], games:[game]}
//   POST /api/live {action:'session-join', code, name}                    -> adds a player name (the same name again changes nothing)
//   POST /api/live {action:'session-game', code, game}                    -> adds a finished game (validated like club games; ON CONFLICT DO NOTHING by id)
//   POST /api/live {action:'session-game-delete', code, id, hostToken}    -> host: removes one game
//   POST /api/live {action:'session-end', code, hostToken}                -> host: ends the session now and deletes everything in it
// A session lasts 24 hours from the moment it is made, checked on every request here (not just in the page), and its rows are
// deleted once expired. Codes are 8 characters of the club alphabet (about 8.5 x 10^11). Wrong codes are counted per network
// like wrong club codes; making sessions is limited per network and for the whole app.
import { fail, cleanName, nameKey, clientIp, purgeMarks, newCode, hashToken, tokenMatches, newOwnerToken, cleanGame } from './_db.js';

export const SESSION_MS = 24 * 60 * 60 * 1000;
export const MAX_PLAYERS = 30, MAX_GAMES = 100;
const MAX_FAILS = 20, MAX_CREATES_PER_NET = 10, MAX_CREATES_GLOBAL = 300;

export function cleanSessionCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{8}$/.test(code)) throw fail(400, 'Session codes are 8 letters and numbers.');
  return code;
}
export const newSessionCode = () => newCode(8);
export const expiresAt = (now = Date.now()) => now + SESSION_MS;

// The only shape that leaves the server: copied field by field, so a new column can never leak by accident.
export function sessionView(row, players, games, now = Date.now()) {
  return {
    session: { code: row.code, name: row.name || '', expiresAt: new Date(row.expires_at).getTime(), now },
    players: players.map(p => p.name),
    games: games.map(g => g.data)
  };
}

async function sweep(sql) {
  if (Math.random() < 0.05) await sql`DELETE FROM pickup_sessions WHERE expires_at <= now()`;
}

// Wrong codes are recorded first and counted, a right one takes its own mark back off (as requireClub does).
export async function requireSession(sql, raw, req) {
  const code = cleanSessionCode(raw), key = 'sess:' + clientIp(req);
  const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '15 minutes'`;
  if (n > MAX_FAILS) throw fail(429, 'Too many wrong session codes. Wait 15 minutes and try again.');
  const [row] = await sql`SELECT code, name, host_hash, expires_at FROM pickup_sessions WHERE code = ${code} AND expires_at > now()`;
  await purgeMarks(sql);
  await sweep(sql);
  if (!row) {
    await sql`DELETE FROM pickup_sessions WHERE code = ${code} AND expires_at <= now()`; // an expired session goes the moment anyone asks for it
    throw fail(404, 'No pickup session has that code. It may have ended: sessions last 24 hours.');
  }
  await sql`DELETE FROM lookup_fails WHERE id = ${id}`;
  return row;
}

async function throttleCreate(sql, req) {
  await purgeMarks(sql);
  for (const [key, max] of [['mksess:' + clientIp(req), MAX_CREATES_PER_NET], ['mksess:*', MAX_CREATES_GLOBAL]]) {
    const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '1 hour'`;
    if (Number(n) > max) { await sql`DELETE FROM lookup_fails WHERE id = ${id}`; throw fail(429, 'Too many sessions were started just now. Try again in an hour.'); }
  }
}

async function load(sql, row) {
  const players = await sql`SELECT name FROM pickup_players WHERE session = ${row.code} ORDER BY joined_at, name_key`;
  const games = await sql`SELECT data FROM pickup_games WHERE session = ${row.code} ORDER BY ended_at DESC LIMIT ${MAX_GAMES}`;
  return sessionView(row, players, games);
}

export async function sessionGet(sql, raw, req) {
  return load(sql, await requireSession(sql, raw, req));
}

// Adds names the session doesn't have yet, all or none, up to the cap.
async function addPlayers(sql, code, names) {
  const have = new Set((await sql`SELECT name_key FROM pickup_players WHERE session = ${code}`).map(r => r.name_key));
  const fresh = new Map();
  for (const n of names) { const k = nameKey(n); if (!have.has(k) && !fresh.has(k)) fresh.set(k, n); }
  if (have.size + fresh.size > MAX_PLAYERS) throw fail(400, `A pickup session holds up to ${MAX_PLAYERS} players.`);
  for (const [k, n] of fresh) await sql`INSERT INTO pickup_players (session, name_key, name) VALUES (${code}, ${k}, ${n}) ON CONFLICT DO NOTHING`;
}

function requireHost(row, token) {
  if (!tokenMatches(row.host_hash, token)) throw fail(403, 'Only the phone that started this session can do that.');
}

export async function sessionAction(sql, body, req) {
  const action = body.action;
  if (action === 'session-create') {
    await throttleCreate(sql, req);
    const name = cleanName(body.name);
    const hostToken = newOwnerToken(), at = expiresAt();
    let code;
    for (let i = 0; i < 5; i++) {
      code = newSessionCode();
      const r = await sql`INSERT INTO pickup_sessions (code, name, host_hash, expires_at) VALUES (${code}, ${name}, ${hashToken(hostToken)}, ${new Date(at).toISOString()}) ON CONFLICT DO NOTHING RETURNING code`;
      if (r.length) break;
      code = null;
    }
    if (!code) throw fail(500, 'Could not make a session code. Try again.');
    const [row] = await sql`SELECT code, name, expires_at FROM pickup_sessions WHERE code = ${code}`;
    return { ok: true, hostToken, ...(await load(sql, row)) };
  }
  const row = await requireSession(sql, body.code, req);
  if (action === 'session-join') {
    const name = cleanName(body.name);
    if (!name) throw fail(400, 'Enter a name.');
    await addPlayers(sql, row.code, [name]);
    return { ok: true, ...(await load(sql, row)) };
  }
  if (action === 'session-game') {
    const g = cleanGame(body.game);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM pickup_games WHERE session = ${row.code}`;
    const [mine] = await sql`SELECT 1 AS x FROM pickup_games WHERE session = ${row.code} AND id = ${g.id}`;
    if (!mine && Number(n) >= MAX_GAMES) throw fail(400, `A pickup session holds up to ${MAX_GAMES} games.`);
    await addPlayers(sql, row.code, g.teams.flat().filter(p => !/^Player \d+$/.test(p)));
    const r = await sql`INSERT INTO pickup_games (session, id, data, ended_at) VALUES (${row.code}, ${g.id}, ${JSON.stringify(g)}::jsonb, ${g.endedAt}) ON CONFLICT (session, id) DO NOTHING RETURNING id`;
    return { ok: true, saved: r.length, ...(await load(sql, row)) };
  }
  if (action === 'session-game-delete') {
    requireHost(row, body.hostToken);
    await sql`DELETE FROM pickup_games WHERE session = ${row.code} AND id = ${String(body.id || '')}`;
    return { ok: true, ...(await load(sql, row)) };
  }
  if (action === 'session-end') {
    requireHost(row, body.hostToken);
    await sql`DELETE FROM pickup_sessions WHERE code = ${row.code}`;
    return { ok: true, ended: true };
  }
  throw fail(400, 'Unknown action.');
}
