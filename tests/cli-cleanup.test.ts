import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type {
  BranchCleanupCandidate,
  PullRequestCleanupCandidate,
} from '../scripts/lib/ado-cli-types.js';
import {
  DEFAULT_CONFIG_FILENAME,
  DEFAULT_CONFIG_VERSION,
  DEFAULT_PR_DEFAULTS,
  DEFAULT_REPORT_DEFAULTS,
} from '../scripts/lib/config.js';
import { execLocalBin, prependPathEntry, writeCommandStub } from './test-helpers.js';

const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI_PATH = join(REPO_ROOT, 'scripts', 'ael.ts');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ael-cleanup-test-'));
}

function writeConfig(workspace: string): void {
  const configPath = join(workspace, DEFAULT_CONFIG_FILENAME);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        configVersion: DEFAULT_CONFIG_VERSION,
        enabled: true,
        organizationUrl: 'https://dev.azure.com/example-org',
        project: 'example-project',
        repositoryId: 'example-repo-id',
        defaultBranch: 'main',
        defaultAgent: 'codex',
        defaultWorkItemType: 'Task',
        defaultAreaPath: 'example-project',
        defaultIterationPath: 'example-project',
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
        prDefaults: DEFAULT_PR_DEFAULTS,
        reportDefaults: DEFAULT_REPORT_DEFAULTS,
        cleanupDefaults: {
          staleBranchDays: 14,
          stalePullRequestDays: 7,
        },
        coordination: {
          areaTags: ['auth', 'frontend'],
          humanBlockReasons: {
            'waiting-on-human': 'waiting-on-human',
            'human-approval-needed': 'human-approval-needed',
            'external-setup-needed': 'external-setup-needed',
          },
        },
        branching: {
          developmentBranches: ['main'],
          rolloutBranches: ['prod'],
          branchAliases: {
            default: 'main',
            main: 'main',
            prod: 'prod',
          },
        },
        hierarchyDefaults: {
          initiativeType: 'Initiative',
          featureType: 'Feature',
          backlogItemType: 'Product Backlog Item',
          taskType: 'Task',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function installStubCommands(workspace: string): {
  binDir: string;
  gitStatePath: string;
  azStatePath: string;
} {
  const binDir = join(workspace, 'bin');
  const gitStatePath = join(workspace, 'git-state.json');
  const azStatePath = join(workspace, 'az-state.json');
  mkdirSync(binDir, { recursive: true });

  writeCommandStub(
    binDir,
    'git',
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.AEL_CLEANUP_GIT_STATE;

function loadState() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n', 'utf8');
}

function out(value) {
  process.stdout.write(value);
}

function fail() {
  process.stderr.write('unsupported git args: ' + args.join(' ') + '\\n');
  process.exit(1);
}

const state = loadState();

if (args[0] === 'branch' && args[1] === '--show-current') {
  out(state.currentBranch + '\\n');
} else if (args[0] === 'for-each-ref') {
  const scope = args[1] ?? '';
  const refs = scope.includes('refs/remotes/origin') ? state.remoteBranches : state.localBranches;
  out(
    refs
      .map(entry => {
        const prefix = scope.includes('refs/remotes/origin') ? 'origin/' : '';
        return prefix + entry.name + '|' + String(entry.timestamp ?? 0);
      })
      .join('\\n') + '\\n',
  );
} else if (args[0] === 'branch' && args[1] === '--merged') {
  out(state.mergedLocalBranches.map(name => '  ' + name).join('\\n') + (state.mergedLocalBranches.length ? '\\n' : ''));
} else if (args[0] === 'branch' && args[1] === '-r' && args[2] === '--merged') {
  out(state.mergedRemoteBranches.map(name => '  origin/' + name).join('\\n') + (state.mergedRemoteBranches.length ? '\\n' : ''));
} else if (args[0] === 'branch' && (args[1] === '-d' || args[1] === '-D')) {
  const branch = args[2];
  state.localBranches = state.localBranches.filter(entry => entry.name !== branch);
  state.mergedLocalBranches = state.mergedLocalBranches.filter(entry => entry !== branch);
  saveState(state);
} else if (args[0] === 'push' && args[1] === 'origin' && args[2] === '--delete') {
  const branch = args[3];
  state.remoteBranches = state.remoteBranches.filter(entry => entry.name !== branch);
  state.mergedRemoteBranches = state.mergedRemoteBranches.filter(entry => entry !== branch);
  saveState(state);
} else if (args[0] === 'ls-remote' && args[1] === '--exit-code' && args[2] === '--heads') {
  const branch = args[4];
  const exists = state.remoteBranches.some(entry => entry.name === branch);
  if (!exists) process.exit(2);
  out('deadbeef\\trefs/heads/' + branch + '\\n');
} else if (args[0] === 'rev-list' && args[1] === '--left-right' && args[2] === '--count') {
  const ref = args[3] ?? '';
  const match = ref.match(/^origin\\/(.+)\\.\\.\\.origin\\/(.+)$/);
  const key = match ? match[2] + '=>' + match[1] : ref;
  const counts = state.aheadCounts[key] ?? { behind: 0, ahead: 1 };
  out(String(counts.behind) + ' ' + String(counts.ahead) + '\\n');
} else {
  fail();
}
`,
  );

  writeCommandStub(
    binDir,
    'az',
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.AEL_CLEANUP_AZ_STATE;

function loadState() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n', 'utf8');
}

function outJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function ensureItem(state, id) {
  const item = state.workItems[String(id)];
  if (!item) {
    process.stderr.write('unknown work item ' + id + '\\n');
    process.exit(1);
  }
  return item;
}

function ensurePullRequest(state, prId) {
  const pr = state.pullRequests.find(entry => Number(entry.pullRequestId) === Number(prId));
  if (!pr) {
    process.stderr.write('unknown pull request ' + prId + '\\n');
    process.exit(1);
  }
  return pr;
}

function fail() {
  process.stderr.write('unsupported az args: ' + args.join(' ') + '\\n');
  process.exit(1);
}

const state = loadState();

if (args[0] === 'boards' && args[1] === 'work-item' && args[2] === 'show') {
  outJson(ensureItem(state, Number(value('--id'))));
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'list') {
  const status = value('--status');
  const prs = state.pullRequests.filter(pr => (status ? pr.status === status : true));
  outJson(prs);
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'work-item' && args[3] === 'list') {
  const pr = ensurePullRequest(state, Number(value('--id')));
  outJson((pr.workItemIds ?? []).map(id => ({ id })));
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'update') {
  const pr = ensurePullRequest(state, Number(value('--id')));
  const status = value('--status');
  if (status) pr.status = status;
  saveState(state);
  outJson(pr);
} else {
  fail();
}
`,
  );

  return { binDir, gitStatePath, azStatePath };
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

test('cleanup-branches identifies merged, closed-item, and stale branches and only deletes safe defaults', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeConfig(workspace);

  const { binDir, gitStatePath, azStatePath } = installStubCommands(workspace);
  writeFileSync(
    gitStatePath,
    `${JSON.stringify(
      {
        currentBranch: 'main',
        localBranches: [
          { name: 'main', timestamp: 1762000000 },
          { name: 'prod', timestamp: 1762000000 },
          { name: 'codex/201-finished-work', timestamp: 1760000000 },
          { name: 'claude/202-stale-no-pr', timestamp: 1757000000 },
        ],
        remoteBranches: [
          { name: 'main', timestamp: 1762000000 },
          { name: 'prod', timestamp: 1762000000 },
          { name: 'codex/201-finished-work', timestamp: 1760000000 },
          { name: 'claude/202-stale-no-pr', timestamp: 1757000000 },
        ],
        mergedLocalBranches: ['codex/201-finished-work'],
        mergedRemoteBranches: ['codex/201-finished-work'],
        aheadCounts: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    azStatePath,
    `${JSON.stringify(
      {
        workItems: {
          '201': {
            id: 201,
            fields: {
              'System.Title': 'Finished work',
              'System.State': 'Closed',
              'System.WorkItemType': 'Task',
            },
          },
          '202': {
            id: 202,
            fields: {
              'System.Title': 'Old branch no PR',
              'System.State': 'Active',
              'System.WorkItemType': 'Task',
            },
          },
        },
        pullRequests: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env = {
    PATH: prependPathEntry(binDir),
    AEL_CLEANUP_GIT_STATE: gitStatePath,
    AEL_CLEANUP_AZ_STATE: azStatePath,
  };

  const preview = JSON.parse(
    runCli(
      ['cleanup-branches', '--delete-local', '--delete-remote', '--dry-run', '--json'],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    candidateCount: number;
    candidates: BranchCleanupCandidate[];
    deleted: string[];
    warnings: string[];
  };

  assert.equal(preview.ok, true);
  assert.equal(preview.candidateCount, 4);
  assert.ok(
    preview.candidates.some(
      (candidate) =>
        candidate.branch === 'codex/201-finished-work' &&
        candidate.reason.includes('merged into main'),
    ),
  );
  assert.ok(
    preview.candidates.some(
      (candidate) =>
        candidate.branch === 'claude/202-stale-no-pr' && candidate.reason.includes('stale for'),
    ),
  );
  assert.deepEqual(preview.deleted, []);

  const applied = JSON.parse(
    runCli(['cleanup-branches', '--delete-local', '--delete-remote', '--json'], workspace, env),
  ) as {
    deleted: string[];
    warnings: string[];
  };
  assert.deepEqual(applied.deleted, ['codex/201-finished-work', 'codex/201-finished-work']);
  assert.ok(applied.warnings.some((warning) => warning.includes('claude/202-stale-no-pr')));

  const gitState = JSON.parse(readFileSync(gitStatePath, 'utf8')) as {
    localBranches: Array<{ name: string }>;
    remoteBranches: Array<{ name: string }>;
  };
  assert.ok(!gitState.localBranches.some((entry) => entry.name === 'codex/201-finished-work'));
  assert.ok(!gitState.remoteBranches.some((entry) => entry.name === 'codex/201-finished-work'));
  assert.ok(gitState.localBranches.some((entry) => entry.name === 'claude/202-stale-no-pr'));
});

test('cleanup-prs identifies stale drafts, closed-item PRs, and missing/fully-merged source branches', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeConfig(workspace);

  const { binDir, gitStatePath, azStatePath } = installStubCommands(workspace);
  writeFileSync(
    gitStatePath,
    `${JSON.stringify(
      {
        currentBranch: 'main',
        localBranches: [{ name: 'main', timestamp: 1762000000 }],
        remoteBranches: [
          { name: 'main', timestamp: 1762000000 },
          { name: 'prod', timestamp: 1762000000 },
          { name: 'codex/202-stale-draft', timestamp: 1757000000 },
          { name: 'codex/201-finished', timestamp: 1760000000 },
        ],
        mergedLocalBranches: [],
        mergedRemoteBranches: [],
        aheadCounts: {
          'codex/201-finished=>main': { behind: 0, ahead: 0 },
          'codex/202-stale-draft=>main': { behind: 0, ahead: 3 },
          'codex/204-missing=>prod': { behind: 0, ahead: 1 },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    azStatePath,
    `${JSON.stringify(
      {
        workItems: {
          '201': {
            id: 201,
            fields: {
              'System.Title': 'Finished work',
              'System.State': 'Closed',
              'System.WorkItemType': 'Task',
            },
          },
          '202': {
            id: 202,
            fields: {
              'System.Title': 'Draft work',
              'System.State': 'Active',
              'System.WorkItemType': 'Task',
            },
          },
          '204': {
            id: 204,
            fields: {
              'System.Title': 'Missing source',
              'System.State': 'Active',
              'System.WorkItemType': 'Task',
            },
          },
        },
        pullRequests: [
          {
            pullRequestId: 301,
            title: 'AB#202 stale draft',
            sourceRefName: 'refs/heads/codex/202-stale-draft',
            targetRefName: 'refs/heads/main',
            status: 'active',
            isDraft: true,
            creationDate: '2026-02-20T00:00:00.000Z',
            workItemIds: [202],
          },
          {
            pullRequestId: 302,
            title: 'AB#201 finished',
            sourceRefName: 'refs/heads/codex/201-finished',
            targetRefName: 'refs/heads/main',
            status: 'active',
            isDraft: false,
            creationDate: '2026-03-01T00:00:00.000Z',
            workItemIds: [201],
          },
          {
            pullRequestId: 303,
            title: 'AB#204 missing source',
            sourceRefName: 'refs/heads/codex/204-missing',
            targetRefName: 'refs/heads/prod',
            status: 'active',
            isDraft: false,
            creationDate: '2026-03-01T00:00:00.000Z',
            workItemIds: [204],
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env = {
    PATH: prependPathEntry(binDir),
    AEL_CLEANUP_GIT_STATE: gitStatePath,
    AEL_CLEANUP_AZ_STATE: azStatePath,
  };

  const preview = JSON.parse(runCli(['cleanup-prs', '--json'], workspace, env)) as {
    ok: boolean;
    candidateCount: number;
    candidates: PullRequestCleanupCandidate[];
    abandoned: number[];
  };

  assert.equal(preview.ok, true);
  assert.equal(preview.candidateCount, 3);
  assert.ok(
    preview.candidates.some(
      (candidate) => candidate.pullRequestId === 301 && candidate.reason.includes('stale draft'),
    ),
  );
  assert.ok(
    preview.candidates.some(
      (candidate) =>
        candidate.pullRequestId === 302 &&
        candidate.reason.includes('linked work items are already closed'),
    ),
  );
  assert.ok(
    preview.candidates.some(
      (candidate) =>
        candidate.pullRequestId === 303 &&
        candidate.reason.includes('source branch is missing on origin'),
    ),
  );
  assert.deepEqual(preview.abandoned, []);

  const applied = JSON.parse(runCli(['cleanup-prs', '--abandon', '--json'], workspace, env)) as {
    abandoned: number[];
  };
  assert.deepEqual(applied.abandoned, [301, 302, 303]);

  const azState = JSON.parse(readFileSync(azStatePath, 'utf8')) as {
    pullRequests: Array<{ pullRequestId: number; status: string }>;
  };
  assert.ok(azState.pullRequests.every((pr) => pr.status === 'abandoned'));
});
