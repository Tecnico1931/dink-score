// Player and club names: no control or invisible formatting characters and no '|', collapsed spaces, Unicode NFC, at most 40 characters.
// Built from character codes so no invisible characters live in this file: control characters, zero-width and
// direction marks, line and paragraph separators, the byte-order mark, and the '|' character.
// Lives apart from _db.js so code that never touches the database (event scheduling and its tests) can use it.
const NAME_JUNK = new RegExp('[' + [[0x00, 0x1F], [0x7F, 0x9F], [0x200B, 0x200F], [0x2028, 0x202E], [0x2060, 0x206F], [0xFEFF, 0xFEFF]]
  .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + '|]', 'g');
// NFC makes "e" + combining accent and the single accented letter the same name (phones and keyboards differ).
export const cleanName = n => String(n || '').replace(/\s/g, ' ').replace(NAME_JUNK, '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 40);
// The key a player is stored and matched under: the cleaned name, lower case. Same rule in the app (nameKey in dink-score.html).
export const nameKey = n => cleanName(n).toLowerCase();

// "Jose" vs "José", "Mary-Ann" vs "Mary Ann": the name with accents, case, spaces and punctuation taken away.
export const looseKey = n => cleanName(n).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function within1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}
// Saved names that are probably the same person as `name` but are not the same key: differ only by accents, spacing or
// punctuation, or by one letter in a name of 5 or more letters ("Jonathon" / "Jonathan"). Used for the "did you mean" prompt.
export function similarNames(name, existing) {
  const k = nameKey(name), loose = looseKey(name);
  if (!loose) return [];
  return existing.filter(e => {
    if (nameKey(e) === k) return false;
    const l = looseKey(e);
    return l === loose || (l.length >= 5 && loose.length >= 5 && within1(l, loose));
  });
}
