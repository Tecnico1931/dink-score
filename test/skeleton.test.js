import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('dink-score.html');
const skel = new Function(html.match(/^const skel = .*$/m)[0] + '; return skel;')();

test('skel() renders n placeholder rows with a screen-reader label', () => {
  const out = skel(4);
  assert.equal((out.match(/class="skel"/g) || []).length, 4);
  assert.match(out, /role="status"[^>]*>.*<span class="vh">Loading…<\/span>/);
  assert.equal((skel(2, true).match(/skel-card/g) || []).length, 2);
});

test('skeleton CSS waits before showing and stills the shimmer for reduced motion', () => {
  assert.match(html, /\.skel-wrap \{[^}]*opacity: 0; animation: skel-in \.01s linear \.25s forwards/);
  const shimmer = html.match(/@media \(prefers-reduced-motion: no-preference\) \{ \.skel i[^}]*\{[^}]*skel-shimmer/);
  assert.ok(shimmer, 'shimmer only under no-preference');
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{ \.skel-wrap \{[^}]*!important/);
  assert.ok(!/\.skel[^{]*\{[^}]*(?:#|rgb)/.test(html.match(/\.skel-wrap[\s\S]*?skel-shimmer \{[^}]*\}/)[0]), 'skeleton colours come from theme tokens');
});

test('loading states use skeletons, not a bare "Loading…" note', () => {
  for (const f of ['dink-score.html', ...fs.readdirSync(path.join(root, 'src/app')).map(n => 'src/app/' + n)])
    assert.ok(!/<p class="note"[^>]*>Loading/.test(read(f)), f);
});
