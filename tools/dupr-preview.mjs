// Serves the built site (public/) with the REAL api/*.js on a throwaway in-memory Postgres, plus a local mock DUPR, so the
// DUPR screens can be driven in a browser without touching any real database or DUPR host.
//   node tools/dupr-preview.mjs [port] [off]        (needs: npm i --no-save @electric-sql/pglite; run `node build.cjs` first)
// 'off' leaves the DUPR keys unset: the app must look exactly as it does for everyone today.
// GET /__seed.json gives the club code and the localStorage entries that make a browser the club's organizer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMock, KEY, SECRET } from './dupr-mock.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 4180, off = process.argv[3] === 'off';
const { PGlite } = await import('@electric-sql/pglite');
const neon = await import('@neondatabase/serverless');
const pg = new PGlite();
const TEXT_OIDS = [16, 20, 21, 23, 25, 700, 701, 1043, 1082, 1114, 1184, 1700, 114, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map(o => [o, v => v]));
const run = async q => { const r = await pg.query(q.query, q.params || [], { rowMode: 'array', parsers }); return { command: 'SELECT', rowCount: r.rows.length, rows: r.rows, fields: r.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID, tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })), rowAsArray: true }; };
const sqlServer = http.createServer((req, res) => { let d = ''; req.on('data', c => (d += c)); req.on('end', async () => { try { const b = JSON.parse(d); const o = b.queries ? await Promise.all(b.queries.map(run)) : await run(b); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b.queries ? { results: o } : o)); } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ message: String(e.message), code: e.code || '42000' })); } }); });
await new Promise(r => sqlServer.listen(0, '127.0.0.1', r));
neon.neonConfig.fetchEndpoint = () => `http://127.0.0.1:${sqlServer.address().port}/sql`;
process.env.DATABASE_URL = 'postgres://local:local@localhost/throwaway';

const mock = await startMock();
if (!off) {
  process.env.DUPR_CONNECT_ENABLED = 'true'; process.env.DUPR_CLIENT_KEY = KEY; process.env.DUPR_CLIENT_SECRET = SECRET; process.env.DUPR_ENV = 'uat';
  (await import(pathToFileURL(path.join(root, 'api', '_duprapi.js')).href)).__test.set({ hosts: mock.hosts, sleep: async () => {} });
}
const names = ['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal'];
names.forEach((n, i) => mock.state.addUser(`sso-token-${n.toLowerCase()}-0000000`, `${n.toUpperCase()}00${i + 1}`, { doubles: (3 + i / 10).toFixed(3) }));

const H = {};
for (const n of ['club', 'events', 'games', 'players', 'roster', 'dupr', 'bracket']) { try { H[n] = (await import(pathToFileURL(path.join(root, 'api', n + '.js')).href)).default; } catch {} }
async function direct(handler, method, body, query = '') {
  const req = { method, url: '/api/x' + query, headers: { 'x-real-ip': '10.9.0.' + Math.floor(Math.random() * 200) }, body };
  let status = 0, text = '';
  await handler(req, { statusCode: 0, setHeader() {}, end(t) { status = this.statusCode; text = t; } });
  return { status, json: JSON.parse(text) };
}
// Seed: a club with an event whose first round is played, and Ana's phone as the organizer.
const club = (await direct(H.club, 'POST', { name: 'Preview Club' })).json;
const code = club.club.code, owner = club.ownerToken;
let ev = (await direct(H.events, 'POST', { code, action: 'create', ownerToken: owner, event: { name: 'Sunday rotation', format: 'roundrobin', rotation: 'auto', courts: 2, players: names, seed: 'preview' } })).json.event;
const claim = (await direct(H.players, 'POST', { code, action: 'claim', name: 'Ana' })).json;
for (const [i, m] of ev.rounds[0].matches.entries()) ev = (await direct(H.events, 'POST', { code, action: 'result', id: ev.id, matchId: m.id, score: i ? [11, 9] : [11, 5], endedAt: Date.now() })).json.event;
const seed = { 'pb.club': { code, name: 'Preview Club', hasPin: false, openClaim: false }, 'pb.clubs': [{ code, name: 'Preview Club', hasPin: false }], 'pb.owners': { [code]: owner }, 'pb.me': { [code]: { name: 'Ana', token: claim.playerToken } }, 'pb.tutorialSeen': true, eventId: ev.id, code };

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers[0].headers;
const pub = path.join(root, 'public');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  for (const h of vercel) res.setHeader(h.key, h.key === 'Content-Security-Policy' ? h.value.replace('frame-src', `frame-src ${mock.origin}`) : h.value); // the mock login page lives on another local origin
  if (url.pathname === '/__seed.json') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(seed)); }
  if (url.pathname.startsWith('/api/')) {
    const h = H[url.pathname.slice(5)]; if (!h) { res.writeHead(404); return res.end('{"error":"Not found"}'); }
    return h(req, res);
  }
  let file = path.normalize(path.join(pub, decodeURIComponent(url.pathname)));
  if (!file.startsWith(pub)) { res.writeHead(403); return res.end(); }
  if (url.pathname.endsWith('/')) file += 'index.html';
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end('nope'); } res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data); });
}).listen(port, () => console.log(`DUPR preview on http://localhost:${port} (${off ? 'DUPR OFF' : 'DUPR ON against the mock at ' + mock.origin}) club ${code}`));
