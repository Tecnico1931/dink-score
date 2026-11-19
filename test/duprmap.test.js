import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, recordResult } from '../api/_events.js';
import { identifierFor, chunk, matchDate, cleanZone, listEventMatches, preflight, toDuprMatch, fingerprint, plan, classify, redact, playTypeFor } from '../api/_dupr_map.js';
import { parseRating, parseUserDetail, parseEntitlements, config, publicConfig } from '../api/_duprapi.js';

const NOW = Date.UTC(2026, 5, 1, 12);
const names = Array.from({ length: 8 }, (_, i) => 'P' + (i + 1));
const mk = (o = {}) => createEvent({ name: 'Sunday rotation', format: 'roundrobin', rotation: 'auto', courts: 2, players: names, seed: 's', ...o }, NOW);
const linksFor = list => new Map(list.map((n, i) => [n.toLowerCase(), 'ID' + (i + 1)]));

test('identifier carries the club, game and revision; chunks hold at most 100', () => {
  assert.equal(identifierFor('ABC123', 'e1x-r1m1'), 'dink-ABC123-e1x-r1m1-r1');
  assert.equal(identifierFor('ABC123', 'e1x-r1m1', 3), 'dink-ABC123-e1x-r1m1-r3');
  assert.equal(identifierFor('A', 'g', 0), 'dink-A-g-r1');
  assert.deepEqual(chunk([...Array(250).keys()]).map(c => c.length), [100, 100, 50]);
  assert.deepEqual(chunk([]), []);
});

test('match date follows the organizer time zone; bad zones fall back to UTC', () => {
  const t = Date.UTC(2026, 5, 1, 2, 30); // 02:30 UTC = 22:30 the day before in New York
  assert.equal(matchDate(t, 'UTC'), '2026-06-01');
  assert.equal(matchDate(t, 'America/New_York'), '2026-05-31');
  assert.equal(matchDate(t, 'Not/AZone'), '2026-06-01');
  assert.equal(cleanZone('Nope'), 'UTC'); assert.equal(cleanZone('Europe/Madrid'), 'Europe/Madrid');
});

test('a finished event match maps to a DUPR doubles payload', () => {
  const ev = mk(); const m0 = ev.rounds[0].matches[0];
  recordResult(ev, m0.id, { score: [11, 7], endedAt: NOW }, NOW);
  const [m] = listEventMatches(ev);
  assert.equal(m.gameId, `${ev.id}-${m0.id}`); assert.equal(m.round, 'Round 1');
  const links = linksFor(names);
  assert.deepEqual(preflight(m, links, { now: NOW }), []);
  const p = toDuprMatch({ club: 'ABC123', ev, m, links });
  assert.equal(p.identifier, `dink-ABC123-${m.gameId}-r1`);
  assert.equal(p.format, 'DOUBLES'); assert.equal(p.matchSource, 'PARTNER'); assert.equal(p.matchCompletionType, 'COMPLETED');
  assert.equal(p.matchType, 'SIDEOUT'); assert.equal(p.matchPlayType, 'RECREATIONAL'); assert.equal(p.matchDate, '2026-06-01');
  assert.equal(p.event, 'Sunday rotation'); assert.equal(p.bracket, 'Round 1');
  assert.equal(p.teamA.game1, 11); assert.equal(p.teamB.game1, 7); assert.equal(p.teamA.game2, undefined);
  assert.deepEqual([p.teamA.player1, p.teamA.player2, p.teamB.player1, p.teamB.player2], m.teams.flat().map(n => links.get(n.toLowerCase())));
  assert.equal('clubId' in p, false); assert.equal('location' in p, false);
  assert.equal(toDuprMatch({ club: 'C', ev: { ...ev, scoring: 'rally' }, m, links }).matchType, 'RALLY');
  assert.equal(playTypeFor({ format: 'single_elim' }), 'TOURNAMENT'); assert.equal(playTypeFor({ format: 'pool_knockout' }), 'TOURNAMENT');
});

test('knockout matches are listed with their round names', () => {
  const ev = createEvent({ name: 'Cup', format: 'single_elim', rotation: 'random', courts: 2, players: names, seed: 'cup' }, NOW);
  const first = ev.bracket.matches.find(m => m.status === 'pending' && m.slots.every(s => s >= 0));
  recordResult(ev, first.id, { score: [11, 4], endedAt: NOW }, NOW);
  const [m] = listEventMatches(ev);
  assert.equal(m.round, 'Semifinals');
  assert.equal(m.teams.length, 2);
});

test('pre-flight blocks every case DUPR would refuse', () => {
  const ok = { teams: [['A', 'B'], ['C', 'D']], score: [11, 5], endedAt: NOW };
  const all = linksFor(['A', 'B', 'C', 'D']);
  const codes = (m, links = all) => preflight(m, links, { now: NOW }).map(r => r.code);
  assert.deepEqual(codes(ok), []);
  assert.deepEqual(codes(ok, linksFor(['A', 'B', 'C'])), ['unlinked']);
  assert.match(preflight(ok, linksFor(['A', 'B', 'C']), { now: NOW })[0].text, /D/);
  assert.deepEqual(codes({ ...ok, score: [7, 7] }), ['tie']);
  assert.deepEqual(codes({ ...ok, score: [5, 3] }), ['low-score']);
  assert.deepEqual(codes({ ...ok, score: [6, 4] }), []);
  assert.deepEqual(codes({ ...ok, score: null }), ['no-score']);
  assert.deepEqual(codes({ ...ok, teams: [['A', 'B'], ['a', 'D']] }), ['duplicate-player', 'unlinked'].filter(c => c === 'duplicate-player'));
  assert.deepEqual(codes({ ...ok, teams: [['A', 'B'], ['C', null]] }), ['teams']);
  assert.deepEqual(codes({ ...ok, endedAt: NOW + 3 * 864e5 }), ['future-date']);
  const shared = new Map([['a', 'X1'], ['b', 'X1'], ['c', 'X3'], ['d', 'X4']]);
  assert.deepEqual(codes(ok, shared), ['duplicate-player']);
});

test('fingerprint changes with the score, players or date but not the identifier', () => {
  const ev = mk(), links = linksFor(names);
  const m = { gameId: 'g', round: 'Round 1', teams: [['P1', 'P2'], ['P3', 'P4']], score: [11, 5], endedAt: NOW };
  const f = x => fingerprint(toDuprMatch({ club: 'C', ev, m: x, links }));
  assert.equal(f(m), fingerprint(toDuprMatch({ club: 'C', ev, m, links, revision: 4 })));
  assert.notEqual(f(m), f({ ...m, score: [11, 6] }));
  assert.notEqual(f(m), f({ ...m, teams: [['P1', 'P5'], ['P3', 'P4']] }));
  assert.notEqual(f(m), f({ ...m, endedAt: NOW + 2 * 864e5 }));
});

test('plan: what to do about a match given what DUPR was already told', () => {
  const row = (o = {}) => ({ status: 'sent', match_code: '1001', revision: 1, payload_hash: 'A', error: null, ...o });
  const p = a => plan({ row: null, gameLive: true, reasons: [], fp: 'A', ...a });
  assert.deepEqual([p().action, p().state], ['create', 'ready']);
  assert.equal(p({ reasons: [{ code: 'tie', text: 't' }] }).state, 'blocked');
  assert.deepEqual([p({ row: row() }).action, p({ row: row() }).state], ['none', 'sent']);
  assert.deepEqual([p({ row: row({ payload_hash: 'B' }) }).action, p({ row: row({ payload_hash: 'B' }) }).state], ['update', 'ready']);
  assert.equal(p({ row: row({ payload_hash: 'B' }), reasons: [{ code: 'unlinked', text: 'x' }] }).state, 'blocked');
  assert.deepEqual([p({ row: row(), gameLive: false }).action, p({ row: row(), gameLive: false }).state], ['delete', 'ready']);
  assert.equal(p({ row: null, gameLive: false }).state, 'skipped');
  // deleted at DUPR, game back in the record: a new revision, because the old identifier is burned
  const again = p({ row: row({ status: 'deleted' }) });
  assert.deepEqual([again.action, again.state, again.revision], ['create', 'ready', 2]);
  assert.equal(p({ row: row({ status: 'pending', match_code: null }) }).action, 'create');
  assert.equal(p({ row: row({ status: 'failed', match_code: null, payload_hash: 'A', error: 'no' }) }).state, 'failed');
  assert.equal(p({ row: row({ status: 'failed', match_code: null, payload_hash: 'OLD' }) }).state, 'ready');
  // sent but DUPR's match code was lost: can't update or delete from here
  assert.equal(p({ row: row({ match_code: null, payload_hash: 'B' }) }).state, 'blocked');
  assert.equal(p({ row: row({ match_code: null }), gameLive: false }).state, 'blocked');
});

test('error classification', () => {
  assert.equal(classify({ network: true }), 'retry');
  assert.equal(classify({ status: 401 }), 'reauth');
  assert.equal(classify({ status: 403 }), 'pause'); assert.equal(classify({ status: 417 }), 'pause');
  assert.equal(classify({ status: 429 }), 'retry'); assert.equal(classify({ status: 503 }), 'retry');
  assert.equal(classify({ status: 400, message: 'bad' }), 'permanent');
  assert.equal(classify({ status: 404 }), 'permanent');
  assert.equal(classify({ status: 409 }), 'duplicate');
  assert.equal(classify({ message: 'Match with identifier already exists' }), 'duplicate');
  assert.equal(classify({ message: 'Rate limit exceeded, try again' }), 'retry');
  assert.equal(classify({ status: 0, message: 'The winning team must score at least 6 points' }), 'permanent');
});

test('secrets and tokens are redacted', () => {
  const jwt = 'eyJhbGciOiJSUzUxMiJ9.eyJzdWIiOiIxMjMifQ.abc_def-123';
  const out = redact(`oops Bearer ${jwt} and key super-secret-key and ${jwt}`, ['super-secret-key']);
  assert.ok(!out.includes('eyJ') && !out.includes('super-secret-key'));
  assert.ok(redact('x'.repeat(1000)).length <= 300);
});

test('DUPR response shapes: ratings, entitlements, config', () => {
  assert.equal(parseRating('3.5204'), 3.52); assert.equal(parseRating('NR'), null); assert.equal(parseRating(null), null); assert.equal(parseRating(12), null);
  assert.deepEqual(parseUserDetail({ result: { ratings: { doubles: '3.520', singles: 'NR', isDoublesReliable: false } } }), { rating: { doubles: 3.52, singles: null }, provisional: { doubles: true, singles: false }, reliability: { doubles: null, singles: null } });
  assert.deepEqual(parseUserDetail({ result: { fullName: 'X', gender: 'F', birthYear: 1980, ratings: { doublesReliabilityScore: '87.46', singlesReliabilityScore: 120 } } }).reliability, { doubles: 87.5, singles: null });
  assert.deepEqual(Object.keys(parseUserDetail({ result: { fullName: 'X', gender: 'F', birthYear: 1980, location: 'Y' } })).sort(), ['provisional', 'rating', 'reliability']);
  assert.deepEqual(parseUserDetail({ result: { doublesRating: 3.8, singlesRating: 4.25, doublesProvisional: true } }).rating, { doubles: 3.8, singles: 4.25 });
  assert.deepEqual(parseEntitlements({ subscriptions: [{ entitlements: { tournaments: ['BASIC_L1', 'PREMIUM_L1'] } }] }), ['BASIC_L1', 'PREMIUM_L1']);
  assert.equal(parseEntitlements({}), null);
  const keep = { k: process.env.DUPR_CLIENT_KEY, s: process.env.DUPR_CLIENT_SECRET, e: process.env.DUPR_ENV };
  try {
    delete process.env.DUPR_CLIENT_KEY; delete process.env.DUPR_CLIENT_SECRET; delete process.env.DUPR_ENV;
    assert.equal(config(), null);
    process.env.DUPR_CLIENT_KEY = 'k-key'; assert.equal(config(), null);
    process.env.DUPR_CLIENT_SECRET = 'a-secret'; assert.equal(config().env, 'prod');
    assert.equal(publicConfig(config()).loginOrigin, 'https://dashboard.dupr.com');
    process.env.DUPR_ENV = 'uat'; assert.equal(config().env, 'uat');
    const pub = publicConfig(config());
    assert.equal(pub.loginOrigin, 'https://uat.dupr.gg'); assert.equal(pub.loginUrl, 'https://uat.dupr.gg/login-external-app/' + encodeURIComponent(Buffer.from('k-key').toString('base64')));
    assert.ok(!JSON.stringify(pub).includes('a-secret'));
    process.env.DUPR_ENV = 'prod'; assert.equal(publicConfig(config()).loginOrigin, 'https://dashboard.dupr.com');
    process.env.DUPR_ENV = 'test'; assert.equal(config().env, 'uat');
    process.env.DUPR_ENV = 'weird'; assert.equal(config().env, 'prod');
  } finally { for (const [n, v] of [['DUPR_CLIENT_KEY', keep.k], ['DUPR_CLIENT_SECRET', keep.s], ['DUPR_ENV', keep.e]]) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } }
});
