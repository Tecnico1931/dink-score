// CI guard: when files that ship to phones changed against the base ref, sw.js VERSION must differ from the base.
//   node tools/check-version.mjs origin/main
import { execSync } from 'node:child_process';
const base = process.argv[2] || 'origin/main';
const sh = c => execSync(c, { encoding: 'utf8' });
const SHIPPED = /^(dink-score\.html|index\.html|b\.html|bracket-public\.html|dupr-export\.js|sheet-import\.js|scan\.js|jsqr\.js|manifest\.webmanifest|icons\/|public\/)/;
const changed = sh(`git diff --name-only ${base}...HEAD`).split('\n').filter(f => SHIPPED.test(f));
if (!changed.length) { console.log('No shipped files changed; VERSION check not needed.'); process.exit(0); }
const ver = t => (t.match(/const VERSION = '([^']+)'/) || [])[1];
const was = ver(sh(`git show ${base}:sw.js`)), now = ver(sh('cat sw.js'));
if (was === now) { console.error(`Shipped files changed (${changed.join(', ')}) but sw.js VERSION is still ${now}. Bump it so phones refresh.`); process.exit(1); }
console.log(`sw.js VERSION ${was} -> ${now}`);
