// Runs the Swift watch client against the real API handlers over HTTP, on a throwaway in-memory Postgres (PGlite): the Swift
// LiveServerTests link a watch, score with tap ids (including a replayed one), undo and get unlinked. Needs a Mac with Swift.
//   npm ci && npm i --no-save @electric-sql/pglite && node tools/watch-swift-check.mjs
// No real database, host or club is touched: the club, code and game below are made up and live only in this process.
import http from 'node:http';
import { spawn } from 'node:child_process';
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
const dbServer = http.createServer((req, res) => {
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
await new Promise(r => dbServer.listen(0, '127.0.0.1', r));
neon.neonConfig.fetchEndpoint = () => `http://127.0.0.1:${dbServer.address().port}/sql`;
process.env.DATABASE_URL = 'postgres://local:local@localhost/throwaway';

const load = async name => (await import(pathToFileURL(path.join(root, 'api', name + '.js')).href)).default;
const [club, live] = await Promise.all(['club', 'live'].map(load));

// The API as Vercel serves it: JSON bodies parsed, handlers called with (req, res).
const api = http.createServer(async (req, res) => {
  let data = '';
  for await (const c of req) data += c;
  if (data) req.body = JSON.parse(data);
  const handler = req.url.startsWith('/api/club') ? club : req.url.startsWith('/api/live') ? live : null;
  if (!handler) { res.statusCode = 404; return res.end('{}'); }
  try { await handler(req, res); } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message) })); }
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${api.address().port}`;

const post = async (handlerPath, body) => (await fetch(base + handlerPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const made = await post('/api/club', { name: 'Swift check club' });
const code = made.club.code, game = 'live-swift1', secret = 'swiftSecret123';
const state = { cfg: { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, teams: [['Ana', 'Ben'], ['Cy', 'Di']] }, score: [0, 0], serving: 0, serverNum: 2, right: [0, 0], server: 0, rallies: 0, switched: false, justSwitched: false, winner: null, startedAt: Date.now(), endedAt: null };
const pub = await post('/api/live', { code, action: 'state', id: game, secret, state, ack: 0 });
if (pub.error) { console.error('Could not start the made-up game:', pub.error); process.exit(1); }
console.log('API on', base, '- made-up club and live game ready; running swift test --filter LiveServerTests');

const child = spawn('swift', ['test', '--package-path', path.join(root, 'watch/Packages/DinkCore'), '--filter', 'LiveServerTests'], {
  stdio: 'inherit', env: { ...process.env, DINK_TEST_URL: base, DINK_TEST_CODE: code, DINK_TEST_GAME: game, DINK_TEST_SECRET: secret }
});
const status = await new Promise(r => child.on('close', r));
api.close(); dbServer.close(); await pg.close();
console.log(status === 0 ? '\nswift watch client passed against the API' : '\nswift watch client FAILED');
process.exit(status === 0 ? 0 : 1);
