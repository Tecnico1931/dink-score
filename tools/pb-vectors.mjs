// Golden vectors for the Swift watch app (watch/Packages/DinkCore): the same inputs run through the JS originals, so a drift in the
// Swift copy of the scoring rules (`PB.rally`, `api/_pb.js`), the pairing hashes or the QR encoder fails `swift test`.
//   node tools/pb-vectors.mjs          rewrite the fixtures
//   node tools/pb-vectors.mjs --check  fail if the committed fixtures are out of date (no write)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rally, call } from '../api/_pb.js';
import * as R from '../api/_watchrules.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'watch/Packages/DinkCore/Tests/DinkCoreTests/Fixtures');

// PB.newGame from dink-score.html (the server has no copy: a phone always makes the game); `startedAt`/`endedAt` are left out of the vectors.
function newGame(cfg) {
  const doubles = cfg.mode === 'doubles', first = cfg.first || 0;
  return { cfg: JSON.parse(JSON.stringify(cfg)), score: [0, 0], serving: first, serverNum: doubles && cfg.scoring === 'sideout' ? 2 : 1,
    right: [0, 0], server: 0, rallies: 0, switched: false, justSwitched: false, winner: null };
}
const plain = s => { const { startedAt, endedAt, ...rest } = s; return rest; };

// A tiny seeded generator, so the fixtures are stable between runs.
function rng(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; }; }

const vectors = [];
let seed = 7;
for (const mode of ['singles', 'doubles']) for (const scoring of ['sideout', 'rally']) for (const [target, winBy] of [[11, 2], [11, 1], [15, 2], [7, 1]]) for (const first of [0, 1]) {
  const teams = mode === 'doubles' ? [['Ana', 'Ben'], ['Cy', 'Di']] : [['Ana'], ['Cy']];
  const cfg = { mode, scoring, target, winBy, first, teams };
  const next = rng(seed++);
  let s = newGame(cfg);
  const sides = [], steps = [];
  let over = 0;
  for (let i = 0; i < 200 && over < 3; i++) {
    const side = next() < 0.55 ? 0 : 1;   // lopsided enough that the server changes and games finish
    s = rally(s, side);
    sides.push(side);
    steps.push({ state: plain(s), call: call(s) });
    if (s.winner !== null) over++;        // the taps after the end (the first one is the winning tap) must change nothing
  }
  vectors.push({ name: `${mode}-${scoring}-${target}-${winBy}-first${first}`, cfg, initial: plain(newGame(cfg)), sides, steps });
}

// Pairing: what the watch sends (hashes of the ids) and the typed fallback code.
const pairing = [
  '00000000000000000000000000000000', 'ffffffffffffffffffffffffffffffff', '0123456789abcdef0123456789abcdef', 'a3f1c2d4e5b60718293a4b5c6d7e8f90', '9c4b7e1a2d3f4a5b6c7d8e9f0a1b2c3d'
].map((pairId, i) => {
  const pollSecret = pairId.split('').reverse().join('');
  return { pairId, pollSecret, idHash: R.pairHash(pairId), pollHash: R.pollHash(pollSecret), shortCode: R.shortCode(pairId), shortHash: R.shortHash(R.shortCode(pairId)), seq: i };
});

// QR: the vendored qrcode-generator (the one the club invite uses in dink-score.html) is the reference; the Swift encoder must
// produce the same module matrix, mask choice included.
const html = readFileSync(path.join(root, 'dink-score.html'), 'utf8');
const start = html.indexOf('var qrcode=function(){');
const end = html.indexOf('qrcode.stringToBytesFuncs["UTF-8"]', start);
if (start < 0 || end < 0) throw new Error('The vendored qrcode-generator moved in dink-score.html; update tools/pb-vectors.mjs.');
const qrcode = new Function(html.slice(start, html.indexOf('\n', end)) + '\nreturn qrcode;')();
const texts = [
  'a', 'HELLO WORLD', 'https://dinkscore.vercel.app/#watch=00000000000000000000000000000000',
  ...pairing.map(p => 'https://dinkscore.vercel.app/#watch=' + p.pairId),
  'https://staging.example.test/#watch=0123456789abcdef0123456789abcdef', 'x'.repeat(120), 'Dink Score ' + '0123456789'.repeat(8)
];
const qr = [];
for (const level of ['L', 'M', 'Q', 'H']) for (const text of texts) {
  const q = qrcode(0, level); q.addData(text, 'Byte'); q.make();
  const n = q.getModuleCount();
  if ((n - 17) / 4 > 10) continue;   // the watch only needs short links: its encoder stops at version 10
  const rows = [];
  for (let r = 0; r < n; r++) { let line = ''; for (let c = 0; c < n; c++) line += q.isDark(r, c) ? '1' : '0'; rows.push(line); }
  qr.push({ text, level, version: (n - 17) / 4, rows });
}

const files = { 'pb-vectors.json': vectors, 'pairing-vectors.json': pairing, 'qr-vectors.json': qr };
let stale = false;
for (const [name, data] of Object.entries(files)) {
  const text = JSON.stringify(data) + '\n', file = path.join(dir, name);
  if (process.argv.includes('--check')) { let have = ''; try { have = readFileSync(file, 'utf8'); } catch {} if (have !== text) { console.error(name + ' is out of date: run node tools/pb-vectors.mjs'); stale = true; } }
  else { mkdirSync(dir, { recursive: true }); writeFileSync(file, text); console.log('wrote', path.relative(root, file), Math.round(text.length / 1024) + ' KB'); }
}
if (stale) process.exit(1);
