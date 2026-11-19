// Builds the GitHub Pages site (index.html) from the app source (dink-score.html).
// dink-score.html is written as an artifact page body: it has no <!doctype>, <head> or <body> of its own.
// This wraps it in a full document and adds what an installable web app needs.
// Usage: node build.cjs [path/to/dink-score.html]
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || path.join(__dirname, 'dink-score.html');
let body = fs.readFileSync(src, 'utf8');

// The app's Dink Rating engine (the `DR` block) is rating-engine.js, the same file the server imports (api/_rating.js).
// Paste it between RATING-START/END in the source page, so dink-score.html stays one self-contained file the tests can load.
{
  const eng = fs.readFileSync(path.join(__dirname, 'rating-engine.js'), 'utf8');
  const exp = eng.match(/^export \{ (.+) \};\s*$/m);
  if (!exp) throw new Error('rating-engine.js needs one "export { ... };" line');
  const code = eng.replace(exp[0], '').replace(/^\/\/ The one Dink Rating[\s\S]*?keep it one line\.\n/, '').trimEnd().replace(/^(?=.)/gm, '  ');
  const dr = `/*RATING-START*/\n// Generated from rating-engine.js by build.cjs: edit that file, not this block.\nconst DR = (() => {\n${code}\n  return { ${exp[1]} };\n})();\n/*RATING-END*/`;
  const i = body.indexOf('/*RATING-START*/'), j = body.indexOf('/*RATING-END*/');
  if (i < 0 || j < i) throw new Error('Missing RATING-START/END in ' + path.basename(src));
  const next = body.slice(0, i) + dr + body.slice(j + '/*RATING-END*/'.length);
  if (next !== body) { body = next; fs.writeFileSync(src, body); console.log('Updated the DR block in', path.basename(src), 'from rating-engine.js'); }
}

// The app's own script is split into src/app/<name>.js (X9). Each file is pasted between MODULE-START:<name>/MODULE-END:<name> in the
// source page, byte for byte, so dink-score.html stays one self-contained file the tests can load. Edit the module file, not the block.
{
  const dir = path.join(__dirname, 'src', 'app');
  let next = body;
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js')).sort()) {
    const name = f.slice(0, -3), a = `/*MODULE-START:${name}*/`, z = `/*MODULE-END:${name}*/`;
    const i = next.indexOf(a), j = next.indexOf(z);
    if (i < 0 || j < i) throw new Error(`Missing ${a} ... ${z} in ${path.basename(src)}`);
    next = next.slice(0, i + a.length) + '\n' + fs.readFileSync(path.join(dir, f), 'utf8') + next.slice(j);
  }
  if (next !== body) { body = next; fs.writeFileSync(src, body); console.log('Updated module blocks in', path.basename(src), 'from src/app/'); }
}

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
  // A new service worker takes over at once; reload so the page and its files come from the same version, but not
  // while a game is open or someone is typing (that waits until the page is put away). Games in progress are saved, so a reload keeps them.
  const had = !!navigator.serviceWorker.controller; let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had || reloading) return;
    const go = () => { reloading = true; location.reload(); };
    let busy = false; try { busy = !!(live && live.open) || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName); } catch (e) {}
    if (!busy) go(); else document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') go(); }, { once: true });
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
  });
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

// The public league and ladder page (/l/<token>): league-public.html with the shared colour tokens.
const lpub = fs.readFileSync(path.join(__dirname, 'league-public.html'), 'utf8')
  .replace('/*@TOKENS*/', () => between(body, '/*TOKENS-START*/', '/*TOKENS-END*/'));
fs.writeFileSync(path.join(__dirname, 'l.html'), lpub);
console.log('Wrote l.html from league-public.html');

// The public result page (/r/<token>) is built by api/_resultpublic.js; its stylesheet and chart script get the same shared pieces.
// They are external files, so the page needs no inline script and no CSP hash.
fs.writeFileSync(path.join(__dirname, 'r.css'), fs.readFileSync(path.join(__dirname, 'result-public.css'), 'utf8')
  .replace('/*@TOKENS*/', () => between(body, '/*TOKENS-START*/', '/*TOKENS-END*/'))
  .replace('/*@REPLAYCHART-CSS*/', () => between(body, '/*REPLAYCHART-CSS-START*/', '/*REPLAYCHART-CSS-END*/')));
fs.writeFileSync(path.join(__dirname, 'r.js'), fs.readFileSync(path.join(__dirname, 'result-view.js'), 'utf8')
  .replace('/*@REPLAYCHART*/', () => between(body, '/*REPLAYCHART-START*/', '/*REPLAYCHART-END*/')));
console.log('Wrote r.css and r.js');

// Security headers for every response, written to vercel.json (commit it: Vercel reads it before the build runs).
// The Content-Security-Policy only runs the page's own inline scripts, matched by hash, so an injected <script> or
// onclick="..." can't run. The hashes change whenever a script changes, which is why this file is rebuilt every time.
const crypto = require('crypto');
const hashes = [...(html + pub + lpub).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
const csp = [
  "default-src 'self'",
  `script-src 'self' ${hashes.join(' ')}`,
  "style-src 'self' 'unsafe-inline'",                              // the app uses inline styles throughout
  "font-src 'self'",                                               // fonts are self-hosted in /fonts
  "img-src 'self' data: blob: https:",                             // photo avatars (data:), the photo picker (blob:), and imported team logos (any https image: the viewer's browser contacts the logo's website)
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-src https://dashboard.dupr.com https://uat.dupr.gg",       // DUPR's login iframe (Connect DUPR); nothing else may be framed
  "frame-ancestors 'none'"
].join('; ');
const vercel = {
  // /b/<token> is the public bracket page: the same shell for every token, which then asks /api/bracket for the data.
  // /r/<token> is a shared result: api/_resultpublic.js (via api/bracket.js) renders the page (with preview tags) and the card image.
  rewrites: [{ source: '/b/:token', destination: '/b.html' }, { source: '/l/:token', destination: '/l.html' }, { source: '/r/:token/card.png', destination: '/api/bracket?result=1&token=:token&fmt=png' }, { source: '/r/:token', destination: '/api/bracket?result=1&token=:token&fmt=html' }, { source: '/privacy', destination: '/privacy.html' }, { source: '/terms', destination: '/terms.html' }],
  headers: [{
    source: '/(b|l)/(.*)',
    headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }, { key: 'Cache-Control', value: 'no-store' }]
  }, {
    source: '/(.*)',
    headers: [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()' }
    ]
  }]
};
fs.writeFileSync(path.join(__dirname, 'vercel.json'), JSON.stringify(vercel, null, 2) + '\n');
console.log(`Wrote vercel.json (${hashes.length} inline scripts allowed by hash)`);

// Vercel serves the static site from public/ (the /api folder is deployed as server functions).
const out = path.join(__dirname, 'public');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
for (const f of ['index.html', 'b.html', 'l.html', 'r.css', 'r.js', 'manifest.webmanifest', 'sw.js', 'dupr-export.js', 'sheet-import.js', 'scan.js', 'jsqr.js', 'privacy.html', 'terms.html', 'legal.css']) fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
for (const f of fs.readdirSync(path.join(__dirname, 'icons'))) fs.copyFileSync(path.join(__dirname, 'icons', f), path.join(out, 'icons', f));
for (const d of ['fonts', '.well-known']) {
  fs.mkdirSync(path.join(out, d), { recursive: true });
  for (const f of fs.readdirSync(path.join(__dirname, d))) fs.copyFileSync(path.join(__dirname, d, f), path.join(out, d, f));
}
console.log('Copied the site into public/');
