import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_CONFIG_FILENAME } from '../scripts/lib/config.js';
import {
  execLocalBin,
  normalizeSlashes,
  prependPathEntry,
  writeCommandStub,
} from './test-helpers.js';

const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI_PATH = join(REPO_ROOT, 'scripts', 'ael.ts');
const TEST_REPOSITORY_ID = '11111111-1111-1111-1111-111111111111';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ael-cli-test-'));
}

function installStubCommands(workspace: string): {
  binDir: string;
  gitCommandPath: string;
  azCommandPath: string;
} {
  const binDir = join(workspace, 'bin');
  mkdirSync(binDir, { recursive: true });

  const gitCommandPath = writeCommandStub(
    binDir,
    'git',
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const workspace = process.env.AEL_TEST_WORKSPACE;
const remote = process.env.AEL_TEST_REMOTE;
const branch = process.env.AEL_TEST_BRANCH || 'main';

function out(value) {
  process.stdout.write(value);
}

function fail() {
  process.stderr.write('unsupported git args: ' + args.join(' ') + '\\n');
  process.exit(1);
}

if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
  out(workspace + '\\n');
} else if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
  out(remote + '\\n');
} else if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'origin/HEAD') {
  out('origin/' + branch + '\\n');
} else if (args[0] === 'remote' && args[1] === 'show' && args[2] === 'origin') {
  out('* remote origin\\n  HEAD branch: ' + branch + '\\n');
} else if (args[0] === 'ls-remote' && args.includes('--heads') && args[args.length - 1] === branch) {
  out('deadbeef\\trefs/heads/' + branch + '\\n');
} else {
  fail();
}
`,
  );

  const azCommandPath = writeCommandStub(
    binDir,
    'az',
    `#!/usr/bin/env node
const args = process.argv.slice(2);

function out(value) {
  process.stdout.write(value);
}

function fail() {
  process.stderr.write('unsupported az args: ' + args.join(' ') + '\\n');
  process.exit(1);
}

if (args[0] === 'version') {
  out(JSON.stringify({ 'azure-cli': '2.60.0' }));
} else if (args[0] === 'extension' && args[1] === 'show' && args[2] === '--name' && args[3] === 'azure-devops') {
  out(JSON.stringify({ name: 'azure-devops' }));
} else if (args[0] === 'account' && args[1] === 'show') {
  if (process.env.AEL_TEST_PAT_ONLY === 'true') {
    process.stderr.write('login not configured\\n');
    process.exit(1);
  }
  out(JSON.stringify({
    user: { name: 'agent@example.com' },
    tenantId: 'tenant-id',
    id: 'subscription-id',
  }));
} else if (args[0] === 'account' && args[1] === 'get-access-token') {
  if (process.env.AEL_TEST_PAT_ONLY === 'true') {
    process.stderr.write('token not available\\n');
    process.exit(1);
  }
  out('test-access-token\\n');
} else if (args[0] === 'repos' && args[1] === 'show') {
  const repositoryIndex = args.indexOf('--repository');
  const repository = repositoryIndex >= 0 ? args[repositoryIndex + 1] : '${TEST_REPOSITORY_ID}';
  const queryIndex = args.indexOf('--query');
  const query = queryIndex >= 0 ? args[queryIndex + 1] : undefined;
  if (query === 'id') {
    out('${TEST_REPOSITORY_ID}\\n');
  } else {
    out(JSON.stringify({ id: repository, name: 'agent-execution-layer' }));
  }
} else if (args[0] === 'devops' && args[1] === 'project' && args[2] === 'show') {
  out(JSON.stringify({ name: 'agent-execution-layer' }));
} else if (args[0] === 'devops' && args[1] === 'user' && args[2] === 'show') {
  const userIndex = args.indexOf('--user');
  const user = userIndex >= 0 ? args[userIndex + 1] : 'owner@example.com';
  out(JSON.stringify({
    user: {
      displayName: user,
      mailAddress: user,
      principalName: user,
      uniqueName: user,
    },
  }));
} else if (args[0] === 'boards' && args[1] === 'query') {
  out(JSON.stringify([]));
} else if (args[0] === 'boards' && args[1] === 'area' && args[2] === 'project' && args[3] === 'list') {
  out(JSON.stringify({
    path: '\\\\agent-execution-layer\\\\Area',
    children: null,
  }));
} else if (args[0] === 'boards' && args[1] === 'iteration' && args[2] === 'project' && args[3] === 'list') {
  out(JSON.stringify({
    path: '\\\\agent-execution-layer\\\\Iteration',
    children: [
      { path: '\\\\agent-execution-layer\\\\Iteration\\\\Sprint 1' },
    ],
  }));
} else if (args[0] === 'repos' && args[1] === 'policy' && args[2] === 'list') {
  out(JSON.stringify([
    {
      id: 10,
      isEnabled: true,
      isBlocking: true,
      type: { displayName: 'Minimum number of reviewers' },
    },
  ]));
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'list') {
  out(JSON.stringify([]));
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'policy' && args[3] === 'list') {
  out(JSON.stringify([]));
} else {
  fail();
}
`,
  );

  return {
    binDir,
    gitCommandPath,
    azCommandPath,
  };
}

function runCli(args: string[], workspace: string, extraEnv: Record<string, string>): string {
  return execLocalBin(REPO_ROOT, 'tsx', [CLI_PATH, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

test('init writes a local generated config and doctor/smoke pass with stubs', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const { binDir, gitCommandPath, azCommandPath } = installStubCommands(workspace);
  const env = {
    PATH: prependPathEntry(binDir),
    AEL_CMD_GIT: gitCommandPath,
    AEL_CMD_AZ: azCommandPath,
    AEL_TEST_WORKSPACE: workspace,
    AEL_TEST_REMOTE:
      'https://dev.azure.com/example-org/agent-execution-layer/_git/agent-execution-layer',
    AEL_TEST_BRANCH: 'main',
  };

  const initOutput = runCli(
    [
      'init',
      '--organization-url',
      'https://dev.azure.com/example-org',
      '--project',
      'agent-execution-layer',
      '--repository',
      'agent-execution-layer',
      '--default-branch',
      'main',
      '--agents',
      'codex;claude',
      '--default-agent',
      'codex',
    ],
    workspace,
    env,
  );

  const configPath = join(workspace, DEFAULT_CONFIG_FILENAME);
  assert.ok(existsSync(configPath));
  assert.match(normalizeSlashes(initOutput), /config: .*\.ael\/config\.local\.json/);

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    repositoryId: string;
    defaultBranch: string;
    defaultAgent: string;
    runtime: {
      platform: string;
    };
  };
  assert.equal(config.repositoryId, TEST_REPOSITORY_ID);
  assert.equal(config.defaultBranch, 'main');
  assert.equal(config.defaultAreaPath, 'agent-execution-layer');
  assert.equal(config.defaultIterationPath, 'agent-execution-layer');
  assert.equal(config.defaultAgent, 'codex');
  assert.equal(config.runtime.platform, 'auto');

  const doctorOutput = runCli(['doctor'], workspace, env);
  assert.match(doctorOutput, /PASS git repository/);
  assert.match(doctorOutput, /PASS repository access/);
  assert.match(doctorOutput, /PASS configured default branch/);
  assert.match(doctorOutput, /PASS branch policies/);
  assert.match(doctorOutput, /PASS configured identities/);

  const statusJson = JSON.parse(runCli(['status', '--json'], workspace, env)) as {
    backend: string;
    validation: { ok: boolean };
    config: {
      runtime: {
        platform: string;
      };
    };
    nextSteps: string[];
  };
  assert.equal(statusJson.backend, 'azure-devops');
  assert.equal(statusJson.validation.ok, true);
  assert.equal(statusJson.config.runtime.platform, 'auto');
  assert.deepEqual(statusJson.nextSteps, ['ael doctor', 'ael next -- --agent <agent-key>']);

  const doctorJson = JSON.parse(runCli(['doctor', '--json'], workspace, env)) as {
    ok: boolean;
    authMode: string;
    checks: Array<{ label: string; ok: boolean }>;
  };
  assert.equal(doctorJson.ok, true);
  assert.equal(doctorJson.authMode, 'azure-cli');
  assert.ok(doctorJson.checks.some((check) => check.label === 'repository access' && check.ok));
  assert.ok(doctorJson.checks.some((check) => check.label === 'branch policies' && check.ok));

  const nextJson = JSON.parse(runCli(['next', '--agent', 'codex', '--json'], workspace, env)) as {
    ok: boolean;
    source: string;
    count: number;
    workItems: unknown[];
  };
  assert.equal(nextJson.ok, true);
  assert.equal(nextJson.source, 'none');
  assert.equal(nextJson.count, 0);
  assert.deepEqual(nextJson.workItems, []);

  const listJson = JSON.parse(runCli(['list', '--agent', 'codex', '--json'], workspace, env)) as {
    ok: boolean;
    count: number;
    workItems: unknown[];
  };
  assert.equal(listJson.ok, true);
  assert.equal(listJson.count, 0);
  assert.deepEqual(listJson.workItems, []);

  const smokeOutput = runCli(['smoke'], workspace, env);
  assert.match(smokeOutput, /PASS work item query smoke/);
  assert.match(smokeOutput, /PASS pull request list smoke/);
  assert.match(smokeOutput, /PASS active pr merge readiness/);
});

test('init can pin the local runtime platform', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const { binDir, gitCommandPath, azCommandPath } = installStubCommands(workspace);
  const env = {
    PATH: prependPathEntry(binDir),
    AEL_CMD_GIT: gitCommandPath,
    AEL_CMD_AZ: azCommandPath,
    AEL_TEST_WORKSPACE: workspace,
    AEL_TEST_REMOTE:
      'https://dev.azure.com/example-org/agent-execution-layer/_git/agent-execution-layer',
    AEL_TEST_BRANCH: 'main',
  };

  runCli(
    [
      'init',
      '--organization-url',
      'https://dev.azure.com/example-org',
      '--project',
      'agent-execution-layer',
      '--repository',
      'agent-execution-layer',
      '--default-branch',
      'main',
      '--platform',
      'windows',
    ],
    workspace,
    env,
  );

  const configPath = join(workspace, DEFAULT_CONFIG_FILENAME);
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    runtime: {
      platform: string;
    };
  };
  assert.equal(config.runtime.platform, 'windows');
});

test('doctor passes with PAT auth fallback and no azure login', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const { binDir, gitCommandPath, azCommandPath } = installStubCommands(workspace);
  const configPath = join(workspace, DEFAULT_CONFIG_FILENAME);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        configVersion: 3,
        enabled: true,
        organizationUrl: 'https://dev.azure.com/example-org',
        project: 'agent-execution-layer',
        repositoryId: TEST_REPOSITORY_ID,
        defaultBranch: 'main',
        defaultAgent: 'codex',
        defaultWorkItemType: 'Task',
        defaultAreaPath: '\\agent-execution-layer',
        defaultIterationPath: '\\agent-execution-layer',
        workItemFieldDefaults: {
          create: {},
          done: {},
        },
        sharedTags: ['agent-managed'],
        agents: [
          {
            key: 'codex',
            tag: 'agent:codex',
            branchPrefix: 'codex',
            defaultAssignee: 'owner@example.com',
          },
        ],
        stateMap: {
          new: 'New',
          active: 'Active',
          done: 'Closed',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env = {
    PATH: prependPathEntry(binDir),
    AEL_CMD_GIT: gitCommandPath,
    AEL_CMD_AZ: azCommandPath,
    AEL_TEST_WORKSPACE: workspace,
    AEL_TEST_REMOTE:
      'https://dev.azure.com/example-org/agent-execution-layer/_git/agent-execution-layer',
    AEL_TEST_BRANCH: 'main',
    AEL_TEST_PAT_ONLY: 'true',
    AEL_ADO_PAT: 'test-pat',
  };

  const doctorJson = JSON.parse(runCli(['doctor', '--json'], workspace, env)) as {
    ok: boolean;
    authMode: string;
    checks: Array<{ label: string; ok: boolean; detail: string }>;
  };

  assert.equal(doctorJson.ok, true);
  assert.equal(doctorJson.authMode, 'pat');
  assert.ok(doctorJson.checks.some((check) => check.label === 'azure login' && check.ok));
  assert.ok(
    doctorJson.checks.some((check) => check.label === 'azure devops access token' && check.ok),
  );
  assert.ok(
    doctorJson.checks.some(
      (check) =>
        check.label === 'configured identities' && check.ok && /validated/.test(check.detail),
    ),
  );
});

test('init --force refreshes stale board path defaults', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const { binDir, gitCommandPath, azCommandPath } = installStubCommands(workspace);
  const configPath = join(workspace, DEFAULT_CONFIG_FILENAME);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        configVersion: 3,
        enabled: true,
        organizationUrl: 'https://dev.azure.com/example-org',
        project: 'agent-execution-layer',
        repositoryId: TEST_REPOSITORY_ID,
        defaultBranch: 'main',
        defaultAgent: 'codex',
        defaultWorkItemType: 'Task',
        defaultAreaPath: '\\agent-execution-layer\\Area',
        defaultIterationPath: '\\agent-execution-layer\\Iteration',
        workItemFieldDefaults: {
          create: {},
          done: {},
        },
        sharedTags: ['agent-managed'],
        agents: [
          {
            key: 'codex',
            tag: 'agent:codex',
            branchPrefix: 'codex',
            defaultAssignee: '',
          },
        ],
        stateMap: {
          new: 'New',
          active: 'Active',
          done: 'Closed',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env = {
    PATH: prependPathEntry(binDir),
    AEL_CMD_GIT: gitCommandPath,
    AEL_CMD_AZ: azCommandPath,
    AEL_TEST_WORKSPACE: workspace,
    AEL_TEST_REMOTE:
      'https://dev.azure.com/example-org/agent-execution-layer/_git/agent-execution-layer',
    AEL_TEST_BRANCH: 'main',
  };

  runCli(
    [
      'init',
      '--organization-url',
      'https://dev.azure.com/example-org',
      '--project',
      'agent-execution-layer',
      '--repository',
      'agent-execution-layer',
      '--default-branch',
      'main',
      '--agents',
      'codex',
      '--default-agent',
      'codex',
      '--force',
    ],
    workspace,
    env,
  );

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    defaultAreaPath: string;
    defaultIterationPath: string;
  };
  assert.equal(config.defaultAreaPath, 'agent-execution-layer');
  assert.equal(config.defaultIterationPath, 'agent-execution-layer');
});

test('doctor --adoption passes for a downstream repo installed with defaults', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'adoption-pass-repo', private: true }, null, 2)}\n`,
    'utf8',
  );

  runCli(['install', '--json'], workspace, {});

  const doctorJson = JSON.parse(runCli(['doctor', '--adoption', '--json'], workspace, {})) as {
    ok: boolean;
    mode: string;
    checks: Array<{ label: string; ok: boolean }>;
  };

  assert.equal(doctorJson.ok, true);
  assert.equal(doctorJson.mode, 'adoption');
  assert.ok(doctorJson.checks.some((check) => check.label === 'ael install manifest' && check.ok));
  assert.ok(doctorJson.checks.some((check) => check.label === 'ael settings' && check.ok));
  assert.ok(doctorJson.checks.some((check) => check.label === 'ael root entrypoint' && check.ok));
  assert.ok(doctorJson.checks.some((check) => check.label === 'ael local ignore' && check.ok));
});

test('doctor --adoption fails when external entrypoint instructions are still missing', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'adoption-fail-repo', private: true }, null, 2)}\n`,
    'utf8',
  );

  runCli(
    ['install', '--no-root-agents', '--entrypoint-file', 'docs/TEAM.md', '--json'],
    workspace,
    {},
  );

  let stdout = '';
  try {
    runCli(['doctor', '--adoption', '--json'], workspace, {});
    assert.fail('expected adoption doctor to fail');
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout ?? '');
  }

  const doctorJson = JSON.parse(stdout) as {
    ok: boolean;
    mode: string;
    checks: Array<{ label: string; ok: boolean; detail: string }>;
    nextSteps: string[];
  };

  assert.equal(doctorJson.ok, false);
  assert.equal(doctorJson.mode, 'adoption');
  assert.ok(
    doctorJson.checks.some(
      (check) => check.label === 'ael external entrypoint' && check.ok === false,
    ),
  );
  assert.match(normalizeSlashes(doctorJson.nextSteps[0] ?? ''), /docs\/TEAM\.md/);
});
