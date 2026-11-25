// UX-06: "Play as a club" opens on Join with a code, then Start a new club, then one quiet passkey row;
// the duplicate account link at the bottom is gone (Account lives in the You sheet).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const between = (from, to) => {
  const a = html.indexOf(from);
  assert.ok(a >= 0, `${from} missing`);
  const b = html.indexOf(to, a);
  assert.ok(b > a, `${to} missing`);
  return html.slice(a, b);
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const branch = between("} else if (!club || c.view === 'add') {", "} else if (c.view === 'unlock') {");

function acctBlock(over = {}) {
  const g = { passkeysOk: () => over.passkeys !== false, acctIn: () => !!over.in, acct: { account: { name: 'Ana' } }, acctMissing: () => over.missing || [], esc };
  const keys = Object.keys(g);
  return new Function(...keys, `${between('function addAcctHTML(', '// A phone whose token was replaced')}\nreturn addAcctHTML;`)(...keys.map(k => g[k]))({ busy: false });
}

test('Play as a club: join form first, create second, one passkey row after both', () => {
  const join = branch.indexOf('data-form="club-join"');
  const create = branch.indexOf('data-form="club-create"');
  const acct = branch.indexOf('${acctBlock}');
  assert.ok(join > 0 && join < create && create < acct, 'order is join, create, sign in');
  assert.ok(acct < branch.indexOf('data-act="pk-open"'), 'sign in comes before the footer links');
});

test('the duplicate Account link at the bottom is removed', () => {
  assert.ok(!branch.includes('data-act="acct-open"'));
  assert.ok(!/Account \(optional\)/.test(branch));
});

test('passkey sign-in is one secondary button, not a primary CTA', () => {
  const out = acctBlock();
  assert.equal((out.match(/data-act="acct-in-add"/g) || []).length, 1);
  assert.match(out, /btn btn-soft block" data-act="acct-in-add"[^>]*>Already have clubs\? Sign in with a passkey</);
  assert.ok(!/btn-ink/.test(out) && !/class="or"/.test(out));
});

test('signed-in phones get the restore button; no passkeys means no row', () => {
  const out = acctBlock({ in: true, missing: [{ code: 'A' }, { code: 'B' }] });
  assert.match(out, /Signed in as <b>Ana<\/b>/);
  assert.match(out, /data-act="acct-restore-add"[^>]*>Bring my clubs to this phone \(2\)</);
  assert.equal(acctBlock({ passkeys: false }), '');
});
