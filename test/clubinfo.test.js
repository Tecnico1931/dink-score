import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPayLink, cleanNote, MAX_LINK, MAX_NOTE } from '../api/_clubinfo.js';

test('pay link: https only, trimmed, empty clears', () => {
  assert.equal(cleanPayLink(''), '');
  assert.equal(cleanPayLink('   '), '');
  assert.equal(cleanPayLink(null), '');
  assert.equal(cleanPayLink('  https://pay.example.com/club?x=1  '), 'https://pay.example.com/club?x=1');
});

test('pay link: refuses anything that is not a plain https address', () => {
  for (const bad of ['http://pay.example.com', 'javascript:alert(1)', 'data:text/html,hi', 'mailto:a@b.co', 'ftp://example.com',
    '//example.com', 'example.com/pay', 'https://user:pw@example.com', 'https://localhost', 'https://exa mple.com', 'https://example.com/"onclick=1', 'https://example.com/<b>', 'not a link']) {
    assert.throws(() => cleanPayLink(bad), Error, bad);
  }
  assert.throws(() => cleanPayLink('https://example.com/' + 'a'.repeat(MAX_LINK)), /too long/);
});

test('note: plain text, length-limited, control characters dropped', () => {
  assert.equal(cleanNote(''), '');
  assert.equal(cleanNote(undefined), '');
  assert.equal(cleanNote('  Courts 3 and 4 are booked.  '), 'Courts 3 and 4 are booked.');
  assert.equal(cleanNote('a\r\nb\u0000c\u0007'), 'a\nbc');
  assert.equal(cleanNote('a\n\n\n\n\n\nb'), 'a\n\n\nb');
  assert.equal(cleanNote('x'.repeat(MAX_NOTE)).length, MAX_NOTE);
  assert.throws(() => cleanNote('x'.repeat(MAX_NOTE + 1)), /too long/);
  // markup is kept as text (the app escapes it when drawing it)
  assert.equal(cleanNote('<img src=x onerror=1>'), '<img src=x onerror=1>');
});
