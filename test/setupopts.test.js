import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
const fnMatch = html.match(/function setupSummary\(s\)\s*\{[\s\S]*?\n\}/);
assert.ok(fnMatch, 'setupSummary(s) is missing from dink-score.html');
const setupSummary = new Function(`${fnMatch[0]}\nreturn setupSummary;`)();

test('setupSummary formats format, scoring, target and win-by into one line', () => {
  assert.equal(setupSummary({ mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2 }), 'Doubles · Side-out · to 11 · win by 2');
  assert.equal(setupSummary({ mode: 'singles', scoring: 'rally', target: 15, winBy: 1 }), 'Singles · Rally · to 15 · win by 1');
  assert.equal(setupSummary({ mode: 'doubles', scoring: 'rally', target: 21, winBy: 2 }), 'Doubles · Rally · to 21 · win by 2');
  assert.equal(setupSummary({}), 'Doubles · Side-out · to 11 · win by 2');
});

test('New game settings start collapsed with an accessible toggle and panel', () => {
  assert.match(html, /let setupOptsOpen = false;/);
  assert.match(html, /<button type="button" class="setup-opts-toggle" data-act="setup-opts" aria-expanded="\$\{setupOptsOpen\}" aria-controls="setup-opts-panel">/);
  assert.match(html, /<div class="setup-opts-panel" id="setup-opts-panel" \$\{setupOptsOpen \? '' : 'hidden'\}>/);
  const panel = html.match(/id="setup-opts-panel"[\s\S]*?<div class="teams">/);
  assert.ok(panel, 'setup-opts-panel should sit above .teams');
  for (const attr of ['data-set-mode', 'data-set-scoring', 'data-set-target', 'data-set-winBy']) {
    assert.ok(panel[0].includes(attr), `${attr} should be inside #setup-opts-panel`);
  }
  assert.match(html, /\.setup-opts-toggle \{[^}]*min-height: 44px/);
  assert.match(html, /:root\[data-outdoor\][^\n]*\.setup-opts-toggle/);
  assert.match(html, /if \(act === 'setup-opts'\) \{ setupOptsOpen = !setupOptsOpen; render\(\);/);
});
