// Paddle tracker (L14): the paddles a player owns, an optional photo of each, and which one they used in each game. Not a route
// (files starting with "_"); the actions live in players.js. Pure, so test/paddles.test.js loads it without a database.
//
// Stored on the player's own roster row as roster.paddles = {list: [{id, name, photo?}], used: {gameId: paddleId}}. It is private to
// the phone linked to that name: never in GET /api/club, the public pages or another player's view (the roster SELECTs name their
// columns). Photos follow the avatar rules exactly: a JPEG or WebP data URL of at most 60,000 characters, and a club holds at most
// MAX_PHOTOS of them.

export const MAX_PADDLES = 6;       // paddles one player can save
export const MAX_PADDLE_NAME = 40;
export const MAX_USED = 1000;        // games remembered per player (a phone's history is capped at 1,000 too)
export const MAX_PHOTO = 60000;       // characters of base64, the same as an avatar photo (players.js)

const bad = msg => Object.assign(new Error(msg), { status: 400 });
const PHOTO = /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export function cleanPaddlePhoto(v) {
  const value = String(v || '');
  if (!PHOTO.test(value)) throw bad('That photo could not be used. Try a different picture.');
  if (value.length > MAX_PHOTO) throw bad('That photo is too large. Try a different picture.');
  return value;
}

// Validates what a phone sends and returns the safe copy to store. Only these shapes get stored, like avatars. A game's choice that
// names a paddle that is no longer in the list is dropped, so deleting a paddle removes it from the record too.
export function cleanPaddles(input) {
  const src = input && typeof input === 'object' ? input : {};
  const rawList = Array.isArray(src.list) ? src.list : [];
  if (rawList.length > MAX_PADDLES) throw bad(`You can save up to ${MAX_PADDLES} paddles.`);
  const ids = new Set();
  const list = rawList.map(p => {
    if (!p || typeof p !== 'object') throw bad('A paddle is missing.');
    const id = String(p.id || '');
    if (!/^[a-z0-9]{4,12}$/.test(id) || ids.has(id)) throw bad('A paddle has an invalid id.');
    ids.add(id);
    // Collapse whitespace and strip control characters; the app escapes it again on display.
    const name = String(p.name || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) throw bad('Give every paddle a name.');
    if (name.length > MAX_PADDLE_NAME) throw bad(`A paddle name can be up to ${MAX_PADDLE_NAME} characters.`);
    return p.photo ? { id, name, photo: cleanPaddlePhoto(p.photo) } : { id, name };
  });
  const used = {};
  const entries = src.used && typeof src.used === 'object' && !Array.isArray(src.used) ? Object.entries(src.used) : [];
  if (entries.length > MAX_USED) throw bad('Too many games are tagged with a paddle.');
  for (const [gameId, paddleId] of entries) {
    if (/^[A-Za-z0-9_-]{4,40}$/.test(gameId) && ids.has(paddleId)) used[gameId] = paddleId;
  }
  return { list, used };
}

export const countPaddlePhotos = doc => (doc && Array.isArray(doc.list) ? doc.list.filter(p => p && p.photo).length : 0);

// The club's photo cap counts every other player's paddle photos; replacing your own is always fine, and so is saving a list with no
// more photos than you already have.
export function paddlePhotoRoom(othersPhotos, mine, next) {
  return countPaddlePhotos(next) <= countPaddlePhotos(mine) || othersPhotos + countPaddlePhotos(next) <= MAX_PHOTO_COUNT;
}
export const MAX_PHOTO_COUNT = 50; // = MAX_PHOTOS in _db.js (club photo pictures); test/paddles.test.js pins them together
