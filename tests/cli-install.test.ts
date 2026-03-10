import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_PATH = join(REPO_ROOT, 'scripts', 'ael.ts');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ael-install-test-'));
}

function runCli(args: string[], workspace: string): string {
  return execFileSync(TSX_BIN, [CLI_PATH, ...args], {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
  });
}

test('install writes downstream package scripts and repo contract files', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'guinea-pig-repo',
        private: true,
        scripts: {
          build: 'tsc -p .',
          test: 'vitest run',
          lint: 'eslint .',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(join(workspace, 'AGENTS.md'), '# Existing Instructions\n', 'utf8');

  const summary = JSON.parse(runCli(['install', '--agent-key', 'cursor', '--json'], workspace)) as {
    ok: boolean;
    scripts: { added: string[] };
    files: { created: string[]; updated: string[] };
    nextSteps: string[];
  };

  assert.equal(summary.ok, true);
  assert.ok(summary.scripts.added.includes('ael:install'));
  assert.ok(summary.scripts.added.includes('ael:init'));
  assert.ok(summary.files.updated.some((path) => path.endsWith('/package.json')));
  assert.ok(summary.files.updated.some((path) => path.endsWith('/AGENTS.md')));
  assert.ok(summary.files.created.some((path) => path.endsWith('/docs/AEL-PROJECT-CONTRACT.md')));
  assert.ok(summary.nextSteps.some((step) => step.includes('ael:init')));

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['ael:install'], 'ael install');
  assert.equal(packageJson.scripts['ael:status'], 'ael status --json');
  assert.equal(packageJson.scripts['ael:doctor'], 'ael doctor --json');

  const agents = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
  assert.match(agents, /AEL WORKFLOW START/);
  assert.match(agents, /`cursor`/);
  assert.match(agents, /`npm run build`/);
  assert.match(agents, /`npm test`/);
  assert.match(agents, /`npm run lint`/);

  const contractPath = join(workspace, 'docs', 'AEL-PROJECT-CONTRACT.md');
  assert.ok(existsSync(contractPath));
  const contract = readFileSync(contractPath, 'utf8');
  assert.match(contract, /Repository: guinea-pig-repo/);
  assert.match(contract, /Default agent key: cursor/);
  assert.match(contract, /Build: npm run build/);

  const gitignore = readFileSync(join(workspace, '.gitignore'), 'utf8');
  assert.match(gitignore, /agent-execution\.config\.local\.json/);

  const statusJson = JSON.parse(runCli(['status', '--json'], workspace)) as {
    nextSteps: string[];
  };
  assert.deepEqual(statusJson.nextSteps, ['npm run ael:init', 'npm run ael:doctor']);
});

test('install fails fast on conflicting package scripts without force', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'conflict-repo',
        private: true,
        scripts: {
          'ael:status': 'echo custom-status',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  assert.throws(() => runCli(['install', '--json'], workspace), /Command failed/);

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['ael:status'], 'echo custom-status');
  assert.equal(existsSync(join(workspace, 'docs', 'AEL-PROJECT-CONTRACT.md')), false);
});
