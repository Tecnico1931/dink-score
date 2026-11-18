// Measures what one hour of polling costs the server, before and after Sync v2, against a throwaway in-memory Postgres.
//   npm i --no-save @electric-sql/pglite
//   git archive <base-commit> api sheet-import.js | tar -x -C /some/dir && ln -s $PWD/node_modules /some/dir/node_modules && cp package.json /some/dir
//   node tools/sync-bench.mjs /some/dir [games]        (without a directory it only measures the current api)
// "Before" polls like the old app: every poll is a full GET. "After" polls like the new app: it sends the ETag it last got.
// Per poll it counts response bytes, SQL statements, bytes the database sent to the function, and handler time.
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
const GAMES = Number(process.argv[3]) || 300;
const { PGlite } = await import('@electric-sql/pglite');
const neon = await import('@neondatabase/serverless');
const pg = new PGlite();
const TEXT_OIDS = [16, 20, 21, 23, 25, 700, 701, 1043, 1082, 1114, 1184, 1700, 114, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map(o => [o, v => v]));
const stat = { queries: 0, dbBytes: 0 };
async function run(q) {
  const r = await pg.query(q.query, q.params || [], { rowMode: 'array', parsers });
  const out = { command: 'SELECT', rowCount: r.rows.length, rows: r.rows, fields: r.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID, tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })), rowAsArray: true };
  stat.queries++; stat.dbBytes += Buffer.byteLength(JSON.stringify(r.rows));
  return out;
}
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', c => (data += c));
  req.on('end', async () => {
    try { const b = JSON.parse(data); const out = b.queries ? await Promise.all(b.queries.map(run)) : await run(b); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b.queries ? { results: out } : out)); }
    catch (err) { res.statusCode = 400; res.end(JSON.stringify({ message: String(err.message), code: err.code || '42000' })); }
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
neon.neonConfig.fetchEndpoint = () => `http://127.0.0.1:${server.address().port}/sql`;
process.env.DATABASE_URL = 'postgres://local:local@localhost/throwaway';

const load = async (dir, name) => (await import(pathToFileURL(path.join(dir, 'api', name + '.js')).href)).default;
const sets = {};
for (const [label, dir] of [['before', baseRoot], ['after', root]]) if (dir) sets[label] = Object.fromEntries(await Promise.all(['club', 'games', 'live', 'events'].map(async n => [n, await load(dir, n)])));
const after = sets.after;

let ip = 0;
async function call(handler, method, { query = '', body, headers = {} } = {}) {
  const req = { method, url: '/api/x' + query, headers: { 'x-real-ip': '10.1.0.' + (++ip % 200), ...headers }, body };
  let status = 0, text = '';
  const out = {};
  const res = { statusCode: 0, setHeader(k, v) { out[k.toLowerCase()] = v; }, end(t) { status = res.statusCode; text = t || ''; } };
  const t0 = process.hrtime.bigint();
  await handler(req, res);
  return { status, headers: out, bytes: Buffer.byteLength(text), ms: Number(process.hrtime.bigint() - t0) / 1e6, json: text ? JSON.parse(text) : null };
}

// A club with a realistic roster (some photos) and GAMES finished games.
const made = await call(after.club, 'POST', { body: { name: 'Bench club' } });
const code = made.json.club.code;
const names = Array.from({ length: 24 }, (_, i) => 'Player ' + String.fromCharCode(65 + i));
for (const [i, n] of names.entries()) {
  const avatar = i < 12 ? { type: 'photo', value: 'data:image/jpeg;base64,' + 'A'.repeat(25000) } : { type: 'emoji', value: '🏓' };
  await pg.query('INSERT INTO roster (club, name_key, name, avatar) VALUES ($1, $2, $3, $4::jsonb)', [code, n.toLowerCase(), n, JSON.stringify(avatar)]);
}
const gameRow = i => {
  const p = k => names[(i * 7 + k * 3) % 24], at = Date.now() - (GAMES - i) * 3600e3;
  return { id: 'bench-' + i, mode: 'doubles', teams: [[p(0), p(1)], [p(2), p(3)]], score: [11, i % 10], endedAt: at, startedAt: at - 900e3, scoring: 'rally', target: 11 };
};
for (let i = 0; i < GAMES; i++) { const g = gameRow(i); await pg.query('INSERT INTO games (club, id, data, ended_at) VALUES ($1, $2, $3::jsonb, $4)', [code, g.id, JSON.stringify(g), g.endedAt]); }
let nextGame = GAMES;
const addGame = async () => { const g = gameRow(nextGame++); g.endedAt = Date.now(); await pg.query('INSERT INTO games (club, id, data, ended_at) VALUES ($1, $2, $3::jsonb, $4)', [code, g.id, JSON.stringify(g), g.endedAt]); };

// One hour of one device: `polls` is [name, handler key, query, polls per hour before, polls per hour after]; `changes` games land
// during the hour. The new app polls the events summary only after a club answer that changed (it returns early on a 304),
// and stretches the club poll while nothing changes (see refreshClub / the poll timer in dink-score.html).
async function hour(label, polls, changes) {
  const set = sets[label], tags = new Map(), tot = { requests: 0, bytes: 0, queries: 0, dbBytes: 0, ms: 0, full: 0, notModified: 0 };
  const rate = p => (label === 'after' ? p[4] : p[3]);
  const n = Math.max(...polls.map(rate));
  const every = changes ? Math.floor(n / (changes + 1)) : 0;
  for (let i = 1; i <= n; i++) {
    if (every && i % every === 0) await addGame();
    for (const p of polls) {
      const [, key, query] = p, perHour = rate(p), tk = key + query;
      if (i % Math.round(n / perHour) !== 0) continue;
      const headers = label === 'after' && tags.get(tk) ? { 'if-none-match': tags.get(tk) } : {};
      stat.queries = 0; stat.dbBytes = 0;
      const r = await call(set[key], 'GET', { query, headers });
      if (r.status === 200 && r.headers.etag && label === 'after') tags.set(tk, r.headers.etag);
      tot.requests++; tot.bytes += r.bytes; tot.queries += stat.queries; tot.dbBytes += stat.dbBytes; tot.ms += r.ms;
      r.status === 304 ? tot.notModified++ : tot.full++;
    }
  }
  return tot;
}
const Q = '?code=' + code;
const scenarios = [
  ['Phone open on the club, 6 games saved in the hour (club + events every 15 s before)', [['club', 'club', Q, 240, 130], ['events', 'events', Q, 240, 7]], 6],
  ['Phone open on the club, quiet hour, nothing saved', [['club', 'club', Q, 240, 72], ['events', 'events', Q, 240, 1]], 0],
  ['Phone scoring a live game (live game every 2.5 s, club every 15 s)', [['live', 'live', Q + '&id=live-bench&secret=abcdef12', 1440, 1440], ['club', 'club', Q, 240, 130]], 6],
  ['Club TV display (court board every 5 s)', [['board', 'live', Q + '&board=1', 720, 720]], 6],
];
// A live game for the scorer scenario.
await call(after.live, 'POST', { body: { code, action: 'state', id: 'live-bench', secret: 'abcdef12', state: { cfg: { teams: [[names[0], names[1]], [names[2], names[3]]], mode: 'doubles', scoring: 'rally', target: 11 }, score: [3, 2], serving: 0, serverNum: 1, winner: null, startedAt: Date.now() }, ack: 0 } });

const kb = v => (v / 1024).toFixed(0) + ' KB', mb = v => (v / 1048576).toFixed(2) + ' MB';
console.log(`Club with ${GAMES} games, 24 players (12 photo avatars). One device, one hour, 6 games saved during it.\n`);
const rows = [];
for (const [title, polls, changes] of scenarios) {
  const res = {};
  for (const label of Object.keys(sets)) res[label] = await hour(label, polls, changes);
  console.log(title);
  for (const [label, t] of Object.entries(res)) console.log(`  ${label.padEnd(6)} ${String(t.requests).padStart(5)} requests (${t.full} full, ${t.notModified} 304) | sent to phone ${mb(t.bytes).padStart(9)} | DB rows to function ${mb(t.dbBytes).padStart(9)} | ${String(t.queries).padStart(5)} SQL statements | handler ${(t.ms / 1000).toFixed(1)} s`);
  if (res.before) console.log(`  ratio  bytes to phone ${(res.before.bytes / res.after.bytes).toFixed(1)}x less, DB transfer ${(res.before.dbBytes / res.after.dbBytes).toFixed(1)}x less, handler time ${(res.before.ms / res.after.ms).toFixed(1)}x less, SQL statements ${(res.before.queries / res.after.queries).toFixed(2)}x`);
  console.log('');
}
server.close(); await pg.close(); process.exit(0);
