// DUPR partner client: configuration, the cached partner token, and the few calls the app makes. Files starting with
// "_" are not routes. Everything is off unless DUPR_CLIENT_KEY and DUPR_CLIENT_SECRET are set (DUPR_ENV=prod by default; uat or test selects DUPR's test site).
// Secrets come only from the environment, are never logged, and never leave this server: the browser gets the
// base64 client key (what DUPR's login iframe needs), nothing else.
// Built from DUPR's published OpenAPI specs and docs; real behaviour was only checked against a local mock.
import { classify, redact } from './_dupr_map.js';

const HOSTS = {
  uat: { api: 'https://uat.mydupr.com/api', pub: 'https://api.uat.dupr.gg', login: 'https://uat.dupr.gg' },
  prod: { api: 'https://prod.mydupr.com/api', pub: 'https://api.dupr.gg', login: 'https://dashboard.dupr.com' }
};

// Tests point these at a local mock and make waiting instant. Production never calls it.
const hooks = { fetch: (...a) => globalThis.fetch(...a), sleep: ms => new Promise(r => setTimeout(r, ms)), hosts: null, now: () => Date.now() };
export const __test = {
  set(h) { Object.assign(hooks, h); tokenCache = null; tokenPending = null; },
  reset() { hooks.fetch = (...a) => globalThis.fetch(...a); hooks.sleep = ms => new Promise(r => setTimeout(r, ms)); hooks.hosts = null; hooks.now = () => Date.now(); tokenCache = null; tokenPending = null; }
};

export function config() {
  const key = String(process.env.DUPR_CLIENT_KEY || '').trim(), secret = String(process.env.DUPR_CLIENT_SECRET || '').trim();
  if (!key || !secret) return null;
  const env = /^(uat|test)$/i.test(String(process.env.DUPR_ENV || '').trim()) ? 'uat' : 'prod';
  return { key, secret, env, hosts: hooks.hosts || HOSTS[env] };
}
export const enabled = () => !!config();
// What the browser needs to show DUPR's login iframe. Never the secret.
export function publicConfig(cfg) {
  return { env: cfg.env, loginOrigin: new URL(cfg.hosts.login).origin, loginUrl: `${cfg.hosts.login}/login-external-app/${encodeURIComponent(Buffer.from(cfg.key).toString('base64'))}` };
}

export class DuprError extends Error {
  constructor(message, { kind, status = 0, requestId = null, consent = false } = {}) {
    super(message);
    this.name = 'DuprError'; this.kind = kind; this.dupr = true; this.upstream = status; this.requestId = requestId; this.consent = consent;
  }
}

let tokenCache = null;   // { token, exp, key }: the partner token, kept in memory for about 55 minutes
let tokenPending = null; // a token request already in flight, shared by simultaneous calls
const TOKEN_MS = 55 * 60 * 1000;
const RETRY_WAITS = [400, 1500]; // pauses before the 2nd and 3rd try of a network error, 429 or 5xx

async function send(cfg, method, url, { body, headers = {}, timeout = 15000 }) {
  const h = Object.assign({ Accept: 'application/json' }, headers);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let res;
  try {
    res = await hooks.fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeout) : undefined });
  } catch (err) {
    throw new DuprError('Could not reach DUPR.', { kind: 'retry' });
  }
  let text = '', json = null;
  try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, requestId: res.headers.get('x-request-id') };
}

// Reads DUPR's answer: HTTP errors, and the HTTP-200-with-status=FAILURE quirk the public API uses, become DuprErrors.
function check(cfg, r, secrets) {
  const msg = redact((r.json && (r.json.message || (Array.isArray(r.json.errors) && r.json.errors[0] && (r.json.errors[0].message || r.json.errors[0]))) ) || '', secrets);
  const failed = r.status < 200 || r.status >= 300 || (r.json && r.json.status === 'FAILURE');
  if (!failed) return r.json;
  const kind = classify({ status: r.status >= 400 ? r.status : 0, message: msg });
  const nice = r.status === 403 || r.status === 417 ? 'DUPR refused the request for this app (' + r.status + ').' : r.status === 429 ? 'DUPR is busy. Try again in a moment.' : msg || `DUPR answered with an error (${r.status}).`;
  throw new DuprError(nice, { kind, status: r.status, requestId: r.requestId, consent: /consent/i.test(msg) });
}

async function partnerToken(cfg, force) {
  if (!force && tokenCache && tokenCache.key === cfg.key && tokenCache.exp > hooks.now()) return tokenCache.token;
  if (!tokenPending) {
    tokenPending = (async () => {
      const basic = Buffer.from(`${cfg.key}:${cfg.secret}`).toString('base64');
      const r = await send(cfg, 'POST', `${cfg.hosts.api}/auth/v1.0/token`, { headers: { 'x-authorization': basic } });
      const body = check(cfg, r, [cfg.secret, cfg.key, basic]);
      const token = body && (body.token || (body.result && body.result.token));
      if (!token) throw new DuprError('DUPR did not return a token.', { kind: 'permanent', status: r.status, requestId: r.requestId });
      const expiry = Date.parse((body.expiry || (body.result && body.result.expiry)) || '');
      const exp = Number.isFinite(expiry) ? Math.min(hooks.now() + TOKEN_MS, expiry - 5 * 60 * 1000) : hooks.now() + TOKEN_MS;
      tokenCache = { token, exp, key: cfg.key };
      return token;
    })().finally(() => { tokenPending = null; });
  }
  return tokenPending;
}

// One call. auth: 'partner' (the cached partner token, renewed once if DUPR says 401) or { user: token } for the
// player's own SSO token. Network errors, 429 and 5xx are retried a couple of times; everything else is thrown once.
// timeout (ms) and retry (false: one try, no waiting) let a read for a person on screen fail fast.
async function call(cfg, method, url, { body, auth = 'partner', timeout, retry = true } = {}) {
  const secrets = [cfg.secret, cfg.key, auth && auth.user];
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      const token = auth === 'partner' ? await partnerToken(cfg, false) : auth.user;
      r = await send(cfg, method, url, { body, timeout, headers: { Authorization: 'Bearer ' + token } });
      if (r.status === 401 && auth === 'partner' && !renewed) { renewed = true; await partnerToken(cfg, true); attempt--; continue; }
      return check(cfg, r, secrets);
    } catch (err) {
      if (!(err instanceof DuprError)) throw err;
      if (retry && err.kind === 'retry' && attempt < RETRY_WAITS.length) { await hooks.sleep(RETRY_WAITS[attempt]); continue; }
      throw err;
    }
  }
}

// ---- parsing (exported so the shapes are tested) ----
export function parseRating(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 && n < 10 ? Math.round(n * 1000) / 1000 : null; // "NR" and blanks mean not rated
}
// Reliability is a 0-100 score; anything else means unknown.
export function parseReliability(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
}
// DUPR documents two shapes for a user's ratings (a nested ratings object, and flat *Rating fields); read either.
// Only the rating fields are read; name, gender, birth year and location are never looked at.
export function parseUserDetail(json) {
  const u = (json && (json.result || json)) || {};
  const r = u.ratings || {};
  const rating = { doubles: parseRating(r.doubles ?? u.doublesRating), singles: parseRating(r.singles ?? u.singlesRating) };
  const prov = { doubles: r.doublesProvisional ?? u.doublesProvisional, singles: r.singlesProvisional ?? u.singlesProvisional };
  const reliable = { doubles: r.isDoublesReliable ?? r.doublesReliable, singles: r.isSinglesReliable ?? r.singlesReliable };
  return {
    rating,
    provisional: { doubles: prov.doubles === true || reliable.doubles === false, singles: prov.singles === true || reliable.singles === false },
    reliability: { doubles: parseReliability(r.doublesReliabilityScore ?? u.doublesReliabilityScore), singles: parseReliability(r.singlesReliabilityScore ?? u.singlesReliabilityScore) }
  };
}
export function parseEntitlements(json) {
  const subs = json && (json.subscriptions || (json.result && json.result.subscriptions));
  if (!Array.isArray(subs)) return null; // unknown
  const out = new Set();
  for (const s of subs) for (const e of (s && s.entitlements && s.entitlements.tournaments) || []) out.add(String(e));
  return [...out];
}

// ---- the calls the app makes ----
// Who is this player? Called once with the user's SSO token, which is then thrown away. The postMessage payload from
// the login iframe is controlled by the browser, so this call is what proves which DUPR account it is.
export async function userInfo(cfg, userToken) {
  const body = await call(cfg, 'GET', `${cfg.hosts.pub}/public/user/info`, { auth: { user: userToken } });
  const first = body && Array.isArray(body.results) ? body.results[0] : null;
  const duprId = first && String(first.duprId || '').trim().toUpperCase();
  if (!duprId || !/^[A-Z0-9]{1,12}$/.test(duprId)) throw new DuprError('DUPR did not say who this is. Try connecting again.', { kind: 'permanent', status: 200 });
  return { duprId };
}
export async function entitlements(cfg, userToken) {
  try { return parseEntitlements(await call(cfg, 'POST', `${cfg.hosts.pub}/subscription/active`, { auth: { user: userToken } })); } catch { return null; }
}
// A player's own rating, read on their behalf: 5 seconds, one try (a 4xx will not change by asking again).
export async function userRatings(cfg, duprId) {
  return parseUserDetail(await call(cfg, 'GET', `${cfg.hosts.api}/user/v1.0/${encodeURIComponent(duprId)}`, { timeout: 5000, retry: false }));
}

// Up to 100 matches. DUPR reports each one: matchCodes[] for those created, errors[] for those refused; one failure
// does not stop the rest. Returns { created: Map(identifier -> {matchCode, hashedMatchCode}), errors: Map(identifier -> message) }.
export async function createBatch(cfg, matches) {
  const body = await call(cfg, 'POST', `${cfg.hosts.api}/match/v1.0/batch`, { body: matches });
  const res = (body && (body.result || body)) || {};
  const created = new Map(), errors = new Map();
  for (const c of res.matchCodes || res.successes || []) if (c && c.identifier) created.set(String(c.identifier), { matchCode: c.matchCode == null ? null : String(c.matchCode), hashedMatchCode: c.hashedMatchCode || null });
  for (const e of res.errors || []) {
    const text = e && (typeof e.error === 'string' ? e.error : e.errors && typeof e.errors === 'object' ? Object.values(e.errors).join('; ') : e.message);
    if (e && e.identifier) errors.set(String(e.identifier), redact(text || 'DUPR refused this match.', [cfg.secret, cfg.key]));
  }
  return { created, errors };
}
export async function updateMatch(cfg, matchId, match) {
  await call(cfg, 'POST', `${cfg.hosts.api}/match/v1.0/update`, { body: Object.assign({ matchId }, match) });
}
export async function deleteMatch(cfg, { matchCode, identifier }) {
  await call(cfg, 'DELETE', `${cfg.hosts.api}/match/v1.0/delete`, { body: { matchCode, identifier } });
}
