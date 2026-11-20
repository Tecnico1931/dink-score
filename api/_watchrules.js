// Apple Watch linking and scoring: the pure rules (no database, no _db.js import, so `npm test` runs them without an install).
// The handlers are in _watch.js and are reached through /api/live (watch-* actions, see live.js; the function count is at its limit).
// A watch holds a random token that is checked by its hash. It is made when the watch is linked (a QR the phone scans) and only
// ever lets that watch read and score the live games a phone has attached to it.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { call as pbCall } from './_pb.js';

export const PAIR_TTL_MIN = 5;          // a QR on the watch is good for 5 minutes, then the watch shows a new one
export const PENDING_LINK_MIN = 10;     // a link the phone has claimed but the watch has not collected yet
export const MAX_CONFIRM_TRIES = 3;     // wrong 4-digit numbers before the pairing is thrown away
export const MAX_POLLS = 200;           // polls of one pairing (every 2 seconds for 5 minutes is 150)
export const LINK_TTL_DAYS = 90;         // a link lasts this long after the watch last called (sliding) ...
export const LINK_MAX_DAYS = 365;        // ... but never longer than this from when it was made
export const TOUCH_EVERY_MS = 60 * 60 * 1000; // last_seen_at and the sliding expiry move at most once an hour
export const MAX_LINKS_PER_CLUB = 20;   // club-wide links; single-game links are counted per game (below), so a tournament is not capped by them
export const GAME_LINK_HOURS = 8;        // a single-game link lasts this long from when the watch collects it (not sliding) ...
export const GAME_LINK_END_MIN = 15;     // ... or this long after the watch finishes the game, so a retry after a lost answer still works
export const MAX_GAME_LINKS = 8;         // watches on one game at once
export const OFFER_TTL_MIN = 10;         // the code a scoring phone shows for a watch to type
export const OPS_KEEP = 32;              // tap ids remembered per live game, so a retried tap is not counted twice
const DAY = 24 * 60 * 60 * 1000;

const sha = s => createHash('sha256').update(s).digest('hex');
// What the watch sends instead of the raw ids, so the server never stores anything that could be replayed from the database.
export const pairHash = pairId => sha('watch-id:' + pairId);
export const pollHash = pollSecret => sha('watch-poll:' + pollSecret);
export const shortHash = short => sha('watch-short:' + short);
export const hashWatchToken = token => sha('watch-token:' + token);
export const offerHash = id => sha('watch-offer:' + id);
export const offerShortHash = short => sha('watch-offer-short:' + short);
export const hashRevokeKey = key => sha('watch-revoke:' + key);
export function hashEq(a, b) {
  const x = Buffer.from(String(a ?? ''), 'hex'), y = Buffer.from(String(b ?? ''), 'hex');
  return x.length === 32 && x.length === y.length && timingSafeEqual(x, y);
}

// `w_` + 64 hex: never mistakable for an owner token (48 bare hex) or a game secret (6 to 32 letters and numbers).
export const newWatchToken = () => 'w_' + randomBytes(32).toString('hex');
export const isWatchToken = t => /^w_[0-9a-f]{64}$/.test(String(t ?? ''));
export function tokenFrom(req) {
  const m = /^Bearer (\S+)$/.exec(String(((req && req.headers) || {}).authorization || ''));
  return m && isWatchToken(m[1]) ? m[1] : null;
}
export const newLinkId = () => randomBytes(8).toString('hex');
export const newRevokeKey = () => randomBytes(16).toString('hex');
export const newOfferId = () => randomBytes(16).toString('hex');   // in the game link; its first 30 bits are the typed code (shortCode)
export const newConfirm = () => String(randomInt(10000)).padStart(4, '0');

export const cleanHash = v => (/^[0-9a-f]{64}$/.test(String(v ?? '')) ? String(v) : null);
export const cleanPairId = v => { const s = String(v ?? '').toLowerCase(); return /^[0-9a-f]{32}$/.test(s) ? s : null; };
export const cleanPollSecret = v => { const s = String(v ?? '').toLowerCase(); return /^[0-9a-f]{32}$/.test(s) ? s : null; };
export const cleanConfirm = v => (/^[0-9]{4}$/.test(String(v ?? '')) ? String(v) : null);
export const cleanOpId = v => (/^[A-Za-z0-9_-]{8,64}$/.test(String(v ?? '')) ? String(v) : null);
// The typed fallback: the first 6 characters of the pairing id in RFC 4648 base32 (30 bits), shown under the QR.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function shortCode(pairId) {
  const v = parseInt(String(pairId).slice(0, 8), 16) >>> 2;
  let out = '';
  for (let i = 0; i < 6; i++) out += B32[(v >>> (25 - 5 * i)) & 31];
  return out;
}
export const cleanShort = v => { const s = String(v ?? '').toUpperCase().replace(/[\s-]/g, ''); return /^[A-Z2-7]{6}$/.test(s) ? s : null; };
// A device name such as "Ana's Apple Watch" is shown in the phone's list of linked watches: text only, short.
export function cleanLabel(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || null;
}

// `tries` already counts this attempt. The third wrong number (or any later one) ends the pairing.
export function confirmVerdict(tries, expected, given) {
  if (tries > MAX_CONFIRM_TRIES) return 'locked';
  if (given !== null && given === expected) return 'ok';
  return tries >= MAX_CONFIRM_TRIES ? 'locked' : 'wrong';
}

// Sliding expiry: 90 days from now, never past a year after the link was made.
export const nextExpiry = (createdMs, nowMs) => Math.min(nowMs + LINK_TTL_DAYS * DAY, createdMs + LINK_MAX_DAYS * DAY);
export const touchDue = (lastSeenMs, nowMs) => !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= TOUCH_EVERY_MS;

// Tap ids. A retry after a lost answer carries the same id, so it changes nothing.
export const seenOp = (ops, opId) => !!opId && Array.isArray(ops) && ops.includes(opId);
export const pushOp = (ops, opId) => [...(Array.isArray(ops) ? ops : []), opId].slice(-OPS_KEEP);

// The score call (serving side first), as the phone says it.
export function callOf(s) {
  if (s && s.cfg) return pbCall(s);
  const parts = [s.score[s.serving], s.score[1 - s.serving]];
  if (s.cfg && s.cfg.mode === 'doubles' && s.cfg.scoring === 'sideout') parts.push(s.serverNum);
  return parts;
}
export const sayOf = (s, call) => (s.winner !== null && s.winner !== undefined ? 'Game over' : 'Score: ' + call.join(', '));

// What a watch sees of a live game: players and score only, nothing about the club's roster, history or other games.
export function watchGame(row) {
  const s = row.state, call = callOf(s);
  return { id: row.id, teams: s.cfg.teams, cfg: s.cfg, score: s.score, serving: s.serving, server: s.server, serverNum: s.serverNum,
    winner: s.winner === undefined ? null : s.winner, rallies: s.rallies, version: row.version, call, say: sayOf(s, call) };
}
