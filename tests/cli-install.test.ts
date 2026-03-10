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

test('install writes downstream repo contract files without mutating package.json by default', (t) => {
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
    mode: string;
    rootInstructions: string;
    rootInstructionsPath?: string;
    scripts: { added: string[] };
    files: { created: string[]; updated: string[] };
    nextSteps: string[];
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'minimal');
  assert.equal(summary.rootInstructions, 'managed');
  assert.equal(summary.rootInstructionsPath, 'AGENTS.md');
  assert.equal(summary.scripts.added.length, 0);
  assert.ok(summary.files.updated.some((path) => path.endsWith('/AGENTS.md')));
  assert.ok(summary.files.created.some((path) => path.endsWith('/.ael/.gitignore')));
  assert.ok(summary.files.created.some((path) => path.endsWith('/.ael/agent-guide.md')));
  assert.ok(summary.files.created.some((path) => path.endsWith('/.ael/install.json')));
  assert.ok(summary.files.created.some((path) => path.endsWith('/.ael/project-contract.md')));
  assert.deepEqual(summary.nextSteps.slice(-2), ['npx ael init', 'npx ael doctor']);

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.deepEqual(packageJson.scripts, {
    build: 'tsc -p .',
    test: 'vitest run',
    lint: 'eslint .',
  });

  const agents = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
  assert.match(agents, /AEL WORKFLOW START/);
  assert.match(agents, /npx ael status/);
  assert.match(agents, /\.ael\/agent-guide\.md/);
  assert.match(agents, /\.ael\/project-contract\.md/);

  const guidePath = join(workspace, '.ael', 'agent-guide.md');
  assert.ok(existsSync(guidePath));
  const guide = readFileSync(guidePath, 'utf8');
  assert.match(guide, /`cursor`/);
  assert.match(guide, /npx ael status/);
  assert.match(guide, /npx ael next -- --agent <agent-key>/);
  assert.match(guide, /`npm run build`/);
  assert.match(guide, /`npm test`/);
  assert.match(guide, /`npm run lint`/);

  const contractPath = join(workspace, '.ael', 'project-contract.md');
  assert.ok(existsSync(contractPath));
  const contract = readFileSync(contractPath, 'utf8');
  assert.match(contract, /Repository: guinea-pig-repo/);
  assert.match(contract, /Default agent key: cursor/);
  assert.match(contract, /Build: npm run build/);

  assert.equal(existsSync(join(workspace, '.gitignore')), false);
  const aelGitignore = readFileSync(join(workspace, '.ael', '.gitignore'), 'utf8');
  assert.match(aelGitignore, /^\*$/m);
  assert.match(aelGitignore, /^!\.gitignore$/m);
  assert.match(aelGitignore, /^!agent-guide\.md$/m);
  assert.match(aelGitignore, /^!install\.json$/m);
  assert.match(aelGitignore, /^!project-contract\.md$/m);

  const installManifest = JSON.parse(
    readFileSync(join(workspace, '.ael', 'install.json'), 'utf8'),
  ) as {
    manifestVersion: number;
    mode: string;
    rootInstructions: { mode: string; path: string };
  };
  assert.equal(installManifest.manifestVersion, 1);
  assert.equal(installManifest.mode, 'minimal');
  assert.equal(installManifest.rootInstructions.mode, 'managed');
  assert.equal(installManifest.rootInstructions.path, 'AGENTS.md');

  const statusJson = JSON.parse(runCli(['status', '--json'], workspace)) as {
    nextSteps: string[];
  };
  assert.deepEqual(statusJson.nextSteps, ['npx ael init', 'npx ael doctor']);
});

test('install --with-scripts writes downstream package scripts and keeps script-mode guidance', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'script-mode-repo',
        private: true,
        scripts: {
          build: 'tsc -p .',
          test: 'vitest run',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const summary = JSON.parse(
    runCli(['install', '--with-scripts', '--agent-key', 'cursor', '--json'], workspace),
  ) as {
    ok: boolean;
    mode: string;
    rootInstructions: string;
    rootInstructionsPath?: string;
    scripts: { added: string[] };
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'with-scripts');
  assert.equal(summary.rootInstructions, 'managed');
  assert.equal(summary.rootInstructionsPath, 'AGENTS.md');
  assert.ok(summary.scripts.added.includes('ael:install'));
  assert.ok(summary.scripts.added.includes('ael:uninstall'));
  assert.ok(summary.scripts.added.includes('ael:init'));

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['ael:install'], 'ael install --with-scripts');
  assert.equal(packageJson.scripts['ael:uninstall'], 'ael uninstall');
  assert.equal(packageJson.scripts['ael:status'], 'ael status --json');
  assert.equal(packageJson.scripts['ael:doctor'], 'ael doctor --json');

  const agents = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
  assert.match(agents, /npm run ael:status/);

  const guide = readFileSync(join(workspace, '.ael', 'agent-guide.md'), 'utf8');
  assert.match(guide, /npm run ael:next -- --agent <agent-key>/);

  const statusJson = JSON.parse(runCli(['status', '--json'], workspace)) as {
    nextSteps: string[];
  };
  assert.deepEqual(statusJson.nextSteps, ['npm run ael:init', 'npm run ael:doctor']);
});

test('install --with-scripts fails fast on conflicting package scripts without force', (t) => {
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

  assert.throws(() => runCli(['install', '--with-scripts', '--json'], workspace), /Command failed/);

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['ael:status'], 'echo custom-status');
  assert.equal(existsSync(join(workspace, '.ael', 'project-contract.md')), false);
});

test('install works in minimal mode without a package.json', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const summary = JSON.parse(runCli(['install', '--minimal', '--json'], workspace)) as {
    ok: boolean;
    mode: string;
    rootInstructions: string;
    packageJsonPath?: string;
    nextSteps: string[];
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'minimal');
  assert.equal(summary.rootInstructions, 'managed');
  assert.equal(summary.packageJsonPath, undefined);
  assert.deepEqual(summary.nextSteps.slice(-2), ['ael init', 'ael doctor']);
  assert.ok(existsSync(join(workspace, 'AGENTS.md')));
  assert.ok(existsSync(join(workspace, '.ael', 'agent-guide.md')));
  assert.ok(existsSync(join(workspace, '.ael', 'project-contract.md')));
  assert.ok(existsSync(join(workspace, '.ael', '.gitignore')));
});

test('install --dry-run previews downstream changes without writing files', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'dry-run-repo', private: true }, null, 2)}\n`,
    'utf8',
  );

  const summary = JSON.parse(runCli(['install', '--dry-run', '--json'], workspace)) as {
    ok: boolean;
    dryRun: boolean;
    files: { created: string[]; updated: string[] };
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, true);
  assert.ok(summary.files.created.some((path) => path.endsWith('/AGENTS.md')));
  assert.ok(summary.files.created.some((path) => path.endsWith('/.ael/agent-guide.md')));
  assert.ok(summary.files.created.some((path) => path.endsWith('/.ael/project-contract.md')));
  assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);
  assert.equal(existsSync(join(workspace, '.ael', 'agent-guide.md')), false);
  assert.equal(existsSync(join(workspace, '.ael', 'project-contract.md')), false);
  assert.equal(existsSync(join(workspace, '.ael', 'install.json')), false);
});

test('install --entrypoint-file writes the root discovery stub to a custom file', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'custom-entrypoint-repo', private: true }, null, 2)}\n`,
    'utf8',
  );

  const summary = JSON.parse(
    runCli(['install', '--entrypoint-file', 'docs/WORKFLOW.md', '--json'], workspace),
  ) as {
    ok: boolean;
    rootInstructions: string;
    rootInstructionsPath?: string;
    files: { created: string[] };
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.rootInstructions, 'managed');
  assert.equal(summary.rootInstructionsPath, 'docs/WORKFLOW.md');
  assert.equal(
    summary.files.created.some((path) => path.endsWith('/docs/WORKFLOW.md')),
    true,
  );
  assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);

  const entrypoint = readFileSync(join(workspace, 'docs', 'WORKFLOW.md'), 'utf8');
  assert.match(entrypoint, /\.ael\/agent-guide\.md/);

  const installManifest = JSON.parse(
    readFileSync(join(workspace, '.ael', 'install.json'), 'utf8'),
  ) as {
    rootInstructions: { path: string };
  };
  assert.equal(installManifest.rootInstructions.path, 'docs/WORKFLOW.md');
});

test('install --no-root-agents leaves existing root instructions untouched', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'external-instructions-repo',
        private: true,
        scripts: {
          build: 'tsc -p .',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(join(workspace, 'AGENTS.md'), '# Team-Owned Instructions\n', 'utf8');

  const summary = JSON.parse(
    runCli(['install', '--no-root-agents', '--agent-key', 'cursor', '--json'], workspace),
  ) as {
    ok: boolean;
    mode: string;
    rootInstructions: string;
    rootInstructionsPath?: string;
    files: { created: string[]; updated: string[] };
    nextSteps: string[];
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'minimal');
  assert.equal(summary.rootInstructions, 'external');
  assert.equal(summary.rootInstructionsPath, 'AGENTS.md');
  assert.equal(
    summary.files.updated.some((path) => path.endsWith('/AGENTS.md')),
    false,
  );
  assert.equal(
    summary.files.created.some((path) => path.endsWith('/AGENTS.md')),
    false,
  );
  assert.match(summary.nextSteps[0] ?? '', /\.ael\/agent-guide\.md/);

  const agents = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
  assert.equal(agents, '# Team-Owned Instructions\n');
  assert.ok(existsSync(join(workspace, '.ael', 'agent-guide.md')));
  assert.ok(existsSync(join(workspace, '.ael', 'project-contract.md')));
  assert.ok(existsSync(join(workspace, '.ael', '.gitignore')));
});

test('install --no-root-agents does not create AGENTS.md when none exists', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const summary = JSON.parse(
    runCli(['install', '--minimal', '--no-root-agents', '--json'], workspace),
  ) as {
    ok: boolean;
    rootInstructions: string;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.rootInstructions, 'external');
  assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);
  assert.ok(existsSync(join(workspace, '.ael', 'agent-guide.md')));
});

test('install --no-root-agents can record a custom external entrypoint path', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(join(workspace, 'docs-note.md'), '# team note\n', 'utf8');

  const summary = JSON.parse(
    runCli(
      ['install', '--no-root-agents', '--entrypoint-file', 'docs-note.md', '--json'],
      workspace,
    ),
  ) as {
    ok: boolean;
    rootInstructions: string;
    rootInstructionsPath?: string;
    nextSteps: string[];
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.rootInstructions, 'external');
  assert.equal(summary.rootInstructionsPath, 'docs-note.md');
  assert.match(summary.nextSteps[0] ?? '', /docs-note\.md/);
  assert.equal(readFileSync(join(workspace, 'docs-note.md'), 'utf8'), '# team note\n');
});

test('uninstall removes managed files and exact-match scripts from a downstream repo', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'uninstall-repo',
        private: true,
        scripts: {
          build: 'tsc -p .',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  runCli(['install', '--with-scripts', '--json'], workspace);
  writeFileSync(
    join(workspace, '.ael', 'config.local.json'),
    `${JSON.stringify({ configVersion: 3 }, null, 2)}\n`,
    'utf8',
  );

  const summary = JSON.parse(runCli(['uninstall', '--json'], workspace)) as {
    ok: boolean;
    dryRun: boolean;
    files: { removed: string[]; updated: string[] };
    scripts: { removed: string[]; preserved: string[] };
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, false);
  assert.ok(summary.files.removed.some((path) => path.endsWith('/AGENTS.md')));
  assert.ok(summary.files.removed.some((path) => path.endsWith('/.ael/agent-guide.md')));
  assert.ok(summary.files.removed.some((path) => path.endsWith('/.ael/project-contract.md')));
  assert.ok(summary.files.removed.some((path) => path.endsWith('/.ael/.gitignore')));
  assert.ok(summary.files.removed.some((path) => path.endsWith('/.ael/install.json')));
  assert.ok(summary.files.removed.some((path) => path.endsWith('/.ael/config.local.json')));
  assert.ok(summary.files.updated.some((path) => path.endsWith('/package.json')));
  assert.ok(summary.scripts.removed.includes('ael:install'));
  assert.ok(summary.scripts.removed.includes('ael:uninstall'));
  assert.equal(summary.scripts.preserved.length, 0);

  assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);
  assert.equal(existsSync(join(workspace, '.ael')), false);

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.scripts, {
    build: 'tsc -p .',
  });
});

test('uninstall --dry-run previews downstream cleanup without removing files', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'uninstall-dry-run-repo',
        private: true,
        scripts: {
          build: 'tsc -p .',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  runCli(['install', '--with-scripts', '--json'], workspace);
  writeFileSync(
    join(workspace, '.ael', 'config.local.json'),
    `${JSON.stringify({ configVersion: 3 }, null, 2)}\n`,
    'utf8',
  );

  const summary = JSON.parse(runCli(['uninstall', '--dry-run', '--json'], workspace)) as {
    ok: boolean;
    dryRun: boolean;
    files: { removed: string[]; updated: string[] };
    scripts: { removed: string[] };
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, true);
  assert.ok(summary.files.removed.some((path) => path.endsWith('/AGENTS.md')));
  assert.ok(summary.files.updated.some((path) => path.endsWith('/package.json')));
  assert.ok(summary.scripts.removed.includes('ael:install'));
  assert.equal(existsSync(join(workspace, 'AGENTS.md')), true);
  assert.equal(existsSync(join(workspace, '.ael', 'agent-guide.md')), true);

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.['ael:install'], 'ael install --with-scripts');
});
