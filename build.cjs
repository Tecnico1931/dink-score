// Builds the GitHub Pages site (index.html) from the app source (dink-score.html).
// dink-score.html is written as an artifact page body: it has no <!doctype>, <head> or <body> of its own.
// This wraps it in a full document and adds what an installable web app needs.
// Usage: node build.cjs [path/to/dink-score.html]
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || path.join(__dirname, 'dink-score.html');
const body = fs.readFileSync(src, 'utf8');

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Pickleball scorekeeper with server tracking, saved players, a Dink Rating leaderboard and a game record.">
<meta name="theme-color" content="#0F241E">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Dink Score">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<script>window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };</script>
<script defer src="/_vercel/insights/script.js"></script>
<style>
:root { color-scheme: light; }
body { margin: 0; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
</head>
<body>
`;

const tail = `
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
</script>
</body>
</html>
`;

const html = head + body + tail;
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('Wrote index.html from', path.basename(src));

// The public bracket page (/b/<token>): bracket-public.html with the shared pieces of the app source dropped in,
// so the app and the public page draw brackets from the same code and the same colours.
const between = (text, a, b) => { const i = text.indexOf(a), j = text.indexOf(b); if (i < 0 || j < i) throw new Error(`Missing ${a} ... ${b} in ${path.basename(src)}`); return text.slice(i + a.length, j); };
const pub = fs.readFileSync(path.join(__dirname, 'bracket-public.html'), 'utf8')
  .replace('/*@TOKENS*/', () => between(body, '/*TOKENS-START*/', '/*TOKENS-END*/'))
  .replace('/*@BRACKET-CSS*/', () => between(body, '/*BRACKET-CSS-START*/', '/*BRACKET-CSS-END*/'))
  .replace('/*@BRACKETVIEW*/', () => between(body, '/*BRACKETVIEW-START*/', '/*BRACKETVIEW-END*/'));
fs.writeFileSync(path.join(__dirname, 'b.html'), pub);
console.log('Wrote b.html from bracket-public.html');

// Security headers for every response, written to vercel.json (commit it: Vercel reads it before the build runs).
// The Content-Security-Policy only runs the page's own inline scripts, matched by hash, so an injected <script> or
// onclick="..." can't run. The hashes change whenever a script changes, which is why this file is rebuilt every time.
const crypto = require('crypto');
const hashes = [...(html + pub).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
const csp = [
  "default-src 'self'",
  `script-src 'self' ${hashes.join(' ')}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // the app uses inline styles throughout
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",                                    // photo avatars (data:) and the photo picker (blob:)
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com", // the service worker caches the fonts
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
const vercel = {
  // /b/<token> is the public bracket page: the same shell for every token, which then asks /api/bracket for the data.
  rewrites: [{ source: '/b/:token', destination: '/b.html' }],
  headers: [{
    source: '/b/(.*)',
    headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }, { key: 'Cache-Control', value: 'no-store' }]
  }, {
    source: '/(.*)',
    headers: [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' }
    ]
  }]
};
fs.writeFileSync(path.join(__dirname, 'vercel.json'), JSON.stringify(vercel, null, 2) + '\n');
console.log(`Wrote vercel.json (${hashes.length} inline scripts allowed by hash)`);

// Vercel serves the static site from public/ (the /api folder is deployed as server functions).
const out = path.join(__dirname, 'public');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
for (const f of ['index.html', 'b.html', 'manifest.webmanifest', 'sw.js']) fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
for (const f of fs.readdirSync(path.join(__dirname, 'icons'))) fs.copyFileSync(path.join(__dirname, 'icons', f), path.join(out, 'icons', f));
console.log('Copied the site into public/');
