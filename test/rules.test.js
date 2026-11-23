// Pure checks for the Rules tab (UX review PR 7): jump row anchors and target ids,
// game rules kept, duplicated settings/DUPR blocks replaced by one-line links to You,
// heading order, reduced motion and accessible styling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fn, page } from './helpers/app.js';

const html = page();
const rulesHtml = new Function(fn('rulesView') + '\nreturn rulesView();')();

test('every jump label in the Rules jump row is a real anchor with an existing unique target id', () => {
  const nav = rulesHtml.match(/<nav class="rules-jump" aria-label="([^"]+)">([\s\S]*?)<\/nav>/);
  assert.ok(nav, 'Rules tab renders a labelled <nav class="rules-jump">');
  assert.ok(!/\bnavigation\b/i.test(nav[1]), 'nav aria-label does not repeat the role name');

  const anchors = [...nav[2].matchAll(/<a\s+href="#([^"]+)">([^<]+)<\/a>/g)].map(m => ({ id: m[1], label: m[2].trim() }));
  assert.ok(anchors.length >= 5, `expected at least 5 jump links, got ${anchors.length}`);

  const ids = [...rulesHtml.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);

  const seenHrefs = new Set();
  for (const { id, label } of anchors) {
    assert.ok(label.length > 0 && label.length <= 16, `jump label "${label}" should be short`);
    assert.ok(!seenHrefs.has(id), `duplicate jump target #${id}`);
    seenHrefs.add(id);
    assert.equal(counts.get(id), 1, `jump target id="${id}" for "${label}" must exist exactly once in Rules markup`);
  }
});

test('every rule of the game and app info remains documented in logical heading order', () => {
  const headings = [...rulesHtml.matchAll(/<(h[1-6])[^>]*>([^<]+)<\/\1>/g)].map(m => [m[1], m[2].trim()]);
  assert.equal(headings[0][0], 'h2');
  assert.equal(headings[0][1], 'Rules');
  for (const [tag] of headings.slice(1)) {
    assert.equal(tag, 'h3', `expected only h3 subsections under h2 Rules, found ${tag}`);
  }
  const titles = headings.map(h => h[1]);
  for (const required of [
    'Calling the score',
    'Side-out scoring',
    'Where to serve from',
    'The serve',
    'Two-bounce rule',
    'The kitchen',
    'Winning and changing ends',
    'How Dink Rating works',
    'Achievements, challenges and seasons',
    'Privacy, terms and security'
  ]) {
    assert.ok(titles.includes(required), `missing rule section: ${required}`);
  }
});

test('duplicated Display and DUPR setup blocks are replaced with one-line links pointing to You', () => {
  assert.ok(!/Display on this phone/.test(rulesHtml), 'inline Display settings block stays removed');
  assert.ok(!/Set up DUPR/.test(rulesHtml), 'long Set up DUPR block is removed');
  assert.ok(!/<ol>/.test(rulesHtml), 'multi-step DUPR setup list is removed');
  assert.match(rulesHtml, /Display and sound[\s\S]*?You[\s\S]*?data-act="settings-open"/);
  assert.match(rulesHtml, /DUPR[\s\S]*?You[\s\S]*?data-act="dupr-open"/);
  assert.match(rulesHtml, /data-tour="open"/, 'quick tour trigger stays available');
});

test('jump scroll respects prefers-reduced-motion, moves focus quietly, and CSS uses tokens with 44px targets', () => {
  const clickIdx = html.indexOf("e.target.closest('.rules-jump a[href^=\"#\"]')");
  assert.ok(clickIdx > 0, 'jump anchor click handler is wired');
  const handler = html.slice(clickIdx, clickIdx + 500);
  assert.match(handler, /prefers-reduced-motion: reduce[\s\S]*?'auto' : 'smooth'/);
  assert.match(handler, /\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.ok(!/\bannounce\(/.test(handler), 'jump handler does not make noisy live-region announcements');

  const css = html.slice(0, html.indexOf('</style>'));
  const rulesCss = css.slice(css.indexOf('/* Rules */'), css.indexOf('/* Tab bar */'));
  assert.match(rulesCss, /\.rules-jump a\s*\{[^}]*min-height:\s*44px;[^}]*min-width:\s*44px;/);
  assert.match(rulesCss, /\.rule-ext a\s*\{[^}]*min-height:\s*44px;[^}]*min-width:\s*44px;/);
  assert.match(rulesCss, /scroll-margin-top:/);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(rulesCss), 'Rules CSS uses theme tokens, no hard-coded colours');
  assert.match(css, /:root\[data-outdoor\] \.rules-jump\s*\{[^}]*background:\s*var\(--bg\)/);
  assert.match(css, /:root\[data-outdoor\] \.rules-jump a\s*\{[^}]*border:\s*2px solid var\(--ink\)/);
});
