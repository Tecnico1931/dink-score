// Paddle tracker (L14): allow-list and limits (same photo rules as avatars), privacy isolation, and the client's record per paddle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanPaddles, cleanPaddlePhoto, countPaddlePhotos, paddlePhotoRoom, MAX_PADDLES, MAX_PHOTO, MAX_USED, MAX_PHOTO_COUNT } from '../api/_paddles.js';
import { MAX_PHOTOS } from '../api/_db.js';
import { module } from './helpers/app.js';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const photo = n => 'data:image/jpeg;base64,' + 'A'.repeat(n);
const bad = (fn) => assert.throws(fn, e => e.status === 400);

test('photo rules are the avatar rules: JPEG or WebP data URL, at most the same size, club cap pinned to MAX_PHOTOS', () => {
  const players = read('api/players.js');
  assert.equal(MAX_PHOTO, Number(players.match(/const MAX_PHOTO = (\d+)/)[1]));
  assert.equal(MAX_PHOTO_COUNT, MAX_PHOTOS);
  assert.equal(cleanPaddlePhoto(photo(100)), photo(100));
  assert.ok(cleanPaddlePhoto('data:image/webp;base64,AAAA'));
  for (const v of ['', null, 'data:image/png;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'https://x.test/a.jpg', 'data:image/jpeg;base64,AA AA', 'javascript:alert(1)']) bad(() => cleanPaddlePhoto(v));
  bad(() => cleanPaddlePhoto(photo(MAX_PHOTO)));
});

test('cleanPaddles keeps only the allowed shape and drops tags for paddles that no longer exist', () => {
  const doc = cleanPaddles({ list: [{ id: 'ab12', name: '  Selkirk   Vanguard ', photo: photo(50), extra: 'x' }, { id: 'cd34', name: 'Joola' }],
    used: { g1234: 'ab12', g5678: 'cd34', g9999: 'gone1', 'bad id': 'ab12' } });
  assert.deepEqual(doc, { list: [{ id: 'ab12', name: 'Selkirk Vanguard', photo: photo(50) }, { id: 'cd34', name: 'Joola' }], used: { g1234: 'ab12', g5678: 'cd34' } });
  assert.deepEqual(cleanPaddles(null), { list: [], used: {} });
  assert.deepEqual(cleanPaddles({ list: [{ id: 'ab12', name: 'A<b>' }] }).list[0].name, 'A b');
});

test('cleanPaddles enforces limits', () => {
  const p = i => ({ id: 'p' + String(i).padStart(3, '0'), name: 'P' + i });
  assert.equal(cleanPaddles({ list: Array.from({ length: MAX_PADDLES }, (_, i) => p(i)) }).list.length, MAX_PADDLES);
  bad(() => cleanPaddles({ list: Array.from({ length: MAX_PADDLES + 1 }, (_, i) => p(i)) }));
  bad(() => cleanPaddles({ list: [{ id: 'ab12', name: '' }] }));
  bad(() => cleanPaddles({ list: [{ id: 'ab12', name: 'x'.repeat(41) }] }));
  bad(() => cleanPaddles({ list: [{ id: 'AB', name: 'x' }] }));
  bad(() => cleanPaddles({ list: [{ id: 'ab12', name: 'a' }, { id: 'ab12', name: 'b' }] }));
  bad(() => cleanPaddles({ list: [{ id: 'ab12', name: 'a', photo: 'data:image/png;base64,AAAA' }] }));
  const used = Object.fromEntries(Array.from({ length: MAX_USED + 1 }, (_, i) => ['game' + i, 'ab12']));
  bad(() => cleanPaddles({ list: [{ id: 'ab12', name: 'a' }], used }));
});

test('the club photo cap counts other players, and replacing or keeping your own is always fine', () => {
  const one = { list: [{ id: 'ab12', name: 'a', photo: photo(5) }] }, none = { list: [{ id: 'ab12', name: 'a' }] };
  assert.equal(countPaddlePhotos(one), 1);
  assert.equal(countPaddlePhotos(null), 0);
  assert.equal(paddlePhotoRoom(MAX_PHOTO_COUNT - 1, none, one), true);
  assert.equal(paddlePhotoRoom(MAX_PHOTO_COUNT, none, one), false);
  assert.equal(paddlePhotoRoom(MAX_PHOTO_COUNT, one, one), true);
});

test('paddles never ride in club, public or sync payloads', () => {
  for (const f of ['api/club.js', 'api/_sync.js', 'api/_share.js', 'api/_result.js', 'api/_resultpublic.js', 'api/live.js', 'api/_clubinfo.js']) assert.ok(!/paddle/i.test(read(f)), f);
  const players = read('api/players.js');
  // Read and write need the player's own token, never an organizer's.
  const block = players.slice(players.indexOf("body.action === 'paddles-get'"), players.indexOf("if (body.action === 'dupr')"));
  assert.match(block, /requirePlayer\(/);
  assert.ok(!/requireOrganizer/.test(block));
  assert.match(read('api/_db.js'), /ADD COLUMN IF NOT EXISTS paddles jsonb/);
});

// The client's record per paddle, from the module that dink-score.html carries.
function clientModule(name, games, doc) {
  const mod = module('paddles');
  assert.equal(mod.trim(), read('src/app/paddles.js').trim(), 'run node build.cjs');
  const store = { get: (k, d) => d, set() {} };
  const club = { code: 'ABC123' };
  const body = `const store = S, club = C, myName = () => N, myToken = () => 't', sameName = (a, b) => a.toLowerCase() === b.toLowerCase(), esc = s => s, iconSvg = () => '', isMe = () => true, playerCall = async () => ({}), render = () => {}, renderProfile = () => {};\n${mod}\npaddleDocs.ABC123 = D;\nreturn { paddleTally, paddlesProfileHTML, paddlePickHTML };`;
  return new Function('S', 'C', 'N', 'D', body)(store, club, name, doc);
}

test('record with each paddle counts wins and losses from the games where it was used, for either team', () => {
  const doc = { list: [{ id: 'ab12', name: 'Vanguard' }, { id: 'cd34', name: 'Joola' }, { id: 'ef56', name: 'Unused' }], used: { g1: 'ab12', g2: 'ab12', g3: 'cd34', g4: 'ab12' } };
  const games = [
    { id: 'g1', teams: [['Ana', 'Bo'], ['Cy', 'Di']], winner: 0 },
    { id: 'g2', teams: [['Cy', 'Di'], ['ana', 'Bo']], winner: 0 },
    { id: 'g3', teams: [['Ana', 'Bo'], ['Cy', 'Di']], winner: 0 },
    { id: 'g4', teams: [['Bo', 'Cy'], ['Di', 'Ed']], winner: 1 }, // Ana was not in it
    { id: 'g5', teams: [['Ana', 'Bo'], ['Cy', 'Di']], winner: 0 } // no paddle chosen
  ];
  const { paddleTally } = clientModule('Ana', games, doc);
  const t = Object.fromEntries(paddleTally('Ana', games).map(r => [r.p.id, [r.w, r.l]]));
  assert.deepEqual(t, { ab12: [1, 1], cd34: [1, 0], ef56: [0, 0] });
});

test('the profile row and the New game picker escape nothing unsafe and use neutral colours (no team colours, no levels)', () => {
  const src = read('src/app/paddles.js');
  assert.ok(!/--blue|--green|TEAM_COLOR/.test(src));
  assert.ok(!/\b(xp|level|shop)\b/i.test(src.replace(/paddle/gi, '')));
  const { paddlesProfileHTML, paddlePickHTML } = clientModule('Ana', [], { list: [{ id: 'ab12', name: 'Vanguard', photo: photo(20) }], used: {} });
  assert.match(paddlesProfileHTML('Ana', []), /Vanguard/);
  assert.match(paddlesProfileHTML('Ana', []), /No games/);
  assert.match(paddlePickHTML(), /data-paddle-pick="ab12"/);
  assert.equal(clientModule('Ana', [], { list: [], used: {} }).paddlePickHTML(), '');
});
