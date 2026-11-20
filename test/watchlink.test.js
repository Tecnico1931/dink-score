import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pairFromUrl, confirmFromUrl, watchFragment, cleanPair, cleanConfirm, cameraMessage, readQr, gameFragment, gameLink, cleanShort } from '../scan.js';
import * as W from '../api/_watchrules.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(root, f), 'utf8');
const ORIGIN = 'https://dinkscore.example';
const PAIR = '0123456789abcdef0123456789abcdef';

test('a watch link is taken only from this site\'s own address, with the id in the fragment', () => {
  assert.equal(pairFromUrl(`${ORIGIN}/#watch=${PAIR}`, ORIGIN), PAIR);
  assert.equal(pairFromUrl(`  ${ORIGIN}/#watch=${PAIR.toUpperCase()} `, ORIGIN), PAIR, 'case and spaces do not matter');
  for (const bad of [
    `https://evil.example/#watch=${PAIR}`, `http://dinkscore.example/#watch=${PAIR}`, `${ORIGIN}.evil.example/#watch=${PAIR}`,
    `https://dinkscore.example@evil.example/#watch=${PAIR}`, `${ORIGIN}/x/#watch=${PAIR}`, `${ORIGIN}/?club=ABC123#watch=${PAIR}`,
    `${ORIGIN}/#watch=${PAIR.slice(1)}`, `${ORIGIN}/#watch=${PAIR}0`, `${ORIGIN}/#watch=${'g'.repeat(32)}`, `${ORIGIN}/#move=${PAIR}`, `${ORIGIN}/`,
    PAIR, 'K7Q2ZM', '', null, undefined, 'javascript:alert(1)', 'WIFI:S:x;;'
  ]) assert.equal(pairFromUrl(bad, ORIGIN), '', String(bad));
});

test('the 4 numbers ride in the fragment after the id; an older link without them still reads', () => {
  assert.equal(pairFromUrl(`${ORIGIN}/#watch=${PAIR}.0420`, ORIGIN), PAIR);
  assert.equal(confirmFromUrl(`${ORIGIN}/#watch=${PAIR}.0420`, ORIGIN), '0420');
  assert.equal(confirmFromUrl(`${ORIGIN}/#watch=${PAIR.toUpperCase()}.0000`, ORIGIN), '0000');
  assert.equal(pairFromUrl(`${ORIGIN}/#watch=${PAIR}`, ORIGIN), PAIR);
  assert.equal(confirmFromUrl(`${ORIGIN}/#watch=${PAIR}`, ORIGIN), '', 'the old form asks for the numbers');
  assert.deepEqual(watchFragment(`#watch=${PAIR}.0420`), { pair: PAIR, confirm: '0420' });
  assert.deepEqual(watchFragment(`#watch=${PAIR}`), { pair: PAIR, confirm: '' });
  for (const bad of ['.042', '.04200', '.04a0', '.', '..0420', '.0420.1', '/0420']) {
    assert.equal(pairFromUrl(`${ORIGIN}/#watch=${PAIR}${bad}`, ORIGIN), '', bad);
    assert.equal(confirmFromUrl(`${ORIGIN}/#watch=${PAIR}${bad}`, ORIGIN), '', bad);
    assert.equal(watchFragment(`#watch=${PAIR}${bad}`), null, bad);
  }
  assert.equal(confirmFromUrl(`https://evil.example/#watch=${PAIR}.0420`, ORIGIN), '', 'only this site');
  assert.equal(confirmFromUrl('K7Q2ZM', ORIGIN), '', 'the typed code has no digits');
  // what cleanPair makes of a new link is still the id alone, and the digits pass the server's own check
  assert.equal(cleanPair(`${ORIGIN}/#watch=${PAIR}.0420`, ORIGIN), PAIR);
  assert.ok(W.cleanConfirm(confirmFromUrl(`${ORIGIN}/#watch=${PAIR}.0420`, ORIGIN)));
});

test('what is typed or scanned becomes the pair the server wants: 32 hex, or the 6 typed characters', () => {
  assert.equal(cleanPair(`${ORIGIN}/#watch=${PAIR}`, ORIGIN), PAIR);
  assert.equal(cleanPair(PAIR.toUpperCase(), ORIGIN), PAIR);
  assert.equal(cleanPair(' k7q-2zm ', ORIGIN), 'K7Q2ZM');
  assert.equal(cleanPair('k7q 2zm', ORIGIN), 'K7Q2ZM');
  for (const bad of ['', 'K7Q2Z', 'K7Q2ZM1', 'K7Q18M', 'K7Q2Z!', PAIR.slice(1), `https://evil.example/#watch=${PAIR}`, null, undefined]) assert.equal(cleanPair(bad, ORIGIN), '', String(bad));
  // The page and the server agree on every shape: what cleanPair returns, the server's own cleaners accept.
  for (let i = 0; i < 25; i++) {
    const id = randomBytes(16).toString('hex'), short = W.shortCode(id);
    assert.equal(W.cleanPairId(cleanPair(`${ORIGIN}/#watch=${id}`, ORIGIN)), id);
    assert.equal(W.cleanShort(cleanPair(short.slice(0, 3).toLowerCase() + ' - ' + short.slice(3).toLowerCase(), ORIGIN)), short);
  }
});

test('the 4 numbers: digits only, exactly four', () => {
  assert.equal(cleanConfirm('0420'), '0420');
  assert.equal(cleanConfirm(' 04 20 '), '0420');
  for (const bad of ['', '123', '12345', 'abcd', null, undefined]) assert.equal(cleanConfirm(bad), '', String(bad));
  assert.ok(W.cleanConfirm(cleanConfirm('0420')));
});

test('a camera problem says what to do next', () => {
  assert.match(cameraMessage({ name: 'NotAllowedError' }), /blocked.*settings.*type/i);
  assert.match(cameraMessage({ name: 'NotFoundError' }), /No camera.*type/i);
  assert.match(cameraMessage(new Error('x')), /could not start.*type/i);
  assert.match(cameraMessage(undefined), /type the code/i);
});

// jsQR is a classic script: load it the way a browser does, with no module system around it.
const jsqrSource = read('jsqr.js');
const jsQR = (() => { const m = { exports: {} }; new Function('module', 'exports', jsqrSource)(m, m.exports); return m.exports; })();
// A QR code as the phone's camera sees it: the page's own generator, drawn as dark squares on white with a quiet zone.
const lib = read('dink-score.html').match(/<script>\s*\/\* qrcode-generator[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g, '');
const qrcode = new Function(lib + '\nreturn qrcode;')();
function frameOf(text, cell = 6, quiet = 4) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), size = (n + quiet * 2) * cell, data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.floor(y / cell) - quiet, c = Math.floor(x / cell) - quiet;
    if (r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c)) { const i = (y * size + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
  }
  return { data, width: size, height: size };
}

test('the code a watch shows is read back from a picture of it, and a foreign code is ignored', () => {
  const mine = `${ORIGIN}/#watch=${PAIR}`;
  const text = readQr(jsQR, frameOf(mine));
  assert.equal(text, mine);
  assert.equal(pairFromUrl(text, ORIGIN), PAIR);
  const withDigits = readQr(jsQR, frameOf(`${ORIGIN}/#watch=${PAIR}.0420`));
  assert.equal(confirmFromUrl(withDigits, ORIGIN), '0420', 'the digits survive the picture');
  const other = readQr(jsQR, frameOf('https://evil.example/#watch=' + PAIR));
  assert.equal(other, 'https://evil.example/#watch=' + PAIR);
  assert.equal(pairFromUrl(other, ORIGIN), '', 'a code that points somewhere else is not taken');
  const blank = { data: new Uint8ClampedArray(200 * 200 * 4).fill(255), width: 200, height: 200 };
  assert.equal(readQr(jsQR, blank), '', 'no code in the picture');
});

test('the vendored decoder is byte for byte jsQR 1.4.0, with its Apache-2.0 license beside it', () => {
  assert.equal(createHash('sha256').update(readFileSync(path.join(root, 'jsqr.js'))).digest('hex'), 'bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859');
  assert.match(read('jsqr.LICENSE.txt'), /Apache License[\s\S]*Version 2\.0/);
  assert.match(read('scan.js'), /jsQR 1\.4\.0/);
});

test('only this site may use the camera, nothing else changes, and the scanner files ship', () => {
  const policy = JSON.parse(read('vercel.json')).headers.find(h => h.source === '/(.*)').headers.find(h => h.key === 'Permissions-Policy').value;
  assert.equal(policy, 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  assert.match(read('build.cjs'), /camera=\(self\), microphone=\(\)/);
  const csp = JSON.parse(read('vercel.json')).headers.find(h => h.source === '/(.*)').headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /wasm-unsafe-eval|unsafe-eval/, 'the decoder is plain JavaScript');
  for (const f of ['scan.js', 'jsqr.js']) assert.match(read('build.cjs'), new RegExp(`'${f.replace('.', '\\.')}'`), f + ' is copied into public/');
  assert.match(read('sw.js'), /'scan\.js'/, 'the small scan.js is cached with the shell');
});

test('the page keeps the address-fragment handler; with no club it offers one game instead of a dead end', () => {
  const page = read('dink-score.html');
  assert.match(page, /\^#watch=\(\[0-9A-Fa-f\]\{32\}\)\(\?:\\\.\(\[0-9\]\{4\}\)\)\?\$/);
  assert.match(page, /watchFromFragment\(wt\[1\]\.toLowerCase\(\), wt\[2\] \|\| ''\)/, 'the fragment digits reach the sheet');
  assert.match(page, /Link a watch to one game/);
  assert.match(page, /record\(s, Scoring\.logOf\(live\), live\.shared && live\.id \? live\.id : null\)/, 'a shared game is saved under its live id');
  assert.match(page, /watch: watchIds\(\)/, 'the phone names its linked watches when it publishes');
});

test('a game link is #game= and 32 hex, and a typed game code is 6 base32 characters', () => {
  assert.equal(gameFragment(`#game=${PAIR}`), PAIR);
  assert.equal(gameFragment(`#game=${PAIR.toUpperCase()}`), PAIR);
  for (const bad of ['', '#game=', `#game=${PAIR}0`, `#game=${PAIR.slice(1)}`, `#watch=${PAIR}`, `#game=${PAIR}.0420`, `game=${PAIR}`, null, undefined]) assert.equal(gameFragment(bad), '', String(bad));
  assert.equal(gameLink('https://dinkscore.example/', PAIR), `https://dinkscore.example/#game=${PAIR}`);
  assert.equal(cleanShort(' k7q-2zm '), 'K7Q2ZM'); assert.equal(cleanShort('K7Q 2ZM'), 'K7Q2ZM');
  for (const bad of ['', 'K7Q2Z', 'K7Q2ZMA', 'K7Q2Z1', 'K7Q2Z8', 'K7Q2Z!', null]) assert.equal(cleanShort(bad), '', String(bad));
});

test('the phone page: a watch link with no club leads to one game, not a dead end, and the game link and code are wired', () => {
  const html = read('dink-score.html'), mod = read('src/app/watch-link.js');
  assert.ok(!html.includes('watchOpenHTML') && !html.includes("view: 'watch-open'"), 'the "open from your Home Screen" dead end is gone');
  assert.match(html, /if \(!club\) \{ watchGameFrom\(\{ pair, confirm: confirm \|\| '' \}\); return; \}/);
  assert.match(html, /\^#game=\(\[0-9A-Fa-f\]\{32\}\)\$/);
  for (const a of ["action: 'watch-offer'", "action: 'watch-claim-game'", 'single: true']) assert.ok(mod.includes(a), a);
  assert.ok(html.includes(mod.slice(mod.indexOf('async function watchGameClaim'), mod.indexOf('async function watchGameClaim') + 200)), 'the built page carries the module');
});

test('the scoring screen has a Link a watch button for a shared game that opens the camera and links on the scan', () => {
  const html = read('dink-score.html');
  assert.match(html, /isShared\(\) && !live\.event && s\.winner === null \? '<button type="button" class="watch-chip" data-act="watch-court">Link a watch to this game<\/button>'/);
  assert.match(html, /clubSheet = \{ view: 'watch-link', single: true, auto: true \}; renderClub\(\); watchScanStart\(\)/, 'straight to the camera, for this game only');
  assert.match(html, /if \(c\.auto && digits\) setTimeout\(watchClaim, 0\)/, 'the numbers come in the code, so the scan is the whole job');
  assert.match(html, /c\.auto\) \{ clubSheet = null; renderClub\(\); showToast\(msg\)/, 'and back to the court');
});
