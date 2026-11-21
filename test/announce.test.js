import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
const block = html.match(/\/\*ANNOUNCE-START\*\/([\s\S]*?)\/\*ANNOUNCE-END\*\//);
assert.ok(block, 'ANNOUNCE-START/END block missing from dink-score.html');
const Announce = new Function(`${block[1]}\nreturn Announce;`)();

test('Announce.hash is stable, text-sensitive and NFC-normalised', () => {
  assert.match(Announce.hash('Courts closed Friday'), /^[0-9a-f]{8}$/);
  assert.equal(Announce.hash('Courts closed Friday'), Announce.hash('Courts closed Friday'));
  assert.notEqual(Announce.hash('Courts closed Friday'), Announce.hash('Courts closed Saturday'));
  assert.equal(Announce.hash('café'), Announce.hash('café'));
  assert.match(Announce.hash(null), /^[0-9a-f]{8}$/);
});

test('Announce.shown: hidden when empty or dismissed, back when the text changes', () => {
  assert.equal(Announce.shown('', ''), false);
  assert.equal(Announce.shown('   ', ''), false);
  assert.equal(Announce.shown(null, ''), false);
  assert.equal(Announce.shown('Courts closed Friday', ''), true);
  const gone = Announce.hash('Courts closed Friday');
  assert.equal(Announce.shown('Courts closed Friday', gone), false);
  assert.equal(Announce.shown('  Courts closed Friday \n', gone), false, 'surrounding whitespace is not a change');
  assert.equal(Announce.shown('Courts closed Saturday', gone), true, 'a new message shows again');
  assert.equal(Announce.shown('Courts closed Friday', 'junk'), true);
});

test('the banner is the first thing on Play, reads the existing club note, escapes it and stores only a hash per device', () => {
  assert.match(html, /return `\$\{announceBannerHTML\(\)\}\$\{pickupBannerHTML\(\)\}/);
  const mod = fs.readFileSync(new URL('../src/app/announce-banner.js', import.meta.url), 'utf8');
  assert.match(mod, /club\.note/);
  assert.match(mod, /<p>\$\{esc\(note\)\}<\/p>/);
  assert.match(mod, /store\.set\(Announce\.key, Announce\.hash\(/);
  assert.match(html, /ds\.act === 'announce-dismiss'/);
  // the dismiss button has a name and a 44 px target; the text wraps and the banner uses theme tokens only
  assert.match(mod, /aria-label="Dismiss announcement"/);
  assert.match(html, /\.ann-x \{[^}]*width: 44px; height: 44px;/);
  const css = html.match(/\.ann-banner \{[^}]*\}/)[0];
  assert.ok(!/#[0-9a-f]{3,6}\b|rgb\(/i.test(css), 'colours come from tokens');
  // no server change: the note already reaches the phone in GET /api/club
  assert.ok(!/announce/i.test(fs.readFileSync(new URL('../api/club.js', import.meta.url), 'utf8')));
});
