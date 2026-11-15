// Tiny static server for previewing public/ locally: node tools/serve.cjs [port]
// The club API isn't served here; use `vercel dev` for that.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'public');
const port = Number(process.argv[2]) || 4173;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// The same security headers Vercel sends (from vercel.json), so the Content-Security-Policy can be tested locally.
let securityHeaders = [];
try { securityHeaders = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8')).headers.find(h => h.source === '/(.*)').headers; } catch {}
// Stand-in events for the preview: kept in memory and run by the same pure modules as api/events.js, with no
// organizer checks. Finished matches also land in the stand-in club's games, like the real API does.
const preview = { games: [], events: new Map(), roster: new Set(), shares: new Map(), refs: new Map() }; // shares: token -> event id; refs: event id -> private DUPR reference IDs
// The preview never calls Google: a sheet link is run through the real link checks (api/_gsheet.js) and then answered by this canned sheet.
const SHEET_STUB = process.env.SHEET_STUB_CSV || 'Team,Player 1,Player 2,DUPR ID 1,DUPR ID 2,Logo URL\r\nNet Ninjas,Ana Lopez,Ben Ruiz,K4M2P9,R7T3QX,https://example.com/logos/net-ninjas.png\r\nDrop Shots,Cy Park,Di Wu,,,\r\nKitchen Crew,Ed Fox,Flo Kim,,,https://example.com/logos/kitchen.png\r\nLob City,Gus Hart,Hal Moss,,,\r\n';
const stubFetch = async () => ({ status: 200, headers: { get: k => (k.toLowerCase() === 'content-type' ? 'text/csv; charset=utf-8' : null) }, body: new Response(SHEET_STUB).body });
function previewEvents(req, url, res) {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  Promise.all([import('../api/_events.js'), import('../api/_share.js'), import('../api/_gsheet.js')]).then(([E, S, G]) => {
    const fail = err => send(err.status || 500, { error: err.message });
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (id) return preview.events.has(id) ? send(200, { event: E.view(preview.events.get(id)) }) : send(404, { error: 'That event no longer exists.' });
      return send(200, { events: [...preview.events.values()].map(e => { const cur = e.rounds.find(r => r.status !== 'done') || e.rounds[e.rounds.length - 1];
        return { id: e.id, name: e.name, format: e.format, partners: e.partners, status: e.status, players: e.players.length, courts: e.courts, round: cur ? cur.n : 0, roundsPlanned: e.roundsPlanned, stage: e.stage, champion: e.champion, createdAt: e.createdAt, updatedAt: e.updatedAt }; }) });
    }
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try {
        const b = JSON.parse(data || '{}'), now = Date.now();
        const keep = out => { if (!out || !out.game) return; const g = Object.assign({}, out.game, { winner: out.game.score[0] > out.game.score[1] ? 0 : 1, event: { id: out.event.id, name: out.event.name }, receivedAt: now });
          const i = preview.games.findIndex(x => x.id === g.id); if (i >= 0) preview.games[i] = Object.assign(preview.games[i], g); else preview.games.unshift(g); };
        if (b.action === 'create') {
          const ev = E.createEvent(b.event, now); preview.events.set(ev.id, ev); ev.players.forEach(p => preview.roster.add(p));
          preview.refs.set(ev.id, E.cleanRefs(b.event && b.event.refs, ev.players));
          return send(201, { event: E.view(ev) });
        }
        if (b.action === 'sheet-fetch') return G.fetchSheetCsv(b.url, stubFetch).then(csv => send(200, { csv }), fail);
        const ev = preview.events.get(b.id);
        if (b.action === 'refs' && ev) return send(200, { refs: preview.refs.get(b.id) || {} });
        if (b.action === 'public-logos' && ev) { ev.publicLogos = b.on === true; return send(200, { event: E.view(ev) }); }
        if (b.action === 'delete') { preview.events.delete(b.id); for (const [t, id] of preview.shares) if (id === b.id) preview.shares.delete(t); return send(200, { ok: true }); }
        if (!ev) return send(404, { error: 'That event no longer exists.' });
        if (b.action === 'result') { const out = E.recordResult(ev, b.matchId, b, now); keep(out); }
        else if (b.action === 'correct') keep(E.correctResult(ev, b.matchId, b.score, now));
        else if (b.action === 'next-round') E.startNextRound(ev, now);
        else if (b.action === 'set-round') E.setRound(ev, b.round, b.matches, now);
        else if (b.action === 'publish-round') E.publishRound(ev, b.round, now);
        else if (b.action === 'start-knockout') E.startKnockout(ev, b.advance, now);
        else if (b.action === 'end') E.endEvent(ev, now);
        else if (b.action === 'share' || b.action === 'share-new' || b.action === 'share-off') {
          let tok = [...preview.shares].find(([, id]) => id === ev.id);
          if (tok && b.action !== 'share') { preview.shares.delete(tok[0]); tok = null; }
          if (!tok && b.action !== 'share-off') { tok = [S.newShareToken(), ev.id]; preview.shares.set(tok[0], ev.id); }
          return send(200, { shareToken: tok ? tok[0] : null });
        }
        else return send(400, { error: 'Unknown action.' });
        send(200, { event: E.view(ev) });
      } catch (err) { fail(err); }
    });
  }).catch(err => send(500, { error: String(err.message) }));
}
http.createServer((req, res) => {
  for (const h of securityHeaders) res.setHeader(h.key, h.value);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') && process.env.DATABASE_URL && /^\/api\/[a-z]+$/.test(url.pathname)) {
    // With the database settings loaded (node --env-file=.env.local tools/serve.cjs), run the real API functions.
    const file = path.join(__dirname, '..', 'api', url.pathname.slice(5) + '.js');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('{"error":"Not found"}'); }
    import('file://' + file.replace(/\\/g, '/')).then(m => m.default(req, res)).catch(err => { console.error(err); res.writeHead(500); res.end('{"error":"Server error"}'); });
    return;
  }
  if (url.pathname === '/api/events') return previewEvents(req, url, res);
  if (url.pathname === '/api/bracket') {
    // The public, read-only view: the same publicView() as api/bracket.js, with the preview's in-memory events.
    Promise.all([import('../api/_share.js')]).then(([S]) => {
      const t = url.searchParams.get('token'), id = S.isShareToken(t) && preview.shares.get(t), ev = id && preview.events.get(id);
      if (!ev) { res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"error":"This bracket link is not active."}'); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=20' });
      res.end(JSON.stringify(S.publicView(ev)));
    });
    return;
  }
  if (/^\/b\/[^/]+\/?$/.test(url.pathname)) { // same rewrite as vercel.json
    return fs.readFile(path.join(root, 'b.html'), (err, data) => { res.writeHead(err ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }); res.end(data); });
  }
  if (url.pathname.startsWith('/api/')) {
    // Stand-in club so the app can be previewed without the real server.
    const code = (url.searchParams.get('code') || 'K7P2QX').toUpperCase();
    const body = url.pathname === '/api/club'
      ? { club: { code, name: 'Preview Club' }, games: preview.games, deleted: [], roster: [...preview.roster] }
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
