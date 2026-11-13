// Builds the app into dist/: the page, its Python and its settings, with the runtime it runs
// on, PyScript and Pyodide, which the app serves itself, rather than from a CDN. They go in
// folders named after their versions, so browsers can keep them for a long time.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const versionOf = (name) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
const PYSCRIPT = `/vendor/pyscript-${versionOf('@pyscript/core')}`;
const PYODIDE = `/vendor/pyodide-${versionOf('pyodide')}`;
/** What Pyodide needs to start: its module, its WebAssembly, the standard library and its package list. */
const PYODIDE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

rmSync('dist', { recursive: true, force: true });
mkdirSync(`dist${PYODIDE}`, { recursive: true });
cpSync('node_modules/@pyscript/core/dist', `dist${PYSCRIPT}`, {
  recursive: true,
  filter: (source) => !source.endsWith('.map'),
});
for (const file of PYODIDE_FILES) {
  cpSync(`node_modules/pyodide/${file}`, `dist${PYODIDE}/${file}`);
}

// The page runs main.py, and loads the other modules into Python's working folder, so it can import them.
const modules = readdirSync('src')
  .filter((name) => name.endsWith('.py'))
  .sort();
for (const name of modules) {
  cpSync(`src/${name}`, `dist/${name}`);
}
const config = {
  interpreter: `${PYODIDE}/pyodide.mjs`,
  files: Object.fromEntries(modules.filter((name) => name !== 'main.py').map((name) => [`/${name}`, `./${name}`])),
};
writeFileSync('dist/pyscript.json', `${JSON.stringify(config, null, 2)}\n`);
writeFileSync('dist/index.html', readFileSync('index.html', 'utf8').replaceAll('%PYSCRIPT%', PYSCRIPT));
cpSync('public', 'dist', { recursive: true });
console.log(`Built dist/ with ${modules.length} Python modules, ${PYSCRIPT} and ${PYODIDE}.`);
