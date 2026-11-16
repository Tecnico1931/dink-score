import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const block = src.match(/\/\*DUPRENTRY-START\*\/([\s\S]*?)\/\*DUPRENTRY-END\*\//);
assert.ok(block, 'the DUPRENTRY block is missing from dink-score.html');
const DuprEntry = new Function(block[1] + '\nreturn DuprEntry;')();
const club = { code: 'ABC123' }, cfg = { enabled: true, env: 'uat' };

test('Your DUPR card state follows club, identity and SSO availability', () => {
  assert.equal(DuprEntry.state({ club: null, cfg, myName: 'Ana' }), 'noclub');
  assert.equal(DuprEntry.state({ club, cfg, myName: null }), 'pickname');
  assert.equal(DuprEntry.state({ club, cfg, myName: 'Ana' }), 'connect');
  assert.equal(DuprEntry.state({ club, cfg: null, myName: 'Ana' }), 'self');
});

test('test mode label only for the uat environment', () => {
  assert.equal(DuprEntry.testMode(cfg), true);
  assert.equal(DuprEntry.testMode({ enabled: true, env: 'prod' }), false);
  assert.equal(DuprEntry.testMode(null), false);
});
