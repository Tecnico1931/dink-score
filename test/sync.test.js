// Sync v2: ETags, 304s and the scoping that keeps one club's tag from matching another's (api/_sync.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tagOf, sameTag, notModified, replyTagged, SYNC_V } from '../api/_sync.js';

const fakeRes = () => {
  const r = { statusCode: 0, headers: {}, body: undefined, setHeader(k, v) { r.headers[k.toLowerCase()] = v; }, end(t) { r.body = t; } };
  return r;
};
const reqWith = tag => ({ headers: tag ? { 'if-none-match': tag } : {} });

test('tags are weak, stable, and depend on scope, content and version', () => {
  const a = tagOf('CLUBA1', '{"games":[]}');
  assert.match(a, /^W\/"[A-Za-z0-9_-]{24}"$/);
  assert.equal(a, tagOf('CLUBA1', '{"games":[]}'));
  assert.notEqual(a, tagOf('CLUBB2', '{"games":[]}'), 'the same body in another club must not share a tag');
  assert.notEqual(a, tagOf('CLUBA1', '{"games":[1]}'));
  assert.equal(typeof SYNC_V, 'number');
});

test('sameTag matches only the exact tag, among several', () => {
  const t = tagOf('X', 'y');
  assert.equal(sameTag(reqWith(t), t), true);
  assert.equal(sameTag(reqWith('W/"zzz", ' + t), t), true);
  assert.equal(sameTag(reqWith('W/"zzz"'), t), false);
  assert.equal(sameTag(reqWith(''), t), false);
  assert.equal(sameTag({}, t), false);
  assert.equal(sameTag(reqWith('*'), t), false, '* is never treated as a match: a poller must hold the real tag');
});

test('a caller with no tag gets the full answer, never cached, with an ETag', () => {
  const res = fakeRes();
  replyTagged(reqWith(), res, 'CLUBA1', { games: [1, 2] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '{"games":[1,2]}');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers.etag, tagOf('CLUBA1', res.body));
});

test('the held tag gets an empty 304; a stale or foreign tag gets the answer', () => {
  const first = fakeRes();
  replyTagged(reqWith(), first, 'CLUBA1', { n: 1 });
  const again = fakeRes();
  replyTagged(reqWith(first.headers.etag), again, 'CLUBA1', { n: 1 });
  assert.equal(again.statusCode, 304);
  assert.equal(again.body, undefined);
  assert.equal(again.headers['cache-control'], 'no-store');
  const changed = fakeRes();
  replyTagged(reqWith(first.headers.etag), changed, 'CLUBA1', { n: 2 });
  assert.equal(changed.statusCode, 200);
  const foreign = fakeRes();
  replyTagged(reqWith(first.headers.etag), foreign, 'CLUBB2', { n: 1 });
  assert.equal(foreign.statusCode, 200, "club A's tag must not unlock club B's identical answer");
});

test('notModified can allow a private browser cache (avatars)', () => {
  const res = fakeRes();
  notModified(res, 'W/"t"', 'private, no-cache');
  assert.equal(res.statusCode, 304);
  assert.equal(res.headers['cache-control'], 'private, no-cache');
});
