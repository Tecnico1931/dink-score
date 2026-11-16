import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReport, reportingOn, reportError } from '../api/_report.js';

test('cleanReport clips, drops query strings and unknown fields', () => {
  const r = cleanReport('client', { message: 'x'.repeat(9999), stack: 'y'.repeat(9999), source: 'https://a/b.js?club=ABC123', page: '/?club=ABC123#h', line: 'nope', secret: 's' });
  assert.equal(r.message.length, 500); assert.equal(r.stack.length, 2000);
  assert.equal(r.source, 'https://a/b.js'); assert.equal(r.page, '/'); assert.equal(r.line, 0);
  assert.equal(r.secret, undefined); assert.equal(r.kind, 'client');
  assert.equal(cleanReport('weird').kind, 'server');
});
test('reporting is off by default and for non-https endpoints', async () => {
  delete process.env.ERROR_REPORT_URL;
  assert.equal(reportingOn(), false);
  assert.equal(await reportError('server', { message: 'm' }), false);
  process.env.ERROR_REPORT_URL = 'http://insecure.example';
  assert.equal(reportingOn(), false);
  delete process.env.ERROR_REPORT_URL;
});
test('reportError posts the cleaned report when on, and never throws', async () => {
  const real = globalThis.fetch; let got;
  globalThis.fetch = async (u, o) => { got = { u, b: JSON.parse(o.body) }; return {}; };
  process.env.ERROR_REPORT_URL = 'https://sink.example/in';
  try {
    assert.equal(await reportError('server', { message: 'boom', source: 'f?x=1' }), true);
    assert.equal(got.u, 'https://sink.example/in'); assert.equal(got.b.source, 'f');
    globalThis.fetch = async () => { throw new Error('down'); };
    assert.equal(await reportError('server', {}), false);
  } finally { globalThis.fetch = real; delete process.env.ERROR_REPORT_URL; }
});
