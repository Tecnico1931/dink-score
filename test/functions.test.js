import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Vercel's Hobby plan allows 12 serverless functions and every api/*.js not starting with "_" is one. A thirteenth
// fails the deploy after the build, so fold new routes into an existing function (helpers go in _*.js files).
test('api/ has at most 12 serverless functions', () => {
  const fns = readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api')).filter(f => f.endsWith('.js') && !f.startsWith('_'));
  assert.ok(fns.length <= 12, `${fns.length} functions: ${fns.join(', ')}`);
});
