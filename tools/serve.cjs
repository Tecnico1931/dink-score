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
