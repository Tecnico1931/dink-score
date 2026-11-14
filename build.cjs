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
<style>
:root { color-scheme: light; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
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

fs.writeFileSync(path.join(__dirname, 'index.html'), head + body + tail);
console.log('Wrote index.html from', path.basename(src));

// Vercel serves the static site from public/ (the /api folder is deployed as server functions).
const out = path.join(__dirname, 'public');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
for (const f of ['index.html', 'manifest.webmanifest', 'sw.js']) fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
for (const f of fs.readdirSync(path.join(__dirname, 'icons'))) fs.copyFileSync(path.join(__dirname, 'icons', f), path.join(out, 'icons', f));
console.log('Copied the site into public/');
