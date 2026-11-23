import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
const has = re => assert.ok(re.test(html), String(re));
const between = (from, to) => { const a = html.indexOf(from); assert.ok(a >= 0, `${from} missing`); return html.slice(a, html.indexOf(to, a)); };

test('the hero card greets by time of day, even with no linked name, and shows the week total, club and seven bars', () => {
  const homeTiles = between('function homeTiles(', '// "This month"');
  assert.ok(homeTiles.includes('Greeting.text(linkedPlayerName()) || Greeting.bucket()'));
  assert.match(homeTiles, /<section class="card hero" aria-label="This week">/);
  assert.match(homeTiles, /class="play-greeting">\$\{esc\(greet\)\}<\/p>/);
  assert.match(homeTiles, /club \? esc\(club\.name\) : 'Just this phone'/);
  assert.match(homeTiles, /game\$\{total === 1 \? '' : 's'\} this week/);
  assert.match(homeTiles, /<div class="week" role="img" aria-label="Games per day/);
  assert.ok(/\$\{hero\}(\$\{Rewards\.cardHTML\(\)\})?<section class="tiles">/.test(homeTiles), 'the hero card sits above the tiles');
  assert.ok(!/class="tile wide"[^`]*This week/.test(homeTiles), 'the old weekly tile is gone');
});

test('the pickleball is one vendored, precached, decorative file used by the hero card and the New game tile', () => {
  const art = between('const BALL_IMG', 'function homeTiles(');
  assert.match(art, /src="icons\/pickleball\.svg" alt=""/, 'decorative: empty alt');
  const svg = fs.readFileSync(new URL('../icons/pickleball.svg', import.meta.url), 'utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(!/<script|href=|<image|<foreignObject|on\w+=/i.test(svg), 'no script or external reference in the artwork');
  assert.match(svg, /<circle cx="60" cy="60" r="56" fill="url\(#pbs-dink\)"\/><circle cx="60" cy="60" r="55\.4" fill="none" stroke="#7E9810"/, 'body shine and outline circles');
  assert.ok(!/id="(pbg|pbh|pbs)"/.test(svg) && (svg.match(/id="pb[ghs]-dink"/g) || []).length === 3, 'unique gradient ids, safe to inline beside other SVGs');
  assert.match(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), /SHELL = \[[^\]]*'icons\/pickleball\.svg'/, 'precached so the hero works offline');
  const homeTiles = between('function homeTiles(', '// "This month"');
  assert.match(homeTiles, /\$\{BALL_IMG\('hero-ball', 124\)\}/);
  assert.match(homeTiles, /class="plus">\$\{BALL_IMG\('', 22\)\}<\/span><span class="t-name">New game/);
});

test('New game is a tile next to Log a result and opens a bottom sheet instead of an inline card', () => {
  const homeTiles = between('function homeTiles(', '// "This month"');
  assert.ok(homeTiles.indexOf('data-act="new-open"') > 0 && homeTiles.indexOf('data-act="new-open"') < homeTiles.indexOf('data-act="log-open"'));
  const play = between('function playView()', '\n}\n');
  assert.ok(!play.includes('new-h') && !play.includes('data-act="start"'), 'Play no longer renders the setup card inline');
  assert.match(html, /<div id="sheet10"><\/div>/);
  const sheet = between('function newGameHTML()', 'function renderNewGame()');
  assert.match(sheet, /role="dialog" aria-modal="true" aria-labelledby="new-h"/);
  for (const part of ['data-act="new-close"', 'data-act="start"', 'id="setup-opts-panel"', 'class="teams"', 'class="roster"']) assert.ok(sheet.includes(part), part);
  has(/if \(act === 'new-open'\) \{ newGameOpen = true; render\(\); return; \}/);
  has(/if \(e\.key === 'Escape' && newGameOpen\)/); // Escape closes the sheet
  has(/closest\('#sheet10'\) && e\.target\.classList\.contains\('sheet-bg'\)\) \{ closeNewGame\(\)/); // so does a tap on the backdrop
  has(/function beginGame\(\) \{\n  newGameOpen = false;/); // Start game closes the sheet
  has(/function lockBody\(on\) \{ if \(shareSheet \|\| newGameOpen\)/); // the page behind does not scroll while it is open
});

test('Saved players has a + Add chip that keeps the new-player input hidden until tapped', () => {
  const sheet = between('function newGameHTML()', 'function renderNewGame()');
  assert.match(sheet, /class="chip-btn add" data-act="add-open"/);
  assert.match(sheet, /\$\{addingPlayer \? `<form class="add-player" data-form="add-player"><input id="new-player"/, 'the input only exists while adding');
  has(/if \(act === 'add-open'\) \{ addingPlayer = true; render\(\); const i = \$\('#new-player'\); if \(i\) i\.focus\(\); return; \}/);
  has(/addToRoster\(\[name\]\); addingPlayer = false; render\(\);/); // it hides again after saving
  has(/\.seg button, \.chip-btn, \.serve-pick[^{]*\{ min-height: 44px; \}/); // the chip is a 44 px target
});

test('the sheet keeps reduced motion, the shared sheet styles and both themes (tokens only)', () => {
  const css = html.slice(0, html.indexOf('</style>'));
  const rules = [...css.matchAll(/^\.(?:hero|tile\.newg|chip-btn\.add|sh-end)[^{]*\{[^}]*\}/gm)].map(m => m[0]).join('\n');
  assert.ok(rules.length > 200);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(rules.replace(/rgb\([^)]*\)/g, '')), 'new rules use tokens, not hard-coded colours');
  assert.ok(/prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ transition: none !important; animation: none !important; \}/.test(css));
});
