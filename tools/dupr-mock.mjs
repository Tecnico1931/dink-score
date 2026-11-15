// A local stand-in for DUPR, for tests and headless checks only. It mimics the paths, headers, payload shapes and error
// shapes in DUPR's published OpenAPI specs (partner API under /api, public API at the root): 401 / 403 / 417 / 429, the
// HTTP-200-with-status=FAILURE quirk of the public API, per-match errors inside a 200 batch, the identifier and 6-point
// rules. Real DUPR behaviour is unverified until UAT keys exist: this only proves our code does what the specs say.
import http from 'node:http';

export const KEY = 'mock-client-key', SECRET = 'mock-client-secret';
const b64 = s => Buffer.from(s).toString('base64');

export async function startMock() {
  const st = {
    creds: b64(`${KEY}:${SECRET}`),
    partnerTokens: new Map(),     // token -> expiry ms
    users: new Map(),             // SSO user token -> { duprId, consent, entitlements }
    ratings: new Map(),           // duprId -> { doubles, singles }
    connected: new Set(),         // duprIds that did SSO (restricted partner: others give 403 on user detail)
    matches: new Map(),           // identifier -> { matchCode, body, deleted }
    nextCode: 1000000001,
    deny: null,                   // 403 | 417: the partner key lacks permission / account expired
    tokenCalls: 0, calls: [],     // every request: { method, path, host }
    rateLimit: 0,                 // answer the next n partner calls with 429
    serverError: 0,               // answer the next n partner calls with 500
    dropAfterCommit: 0,           // process the next n batch calls, then cut the connection before replying
    expireTokenNow() { st.partnerTokens.clear(); },
    addUser(token, duprId, { consent = true, entitlements = ['BASIC_L1'], doubles = '3.520', singles = '3.610', connected = true } = {}) {
      st.users.set(token, { duprId, consent, entitlements }); st.ratings.set(duprId, { doubles, singles }); if (connected) st.connected.add(duprId);
    },
    live: () => [...st.matches.values()].filter(m => !m.deleted)
  };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': 'mock-req' }); res.end(JSON.stringify(body)); };
  const known = id => st.ratings.has(id);

  function validate(m, forUpdate) {
    const errs = [];
    for (const k of ['event', 'format', 'identifier', 'matchDate', 'teamA', 'teamB']) if (!m || m[k] == null || m[k] === '') errs.push(`${k} is required`);
    if (errs.length) return errs.join('; ');
    const players = [m.teamA.player1, m.teamA.player2, m.teamB.player1, m.teamB.player2].filter(Boolean);
    if (new Set(players).size !== players.length) return 'Duplicate players are not allowed';
    if (m.format === 'DOUBLES' && players.length !== 4) return 'Doubles needs four players';
    if (players.some(p => !known(p))) return 'Unknown DUPR player';
    const a = m.teamA.game1, b = m.teamB.game1;
    if (!Number.isInteger(a) || !Number.isInteger(b)) return 'game1 is required for both teams';
    if (a === b) return 'A game cannot be tied';
    if (Math.max(a, b) < 6) return 'The winning team must score at least 6 points';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.matchDate)) return 'matchDate must be yyyy-MM-dd';
    if (Date.parse(m.matchDate) > Date.now() + 36 * 3600e3) return 'matchDate cannot be in the future';
    if (m.matchSource && m.matchSource !== 'PARTNER' && m.matchSource !== 'CLUB') return 'Invalid matchSource';
    return null;
  }
  const create = m => {
    const bad = validate(m);
    if (bad) return { error: bad };
    if (st.matches.has(m.identifier)) return { error: 'Match with identifier already exists' };
    const matchCode = String(st.nextCode++);
    st.matches.set(m.identifier, { matchCode, body: m, deleted: false });
    return { ok: { identifier: m.identifier, matchCode, hashedMatchCode: 'H' + matchCode } };
  };

  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      const path = url.pathname;
      st.calls.push({ method: req.method, path, auth: req.headers.authorization || null });
      let body = null; try { body = data ? JSON.parse(data) : null; } catch { return json(res, 400, { status: 'FAILURE', message: 'Bad JSON' }); }
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');

      // the login iframe page (preview only): a button that posts what DUPR's iframe posts
      if (path.startsWith('/sso/login-external-app/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const tokens = [...st.users.keys()];
        return res.end(`<!doctype html><body style="font:16px system-ui;padding:16px"><p>Mock DUPR login</p>${tokens.map(t => `<button style="display:block;margin:6px 0;padding:10px" data-t="${t}">Sign in as ${st.users.get(t).duprId}</button>`).join('')}<script>document.querySelectorAll('button').forEach(b=>b.onclick=()=>{parent.postMessage({userToken:b.dataset.t,refreshToken:'r-'+b.dataset.t,id:1,duprId:'x',stats:{}},'*')})</script></body>`);
      }

      if (path === '/api/auth/v1.0/token' && req.method === 'POST') {
        st.tokenCalls++;
        if (req.headers['x-authorization'] !== st.creds) return json(res, 401, { status: 'FAILURE', message: 'Invalid credentials' });
        const token = 'partner-' + st.tokenCalls; st.partnerTokens.set(token, Date.now() + 3600e3);
        return json(res, 200, { token, expiry: new Date(Date.now() + 3600e3).toISOString() });
      }

      // public API: the player's own SSO token
      if (path === '/public/user/info') {
        const u = st.users.get(bearer);
        if (!u) return json(res, 403, { status: 'FAILURE', message: 'Token is invalid' });
        if (!u.consent) return json(res, 200, { status: 'FAILURE', errors: [{ message: 'No active consent for this partner. The user must re-grant consent.' }], message: 'No active consent for this partner. The user must re-grant consent.' });
        return json(res, 200, { status: 'SUCCESS', results: [{ duprId: u.duprId, fullName: 'Mock Player' }] });
      }
      if (path === '/subscription/active') {
        const u = st.users.get(bearer);
        if (!u) return json(res, 403, { status: 'FAILURE', message: 'Token is invalid' });
        return json(res, 200, { subscriptions: [{ displayName: 'DUPR+', status: 'active', entitlements: { tournaments: u.entitlements, merchandise: [] } }] });
      }

      // partner API
      if (!path.startsWith('/api/')) return json(res, 404, { status: 'FAILURE', message: 'Not found' });
      if (!st.partnerTokens.has(bearer) || st.partnerTokens.get(bearer) < Date.now()) return json(res, 401, { status: 'FAILURE', message: 'Authentication failed' });
      if (st.deny) return json(res, st.deny, { status: 'FAILURE', message: st.deny === 417 ? 'Account expired. Contact DUPR API support to renew access.' : 'Insufficient permissions' });
      if (st.rateLimit > 0) { st.rateLimit--; return json(res, 429, { status: 'FAILURE', message: 'Rate limit exceeded' }); }
      if (st.serverError > 0) { st.serverError--; return json(res, 500, { status: 'FAILURE', message: 'Internal error' }); }

      let m;
      if ((m = path.match(/^\/api\/user\/v1\.0\/([A-Za-z0-9]+)$/)) && req.method === 'GET') {
        const id = m[1];
        if (!known(id)) return json(res, 404, { status: 'FAILURE', message: 'User not found' });
        if (!st.connected.has(id)) return json(res, 403, { status: 'FAILURE', message: 'This user has not connected to your platform' });
        const r = st.ratings.get(id);
        return json(res, 200, { status: 'SUCCESS', result: { id, fullName: 'Mock Player', ratings: { doubles: r.doubles, singles: r.singles, isDoublesReliable: true, isSinglesReliable: true } } });
      }
      if (path === '/api/match/v1.0/batch' && req.method === 'POST') {
        if (!Array.isArray(body) || body.length > 100) return json(res, 400, { status: 'FAILURE', message: 'Up to 100 matches per batch' });
        const matchCodes = [], errors = [];
        for (const x of body) { const r = create(x); if (r.ok) matchCodes.push(r.ok); else errors.push({ identifier: x && x.identifier, error: r.error, errors: { match: r.error } }); }
        if (st.dropAfterCommit > 0) { st.dropAfterCommit--; return req.socket.destroy(); }
        return json(res, 200, { status: errors.length && matchCodes.length ? 'PARTIAL' : 'SUCCESS', result: { matchCodes, errors } });
      }
      if (path === '/api/match/v1.0/update' && req.method === 'POST') {
        const cur = [...st.matches.values()].find(x => x.matchCode === String(body && body.matchId) && !x.deleted);
        if (!cur) return json(res, 404, { status: 'FAILURE', message: 'Match not found' });
        const bad = validate(body, true);
        if (bad) return json(res, 400, { status: 'FAILURE', message: bad });
        if (body.identifier !== cur.body.identifier) return json(res, 400, { status: 'FAILURE', message: 'identifier does not match' });
        const { matchId, ...rest } = body; cur.body = rest;
        return json(res, 200, { status: 'SUCCESS', result: { identifier: rest.identifier, matchCode: cur.matchCode, hashedMatchCode: 'H' + cur.matchCode } });
      }
      if (path === '/api/match/v1.0/delete' && req.method === 'DELETE') {
        const cur = st.matches.get(body && body.identifier);
        if (!cur || cur.deleted || cur.matchCode !== String(body.matchCode)) return json(res, 404, { status: 'FAILURE', message: 'Match not found' });
        cur.deleted = true; // the identifier stays burned: it can never be created again
        return json(res, 200, { status: 'SUCCESS' });
      }
      return json(res, 404, { status: 'FAILURE', message: 'Not found' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, state: st, KEY, SECRET,
    hosts: { api: origin + '/api', pub: origin, login: origin + '/sso' },
    close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); })
  };
}
