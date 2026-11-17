// What organizers can post for their members: a "how to pay" link (dues or court fees; the app never handles money)
// and a pinned note. Both are optional; an empty value clears them. Pure functions, used by api/club.js.
export const MAX_LINK = 300;
export const MAX_NOTE = 500;

// An https address, nothing else: no javascript:, http:, data: or mailto: links, no user:password@ part.
export function cleanPayLink(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (s.length > MAX_LINK) throw new Error(`The link is too long (at most ${MAX_LINK} characters).`);
  if (/[\s<>"']/.test(s)) throw new Error('The link cannot contain spaces or quotes.');
  let u;
  try { u = new URL(s); } catch { throw new Error('Enter a full web address, starting with https://'); }
  if (u.protocol !== 'https:') throw new Error('The link must start with https://');
  if (u.username || u.password) throw new Error('The link cannot contain a name or password.');
  if (!u.hostname || !u.hostname.includes('.')) throw new Error('Enter a full web address, like https://example.com/pay');
  return u.href;
}

// Plain text, up to MAX_NOTE characters, line breaks kept (at most 3 in a row). Control characters are dropped.
export function cleanNote(v) {
  const s = String(v == null ? '' : v).normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
  if (s.length > MAX_NOTE) throw new Error(`The note is too long (at most ${MAX_NOTE} characters).`);
  return s;
}
