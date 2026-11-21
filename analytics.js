// Vercel Web Analytics, first-party and cookie-less: the queue stub plus the privacy filter, loaded before
// /_vercel/insights/script.js (Vercel serves that script and its beacon from this same origin; the CSP allows no other host).
// Plain script, no module and no globals beyond window.va/vaq and window.dinkAnalytics (the tests run this file in a sandbox).
//
// Only page views are sent, and only with a masked address: no query string, no #fragment and no share token.
// /b/<token>, /l/<token> and /r/<token> become /b/[token], /l/[token] and /r/[token]; anything not listed becomes /.
// A browser that sends Do Not Track or Global Privacy Control sends nothing at all.
(function (w) {
  var PAGES = { privacy: 1, terms: 1 }, SHARED = { b: 1, l: 1, r: 1 };

  function scrubUrl(raw, base) {
    var u;
    try { u = new URL(raw, base); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    var seg = u.pathname.split('/').filter(Boolean), first = seg[0] || '', path = '/';
    if (SHARED[first]) path = '/' + first + (seg.length > 1 ? '/[token]' : '');
    else if (PAGES[first]) path = '/' + first;
    return u.origin + path;
  }

  function optedOut(nav, win) {
    nav = nav || {}; win = win || {};
    return nav.doNotTrack === '1' || win.doNotTrack === '1' || nav.msDoNotTrack === '1' || nav.globalPrivacyControl === true;
  }

  // Returns the event to send, or null to send nothing.
  function beforeSend(e, nav, win, base) {
    if (!e || e.type !== 'pageview' || optedOut(nav, win)) return null;
    var url = scrubUrl(e.url, base);
    return url ? { type: 'pageview', url: url } : null;
  }

  w.dinkAnalytics = { scrubUrl: scrubUrl, optedOut: optedOut, beforeSend: beforeSend };
  if (!w.va) w.va = function () { (w.vaq = w.vaq || []).push(arguments); };
  try {
    w.va('beforeSend', function (e) { return beforeSend(e, w.navigator, w, w.location && w.location.href); });
  } catch (e) { /* analytics must never break the page */ }
})(typeof window !== 'undefined' ? window : this);
