import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  execLocalBin,
  normalizeSlashes,
  pathListIncludesSuffix,
  writeCommandStub,
} from './test-helpers.js';

const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI_PATH = join(REPO_ROOT, 'scripts', 'ael.ts');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ael-install-test-'));
}

function runCli(args: string[], workspace: string): string {
  return execLocalBin(REPO_ROOT, 'tsx', [CLI_PATH, ...args], {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
  });
}

function runCliWithEnv(args: string[], workspace: string, env: NodeJS.ProcessEnv): string {
  return execLocalBin(REPO_ROOT, 'tsx', [CLI_PATH, ...args], {
    cwd: workspace,
    env,
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
    ownership: { managedFiles: string[]; userOwnedFiles: string[]; localOnlyFiles: string[] };
    files: { created: string[]; updated: string[] };
    nextSteps: string[];
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'minimal');
  assert.equal(summary.rootInstructions, 'managed');
  assert.equal(summary.rootInstructionsPath, 'AGENTS.md');
  assert.equal(summary.scripts.added.length, 0);
  assert.ok(pathListIncludesSuffix(summary.files.updated, 'AGENTS.md'));
  assert.ok(pathListIncludesSuffix(summary.files.created, '.ael/.gitignore'));
  assert.ok(pathListIncludesSuffix(summary.files.created, '.ael/agent-guide.md'));
  assert.ok(pathListIncludesSuffix(summary.files.created, '.ael/install.json'));
  assert.ok(pathListIncludesSuffix(summary.files.created, '.ael/project-contract.md'));
  assert.ok(pathListIncludesSuffix(summary.files.created, '.ael/settings.json'));
  assert.ok(pathListIncludesSuffix(summary.ownership.managedFiles, '.ael/agent-guide.md'));
  assert.ok(pathListIncludesSuffix(summary.ownership.userOwnedFiles, '.ael/project-contract.md'));
  assert.ok(pathListIncludesSuffix(summary.ownership.localOnlyFiles, '.ael/config.local.json'));
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
  assert.match(guide, /npx ael backlog-create/);
  assert.match(guide, /npx ael backlog-polish/);
  assert.match(guide, /npx ael orchestrate/);
  assert.match(guide, /\.ael\/orchestration/);

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
  assert.match(aelGitignore, /^!settings\.json$/m);

  const installManifest = JSON.parse(
    readFileSync(join(workspace, '.ael', 'install.json'), 'utf8'),
  ) as {
    manifestVersion: number;
    mode: string;
    defaults: { agentKey: string; defaultBranch: string };
    rootInstructions: { mode: string; path: string };
    files: { settings: string };
  };
  assert.equal(installManifest.manifestVersion, 1);
  assert.equal(installManifest.mode, 'minimal');
  assert.equal(installManifest.defaults.agentKey, 'cursor');
  assert.equal(installManifest.defaults.defaultBranch, 'main');
  assert.equal(installManifest.rootInstructions.mode, 'managed');
  assert.equal(installManifest.rootInstructions.path, 'AGENTS.md');
  assert.equal(installManifest.files.settings, '.ael/settings.json');

  const settingsPath = join(workspace, '.ael', 'settings.json');
  assert.ok(existsSync(settingsPath));
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    promptTemplates: {
      backlogCreate: string;
      backlogPolish: string;
      orchestratorMaster: string;
      orchestratorChild: string;
      orchestratorFinalize: string;
    };
    orchestration: { defaults: { maxParallelChildren: number } };
  };
  assert.match(settings.promptTemplates.backlogCreate, /Identify meaningful gaps/);
  assert.match(settings.promptTemplates.backlogPolish, /Improve the clarity/);
  assert.match(settings.promptTemplates.orchestratorMaster, /You are the orchestrator/);
  assert.match(settings.promptTemplates.orchestratorChild, /You are a Codex subagent/);
  assert.match(
    settings.promptTemplates.orchestratorFinalize,
    /You are finalizing orchestration run/,
  );
  assert.equal(settings.orchestration.defaults.maxParallelChildren, 3);

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
  assert.ok(summary.scripts.added.includes('ael:refresh'));
  assert.ok(summary.scripts.added.includes('ael:upgrade'));
  assert.ok(summary.scripts.added.includes('ael:uninstall'));
  assert.ok(summary.scripts.added.includes('ael:backlog-create'));
  assert.ok(summary.scripts.added.includes('ael:backlog-polish'));
  assert.ok(summary.scripts.added.includes('ael:orchestrate'));
  assert.ok(summary.scripts.added.includes('ael:orchestrate-status'));
  assert.ok(summary.scripts.added.includes('ael:orchestrate-sync'));
  assert.ok(summary.scripts.added.includes('ael:orchestrate-finalize'));
  assert.ok(summary.scripts.added.includes('ael:orchestrate-stop'));
  assert.ok(summary.scripts.added.includes('ael:subagent-checkin'));
  assert.ok(summary.scripts.added.includes('ael:init'));
  assert.ok(summary.scripts.added.includes('ael:block'));
  assert.ok(summary.scripts.added.includes('ael:unblock'));
  assert.ok(summary.scripts.added.includes('ael:claim'));
  assert.ok(summary.scripts.added.includes('ael:prioritize'));
  assert.ok(summary.scripts.added.includes('ael:link'));
  assert.ok(summary.scripts.added.includes('ael:branch'));
  assert.ok(summary.scripts.added.includes('ael:retag'));
  assert.ok(summary.scripts.added.includes('ael:cleanup-branches'));
  assert.ok(summary.scripts.added.includes('ael:cleanup-prs'));

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['ael:install'], 'ael install --with-scripts');
  assert.equal(packageJson.scripts['ael:refresh'], 'ael refresh');
  assert.equal(packageJson.scripts['ael:upgrade'], 'ael upgrade');
  assert.equal(packageJson.scripts['ael:uninstall'], 'ael uninstall');
  assert.equal(packageJson.scripts['ael:backlog-create'], 'ael backlog-create');
  assert.equal(packageJson.scripts['ael:backlog-polish'], 'ael backlog-polish');
  assert.equal(packageJson.scripts['ael:orchestrate'], 'ael orchestrate');
  assert.equal(packageJson.scripts['ael:orchestrate-status'], 'ael orchestrate-status --json');
  assert.equal(packageJson.scripts['ael:subagent-checkin'], 'ael subagent-checkin --json');
  assert.equal(packageJson.scripts['ael:status'], 'ael status --json');
  assert.equal(packageJson.scripts['ael:doctor'], 'ael doctor --json');
  assert.equal(packageJson.scripts['ael:block'], 'ael block');
  assert.equal(packageJson.scripts['ael:unblock'], 'ael unblock');
  assert.equal(packageJson.scripts['ael:claim'], 'ael claim');
  assert.equal(packageJson.scripts['ael:prioritize'], 'ael prioritize');
  assert.equal(packageJson.scripts['ael:link'], 'ael link');
  assert.equal(packageJson.scripts['ael:branch'], 'ael branch');
  assert.equal(packageJson.scripts['ael:retag'], 'ael retag');
  assert.equal(
    packageJson.scripts['ael:cleanup-branches'],
    'ael cleanup-branches --dry-run --json',
  );
  assert.equal(packageJson.scripts['ael:cleanup-prs'], 'ael cleanup-prs --dry-run --json');

  const agents = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
  assert.match(agents, /npm run ael:status/);

  const guide = readFileSync(join(workspace, '.ael', 'agent-guide.md'), 'utf8');
  assert.match(guide, /npm run ael:next -- --agent <agent-key>/);
  assert.match(guide, /npm run ael:backlog-create/);
  assert.match(guide, /npm run ael:backlog-polish/);

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
  assert.ok(pathListIncludesSuffix(summary.files.created, 'AGENTS.md'));
  assert.ok(pathListIncludesSuffix(summary.files.created, '.ael/agent-guide.md'));
  assert.ok(pathListIncludesSuffix(summary.files.created, '.ael/project-contract.md'));
  assert.ok(pathListIncludesSuffix(summary.files.created, '.ael/settings.json'));
  assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);
  assert.equal(existsSync(join(workspace, '.ael', 'agent-guide.md')), false);
  assert.equal(existsSync(join(workspace, '.ael', 'project-contract.md')), false);
  assert.equal(existsSync(join(workspace, '.ael', 'install.json')), false);
  assert.equal(existsSync(join(workspace, '.ael', 'settings.json')), false);
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
  assert.equal(pathListIncludesSuffix(summary.files.created, 'docs/WORKFLOW.md'), true);
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
  assert.equal(pathListIncludesSuffix(summary.files.updated, 'AGENTS.md'), false);
  assert.equal(pathListIncludesSuffix(summary.files.created, 'AGENTS.md'), false);
  assert.match(normalizeSlashes(summary.nextSteps[0] ?? ''), /\.ael\/agent-guide\.md/);

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

test('upgrade refreshes managed files while preserving user-owned templates', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'upgrade-repo',
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

  runCli(['install', '--with-scripts', '--agent-key', 'cursor', '--json'], workspace);

  writeFileSync(join(workspace, '.ael', 'agent-guide.md'), '# stale guide\n', 'utf8');
  writeFileSync(join(workspace, '.ael', 'project-contract.md'), '# team-owned contract\n', 'utf8');
  writeFileSync(
    join(workspace, '.ael', 'settings.json'),
    `${JSON.stringify({ promptTemplates: { backlogCreate: 'custom create' } }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(workspace, '.ael', 'config.local.json'),
    `${JSON.stringify(
      {
        configVersion: 3,
        defaultBranch: 'release',
        defaultAgent: 'claude',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const packageJsonBeforeUpgrade = JSON.parse(
    readFileSync(join(workspace, 'package.json'), 'utf8'),
  ) as {
    scripts: Record<string, string>;
  };
  const {
    'ael:refresh': _removedRefreshScript,
    'ael:upgrade': _removedUpgradeScript,
    ...remainingScripts
  } = packageJsonBeforeUpgrade.scripts;
  packageJsonBeforeUpgrade.scripts = remainingScripts;
  packageJsonBeforeUpgrade.scripts['ael:status'] = 'echo stale-status';
  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(packageJsonBeforeUpgrade, null, 2)}\n`,
    'utf8',
  );

  const summary = JSON.parse(runCli(['upgrade', '--json'], workspace)) as {
    ok: boolean;
    mode: string;
    rootInstructions: string;
    defaults: { agentKey: string; defaultBranch: string };
    scripts: { added: string[]; updated: string[] };
    files: { updated: string[]; preserved: string[] };
    ownership: { managedFiles: string[]; userOwnedFiles: string[]; localOnlyFiles: string[] };
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'with-scripts');
  assert.equal(summary.rootInstructions, 'managed');
  assert.equal(summary.defaults.agentKey, 'claude');
  assert.equal(summary.defaults.defaultBranch, 'release');
  assert.ok(summary.scripts.added.includes('ael:upgrade'));
  assert.ok(summary.scripts.added.includes('ael:refresh'));
  assert.ok(summary.scripts.updated.includes('ael:status'));
  assert.ok(pathListIncludesSuffix(summary.files.updated, 'package.json'));
  assert.ok(pathListIncludesSuffix(summary.files.updated, '.ael/agent-guide.md'));
  assert.ok(pathListIncludesSuffix(summary.files.updated, '.ael/install.json'));
  assert.ok(pathListIncludesSuffix(summary.files.preserved, '.ael/project-contract.md'));
  assert.ok(pathListIncludesSuffix(summary.files.preserved, '.ael/settings.json'));
  assert.ok(pathListIncludesSuffix(summary.ownership.localOnlyFiles, '.ael/config.local.json'));

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['ael:upgrade'], 'ael upgrade');
  assert.equal(packageJson.scripts['ael:refresh'], 'ael refresh');
  assert.equal(packageJson.scripts['ael:status'], 'ael status --json');

  const guide = readFileSync(join(workspace, '.ael', 'agent-guide.md'), 'utf8');
  assert.match(guide, /`claude`/);

  const contract = readFileSync(join(workspace, '.ael', 'project-contract.md'), 'utf8');
  assert.equal(contract, '# team-owned contract\n');

  const settings = JSON.parse(readFileSync(join(workspace, '.ael', 'settings.json'), 'utf8')) as {
    promptTemplates: { backlogCreate: string };
  };
  assert.equal(settings.promptTemplates.backlogCreate, 'custom create');

  const installManifest = JSON.parse(
    readFileSync(join(workspace, '.ael', 'install.json'), 'utf8'),
  ) as {
    defaults: { agentKey: string; defaultBranch: string };
  };
  assert.equal(installManifest.defaults.agentKey, 'claude');
  assert.equal(installManifest.defaults.defaultBranch, 'release');
});

test('refresh updates the installed AEL dependency and then runs upgrade with the new package', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'refresh-repo',
        private: true,
        devDependencies: {
          'agent-execution-layer': 'github:ntwg/agent-execution-layer',
        },
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

  const binDir = join(workspace, 'bin');
  const npmStatePath = join(workspace, 'npm-state.json');
  const refreshInvocationPath = join(workspace, 'refresh-invocation.json');
  mkdirSync(binDir, { recursive: true });

  const npmStubPath = writeCommandStub(
    binDir,
    'npm',
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const statePath = process.env.AEL_REFRESH_NPM_STATE;
const installedPackagePath = process.env.AEL_REFRESH_INSTALLED_PACKAGE;

fs.writeFileSync(statePath, JSON.stringify({ args }, null, 2) + '\\n', 'utf8');
const packageJsonPath = path.join(installedPackagePath, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
pkg.version = '0.4.0';
fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\\n', 'utf8');
`,
  );

  const installedPackageDir = join(workspace, 'node_modules', 'agent-execution-layer');
  mkdirSync(join(installedPackageDir, 'bin'), { recursive: true });
  writeFileSync(
    join(installedPackageDir, 'package.json'),
    `${JSON.stringify({ name: 'agent-execution-layer', version: '0.3.0' }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(installedPackageDir, 'bin', 'ael.js'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const invocationPath = process.env.AEL_REFRESH_INVOCATION;
fs.writeFileSync(invocationPath, JSON.stringify({ argv: process.argv.slice(2) }, null, 2) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({
  ok: true,
  dryRun: false,
  mode: 'with-scripts',
  rootInstructions: 'managed',
  rootInstructionsPath: 'AGENTS.md',
  workspace: process.cwd(),
  packageJsonPath: 'package.json',
  defaults: { agentKey: 'codex', defaultBranch: 'main' },
  scripts: { added: [], updated: [], unchanged: [] },
  files: { created: [], updated: ['.ael/agent-guide.md'], unchanged: [], preserved: ['.ael/project-contract.md'] },
  ownership: { managedFiles: ['.ael/agent-guide.md'], userOwnedFiles: ['.ael/project-contract.md'], localOnlyFiles: ['.ael/config.local.json'] },
  warnings: [],
  nextSteps: ['npm run ael:doctor -- --adoption']
}, null, 2));
`,
    'utf8',
  );

  const summary = JSON.parse(
    runCliWithEnv(['refresh', '--json'], workspace, {
      ...process.env,
      AEL_CMD_NPM: npmStubPath,
      AEL_REFRESH_NPM_STATE: npmStatePath,
      AEL_REFRESH_INSTALLED_PACKAGE: installedPackageDir,
      AEL_REFRESH_INVOCATION: refreshInvocationPath,
    }),
  ) as {
    ok: boolean;
    packageManager: string;
    dependency: {
      section: string;
      spec: string;
      installedVersionBefore?: string;
      installedVersionAfter?: string;
    };
    commands: { update: string; upgrade: string };
    upgrade?: { ok: boolean; files: { updated: string[]; preserved: string[] } };
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.packageManager, 'npm');
  assert.equal(summary.dependency.section, 'devDependencies');
  assert.equal(summary.dependency.spec, 'github:ntwg/agent-execution-layer');
  assert.equal(summary.dependency.installedVersionBefore, '0.3.0');
  assert.equal(summary.dependency.installedVersionAfter, '0.4.0');
  assert.match(
    summary.commands.update,
    /npm install --save-dev agent-execution-layer@github:ntwg\/agent-execution-layer/,
  );
  assert.match(summary.commands.upgrade, /npx --no-install ael upgrade --json/);
  assert.equal(summary.upgrade?.ok, true);
  assert.ok(pathListIncludesSuffix(summary.upgrade?.files.updated ?? [], '.ael/agent-guide.md'));
  assert.ok(
    pathListIncludesSuffix(summary.upgrade?.files.preserved ?? [], '.ael/project-contract.md'),
  );

  const npmState = JSON.parse(readFileSync(npmStatePath, 'utf8')) as { args: string[] };
  assert.deepEqual(npmState.args, [
    'install',
    '--save-dev',
    'agent-execution-layer@github:ntwg/agent-execution-layer',
  ]);

  const refreshInvocation = JSON.parse(readFileSync(refreshInvocationPath, 'utf8')) as {
    argv: string[];
  };
  assert.deepEqual(refreshInvocation.argv, ['upgrade', '--json']);
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
    ownership: { managedFiles: string[]; userOwnedFiles: string[]; localOnlyFiles: string[] };
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, false);
  assert.ok(pathListIncludesSuffix(summary.files.removed, 'AGENTS.md'));
  assert.ok(pathListIncludesSuffix(summary.files.removed, '.ael/agent-guide.md'));
  assert.ok(pathListIncludesSuffix(summary.files.removed, '.ael/project-contract.md'));
  assert.ok(pathListIncludesSuffix(summary.files.removed, '.ael/.gitignore'));
  assert.ok(pathListIncludesSuffix(summary.files.removed, '.ael/install.json'));
  assert.ok(pathListIncludesSuffix(summary.files.removed, '.ael/config.local.json'));
  assert.ok(pathListIncludesSuffix(summary.files.removed, '.ael/settings.json'));
  assert.ok(pathListIncludesSuffix(summary.files.updated, 'package.json'));
  assert.ok(summary.scripts.removed.includes('ael:install'));
  assert.ok(summary.scripts.removed.includes('ael:refresh'));
  assert.ok(summary.scripts.removed.includes('ael:upgrade'));
  assert.ok(summary.scripts.removed.includes('ael:uninstall'));
  assert.ok(summary.scripts.removed.includes('ael:block'));
  assert.ok(summary.scripts.removed.includes('ael:unblock'));
  assert.ok(summary.scripts.removed.includes('ael:backlog-create'));
  assert.ok(summary.scripts.removed.includes('ael:backlog-polish'));
  assert.ok(summary.scripts.removed.includes('ael:cleanup-branches'));
  assert.ok(summary.scripts.removed.includes('ael:cleanup-prs'));
  assert.equal(summary.scripts.preserved.length, 0);
  assert.ok(pathListIncludesSuffix(summary.ownership.localOnlyFiles, '.ael/config.local.json'));

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
  assert.ok(pathListIncludesSuffix(summary.files.removed, 'AGENTS.md'));
  assert.ok(pathListIncludesSuffix(summary.files.updated, 'package.json'));
  assert.ok(summary.scripts.removed.includes('ael:install'));
  assert.ok(summary.scripts.removed.includes('ael:refresh'));
  assert.ok(summary.scripts.removed.includes('ael:upgrade'));
  assert.equal(existsSync(join(workspace, 'AGENTS.md')), true);
  assert.equal(existsSync(join(workspace, '.ael', 'agent-guide.md')), true);

  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.['ael:install'], 'ael install --with-scripts');
  assert.equal(packageJson.scripts?.['ael:refresh'], 'ael refresh');
  assert.equal(packageJson.scripts?.['ael:upgrade'], 'ael upgrade');
});
