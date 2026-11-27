import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// Dinks live only in the dedicated rewards modules (src/app/economy*.js, rules in DESIGN.md "Rewards"); nowhere else on the page may name them.
test('the old shop is gone and Dinks live only in the rewards modules: no old shop or Dinks API files, routes or other app copy', () => {
  for (const f of ['api/shop.js', 'api/_dinks.js']) assert.ok(!fs.existsSync(path.join(root, f)), f);
  assert.ok(!/api\/shop|dinks/i.test(read('vercel.json').replace(/dinkscore/gi, '')));
  for (const f of ['dink-score.html', 'index.html']) {
    const t = read(f).replace(read('src/app/economy.js'), '').replace(read('src/app/economypets.js'), '').replace(read('src/app/economyshop.js'), '').replace(read('src/app/economysound.js'), '').replace(read('src/app/economycelebrate.js'), '').replace(read('src/app/economypass.js'), '').replace(read('src/app/economymanage.js'), '').replace(/dinkscore/gi, '');
    assert.ok(!/\bDinks?\b(?! Rating| Score)/.test(t.replace(/Dink Rating|Dink Score/g, '')), f + ' mentions Dinks');
    assert.ok(!/data-tab="shop"|api\('shop'|spin-wheel|equippedFor/.test(t), f + ' still has shop code');
  }
});

test('the progress rules no longer pay or count Dinks', async () => {
  const m = await import('../api/_progress.js');
  const games = [{ id: 'g1', mode: 'doubles', teams: [['A', 'B'], ['C', 'D']], score: [11, 5], winner: 0, endedAt: 1e12, receivedAt: 1e12, scoredBy: 'a' }];
  for (const p of m.computeProgress(games, 2e12).values()) for (const k of ['earned', 'base', 'bonus']) assert.ok(!(k in p), k);
  assert.ok(m.ACHIEVEMENTS.every(a => !('dinks' in a)) && m.CHALLENGES.every(c => !('dinks' in c)));
});

test('no runtime API code reads or writes the legacy DB leftovers (except rename/anonymise data-rights handling on purchases)', () => {
  // The old roster.prestige column stays unused; the ledger-based prestige (api/_economyprestige.js) never touches it.
  const forbidden = /\b(purchases_club_name|total_count|equipped)\b|roster\.prestige|\bprestige jsonb|\b(SELECT|SET) prestige\b|clubs\.shop\b/;
  for (const name of fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js'))) {
    let src = read('api/' + name);
    if (name === '_db.js') {
      const stripped = src.replace(/export function ensureSchema\(\)[\s\S]*?return ready;\n\}/, '');
      assert.notEqual(stripped, src, 'ensureSchema() block should be found in api/_db.js');
      src = stripped;
    }
    const hit = src.match(forbidden);
    assert.ok(!hit, `api/${name} still references legacy DB object "${hit && hit[0]}" outside ensureSchema()`);
    // Only the two data-rights statements on `purchases` (rename/merge UPDATE and anonymise DELETE) may remain until the table is dropped.
    const withoutRights = name === '_rename.js'
      ? src.replace(/writes\.push\(sql`UPDATE purchases SET name_key = \$\{toKey\} WHERE club = \$\{code\} AND name_key = \$\{fromKey\}`\);/, '')
      : name === 'players.js'
        ? src.replace(/ops\.push\(sql`DELETE FROM purchases WHERE club = \$\{code\} AND name_key = \$\{k\}`\);/, '')
        : src;
    const noComments = withoutRights.replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\bpurchases\b/.test(noComments), `api/${name} still accesses legacy purchases outside rename/anonymise data-rights handling`);
  }
});
