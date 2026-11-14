// Tiny static server for previewing public/ locally: node tools/serve.cjs [port]
// The club API isn't served here; use `vercel dev` for that.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'public');
const port = Number(process.argv[2]) || 4173;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') && process.env.DATABASE_URL && /^\/api\/[a-z]+$/.test(url.pathname)) {
    // With the database settings loaded (node --env-file=.env.local tools/serve.cjs), run the real API functions.
    const file = path.join(__dirname, '..', 'api', url.pathname.slice(5) + '.js');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('{"error":"Not found"}'); }
    import('file://' + file.replace(/\\/g, '/')).then(m => m.default(req, res)).catch(err => { console.error(err); res.writeHead(500); res.end('{"error":"Server error"}'); });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    // Stand-in club so the app can be previewed without the real server.
    const code = (url.searchParams.get('code') || 'K7P2QX').toUpperCase();
    const body = url.pathname === '/api/club'
      ? { club: { code, name: 'Preview Club' }, games: [], deleted: [], roster: [] }
      : { ok: true, saved: 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Not available in local preview"}'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log(`Preview on http://localhost:${port}`));
