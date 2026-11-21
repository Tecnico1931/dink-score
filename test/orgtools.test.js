import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('dink-score.html');
const pure = html.slice(html.indexOf('/*OT-PURE-START*/'), html.indexOf('/*OT-PURE-END*/'));
const { otItems, otPendingTotal } = new Function(pure + '; return { otItems, otPendingTotal };')();
const base = { requests: 0, held: 0, dupes: 0, nights: 0, liveEvents: 0, players: 12, undoable: 0, requireConfirmation: true, hasPin: true };
const ids = s => otItems(s).map(r => r.id);

test('rows with something waiting come first, the rest keep their listed order', () => {
  const quiet = ids(base);
  assert.deepEqual(quiet.slice(0, 3), ['requests', 'approve', 'dupes']);
  assert.ok(quiet.includes('members') && quiet.includes('nights') && quiet.includes('events') && quiet.includes('pin') && quiet.includes('history'));
  const busy = otItems({ ...base, dupes: 1, requests: 2 });
  assert.deepEqual(busy.slice(0, 2).map(r => [r.id, r.n]), [['requests', 2], ['dupes', 1]]);
  assert.deepEqual(busy.slice(2).map(r => r.id), quiet.filter(i => i !== 'requests' && i !== 'dupes'));
  assert.equal(ids({ ...base, held: 5 })[0], 'approve');
});

test('counts are clamped and hints read as plain sentences', () => {
  const r = id => otItems({ ...base, requests: 1, held: 3, dupes: -4, nights: 2, undoable: 1 }).find(x => x.id === id);
  assert.equal(r('requests').hint, '1 phone wants to link to a player');
  assert.equal(r('approve').hint, '3 games are held out of ratings until approved');
  assert.equal(r('dupes').n, 0);
  assert.equal(r('nights').hint, '2 upcoming');
  assert.equal(r('undo').hint, '1 change you can undo');
  assert.equal(otPendingTotal({ requests: 2, held: 3, dupes: 1 }), 6);
  assert.equal(otPendingTotal({ requests: 'x', held: null }), 0);
  assert.equal(otItems({ ...base, hasPin: false }).find(x => x.id === 'pin').title, 'Set an organizer PIN');
});

test('every tappable row points at a handler that already exists', () => {
  for (const row of otItems({ ...base, requests: 1 })) {
    if (!row.go) continue;
    const act = row.go.match(/data-act="([^"]+)"/);
    if (act) assert.ok(html.includes(`ds.act === '${act[1]}'`) || html.includes(`a === '${act[1]}'`) || act[1] === 'ot-events', act[1]);
    else assert.match(row.go, /^data-gn="open"/);
  }
});

test('the hub is for organizers only and adds no server function', () => {
  assert.match(html, /const otCan = \(\) => !!club && \(isCreator\(\) \|\| \(club\.hasPin && hasOrganizer\(\)\)\)/);
  assert.match(html, /c\.view === 'orgtools' && club && otCan\(\)/);
  assert.match(html, /\$\{otCan\(\) \? otEntryHTML\(\) : ''\}/);
  assert.match(read('src/app/organizer-tools.js'), /^const otCan/m);
  const entry = html.match(/function otEntryHTML[\s\S]*?\n\}\n/)[0];
  assert.ok(entry.includes('Organizer tools') && !/fetch\(|api\('/.test(html.match(/function otHTML[\s\S]*?\n\}\n/)[0]));
  assert.ok(!fs.existsSync(path.join(root, 'api/organizer.js')));
});

test('the hub reuses the approval and confirmation endpoints and colours come from tokens', () => {
  const src = read('src/app/organizer-tools.js');
  assert.ok(src.includes("action: 'members'") && src.includes('data-decide') && src.includes('confirmGame') && src.includes('keepBoth'));
  const css = html.match(/\.ot-card \{[\s\S]*?\.ot-idle \{[^}]*\}/)[0];
  assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(/i.test(css), 'hub CSS uses theme tokens only');
  assert.ok(!/\bXP\b|prestige|levelFrom|LEVEL_MAX/i.test(src));
});

test('the service worker version moved past main', () => {
  assert.match(read('sw.js'), /dink-score-v(\d+)/);
  assert.ok(Number(read('sw.js').match(/dink-score-v(\d+)/)[1]) >= 117);
});
