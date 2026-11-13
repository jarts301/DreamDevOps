// Runs the tests in tests/ with Pyodide, the same Python the browser runs, so no Python
// install is needed. The tests use unittest, so python -m unittest runs them too.
import { readdirSync, readFileSync } from 'node:fs';
import { loadPyodide } from 'pyodide';

const pyodide = await loadPyodide();
for (const folder of ['src', 'tests']) {
  pyodide.FS.mkdirTree(`/app/${folder}`);
  for (const name of readdirSync(folder).filter((file) => file.endsWith('.py'))) {
    pyodide.FS.writeFile(`/app/${folder}/${name}`, readFileSync(`${folder}/${name}`, 'utf8'));
  }
}
const passed = pyodide.runPython(`
import sys
import unittest

sys.path[:0] = ["/app/src", "/app"]
suite = unittest.defaultTestLoader.discover("/app/tests", top_level_dir="/app")
unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(suite).wasSuccessful()
`);
process.exitCode = passed ? 0 : 1;
