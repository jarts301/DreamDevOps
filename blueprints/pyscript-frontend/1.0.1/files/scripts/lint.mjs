// Checks the Python code with Ruff, for mistakes, style and formatting, as ruff check and
// ruff format --check do. Ruff runs here as WebAssembly, so no Python install is needed.
import { readdirSync, readFileSync } from 'node:fs';
import { PositionEncoding, Workspace } from '@astral-sh/ruff-wasm-nodejs';

const FOLDERS = ['src', 'tests'];
const files = FOLDERS.flatMap((folder) =>
  readdirSync(folder)
    .filter((name) => name.endsWith('.py'))
    .map((name) => `${folder}/${name}`),
);

/** Ruff's settings, as a ruff.toml would hold them. */
const SETTINGS = {
  'line-length': 120,
  'target-version': 'py314',
  lint: {
    // Errors, mistakes, imports, bugbear, newer syntax, simpler code and names.
    select: ['E', 'F', 'W', 'I', 'B', 'UP', 'SIM', 'N'],
    isort: {
      // The app's own modules, which the page loads side by side.
      'known-first-party': ['tests', ...readdirSync('src').map((name) => name.replace(/\.py$/, ''))],
    },
  },
};

/**
 * DreamDevOps writes the app's name here as it was registered, which can be long and hold
 * quotes of either kind, so only its length and quotes are left as they are.
 */
const NAME_FILE = 'src/app_info.py';

const workspace = new Workspace(SETTINGS, PositionEncoding.Utf16);
let problems = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const diagnostic of workspace.check(source)) {
    if (file === NAME_FILE && diagnostic.code === 'E501') {
      continue;
    }
    problems += 1;
    const { row, column } = diagnostic.start_location;
    console.log(`${file}:${row}:${column}: ${diagnostic.code ?? 'error'} ${diagnostic.message}`);
  }
  if (file !== NAME_FILE && workspace.format(source) !== source) {
    problems += 1;
    console.log(`${file}: isn't formatted as Ruff formats it.`);
  }
}
console.log(problems === 0 ? `Checked ${files.length} files.` : `${problems} problems.`);
process.exitCode = problems === 0 ? 0 : 1;
