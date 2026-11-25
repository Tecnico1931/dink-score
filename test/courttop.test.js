// UX-15: the four icon-only buttons on the live court top bar carry a visible word (Sun, Share, Log, Undo)
// that their accessible names start with (WCAG 2.5.3), at 12 px or more and 44 px or more.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const a = html.indexOf('<div class="cright">');
assert.ok(a > 0, 'court top bar missing');
const bar = html.slice(a, html.indexOf('</div>', a));
const buttons = [...bar.matchAll(/<button class="icon-btn lab" data-act="([^"]+)"[^>]*aria-label="([^"]+)"[^>]*>\$\{ICON\.(\w+)\}<span aria-hidden="true">([^<]+)<\/span><\/button>/g)];

test('the court top bar has four labelled buttons in order', () => {
  assert.deepEqual(buttons.map(m => [m[1], m[3], m[4]]), [['display', 'sun', 'Sun'], ['club-share', 'share', 'Share'], ['log-open', 'plus', 'Log'], ['undo', 'undo', 'Undo']]);
  assert.equal((bar.match(/<button/g) || []).length, 4, 'no unlabelled button left in the group');
});

test('each visible label is the start of the accessible name', () => {
  for (const [, , name, , label] of buttons) assert.ok(new RegExp(`^${label}\\b`, 'i').test(name), `${label} vs ${name}`); // whole word, as axe label-content-name-mismatch checks
});

test('labelled buttons stay 44 px wide and tall with 12 px text, and scale up for large scores', () => {
  const css = html.slice(0, html.indexOf('</style>'));
  const base = css.match(/\.icon-btn \{[^}]*\}/)[0];
  assert.match(base, /width: 44px; height: 44px/);
  const lab = css.match(/\.icon-btn\.lab \{[^}]*\}/)[0];
  assert.match(lab, /height: 56px/);
  assert.match(lab, /font-size: 12px/);
  assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(/i.test(lab), 'tokens only');
  assert.match(css, /:root\[data-large\] \.icon-btn\.lab \{ width: auto; min-width: 44px;[^}]*font-size: 15px/);
});

test('the undo button still starts disabled with no rallies and the sun button stays a toggle', () => {
  assert.match(bar, /data-act="undo" aria-label="Undo last rally" \$\{live\.stack\.length \? '' : 'disabled'\}/);
  assert.match(bar, /data-act="display" aria-pressed="\$\{display\.outdoor \? 'true' : 'false'\}"/);
});
