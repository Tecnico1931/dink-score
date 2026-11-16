import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gameView, sessionView, preview, cardModel, pageHTML, deadHTML, safeOrigin } from '../api/_result.js';
import { gameCard, sessionCard, cardText } from '../api/_card.js';
import { encode, flow, checkLog } from '../api/_rallylog.js';
import { newShareToken } from '../api/_share.js';
import { inflateSync } from 'node:zlib';

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const block = src.match(/\/\*REPLAYCHART-START\*\/([\s\S]*?)\/\*REPLAYCHART-END\*\//);
assert.ok(block, 'the REPLAYCHART block is missing from dink-score.html');
const RC = new Function(block[1] + '\nreturn RC;')();

// A real game: team 0 wins 11-3 at side-out scoring, singles-style bookkeeping is enough for the rules.
const wins = [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const base = { id: 'g-secret-id-1', mode: 'singles', teams: [['Ana'], ['Ben']], score: [11, 3], winner: 0, scoring: 'rally', target: 11, winBy: 2, rallies: 0, startedAt: 1, endedAt: Date.UTC(2026, 10, 14, 15, 30), logged: false };
// Build a log that replays to a finished game under rally scoring.
const log = (() => { const w = []; let a = 0, b = 0; while (a < 11) { if (b < 3 && w.length % 4 === 3) { w.push(1); b++; } else { w.push(0); a++; } } return encode(0, w); })();
const game = { ...base, rallies: log.length - 2, score: [11, 3] };
const stored = { ...game, scoredBy: 'ana', receivedAt: 5, secretField: 'nope', confirmedBy: 'x' };

test('game view copies only listed fields: no ids, scorer, or unknown fields', () => {
  const v = gameView(stored, log);
  const text = JSON.stringify(v);
  for (const leak of ['g-secret-id-1', 'scoredBy', 'receivedAt', 'secretField', 'confirmedBy', 'rallyLog']) assert.ok(!text.includes(leak), leak);
  assert.deepEqual(v.teams, [['Ana'], ['Ben']]);
  assert.deepEqual(v.score, [11, 3]);
  assert.equal(v.kind, 'game');
});

test('the score-flow numbers only travel when the log replays to the saved score', () => {
  assert.ok(checkLog(game, log), 'fixture log is honest');
  const v = gameView(stored, log);
  assert.equal(v.flow.n, game.rallies);
  assert.equal(v.flow.lead[0], 0);
  assert.equal(v.flow.lead.at(-1), 8);
  assert.equal(gameView(stored, '0:0101').flow, null, 'a log for another game is dropped');
  assert.equal(gameView({ ...stored, logged: true }, log).flow, null, 'a hand-logged game has no replay');
  assert.equal(gameView(stored, null).flow, null);
});

test('session view lists games and nothing else about them', () => {
  const v = sessionView([stored, { ...stored, teams: [['Cy', 'Di'], ['Ed', 'Flo']], mode: 'doubles' }], 1, 2);
  assert.equal(v.games.length, 2);
  assert.ok(!JSON.stringify(v).includes('g-secret-id-1'));
  assert.deepEqual(Object.keys(v.games[0]).sort(), ['endedAt', 'mode', 'score', 'teams', 'winner']);
});

test('anonymised names stay as stored: the view never recovers anything', () => {
  const v = gameView({ ...stored, teams: [['Former player K7M2Q'], ['Ben']] }, log);
  assert.equal(v.teams[0][0], 'Former player K7M2Q');
  assert.match(preview(v).title, /Former player K7M2Q beat Ben/);
});

test('page text is escaped and carries the preview tags', () => {
  const v = gameView({ ...stored, teams: [['<img src=x onerror=1>'], ['"Ben"']] }, log);
  const tok = newShareToken();
  const html = pageHTML(v, tok, 'https://example.test');
  assert.ok(!html.includes('<img src=x'), 'markup in a name is escaped');
  assert.match(html, /<meta property="og:image" content="https:\/\/example\.test\/r\/[\w-]{32}\/card\.png">/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /<script src="\/r\.js" defer><\/script>/);
  assert.ok(!/<script>/.test(html), 'no inline script (the CSP allows none here)');
  assert.ok(!/join|club code|member/i.test(html.replace(/A read-only result shared from Dink Score\. It shows names and scores only\./, '')), 'no club or member wording');
  assert.match(deadHTML(), /not active/);
});

test('safeOrigin accepts a plain host and refuses anything else', () => {
  assert.equal(safeOrigin({ headers: { host: 'dink.example' } }), 'https://dink.example');
  assert.equal(safeOrigin({ headers: { host: 'localhost:3000' } }), 'http://localhost:3000');
  assert.equal(safeOrigin({ headers: { 'x-forwarded-host': 'evil.test"><script>' } }), '');
  assert.equal(safeOrigin({ headers: {} }), '');
});

test('card images are valid PNGs of 1200x630', () => {
  for (const buf of [gameCard(cardModel(gameView(stored, log))), sessionCard(cardModel(sessionView([stored], Date.UTC(2026, 10, 14), 0)))]) {
    assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(buf.readUInt32BE(16), 1200); assert.equal(buf.readUInt32BE(20), 630);
    const idat = buf.indexOf('IDAT'), len = buf.readUInt32BE(idat - 4);
    assert.equal(inflateSync(buf.subarray(idat + 4, idat + 4 + len)).length, (1200 * 3 + 1) * 630);
  }
  assert.equal(cardText('Zoë Östergård ✓'), 'ZOE OSTERGARD ?');
});

test('the shared chart draws the same svg for the server numbers as the app does, without app globals', () => {
  const f = flow(game, log);
  const svg = RC.chart(f, f.n, ['Blue', 'Green'], s => s, false);
  assert.match(svg, /^<svg class="rp-svg"/);
  assert.match(svg, /Longest run: \d+ unanswered points by Blue/);
  assert.ok(!/replay controls/.test(svg));
  assert.match(RC.chart(f, f.n, ['Blue', 'Green'], s => s), /replay controls/);
});
