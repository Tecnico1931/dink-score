// DUPR: turning finished event matches into DUPR match payloads, and deciding what may be sent. Pure functions, no
// database and no network, so every rule here is covered by test/dupr.test.js. The API side lives in dupr.js and _dupr.js.
// Field names and rules come from DUPR's published partner OpenAPI spec (ExternalMatchRequest); how DUPR behaves for
// real is unverified until UAT keys exist. See the DUPR section of README.md.
import { createHash } from 'node:crypto';
import * as B from './_bracket.js';
import { matchTeams } from './_events.js';

export const MIN_WINNING_SCORE = 6; // DUPR: a rated game needs a clear winner with at least 6 points
export const BATCH_SIZE = 100;      // DUPR: POST /match/v1.0/batch takes up to 100 matches

// DUPR identifiers must be globally unique and can never be reused, even after a delete, so a match that is deleted
// from DUPR and later sent again gets the next revision.
export const identifierFor = (club, gameId, revision = 1) => `dink-${club}-${gameId}-r${Math.max(1, Math.trunc(revision) || 1)}`;

export function chunk(list, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// yyyy-MM-dd of a moment in a time zone (the organizer's, sent with the request). Falls back to UTC for anything
// that is not a real zone name.
export function matchDate(ms, tz = 'UTC') {
  const fmt = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  try { return fmt(tz || 'UTC'); } catch { return fmt('UTC'); }
}
export const cleanZone = tz => { try { new Intl.DateTimeFormat('en', { timeZone: String(tz) }); return String(tz); } catch { return 'UTC'; } };

// How DUPR should weigh the event. Unverified how DUPR treats the types, so only events with a knockout stage count as
// TOURNAMENT; open round robins (rotating or fixed partners) are RECREATIONAL.
export const playTypeFor = ev => (ev.format === 'roundrobin' ? 'RECREATIONAL' : 'TOURNAMENT');

// Every finished match of an event, with the round it belongs to. The score is the current one (corrections included).
export function listEventMatches(ev) {
  const out = [];
  const add = (m, round) => {
    if (!m || m.status !== 'done' || !Array.isArray(m.score)) return;
    out.push({ matchId: m.id, gameId: m.gameId || `${ev.id}-${m.id}`, round, teams: matchTeams(ev, m), score: m.score, endedAt: m.endedAt || ev.updatedAt });
  };
  for (const r of ev.rounds || []) for (const m of r.matches) add(m, r.title || `Round ${r.n}`);
  if (ev.bracket) {
    const prefix = ev.format === 'pool_knockout' ? 'Knockout: ' : '';
    for (const r of B.rounds(ev.bracket)) for (const m of r.matches) add(m, prefix + r.title);
  }
  return out;
}

const fmtNames = list => list.join(', ');
// Why a match can't go to DUPR, as [{code, text}]; empty means it can. links: Map of lower-case player name to DUPR id.
export function preflight(m, links, { now = Date.now() } = {}) {
  const why = [];
  const teams = m.teams;
  const players = Array.isArray(teams) && teams.length === 2 && teams.every(t => Array.isArray(t) && t.length === 2 && t.every(p => typeof p === 'string' && p)) ? teams.flat() : null;
  if (!players) return [{ code: 'teams', text: 'The four players of this match are not known.' }];
  const keys = players.map(p => p.toLowerCase());
  if (new Set(keys).size !== 4) why.push({ code: 'duplicate-player', text: 'The same player is on both sides, or twice on one side.' });
  const missing = players.filter((p, i) => !links.get(keys[i]));
  if (missing.length) why.push({ code: 'unlinked', text: `Not linked to DUPR: ${fmtNames(missing)}.`, players: missing });
  const ids = keys.map(k => links.get(k)).filter(Boolean);
  if (new Set(ids).size !== ids.length && new Set(keys).size === 4) why.push({ code: 'duplicate-player', text: 'Two of the players share one DUPR account.' });
  const s = m.score;
  if (!Array.isArray(s) || s.length !== 2 || s.some(v => !Number.isInteger(v) || v < 0)) why.push({ code: 'no-score', text: 'This match has no valid score.' });
  else if (s[0] === s[1]) why.push({ code: 'tie', text: 'The score is tied, so there is no clear winner.' });
  else if (Math.max(s[0], s[1]) < MIN_WINNING_SCORE) why.push({ code: 'low-score', text: `The winner has under ${MIN_WINNING_SCORE} points, which DUPR does not rate.` });
  // DUPR accepts today or earlier, with a 24 hour grace for time zones.
  if (!(Number(m.endedAt) <= now + 864e5)) why.push({ code: 'future-date', text: 'The match date is in the future.' });
  return why;
}

// The body for DUPR's create (and, with matchId added, update) endpoints. Call only after preflight() found nothing.
export function toDuprMatch({ club, ev, m, links, revision = 1, tz = 'UTC' }) {
  const id = name => links.get(name.toLowerCase());
  const team = (t, i) => ({ player1: id(t[0]), player2: id(t[1]), game1: m.score[i] });
  return {
    identifier: identifierFor(club, m.gameId, revision),
    matchDate: matchDate(m.endedAt, tz),
    teamA: team(m.teams[0], 0),
    teamB: team(m.teams[1], 1),
    format: 'DOUBLES',
    event: ev.name,
    bracket: m.round,
    matchType: ev.scoring === 'rally' ? 'RALLY' : 'SIDEOUT',
    matchSource: 'PARTNER',
    matchPlayType: playTypeFor(ev),
    matchCompletionType: 'COMPLETED' // forfeits and retirements are not modelled by the app, so they are never guessed
  };
}

// What decides whether DUPR must be told again: who played, the score and the date.
export function fingerprint(p) {
  const key = JSON.stringify([p.format, p.teamA.player1, p.teamA.player2, p.teamA.game1, p.teamB.player1, p.teamB.player2, p.teamB.game1, p.matchDate]);
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

// What to do about one match. row: its dupr_matches row or null; gameLive: it is still in the club record (not deleted);
// reasons: preflight() output; fp: fingerprint of what would be sent now (null when it can't be built).
// Returns { action: 'create'|'update'|'delete'|'none', state: 'ready'|'blocked'|'sent'|'failed'|'skipped', reasons, note?, revision }.
export function plan({ row, gameLive, reasons, fp }) {
  const sent = row && row.status === 'sent';
  const haveCode = sent && !!row.match_code;
  if (!gameLive) {
    if (haveCode) return { action: 'delete', state: 'ready', reasons: [], note: 'Deleted from the club record, so it will be removed from DUPR.', revision: row.revision };
    if (sent) return { action: 'none', state: 'blocked', reasons: [{ code: 'code-lost', text: 'Deleted here, but DUPR has it and its match code was not saved. Remove it in DUPR.' }], revision: row.revision };
    return { action: 'none', state: 'skipped', reasons: [], note: 'Not in the club record.', revision: row ? row.revision : 1 };
  }
  if (sent && fp && row.payload_hash === fp) return { action: 'none', state: 'sent', reasons: [], note: haveCode ? undefined : 'Sent. DUPR did not return a match code.', revision: row.revision };
  const fresh = !row || row.status === 'deleted';
  const revision = row ? (row.status === 'deleted' ? row.revision + 1 : row.revision) : 1;
  const action = sent ? 'update' : 'create';
  if (reasons.length) return { action, state: 'blocked', reasons, revision };
  if (sent && !haveCode) return { action: 'none', state: 'blocked', reasons: [{ code: 'code-lost', text: 'The score changed, but DUPR has this match and its match code was not saved. Fix it in DUPR.' }], revision };
  if (!fresh && row.status === 'failed' && row.payload_hash === fp) return { action: 'create', state: 'failed', reasons: [], note: row.error || 'DUPR refused this match.', revision };
  return { action, state: 'ready', reasons: [], revision, note: sent ? 'The score changed since it was sent.' : row && row.status === 'pending' ? 'An earlier attempt did not finish.' : undefined };
}

// Sorts a failure into what to do next. Pass an HTTP status, or just a message for a per-match error in a batch.
//   retry     try again later with the same identifier (network, 429, 5xx, a temporary message)
//   reauth    the partner token was refused: fetch a new one and repeat the call once
//   pause     403 or 417: the key lacks permission or the account expired, so stop all sending
//   duplicate DUPR already has this identifier
//   permanent the match itself is refused (400, 404, validation text, HTTP 200 with status FAILURE)
export function classify({ status = 0, message = '', network = false } = {}) {
  const msg = String(message || '');
  if (network) return 'retry';
  if (status === 401) return 'reauth';
  if (status === 403 || status === 417) return 'pause';
  if (status === 429 || status >= 500) return 'retry';
  if (status === 409 || /already exists/i.test(msg)) return 'duplicate';
  if (/rate limit|too many requests|try again|temporar|timed? ?out|unavailable/i.test(msg)) return 'retry';
  return 'permanent';
}

// Secrets and tokens never go into errors, logs or responses.
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && String(s).length >= 6) out = out.split(String(s)).join('[hidden]');
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [hidden]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]+/g, '[hidden]')
    .slice(0, 300);
}
