import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The outbox rules live inline in dink-score.html; load just that block.
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const block = src.match(/\/\*OUTBOX-START\*\/([\s\S]*?)\/\*OUTBOX-END\*\//);
assert.ok(block, 'the OUTBOX block is missing from dink-score.html');
const Outbox = new Function(block[1] + '\nreturn Outbox;')();

const game = id => ({ id, teams: [['Ana'], ['Bo']], score: [11, 5], endedAt: 1 });
const err = (status, message) => Object.assign(new Error(message), { status });

// The app's flush loop in miniature: same decisions, with a fake server.
async function flush(outbox, send) {
  let op;
  while ((op = outbox.find(o => !o.failed))) {
    try { await send(op); outbox.splice(outbox.indexOf(op), 1); }
    catch (e) { if (Outbox.waits(e, op)) break; Outbox.fail(op, e, 1000); }
  }
}

test('a 400 keeps the game, marked, and the queue carries on', async () => {
  const outbox = [{ type: 'game', code: 'ABC123', game: game('g1') }, { type: 'game', code: 'ABC123', game: game('g2') }];
  await flush(outbox, async op => { if (op.game.id === 'g1') throw err(400, 'Too many games.'); });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].game.id, 'g1');
  assert.equal(outbox[0].failed.status, 400);
  assert.equal(outbox[0].failed.message, 'Too many games.');
  assert.ok(outbox[0].uid);
  assert.equal(Outbox.active(outbox, 'ABC123').length, 0);
  assert.equal(Outbox.failed(outbox, 'ABC123').length, 1);
  assert.equal(Outbox.failed(outbox, 'ZZZZZZ').length, 0);
});

test('a 409 on an event result is kept too', async () => {
  const outbox = [{ type: 'event-result', code: 'ABC123', eventId: 'e1', matchId: 'm1', score: [11, 3] }];
  await flush(outbox, async () => { throw err(409, 'That match has already been played.'); });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].failed.status, 409);
});

test('offline, server errors and rate limits wait instead of failing', async () => {
  for (const e of [Object.assign(new Error('x'), { offline: true }), err(500, 'x'), err(503, 'x'), err(429, 'x')]) {
    const outbox = [{ type: 'game', code: 'ABC123', game: game('g1') }];
    await flush(outbox, async () => { throw e; });
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].failed, undefined);
  }
  // a 429 on a PIN-guarded change is the PIN lockout: that one is refused, not waited on
  const del = [{ type: 'delete', code: 'ABC123', id: 'g1' }];
  await flush(del, async () => { throw err(429, 'Too many PIN tries.'); });
  assert.ok(del[0].failed);
});

test('retry puts a refused change back in the queue and it can then succeed', async () => {
  const outbox = [{ type: 'game', code: 'ABC123', game: game('g1') }];
  await flush(outbox, async () => { throw err(400, 'no'); });
  Outbox.retry(outbox[0]);
  const sent = [];
  await flush(outbox, async op => { sent.push(op.game.id); });
  assert.deepEqual(sent, ['g1']);
  assert.equal(outbox.length, 0);
});

test('fixing the score re-queues a game; bad scores are refused and change nothing', () => {
  const op = Outbox.fail({ type: 'game', code: 'ABC123', game: game('g1') }, err(400, 'Scores must be whole numbers.'), 5);
  assert.equal(Outbox.rescore(op, '-1', '5'), false);
  assert.equal(Outbox.rescore(op, '1.5', '5'), false);
  assert.equal(Outbox.rescore(op, '', 'x'), false);
  assert.ok(op.failed);
  assert.deepEqual(op.game.score, [11, 5]);
  assert.equal(Outbox.rescore(op, '11', '9'), true);
  assert.deepEqual(op.game.score, [11, 9]);
  assert.equal(op.failed, undefined);
  assert.equal(Outbox.rescore({ type: 'delete', id: 'x' }, 1, 2), false);
});

test('the export holds the refused games but never a PIN or owner token', () => {
  const op = Outbox.fail({ type: 'edit', code: 'ABC123', game: game('g1'), pin: '1234', ownerToken: 'secret' }, err(403, 'Wrong PIN.'), 5);
  const out = Outbox.exportJson([op], 'ABC123');
  assert.ok(!out.includes('1234') && !out.includes('secret'));
  const j = JSON.parse(out);
  assert.equal(j.club, 'ABC123');
  assert.equal(j.changes[0].game.id, 'g1');
  assert.equal(j.changes[0].failed.status, 403);
});
