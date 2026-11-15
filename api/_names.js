// Player and club names: no control or invisible formatting characters and no '|', collapsed spaces, at most 40 characters.
// Built from character codes so no invisible characters live in this file: control characters, zero-width and
// direction marks, line and paragraph separators, the byte-order mark, and the '|' character.
// Lives apart from _db.js so code that never touches the database (event scheduling and its tests) can use it.
const NAME_JUNK = new RegExp('[' + [[0x00, 0x1F], [0x7F, 0x9F], [0x200B, 0x200F], [0x2028, 0x202E], [0x2060, 0x206F], [0xFEFF, 0xFEFF]]
  .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + '|]', 'g');
export const cleanName = n => String(n || '').replace(/\s/g, ' ').replace(NAME_JUNK, '').trim().replace(/\s+/g, ' ').slice(0, 40);
