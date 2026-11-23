import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const news = read('src/app/tutorial.js').match(/const NEWS = \{ id: '([^']+)'[\s\S]*?\n\] \};/);

test("what's new sheet has a dated id and short plain entries", () => {
  assert.ok(news, 'NEWS block not found');
  assert.match(news[1], /^\d{4}-\d{2}-\d{2}$/);
  const items = [...news[0].matchAll(/^\s+\['[^']+', '[^']+', '(.+)'\],?$/gm)];
  assert.ok(items.length >= 1);
  for (const [, body] of items) assert.ok(body.length <= 200, body);
});

test("the built page and the a11y check use the same news id", () => {
  assert.ok(read('dink-score.html').includes(`const NEWS = { id: '${news[1]}'`));
  assert.ok(read('index.html').includes(`const NEWS = { id: '${news[1]}'`));
  assert.ok(read('tools/a11y-check.mjs').includes(`"${news[1]}"`));
});

test("what's new push alerts entry only lists shipped push categories", () => {
  const entries = new Map([...news[0].matchAll(/^\s+\['[^']+', '([^']+)', '(.+)'\],?$/gm)].map(m => [m[1], m[2]]));
  const alerts = entries.get('Pick your alerts');
  assert.ok(alerts, 'Pick your alerts entry exists');
  assert.doesNotMatch(alerts, /games to confirm/i, 'push alerts copy omits unshipped games-to-confirm push');
  assert.match(alerts, /game nights/i);
  assert.match(alerts, /events and courts/i);
  assert.match(alerts, /league/i);
  assert.match(entries.get('Bell and inbox') || '', /games to confirm/i, 'inbox entry still lists games to confirm');
});
