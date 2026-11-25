// UX-08: the club sheet shares one row between its title and the close button, a tap on a sheet title draws no focus box,
// and field inputs use the app font and ink colour instead of the browser's monospace textarea default.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');

test('the club sheet hoists a leading h2 into the sheet-head row', () => {
  const a = html.indexOf('function renderClub()');
  const fn = html.slice(a, html.indexOf("if (c.view === 'watch-link') watchReattach();", a));
  assert.match(fn, /const lead = body\.match\(\/\^\\s\*\(<h2\\b\[\^>\]\*>\[\\s\\S\]\*\?<\\\/h2>\)\/\);/);
  assert.match(fn, /<div class="sheet-head">\$\{lead \? lead\[1\] : '<span><\/span>'\}<button type="button" class="x" data-act="club-close" aria-label="Close">/);
  // the row is the same flex row as every other sheet head
  assert.match(html, /\.sheet-head \{ display: flex; justify-content: space-between; align-items: center;/);
});

test('programmatic focus on a sheet title is invisible for touch and kept for keyboard users', () => {
  assert.match(html, /h2\[tabindex="-1"\]:focus:not\(:focus-visible\) \{ outline: none; \}/);
  assert.doesNotMatch(html, /h2\[tabindex="-1"\]:focus \{ outline: none/, 'the keyboard ring stays');
});

test('field inputs inherit the app font and use the ink token', () => {
  const rule = html.match(/\n\.field-input \{[^}]*\}/)[0];
  assert.match(rule, /font-family: inherit/);
  assert.match(rule, /color: var\(--ink\)/);
});
