// UX-07: the Rules jump bar is one horizontally scrollable row (60 px sticky, not 110 px) with 44 px pills.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const rule = sel => {
  const a = html.indexOf(`${sel} {`);
  assert.ok(a >= 0, `${sel} missing`);
  return html.slice(a, html.indexOf('}', a));
};

test('jump list is a single non-wrapping scroll row with the scrollbar hidden', () => {
  const ul = rule('.rules-jump ul');
  assert.match(ul, /flex-wrap: nowrap/);
  assert.match(ul, /overflow-x: auto/);
  assert.match(ul, /scrollbar-width: none/);
  assert.ok(!/flex-wrap: wrap/.test(ul));
  assert.match(html, /\.rules-jump ul::-webkit-scrollbar \{ display: none; \}/);
  assert.match(rule('.rules-jump li'), /flex: none/);
});

test('right edge fades with a token colour and leaves room so the last pill is readable', () => {
  const ul = rule('.rules-jump ul');
  assert.match(ul, /mask-image: linear-gradient\(to right, var\(--ink\) calc\(100% - 24px\), transparent\)/);
  assert.match(ul, /padding: 3px 27px 3px 3px/); // 3 px keeps focus rings and shadows from being clipped by the scroll box
  assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(/i.test(ul), 'tokens only');
});

test('pills keep 44 px targets and 13 px text', () => {
  const a = rule('.rules-jump a');
  assert.match(a, /min-height: 44px; min-width: 44px/);
  assert.match(a, /font-size: 13px/);
});

test('anchors clear the shorter sticky bar: 68 px, not 118 px', () => {
  assert.match(html, /\.rule\[id\], \.rules button, \.rules a \{ scroll-margin-top: calc\(68px \+ env\(safe-area-inset-top, 0px\)\); \}/);
  assert.ok(!html.includes('scroll-margin-top: calc(118px'));
  // bar = 8 + 44 + 8 padding; 68 leaves an 8 px gap
  assert.match(rule('.rules-jump'), /padding: 8px 4px/);
});
