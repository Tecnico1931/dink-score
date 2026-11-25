// UX-20: the Display and sound sheet carries its own name, the sound toggle is dimmed and disabled while Win celebration is off,
// and the TV display hides the app behind it and fits its exit link in a 1280x800 screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'dink-score.html'), 'utf8');
const sheet = fs.readFileSync(path.join(root, 'src/app/settings-sheet.js'), 'utf8');

test('the sheet is titled like the row that opens it', () => {
  assert.match(sheet, /<h2 id="settings-h" tabindex="-1">Display and sound<\/h2>/);
  assert.match(html, /youRow\('data-act="settings-open"', '[^']+', 'Display and sound'/);
});

test('Celebration sound is disabled and dimmed while Win celebration is off', () => {
  assert.match(sheet, /replaceAll\('<button type="button"', celebration\.on \? '<button type="button"' : '<button type="button" disabled'\)/);
  assert.match(sheet, /Turn Win celebration on to use sound\./);
  assert.match(html, /\.seg button:disabled \{ opacity: \.5;/);
});

test('TV display mode takes #app and #tabs out of the accessibility tree and the tab order', () => {
  assert.match(html, /html\.dsp-lock #app, html\.dsp-lock #tabs \{ display: none; \}/);
  assert.match(html, /document\.documentElement\.classList\.add\('dsp-lock'\)/);
});

test('the TV QR is at most 44vh so the sign and its exit link fit 800 px', () => {
  const m = html.match(/\.dsp-qr \{[^}]*width: min\((\d+)vh, 78vw\)/);
  assert.ok(m, 'dsp-qr width rule');
  assert.ok(+m[1] <= 44, `QR is ${m[1]}vh`);
});
