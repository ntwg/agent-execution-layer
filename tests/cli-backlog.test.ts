import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG_FILENAME, DEFAULT_SETTINGS_FILENAME } from '../scripts/lib/config.js';

const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_PATH = join(REPO_ROOT, 'scripts', 'ael.ts');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ael-backlog-test-'));
}

function runCli(args: string[], workspace: string): string {
  return execFileSync(TSX_BIN, [CLI_PATH, ...args], {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
  });
}

test('backlog-create renders the customizable settings template with repo context', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'downstream-backlog-repo',
        private: true,
        scripts: {
          'ael:status': 'ael status --json',
          'ael:create': 'ael create',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const configPath = join(workspace, DEFAULT_CONFIG_FILENAME);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        configVersion: 3,
        enabled: true,
        organizationUrl: 'https://dev.azure.com/example-org',
        project: 'Downstream Project',
        repositoryId: '11111111-1111-1111-1111-111111111111',
        defaultBranch: 'main',
        defaultAgent: 'claude',
        defaultWorkItemType: 'Task',
        defaultAreaPath: 'Downstream Project',
        defaultIterationPath: 'Downstream Project',
        workItemFieldDefaults: {
          create: {},
          done: {},
        },
        sharedTags: ['agent-managed', 'platform'],
        agents: [
          {
            key: 'claude',
            tag: 'agent:claude',
            branchPrefix: 'claude',
            defaultAssignee: '',
          },
        ],
        stateMap: {
          new: 'New',
          active: 'Active',
          done: 'Closed',
        },
        prDefaults: {
          reviewerMode: 'off',
          reviewerRequired: false,
          syncWorkItemTags: true,
          syncTagMode: 'non-agent',
        },
        reportDefaults: {
          staleDays: 7,
          recentDays: 7,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const settingsPath = join(workspace, DEFAULT_SETTINGS_FILENAME);
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        promptTemplates: {
          backlogCreate:
            'Repo={{REPOSITORY_NAME}} Agent={{DEFAULT_AGENT_KEY}} Status={{WORKFLOW_STATUS_COMMAND}} Create={{WORKFLOW_CREATE_COMMAND}} Settings={{AEL_SETTINGS_PATH}}',
          backlogPolish: 'unused',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = JSON.parse(runCli(['backlog-create', '--json'], workspace)) as {
    ok: boolean;
    settingsSource: string;
    settingsPath: string;
    warnings: string[];
    prompt: string;
  };

  assert.equal(result.ok, true);
  assert.equal(result.settingsSource, 'workspace');
  assert.equal(realpathSync(result.settingsPath), realpathSync(settingsPath));
  assert.deepEqual(result.warnings, []);
  assert.match(result.prompt, /Repo=downstream-backlog-repo/);
  assert.match(result.prompt, /Agent=claude/);
  assert.match(result.prompt, /Status=npm run ael:status/);
  assert.match(result.prompt, /Create=npm run ael:create -- --title/);
  assert.match(result.prompt, /Settings=.ael\/settings\.json/);
});

test('backlog-polish falls back to bundled defaults when settings are missing', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'fallback-backlog-repo', private: true }, null, 2)}\n`,
    'utf8',
  );

  const result = JSON.parse(runCli(['backlog-polish', '--json'], workspace)) as {
    ok: boolean;
    settingsSource: string;
    warnings: string[];
    prompt: string;
  };

  assert.equal(result.ok, true);
  assert.equal(result.settingsSource, 'template');
  assert.ok(result.warnings.some((warning) => warning.includes('.ael/settings.json')));
  assert.match(result.prompt, /Improve the clarity, sequencing, metadata, and execution-readiness/);
  assert.match(result.prompt, /fallback-backlog-repo/);
});
