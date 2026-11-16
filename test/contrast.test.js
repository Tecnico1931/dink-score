// WCAG 2.x contrast of every text/background pair the CSS tokens make, in each theme, plus the court's team colours.
// Reads dink-score.html itself, so a token change that drops a pair under its threshold fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
const tokenBlock = html.split('/*TOKENS-START*/')[1].split('/*TOKENS-END*/')[0];
const hexRgb = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
const vars = body => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{3,6})\b/g)].map(m => [m[1], hexRgb(m[2])]));
// Each theme is the :root defaults, then its overrides.
const light = vars(tokenBlock.split('@media')[0]);
const dark = Object.assign({}, light, vars(tokenBlock.split(':root[data-theme="dark"]')[1].split('}')[0]));
const outdoor = Object.assign({}, light, vars(tokenBlock.split(':root[data-outdoor]')[1].split('}')[0]));
const WHITE = [255, 255, 255];

// [foreground, background, minimum, what]: 4.5 for text, 3 for large text and UI components (WCAG 1.4.3, 1.4.11).
const pairs = t => [
  [t.ink, t.bg, 4.5, 'body text'], [t.ink, t.surface, 4.5, 'text on cards'], [t.ink, t['surface-2'], 4.5, 'text on soft buttons'],
  [t.muted, t.bg, 4.5, 'muted text on page'], [t.muted, t.surface, 4.5, 'muted text on cards'], [t.muted, t['surface-2'], 4.5, 'muted text on soft buttons'],
  [t.bg, t.ink, 4.5, '.btn-ink'], [WHITE, t.blue, 4.5, 'white on blue (.btn-blue, team 1)'], [ [255, 255, 255], t.green, 4.5, 'white on green (team 2)'],
  [t['ball-ink'], t.ball, 4.5, 'text on the ball highlight'], [t.danger, t.surface, 4.5, 'error text on cards'], [t.danger, t.bg, 4.5, 'error text on page'],
  [t.up, t.surface, 4.5, 'rating up'], [t.down, t.surface, 4.5, 'rating down'], [t.focus, t.bg, 3, 'focus ring on page'], [t.focus, t.surface, 3, 'focus ring on cards'], [t['blue-text'], t.surface, 4.5, 'blue text on cards'], [t['blue-text'], t.bg, 4.5, 'blue text on page'], [t.green, t.surface, 3, 'green marks on cards'], [t.blue, t.surface, 3, 'blue marks on cards'],
];
for (const [name, t] of [['light', light], ['dark', dark], ['outdoor', outdoor]]) {
  test(`token contrast: ${name}`, () => {
    for (const [fg, bg, min, what] of pairs(t)) assert.ok(ratio(fg, bg) >= min, `${name}: ${what} is ${ratio(fg, bg).toFixed(2)}:1, needs ${min}:1`);
  });
}
test('danger buttons: label colour passes in every theme', () => {
  // .btn-danger paints text #fff on --danger; dark mode lightens --danger, so its label flips to the dark background colour.
  for (const [name, t] of [['light', light], ['outdoor', outdoor]]) assert.ok(ratio(WHITE, t.danger) >= 4.5, `${name}: white on danger ${ratio(WHITE, t.danger).toFixed(2)}`);
  assert.ok(ratio(dark.bg, dark.danger) >= 4.5, 'dark: bg on danger');
  assert.match(html, /:root\[data-theme="dark"\] \.btn-danger \{ color: var\(--bg\); \}/);
  assert.match(html, /prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \.btn-danger \{ color: var\(--bg\)/);
});

// The court: white text over each team's gradient, at the lightest end (the worst case) and at the dimmed "idle" half.
const a11y = html.split('/*A11Y-START*/')[1].split('/*A11Y-END*/')[0];
const halfVars = sel => { const m = new RegExp(sel.replace(/[[\]"]/g, '\\$&') + ' \\{[^}]*?--c1: (#[0-9A-Fa-f]{6}); --c2: (#[0-9A-Fa-f]{6})').exec(a11y); assert.ok(m, 'no court colours for ' + sel); return [hexRgb(m[1]), hexRgb(m[2])]; };
for (const [name, sel] of [['team 1', '.half'], ['team 2', '.half[data-k="b"]'], ['outdoor team 1', ':root[data-outdoor] .half'], ['outdoor team 2', ':root[data-outdoor] .half[data-k="b"]']]) {
  test(`court contrast: ${name}`, () => {
    const out = name.startsWith('outdoor');
    for (const c of halfVars(sel)) {
      for (const [alpha, what] of [[1, 'score and names on the active half'], [0.92, 'names'], [0.94, 'side box']]) {
        const a = out ? 1 : alpha; // outdoor mode draws every court text at full opacity
        assert.ok(ratio(over(WHITE, c, a), c) >= 4.5, `${name} ${what} at ${a}: ${ratio(over(WHITE, c, a), c).toFixed(2)}:1`);
      }
      const idle = over([6, 10, 16], c, 0.3); // the .idle overlay only darkens, so white text gets stronger
      assert.ok(ratio(WHITE, idle) >= ratio(WHITE, c));
    }
  });
}
test('court: ball highlight text, call pill and toast pass', () => {
  assert.ok(ratio(light['ball-ink'], light.ball) >= 7);
  assert.ok(ratio(over(WHITE, [15, 22, 34], 0.8), [15, 22, 34]) >= 4.5, 'call labels on the dark pill');
  assert.ok(ratio(over(WHITE, [10, 17, 27], 0.9), [10, 17, 27]) >= 4.5, 'who serves note');
});

// Text size and the display setting are plain CSS, so pin them here.
test('no text under 12px outside the decorative tour art', () => {
  const css = html.split('</style>')[0];
  const small = css.split('\n').filter(l => /font-size:\s*(9|10|11)(\.\d)?px/.test(l) && !/\.mini/.test(l));
  assert.deepEqual(small, []);
});
test('outdoor display: every court text is opaque and the display setting is wired', () => {
  assert.match(a11y, /:root\[data-outdoor\] \.names span[^}]*opacity: 1/);
  assert.match(html, /store\.get\('pb\.display'/);
  assert.match(html, /data-act="display"[^>]*aria-pressed/);
  assert.match(html, /id="a11y-live"[^>]*aria-live="polite"/);
});
