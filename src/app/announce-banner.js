/* ---------- club announcement banner on the Play home screen (the organizer's pinned note, api/_clubinfo.js) ---------- */
// The dismissed message is remembered on this phone only, as a hash of its text: a changed message hashes differently and shows again.
/*ANNOUNCE-START*/
const Announce = {
  key: 'pb.announceDismissed',
  // FNV-1a over the NFC text, 8 hex digits: enough to tell one note from the next, not a security hash.
  hash(text) {
    let h = 0x811c9dc5;
    for (const c of String(text == null ? '' : text).normalize('NFC')) {
      h ^= c.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  },
  // Show a non-empty note unless this phone dismissed exactly this text.
  shown(note, dismissed) {
    const t = String(note == null ? '' : note).trim();
    return !!t && Announce.hash(t) !== dismissed;
  }
};
/*ANNOUNCE-END*/

function announceBannerHTML() {
  if (!club) return '';
  const note = String(club.note || '').trim();
  if (!Announce.shown(note, store.get(Announce.key, ''))) return '';
  return `<section class="ann-banner" id="ann-banner" aria-label="Club announcement"><p>${esc(note)}</p><button type="button" class="ann-x" data-act="announce-dismiss" aria-label="Dismiss announcement"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></section>`;
}

function announceDismiss() {
  if (club) store.set(Announce.key, Announce.hash(String(club.note || '').trim()));
  render();
  announce('Announcement dismissed');
  const h = document.querySelector('.top h1');
  if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
}
