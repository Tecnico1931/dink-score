import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
const Greeting = new Function(html.match(/\/\*GREETING-START\*\/([\s\S]*?)\/\*GREETING-END\*\//)[1] + '\nreturn Greeting;')();

test('firstName extracts first word, trims whitespace and strips outer punctuation', () => {
  assert.equal(Greeting.firstName('Alex'), 'Alex');
  assert.equal(Greeting.firstName('Alex Morgan'), 'Alex');
  assert.equal(Greeting.firstName('  Alex   Morgan  '), 'Alex');
  assert.equal(Greeting.firstName('Alex!'), 'Alex');
  assert.equal(Greeting.firstName('...Alex, Jr.'), 'Alex');
  assert.equal(Greeting.firstName('— Alex'), 'Alex');
  assert.equal(Greeting.firstName("O'Connor Smith"), "O'Connor");
  assert.equal(Greeting.firstName('Anne-Marie Jones'), 'Anne-Marie');
  assert.equal(Greeting.firstName('José García'), 'José');
});

test('firstName returns empty string for empty, unlinked or punctuation-only names', () => {
  assert.equal(Greeting.firstName(''), '');
  assert.equal(Greeting.firstName('   '), '');
  assert.equal(Greeting.firstName(null), '');
  assert.equal(Greeting.firstName(undefined), '');
  assert.equal(Greeting.firstName('!!! ---'), '');
});

test('bucket maps hours to morning, afternoon, and evening', () => {
  const at = h => new Date(2026, 4, 15, h, 30, 0);
  assert.equal(Greeting.bucket(at(5)), 'Good morning');
  assert.equal(Greeting.bucket(at(11)), 'Good morning');
  assert.equal(Greeting.bucket(at(12)), 'Good afternoon');
  assert.equal(Greeting.bucket(at(16)), 'Good afternoon');
  assert.equal(Greeting.bucket(at(17)), 'Good evening');
  assert.equal(Greeting.bucket(at(23)), 'Good evening');
  assert.equal(Greeting.bucket(at(0)), 'Good evening');
  assert.equal(Greeting.bucket(at(4)), 'Good evening');
});

test('text formats greeting or returns empty string when unlinked', () => {
  assert.equal(Greeting.text('Alex Rivera', new Date(2026, 4, 15, 9, 0)), 'Good morning, Alex');
  assert.equal(Greeting.text('  Sam  ', new Date(2026, 4, 15, 14, 0)), 'Good afternoon, Sam');
  assert.equal(Greeting.text('Jordan!', new Date(2026, 4, 15, 19, 0)), 'Good evening, Jordan');
  assert.equal(Greeting.text('', new Date(2026, 4, 15, 9, 0)), '');
  assert.equal(Greeting.text(null, new Date(2026, 4, 15, 9, 0)), '');
});

test('Play greeting is wired above This week bars with escaping', () => {
  assert.match(html, /class="play-greeting">\$\{esc\(greet\)\}<\/p>/);
  assert.ok(html.includes('Greeting.text(linkedPlayerName())'));
});
