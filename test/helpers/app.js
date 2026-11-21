// Loads pieces of the client page for tests, so a test names what it wants (a marked section, a src/app module, a function)
// and not where it lives. When code moves between dink-score.html and src/app/, only this file changes.
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const between = (src, a, z) => { const i = src.indexOf(a), j = src.indexOf(z, i + a.length); return i < 0 || j < 0 ? null : src.slice(i + a.length, j); };
const found = (text, what) => { if (text === null || text === undefined) throw new Error(`${what} is missing from dink-score.html`); return text; };

// The modules of src/app/manifest, in order, that dink-score.html does not carry (no MODULE block): build.cjs emits them at its /*@APP*/ line.
const loose = html => read('src/app/manifest').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean)
  .filter(n => !html.includes(`/*MODULE-START:${n}*/`)).map(n => read(`src/app/${n}.js`)).join('');

// The whole page source as the browser gets it (the /*@APP*/ line replaced by its modules), for tests that assert on markup, CSS or wiring.
export const page = () => { const html = read('dink-score.html'); return html.replace('/*@APP*/\n', () => loose(html)); };

// The text between /*NAME-START*/ and /*NAME-END*/.
export const section = name => found(between(page(), `/*${name}-START*/`, `/*${name}-END*/`), `the ${name} block`);

// The text of the src/app/<name>.js module, as build.cjs pastes it between /*MODULE-START:<name>*/ and /*MODULE-END:<name>*/.
export const module = name => found(between(page(), `/*MODULE-START:${name}*/`, `/*MODULE-END:${name}*/`) ?? (read('src/app/manifest').includes(name) ? read(`src/app/${name}.js`) : null), `the ${name} module`);

// A top-level `function name(...) { ... }`, closed by a `}` at the start of a line.
export const fn = name => {
  const m = page().match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`));
  return found(m && m[0], `${name}()`);
};

// A top-level `const NAME = (() => { ... })();`, as the engine blocks (PB, DR) are written.
export const iife = name => {
  const m = page().match(new RegExp(`const ${name} = \\(\\(\\) => \\{[\\s\\S]*?\\n\\}\\)\\(\\);`));
  return found(m && m[0], `const ${name}`);
};
