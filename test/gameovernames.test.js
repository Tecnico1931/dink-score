// UX-19: Game Over keeps ball yellow for one primary action and lets the scorer name default players before saving.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const a = html.indexOf('aria-labelledby="win-h"');
const sheet = html.slice(a, html.indexOf('} else if (live.confirmEnd)', a));

test('Share on Game Over is soft, so Save and rematch is the only ball-yellow button', () => {
  assert.match(sheet, /<button class="btn btn-soft share-pill" data-act="share-live">/);
  assert.equal((sheet.match(/btn-ball/g) || []).length, 2, 'rematch, plus Save result for an event match (never both on screen)');
  assert.match(sheet, /\$\{live\.event \? '' : '<button class="btn btn-ball" data-act="rematch">/);
});

test('with only default names the dead-end note became an Add player names button', () => {
  assert.doesNotMatch(html, /if \(!named\.length\) return `<p class="expect">Add player names next time/, 'no unconditional dead-end note');
  assert.match(html, /if \(!named\.length\) return nameBlock\(\);/);
  assert.match(html, /data-act="name-open">Add player names<\/button>/);
  assert.match(html, /act === 'name-open'/);
  assert.match(html, /act === 'name-save'/);
});

test('naming inputs are labelled, kept across re-renders and checked for blanks and duplicates', () => {
  const f = html.slice(html.indexOf('function nameBlock()'), html.indexOf('function ratingPreview'));
  assert.match(f, /aria-label="\$\{TEAM_NAME\[ti\]\} team, player \$\{i \+ 1\}"/);
  assert.match(f, /live\.event \|\| live\.shared/, 'event and shared games keep the old note');
  assert.match(html, /d\.gname && live && live\.naming/, 'typed text survives the toast re-render');
  assert.match(html, /Type at least one name\./);
  assert.match(html, /Each player needs a different name\./);
  assert.match(html, /announce\('Names saved\./);
});
