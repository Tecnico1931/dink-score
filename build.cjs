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

// The same for the scoring rules (the `PB` block): pb-engine.js, which the server imports through api/_pb.js.
{
  const eng = fs.readFileSync(path.join(__dirname, 'pb-engine.js'), 'utf8');
  const exp = eng.match(/^export \{ (.+) \};\s*$/m);
  if (!exp) throw new Error('pb-engine.js needs one "export { ... };" line');
  const code = eng.replace(exp[0], '').replace(/^\/\/ The one pickleball[\s\S]*?keep it one line\.\n/, '').trimEnd().replace(/^(?=.)/gm, '  ');
  const pb = `/*PB-START*/\n// Generated from pb-engine.js by build.cjs: edit that file, not this block.\nconst PB = (() => {\n${code}\n  return { ${exp[1]} };\n})();\n/*PB-END*/`;
  const i = body.indexOf('/*PB-START*/'), j = body.indexOf('/*PB-END*/');
  if (i < 0 || j < i) throw new Error('Missing PB-START/END in ' + path.basename(src));
  const next = body.slice(0, i) + pb + body.slice(j + '/*PB-END*/'.length);
  if (next !== body) { body = next; fs.writeFileSync(src, body); console.log('Updated the PB block in', path.basename(src), 'from pb-engine.js'); }
}

// The app's own script is split into src/app/<name>.js (X9), listed in order in src/app/manifest (one name per line, # comments).
// A module with a MODULE-START:<name>/MODULE-END:<name> block in the source page is pasted there, byte for byte, so dink-score.html stays
// one self-contained file the tests can load: edit the module file, not the block. Those marker lines are stripped when building index.html,
// so a pure move leaves the shipped page and its CSP hash unchanged. A module without a block is not in the page; it is emitted, in manifest
// order, at the /*@APP*/ line of the main script, in index.html only.
let app = '';
{
  const dir = path.join(__dirname, 'src', 'app');
  const names = fs.readFileSync(path.join(dir, 'manifest'), 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  const files = fs.readdirSync(dir).filter(n => n.endsWith('.js')).map(n => n.slice(0, -3)).sort();
  if (new Set(names).size !== names.length || names.slice().sort().join() !== files.join()) throw new Error('src/app/manifest and the src/app/*.js files must list the same modules, once each');
  let next = body, at = -1, loose = '';
  for (const name of names) {
    const a = `/*MODULE-START:${name}*/`, z = `/*MODULE-END:${name}*/`, code = fs.readFileSync(path.join(dir, name + '.js'), 'utf8');
    const i = next.indexOf(a), j = next.indexOf(z);
    if (i < 0 && j < 0) { loose += code; continue; }
    if (i < 0 || j < i) throw new Error(`Missing ${a} ... ${z} in ${path.basename(src)}`);
    if (i < at) throw new Error(`src/app/manifest lists ${name} out of the order of the page`);
    at = i;
    next = next.slice(0, i + a.length) + '\n' + code + next.slice(j);
  }
  if (next !== body) { body = next; fs.writeFileSync(src, body); console.log('Updated module blocks in', path.basename(src), 'from src/app/'); }
  if (body.split('/*@APP*/\n').length !== 2) throw new Error('The main script of ' + path.basename(src) + ' needs exactly one /*@APP*/ line');
  app = body.replace('/*@APP*/\n', () => loose).replace(/^\/\*MODULE-(?:START|END):[^*\n]+\*\/\n/gm, '');
}

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Pickleball scorekeeper with server tracking, saved players, a Dink Rating leaderboard and a game record.">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F2F4F7">
<script>(function(){try{var d=JSON.parse(localStorage.getItem('pb.display')||'{}')||{};var r=document.documentElement;var t=d.theme==='light'||d.theme==='dark'?d.theme:'';if(t)r.setAttribute('data-theme',t);var P={green:['#F2F4F7','#0A0F17'],blue:['#F1F4F9','#090E18'],clay:['#F6F3F0','#120C0B'],violet:['#F4F2F8','#0D0A14'],sunset:['#F7F4EF','#120E0A'],slate:['#F3F4F6','#0A0C10']};var p=P[d.palette]?d.palette:'green';if(p!=='green')r.setAttribute('data-palette',p);if(d.outdoor)r.setAttribute('data-outdoor','');if(d.large)r.setAttribute('data-large','');var dk=d.outdoor?false:(t?t==='dark':!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches));var cs=document.querySelector('meta[name=color-scheme]');if(cs)cs.content=d.outdoor?'light':(t||'light dark');var tc=document.querySelector('meta[name=theme-color]');if(tc)tc.content=d.outdoor?'#000000':P[p][dk?1:0];}catch(e){}})();</script>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Dink Score">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<script src="/analytics.js"></script>
<script defer src="/_vercel/insights/script.js"></script>
<style>
:root { color-scheme: light dark; }
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

const html = head + app + tail;
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
for (const f of ['index.html', 'b.html', 'l.html', 'r.css', 'r.js', 'manifest.webmanifest', 'sw.js', 'analytics.js', 'dupr-export.js', 'sheet-import.js', 'scan.js', 'jsqr.js', 'privacy.html', 'terms.html', 'legal.css']) fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
for (const f of fs.readdirSync(path.join(__dirname, 'icons'))) fs.copyFileSync(path.join(__dirname, 'icons', f), path.join(out, 'icons', f));
for (const d of ['fonts', '.well-known']) {
  fs.mkdirSync(path.join(out, d), { recursive: true });
  for (const f of fs.readdirSync(path.join(__dirname, d))) fs.copyFileSync(path.join(__dirname, d, f), path.join(out, d, f));
}
console.log('Copied the site into public/');
