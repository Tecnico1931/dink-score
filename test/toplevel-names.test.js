import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { page } from './helpers/app.js';

// Inline scripts of a page share one global scope, and a repeated top-level `function` silently replaces the
// earlier one (PR #5 and #6 both declared duprHTML, which broke the profile rating box). Fail on any repeat.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// End index (exclusive) of a template literal whose body starts at j; ${} expressions may nest strings and templates.
function skipTemplate(s, j) {
  while (j < s.length) {
    if (s[j] === '\\') j += 2;
    else if (s[j] === '`') return j + 1;
    else if (s[j] === '$' && s[j + 1] === '{') {
      let d = 1; j += 2;
      while (j < s.length && d) {
        const c = s[j];
        if (c === '`') j = skipTemplate(s, j + 1);
        else if (c === '"' || c === "'") { j++; while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1; j++; }
        else { if (c === '{') d++; else if (c === '}') d--; j++; }
      }
    } else j++;
  }
  return j;
}

// Blank out comments, strings, template literals and regexes so only structure remains.
function skeleton(s) {
  let out = '', i = 0, prev = '';
  const blank = t => t.replace(/[^\n]/g, ' ');
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    let j = i;
    if (c === '/' && n === '/') { while (j < s.length && s[j] !== '\n') j++; }
    else if (c === '/' && n === '*') { j = s.indexOf('*/', i + 2); j = j < 0 ? s.length : j + 2; }
    else if (c === '"' || c === "'") { j++; while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1; j++; }
    else if (c === '`') j = skipTemplate(s, i + 1);
    else if (c === '/' && /(?:[(,=:[!&|?{};+\-*%<>~^]|return|typeof)$|^$/.test(prev)) {
      j++; let cls = false;
      while (j < s.length && s[j] !== '\n' && (s[j] !== '/' || cls)) { if (s[j] === '\\') j++; else if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false; j++; }
      j++; while (/[a-z]/.test(s[j] || '')) j++;
    } else { out += c; if (!/\s/.test(c)) prev = (prev + c).slice(-6); i++; continue; }
    out += blank(s.slice(i, j)); prev = 'x'; i = j;
  }
  return out;
}

export function topLevelNames(code) {
  const sk = skeleton(code), names = [];
  let depth = 0, stmt = true;
  for (let i = 0; i < sk.length; i++) {
    const c = sk[i];
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) { depth--; if (c === '}' && depth === 0) stmt = true; }
    else if (depth === 0 && (c === ';' || c === '\n')) stmt = true;
    else if (depth === 0 && stmt && /\S/.test(c)) {
      stmt = false;
      const m = /^(?:async\s+function\s*\*?|function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(sk.slice(i));
      if (m) names.push(m[1]);
    }
  }
  return names;
}

const scripts = html => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);

test('topLevelNames sees the declaration kinds', () => {
  const code = "function a(){ function inner(){} }\nconst b = `x${ {c:1}.c }`, d = /}/;\nasync function e(){}\nclass F{}\nlet g;\nvar h = '}';";
  assert.deepEqual(topLevelNames(code), ['a', 'b', 'e', 'F', 'g', 'h']);
});

for (const f of ['dink-score.html', 'b.html', 'dupr-export.js']) {
  test(`${f}: no top-level name is declared twice`, () => {
    const src = f === 'dink-score.html' ? page() : readFileSync(path.join(root, f), 'utf8');
    const names = (f.endsWith('.html') ? scripts(src) : [src]).flatMap(topLevelNames);
    assert.ok(names.length > 0, 'found no declarations; the scanner is broken');
    const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    assert.deepEqual(dup, []);
  });
}
