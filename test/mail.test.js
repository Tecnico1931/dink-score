import test from 'node:test';
import assert from 'node:assert/strict';
import { mailEnabled, cleanEmail, sendLoginMail } from '../api/_mail.js';

test('mail is on only with both a key and a sender', () => {
  assert.equal(mailEnabled({}), false);
  assert.equal(mailEnabled({ RESEND_API_KEY: 'k' }), false);
  assert.equal(mailEnabled({ RESEND_API_KEY: 'k', MAIL_FROM: 'Dink <a@b.test>' }), true);
});

test('cleanEmail gives one spelling and refuses anything that is not a plain address', () => {
  assert.equal(cleanEmail('  Ana.P+club@Example.TEST '), 'ana.p+club@example.test');
  for (const bad of ['', null, 'a@b', 'a b@c.test', 'a@b.test, c@d.test', '<a@b.test>', 'a@@b.test', '@b.test', 'a@-b.test', 'x'.repeat(65) + '@b.test', 'a@' + 'b'.repeat(250) + '.test']) assert.equal(cleanEmail(bad), '', String(bad));
});

test('sendLoginMail posts to Resend with the key in a header and reports only the status on failure', async () => {
  const real = globalThis.fetch, calls = [];
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: false, status: 422, text: async () => 'echo of re_secret' }; };
    const env = { RESEND_API_KEY: 're_secret', MAIL_FROM: 'Dink <a@b.test>' };
    await assert.rejects(sendLoginMail('x@y.test', 'https://h.test/#signin=t', env), err => err.message === 'mail: 422' && !err.message.includes('re_secret'));
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_secret');
    assert.equal(JSON.parse(calls[0].init.body).to[0], 'x@y.test');
    globalThis.fetch = async () => { throw new Error('boom re_secret'); };
    await assert.rejects(sendLoginMail('x@y.test', 'l', env), err => !err.message.includes('re_secret'));
  } finally { globalThis.fetch = real; }
});
