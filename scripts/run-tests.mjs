import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const testsDirectory = join(repositoryRoot, 'tests');
const tsxCliPath = require.resolve('tsx/cli');

const testFiles = readdirSync(testsDirectory)
  .filter((entry) => entry.endsWith('.test.ts'))
  .sort()
  .map((entry) => join('tests', entry));

if (testFiles.length === 0) {
  console.error('No test files found under tests/.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxCliPath, '--test', ...testFiles], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
