import { test } from 'node:test';
import assert from 'node:assert/strict';
import { section } from './helpers/app.js';

const DuprEntry = new Function(section('DUPRENTRY') + '\nreturn DuprEntry;')();
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
