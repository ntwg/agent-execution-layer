import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
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
  return mkdtempSync(join(tmpdir(), 'ael-write-json-test-'));
}

function installStubCommands(workspace: string): {
  binDir: string;
  gitCommandPath: string;
  azCommandPath: string;
  curlCommandPath: string;
  gitStatePath: string;
  azStatePath: string;
} {
  const binDir = join(workspace, 'bin');
  const gitStatePath = join(workspace, 'git-state.json');
  const azStatePath = join(workspace, 'az-state.json');
  mkdirSync(binDir, { recursive: true });

  const gitCommandPath = writeCommandStub(
    binDir,
    'git',
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.AEL_WRITE_GIT_STATE;

function loadState() {
  if (!statePath || !fs.existsSync(statePath)) {
    return {
      currentBranch: 'main',
      branches: ['main'],
      remoteBranches: ['main'],
      commits: [],
    };
  }
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
} else if (args[0] === 'branch' && args[1] === '--list') {
  const name = args[2];
  if (state.branches.includes(name)) out('  ' + name + '\\n');
} else if (args[0] === 'branch' && args[1] === '-r' && args[2] === '--list') {
  const ref = args[3] ?? '';
  const name = ref.replace(/^origin\\//, '');
  if (state.remoteBranches.includes(name)) out('  origin/' + name + '\\n');
} else if (args[0] === 'checkout' && args[1] === '-b') {
  const name = args[2];
  if (!state.branches.includes(name)) state.branches.push(name);
  state.currentBranch = name;
  saveState(state);
} else if (args[0] === 'checkout' && args[1] === '--track') {
  const ref = args[2] ?? '';
  const name = ref.replace(/^origin\\//, '');
  if (!state.branches.includes(name)) state.branches.push(name);
  state.currentBranch = name;
  saveState(state);
} else if (args[0] === 'checkout' && typeof args[1] === 'string') {
  const name = args[1];
  if (!state.branches.includes(name)) state.branches.push(name);
  state.currentBranch = name;
  saveState(state);
} else if (args[0] === 'push' && args[1] === '-u' && args[2] === 'origin') {
  const name = args[3];
  if (!state.remoteBranches.includes(name)) state.remoteBranches.push(name);
  saveState(state);
} else if (args[0] === 'add') {
  process.exit(0);
} else if (args[0] === 'commit') {
  const messages = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-m') {
      messages.push(args[index + 1] ?? '');
      index += 1;
    }
  }
  const message = messages.join('\\n\\n');
  const hash = 'commit' + String(state.commits.length + 1);
  state.commits.push({ hash, message });
  saveState(state);
  out('[' + state.currentBranch + ' ' + hash + '] ' + (messages[0] ?? '') + '\\n');
} else if (args[0] === 'log') {
  const grepIndex = args.indexOf('--grep');
  const pattern = grepIndex >= 0 ? args[grepIndex + 1] : '';
  const match = [...state.commits].reverse().find(commit => commit.message.includes(pattern));
  if (match) out(match.hash + '\\n');
} else {
  fail();
}
`,
  );

  const azCommandPath = writeCommandStub(
    binDir,
    'az',
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.AEL_WRITE_AZ_STATE;

function loadState() {
  if (!statePath || !fs.existsSync(statePath)) {
    return {
      nextWorkItemId: 100,
      nextPrId: 200,
      workItems: {},
      pullRequests: [],
    };
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n', 'utf8');
}

function outJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function out(value) {
  process.stdout.write(value);
}

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function values(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return [];
  const collected = [];
  for (let cursor = index + 1; cursor < args.length; cursor += 1) {
    if (args[cursor].startsWith('--')) break;
    collected.push(args[cursor]);
  }
  return collected;
}

function joinedValue(flag) {
  const collected = values(flag);
  if (collected.length > 0) return collected.join('\\n');
  return value(flag);
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

function applyFields(target, fieldArgs) {
  for (const entry of fieldArgs) {
    const separator = entry.indexOf('=');
    const key = separator >= 0 ? entry.slice(0, separator) : entry;
    const rawValue = separator >= 0 ? entry.slice(separator + 1) : '';
    target.fields[key] = key === 'Microsoft.VSTS.Common.Priority' ? Number(rawValue) : rawValue;
  }
}

function touchItem(item, changedDate = '2026-03-09T12:00:00.000Z') {
  item.fields['System.ChangedDate'] = changedDate;
}

function fail() {
  process.stderr.write('unsupported az args: ' + args.join(' ') + '\\n');
  process.exit(1);
}

const state = loadState();

if (args[0] === 'account' && args[1] === 'get-access-token') {
  out('test-access-token\\n');
} else if (args[0] === 'devops' && args[1] === 'user' && args[2] === 'show') {
  const user = value('--user') ?? 'owner@example.com';
  outJson({
    user: {
      displayName: user,
      mailAddress: user,
      principalName: user,
      uniqueName: user,
    },
  });
} else if (args[0] === 'boards' && args[1] === 'work-item' && args[2] === 'create') {
  const id = state.nextWorkItemId++;
  const item = {
    id,
    fields: {
      'System.Title': value('--title') ?? '',
      'System.State': 'New',
      'System.Description': joinedValue('--description') ?? '',
      'System.WorkItemType': value('--type') ?? 'Task',
    },
    relations: [],
    discussions: [],
    comments: [],
  };
  const assignedTo = value('--assigned-to');
  if (assignedTo) item.fields['System.AssignedTo'] = assignedTo;
  applyFields(item, values('--fields'));
  touchItem(item);
  state.workItems[String(id)] = item;
  saveState(state);
  outJson(item);
} else if (args[0] === 'boards' && args[1] === 'work-item' && args[2] === 'update') {
  const id = Number(value('--id'));
  const item = ensureItem(state, id);
  const stateValue = value('--state');
  if (stateValue) item.fields['System.State'] = stateValue;
  const assignedTo = value('--assigned-to');
  if (assignedTo) item.fields['System.AssignedTo'] = assignedTo;
  const description = joinedValue('--description');
  if (description) item.fields['System.Description'] = description;
  applyFields(item, values('--fields'));
  const discussion = value('--discussion');
  if (discussion) item.discussions.push(discussion);
  touchItem(item);
  saveState(state);
  outJson(item);
} else if (args[0] === 'boards' && args[1] === 'work-item' && args[2] === 'show') {
  const id = Number(value('--id'));
  outJson(ensureItem(state, id));
} else if (args[0] === 'boards' && args[1] === 'query') {
  const wiql = value('--wiql') ?? '';
  const matches = Object.values(state.workItems).filter(item => {
    const stateValue = String(item.fields['System.State'] ?? '');
    const typeValue = String(item.fields['System.WorkItemType'] ?? '');
    const tags = String(item.fields['System.Tags'] ?? '').split(';').map(tag => tag.trim()).filter(Boolean);
    if (wiql.includes("[System.WorkItemType] = 'Task'") && typeValue !== 'Task') return false;
    if (wiql.includes("[System.State] = 'New'") && stateValue !== 'New') return false;
    if (wiql.includes("[System.State] = 'Active'") && stateValue !== 'Active') return false;
    if (wiql.includes("[System.State] = 'Closed'") && stateValue !== 'Closed') return false;
    if (wiql.includes("[System.State] <> 'Closed'") && stateValue === 'Closed') return false;
    const containsMatches = [...wiql.matchAll(/\\[System\\.Tags\\] CONTAINS '([^']+)'/g)];
    for (const match of containsMatches) {
      if (!tags.some(tag => tag.toLowerCase() === match[1].toLowerCase())) return false;
    }
    const notContainsMatches = [...wiql.matchAll(/\\[System\\.Tags\\] NOT CONTAINS '([^']+)'/g)];
    for (const match of notContainsMatches) {
      if (tags.some(tag => tag.toLowerCase() === match[1].toLowerCase())) return false;
    }
    return true;
  }).sort((left, right) => {
    const leftPriority = Number(left.fields['Microsoft.VSTS.Common.Priority'] ?? 999);
    const rightPriority = Number(right.fields['Microsoft.VSTS.Common.Priority'] ?? 999);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftChanged = Date.parse(String(left.fields['System.ChangedDate'] ?? '1970-01-01T00:00:00.000Z'));
    const rightChanged = Date.parse(String(right.fields['System.ChangedDate'] ?? '1970-01-01T00:00:00.000Z'));
    return rightChanged - leftChanged;
  }).map(item => ({ id: item.id }));
  outJson(matches);
} else if (args[0] === 'boards' && args[1] === 'work-item' && args[2] === 'relation' && args[3] === 'add') {
  const id = Number(value('--id'));
  const item = ensureItem(state, id);
  const relationType = value('--relation-type') ?? '';
  const targetIdRaw = value('--target-id') ?? '';
  for (const targetId of targetIdRaw.split(',').filter(Boolean)) {
    item.relations.push({
      rel: relationType,
      url: 'https://example.dev/workItems/' + targetId,
    });
  }
  touchItem(item);
  saveState(state);
  outJson(item);
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'list') {
  const sourceBranch = value('--source-branch');
  const targetBranch = value('--target-branch');
  const status = value('--status');
  const matches = state.pullRequests.filter(pr =>
    (sourceBranch ? pr.sourceBranch === sourceBranch : true) &&
    (targetBranch ? pr.targetBranch === targetBranch : true) &&
    (status ? pr.status === status : true)
  ).map(pr => ({
    pullRequestId: pr.pullRequestId,
    title: pr.title,
    description: pr.description,
    sourceRefName: pr.sourceRefName,
    targetRefName: pr.targetRefName,
    status: pr.status,
    isDraft: pr.isDraft,
    repository: pr.repository,
    reviewers: pr.reviewers,
  }));
  outJson(matches);
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'create') {
  const pullRequestId = state.nextPrId++;
  const sourceBranch = value('--source-branch') ?? '';
  const targetBranch = value('--target-branch') ?? '';
  const pr = {
    pullRequestId,
    title: value('--title') ?? '',
    description: joinedValue('--description') ?? '',
    sourceBranch,
    targetBranch,
    sourceRefName: 'refs/heads/' + sourceBranch,
    targetRefName: 'refs/heads/' + targetBranch,
    status: 'active',
    isDraft: value('--draft') === 'true',
    repository: { webUrl: 'https://dev.azure.com/example-org/example-project/_git/example-repo' },
    workItemIds: values('--work-items').map(id => Number(id)).filter(Number.isFinite),
    labels: [],
    reviewers: [],
  };
  state.pullRequests.push(pr);
  saveState(state);
  outJson({
    pullRequestId: pr.pullRequestId,
    repository: pr.repository,
  });
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'show') {
  outJson(ensurePullRequest(state, Number(value('--id'))));
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'work-item' && args[3] === 'list') {
  const pr = ensurePullRequest(state, Number(value('--id')));
  outJson((pr.workItemIds ?? []).map(id => ({ id })));
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'update') {
  const pr = ensurePullRequest(state, Number(value('--id')));
  const description = joinedValue('--description');
  if (description) pr.description = description;
  saveState(state);
  outJson(pr);
} else if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'reviewer' && args[3] === 'add') {
  const pr = ensurePullRequest(state, Number(value('--id')));
  const reviewer = value('--reviewers');
  if (reviewer) {
    pr.reviewers.push({
      displayName: reviewer,
      uniqueName: reviewer,
      vote: 0,
      isRequired: value('--required') === 'true',
    });
  }
  saveState(state);
  outJson({ ok: true });
} else {
  fail();
}
`,
  );

  const curlCommandPath = writeCommandStub(
    binDir,
    'curl',
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.AEL_WRITE_AZ_STATE;

function loadState() {
  if (!statePath || !fs.existsSync(statePath)) {
    return {
      nextWorkItemId: 100,
      nextPrId: 200,
      workItems: {},
      pullRequests: [],
    };
  }
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
  process.stderr.write('unsupported curl args: ' + args.join(' ') + '\\n');
  process.exit(1);
}

const state = loadState();
const method = value('-X') ?? 'GET';
const body = value('--data');
const url = args[args.length - 1];
if (!url || url.startsWith('-')) fail();
const parsed = new URL(url);

if (method === 'GET' && parsed.pathname.includes('/_apis/wit/workitems')) {
  const ids = (parsed.searchParams.get('ids') ?? '')
    .split(',')
    .map(entry => Number(entry))
    .filter(Number.isFinite);
  outJson({
    value: ids.map(id => ensureItem(state, id)),
  });
} else if (method === 'GET' && /\\/workItems\\/\\d+\\/comments$/i.test(parsed.pathname)) {
  const match = parsed.pathname.match(/\\/workItems\\/(\\d+)\\/comments$/i);
  const item = ensureItem(state, Number(match[1]));
  outJson({
    comments: item.comments ?? [],
  });
} else if (method === 'PATCH' && /\\/workItems\\/\\d+\\/comments\\/\\d+$/i.test(parsed.pathname)) {
  const match = parsed.pathname.match(/\\/workItems\\/(\\d+)\\/comments\\/(\\d+)$/i);
  const item = ensureItem(state, Number(match[1]));
  const commentId = Number(match[2]);
  const payload = JSON.parse(body ?? '{}');
  item.comments = (item.comments ?? []).map(comment =>
    Number(comment.id) === commentId
      ? { ...comment, text: String(payload.text ?? comment.text) }
      : comment,
  );
  saveState(state);
  outJson({ ok: true });
} else if (method === 'GET' && /\\/pullRequests\\/\\d+\\/labels$/i.test(parsed.pathname)) {
  const match = parsed.pathname.match(/\\/pullRequests\\/(\\d+)\\/labels$/i);
  const pr = ensurePullRequest(state, Number(match[1]));
  outJson({
    value: (pr.labels ?? []).map(name => ({ name })),
  });
} else if (method === 'POST' && /\\/pullRequests\\/\\d+\\/labels$/i.test(parsed.pathname)) {
  const match = parsed.pathname.match(/\\/pullRequests\\/(\\d+)\\/labels$/i);
  const pr = ensurePullRequest(state, Number(match[1]));
  const payload = JSON.parse(body ?? '{}');
  const label = String(payload.name ?? '').trim();
  if (label && !(pr.labels ?? []).some(existing => existing.toLowerCase() === label.toLowerCase())) {
    pr.labels = [...(pr.labels ?? []), label];
  }
  saveState(state);
  outJson({ name: label });
} else if (method === 'PATCH' && /\\/workitems\\/\\d+$/i.test(parsed.pathname)) {
  const match = parsed.pathname.match(/\\/workitems\\/(\\d+)$/i);
  const item = ensureItem(state, Number(match[1]));
  const payload = JSON.parse(body ?? '[]');
  for (const operation of payload) {
    if (operation.path === '/fields/System.Tags') {
      item.fields['System.Tags'] = String(operation.value ?? '');
    }
  }
  saveState(state);
  if (value('-o') !== '/dev/null') outJson({ ok: true });
} else {
  fail();
}
`,
  );

  return {
    binDir,
    gitCommandPath,
    azCommandPath,
    curlCommandPath,
    gitStatePath,
    azStatePath,
  };
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
          create: {
            'Custom.AgentManaged': true,
          },
          done: {
            'Custom.CompletionChannel': 'ael',
          },
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
        prDefaults: DEFAULT_PR_DEFAULTS,
        reportDefaults: DEFAULT_REPORT_DEFAULTS,
        cleanupDefaults: {
          staleBranchDays: 14,
          stalePullRequestDays: 7,
        },
        coordination: {
          areaTags: ['auth', 'db', 'frontend', 'pipeline', 'infra', 'migration'],
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

function writeAzState(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

test('write-side commands emit structured json', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const { binDir, gitCommandPath, azCommandPath, curlCommandPath, gitStatePath, azStatePath } =
    installStubCommands(workspace);
  writeConfig(workspace);

  const env = {
    PATH: prependPathEntry(binDir),
    AEL_CMD_GIT: gitCommandPath,
    AEL_CMD_AZ: azCommandPath,
    AEL_CMD_CURL: curlCommandPath,
    AEL_WRITE_GIT_STATE: gitStatePath,
    AEL_WRITE_AZ_STATE: azStatePath,
  };

  const created = JSON.parse(
    runCli(
      [
        'create',
        '--title',
        'JSON command flow',
        '--human-summary',
        'Make command outputs machine-readable',
        '--agent-context',
        'Add --json support to mutating commands.',
        '--kind',
        'feature',
        '--priority',
        '1',
        '--tags',
        'automation;cli',
        '--json',
      ],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    workItem: {
      id: number;
      title: string;
      kind?: string;
      type: string;
      priority?: number;
      tags: string[];
      fieldsApplied: Record<string, string | number | boolean>;
    };
    warnings: string[];
  };
  assert.equal(created.ok, true);
  assert.equal(created.workItem.id, 100);
  assert.equal(created.workItem.title, 'JSON command flow');
  assert.equal(created.workItem.kind, 'feature');
  assert.equal(created.workItem.type, 'Feature');
  assert.equal(created.workItem.priority, 1);
  assert.deepEqual(created.workItem.tags, ['agent-managed', 'automation', 'cli']);
  assert.equal(created.workItem.fieldsApplied['Custom.AgentManaged'], true);
  assert.equal(created.workItem.fieldsApplied['System.Tags'], 'agent-managed;automation;cli');
  assert.equal(created.workItem.fieldsApplied['Microsoft.VSTS.Common.Priority'], 1);
  assert.deepEqual(created.warnings, []);

  const claimed = JSON.parse(
    runCli(
      [
        'claim',
        '--id',
        '100',
        '--agent',
        'codex',
        '--assigned-to',
        'owner@example.com',
        '--note',
        'Taking ownership.',
        '--json',
      ],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    id: number;
    state: string;
    agent: string;
    tags: string[];
  };
  assert.equal(claimed.ok, true);
  assert.equal(claimed.id, 100);
  assert.equal(claimed.state, 'Active');
  assert.equal(claimed.agent, 'codex');
  assert.ok(claimed.tags.includes('agent:codex'));

  const blocked = JSON.parse(
    runCli(
      [
        'block',
        '--id',
        '100',
        '--reason',
        'human-approval-needed',
        '--note',
        'Waiting for a human reviewer.',
        '--json',
      ],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    id: number;
    reason: string;
    tags: string[];
  };
  assert.equal(blocked.ok, true);
  assert.equal(blocked.id, 100);
  assert.equal(blocked.reason, 'human-approval-needed');
  assert.ok(blocked.tags.includes('human-approval-needed'));

  const unblocked = JSON.parse(
    runCli(
      ['unblock', '--id', '100', '--reason', 'human-approval-needed', '--json'],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    id: number;
    removedTags: string[];
    tags: string[];
  };
  assert.equal(unblocked.ok, true);
  assert.equal(unblocked.id, 100);
  assert.deepEqual(unblocked.removedTags, ['human-approval-needed']);
  assert.ok(!unblocked.tags.includes('human-approval-needed'));

  const branched = JSON.parse(
    runCli(
      [
        'branch',
        '--id',
        '100',
        '--agent',
        'codex',
        '--branch-name',
        'codex/100-json-command-flow',
        '--base',
        'main',
        '--json',
      ],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    branchName: string;
    baseBranch: string;
  };
  assert.equal(branched.ok, true);
  assert.equal(branched.branchName, 'codex/100-json-command-flow');
  assert.equal(branched.baseBranch, 'main');

  const committed = JSON.parse(
    runCli(
      ['commit', '--id', '100', '--message', 'Add structured CLI output', '--all', '--json'],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    id: number;
    subject: string;
    addAll: boolean;
  };
  assert.equal(committed.ok, true);
  assert.equal(committed.id, 100);
  assert.equal(committed.subject, 'AB#100 Add structured CLI output');
  assert.equal(committed.addAll, true);

  const pullRequest = JSON.parse(
    runCli(
      ['pr', '--id', '100', '--ready', '--target', 'prod', '--no-sync-pr-tags', '--json'],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    created: boolean;
    pullRequestId: number;
    draft: boolean;
    currentBranch: string;
    targetBranch: string;
    syncPrTags: boolean;
    url?: string;
  };
  assert.equal(pullRequest.ok, true);
  assert.equal(pullRequest.created, true);
  assert.equal(pullRequest.pullRequestId, 200);
  assert.equal(pullRequest.draft, false);
  assert.equal(pullRequest.currentBranch, 'codex/100-json-command-flow');
  assert.equal(pullRequest.targetBranch, 'prod');
  assert.equal(pullRequest.syncPrTags, false);
  assert.ok(pullRequest.url);

  const existingPullRequest = JSON.parse(
    runCli(
      ['pr', '--id', '100', '--ready', '--target', 'prod', '--no-sync-pr-tags', '--json'],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    created: boolean;
    pullRequestId: number;
  };
  assert.equal(existingPullRequest.ok, true);
  assert.equal(existingPullRequest.created, false);
  assert.equal(existingPullRequest.pullRequestId, 200);

  const secondItem = JSON.parse(
    runCli(
      [
        'create',
        '--title',
        'JSON start flow',
        '--human-summary',
        'Exercise start JSON',
        '--agent-context',
        'Claim and branch in one command.',
        '--json',
      ],
      workspace,
      env,
    ),
  ) as {
    workItem: { id: number };
  };

  const started = JSON.parse(
    runCli(
      [
        'start',
        '--id',
        String(secondItem.workItem.id),
        '--agent',
        'codex',
        '--assigned-to',
        'owner@example.com',
        '--branch-name',
        `codex/${secondItem.workItem.id}-start-flow`,
        '--base',
        'main',
        '--note',
        'Starting now.',
        '--json',
      ],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    id: number;
    state: string;
    branchName: string;
  };
  assert.equal(started.ok, true);
  assert.equal(started.id, secondItem.workItem.id);
  assert.equal(started.state, 'Active');
  assert.equal(started.branchName, `codex/${secondItem.workItem.id}-start-flow`);

  const completed = JSON.parse(
    runCli(
      [
        'done',
        '--id',
        '100',
        '--summary',
        'Structured output shipped.',
        '--impact',
        'Agents can parse mutating command results safely.',
        '--checks',
        'build;test',
        '--changed-files',
        'scripts/ael.ts;tests/cli-write-json.test.ts',
        '--pr',
        '200',
        '--skip-link-checks',
        '--json',
      ],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    id: number;
    state: string;
    summary: string;
    impact: string;
    checks: string[];
    changedFiles: string[];
    fieldsApplied: Record<string, string | number | boolean>;
    pr: string;
    skipLinkChecks: boolean;
  };
  assert.equal(completed.ok, true);
  assert.equal(completed.id, 100);
  assert.equal(completed.state, 'Closed');
  assert.equal(completed.summary, 'Structured output shipped.');
  assert.equal(completed.impact, 'Agents can parse mutating command results safely.');
  assert.deepEqual(completed.checks, ['build', 'test']);
  assert.deepEqual(completed.changedFiles, ['scripts/ael.ts', 'tests/cli-write-json.test.ts']);
  assert.equal(completed.fieldsApplied['Custom.CompletionChannel'], 'ael');
  assert.equal(completed.pr, '200');
  assert.equal(completed.skipLinkChecks, true);

  const disabled = JSON.parse(runCli(['disable', '--json'], workspace, env)) as {
    ok: boolean;
    enabled: boolean;
    changed: boolean;
  };
  assert.equal(disabled.ok, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.changed, true);

  const enabled = JSON.parse(runCli(['enable', '--json'], workspace, env)) as {
    ok: boolean;
    enabled: boolean;
    changed: boolean;
  };
  assert.equal(enabled.ok, true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.changed, true);

  assert.ok(existsSync(gitStatePath));
  assert.ok(existsSync(azStatePath));
  const gitState = JSON.parse(readFileSync(gitStatePath, 'utf8')) as {
    currentBranch: string;
    commits: Array<{ message: string }>;
  };
  assert.equal(gitState.currentBranch, `codex/${secondItem.workItem.id}-start-flow`);
  assert.ok(gitState.commits.some((commit) => commit.message.includes('AB#100')));
});

test('report, audit, and retag emit structured json', (t) => {
  const workspace = makeTempDir();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const { binDir, gitCommandPath, azCommandPath, curlCommandPath, gitStatePath, azStatePath } =
    installStubCommands(workspace);
  writeConfig(workspace);
  writeAzState(azStatePath, {
    nextWorkItemId: 104,
    nextPrId: 201,
    workItems: {
      '100': {
        id: 100,
        fields: {
          'System.Title': 'Active formatting cleanup',
          'System.State': 'Active',
          'System.Description': '## Human Summary\\n\\nLegacy markdown body',
          'System.WorkItemType': 'Task',
          'System.Tags': 'agent-managed;agent:codex',
          'Microsoft.VSTS.Common.Priority': 1,
          'System.AssignedTo': { uniqueName: 'owner@example.com', displayName: 'Owner Name' },
          'System.ChangedDate': '2026-02-20T12:00:00.000Z',
        },
        relations: [
          {
            rel: 'ArtifactLink',
            url: 'vstfs:///Git/PullRequestId/example/example/200',
            attributes: { name: 'Pull Request' },
          },
        ],
        discussions: [],
        comments: [],
      },
      '101': {
        id: 101,
        fields: {
          'System.Title': 'New unclaimed item',
          'System.State': 'New',
          'System.Description': '',
          'System.WorkItemType': 'Task',
          'System.Tags': '',
          'Microsoft.VSTS.Common.Priority': 2,
          'System.ChangedDate': '2026-03-08T12:00:00.000Z',
        },
        relations: [],
        discussions: [],
        comments: [],
      },
      '102': {
        id: 102,
        fields: {
          'System.Title': 'Recently done item',
          'System.State': 'Closed',
          'System.Description': '',
          'System.WorkItemType': 'Task',
          'System.Tags': 'agent-managed',
          'Microsoft.VSTS.Common.Priority': 3,
          'System.ChangedDate': '2026-03-08T12:00:00.000Z',
        },
        relations: [],
        discussions: [],
        comments: [],
      },
      '103': {
        id: 103,
        fields: {
          'System.Title': 'Blocked active item',
          'System.State': 'Active',
          'System.Description': '',
          'System.WorkItemType': 'Task',
          'System.Tags': 'agent-managed;agent:codex',
          'Microsoft.VSTS.Common.Priority': 4,
          'System.ChangedDate': '2026-02-25T12:00:00.000Z',
        },
        relations: [
          {
            rel: 'System.LinkTypes.Dependency-Reverse',
            url: 'https://example.dev/workItems/101',
          },
        ],
        discussions: [],
        comments: [],
      },
    },
    pullRequests: [
      {
        pullRequestId: 200,
        title: 'AB#100 Active formatting cleanup',
        description: '## Summary\\n\\nNeeds normalization',
        sourceBranch: 'codex/100-active-formatting-cleanup',
        targetBranch: 'main',
        sourceRefName: 'refs/heads/codex/100-active-formatting-cleanup',
        targetRefName: 'refs/heads/main',
        status: 'active',
        isDraft: false,
        repository: {
          webUrl: 'https://dev.azure.com/example-org/example-project/_git/example-repo',
        },
        workItemIds: [100],
        labels: [],
        reviewers: [
          {
            displayName: 'Owner Name',
            uniqueName: 'owner@example.com',
            vote: 0,
            isRequired: false,
          },
        ],
      },
    ],
  });

  const env = {
    PATH: prependPathEntry(binDir),
    AEL_CMD_GIT: gitCommandPath,
    AEL_CMD_AZ: azCommandPath,
    AEL_CMD_CURL: curlCommandPath,
    AEL_WRITE_GIT_STATE: gitStatePath,
    AEL_WRITE_AZ_STATE: azStatePath,
  };

  const retag = JSON.parse(
    runCli(
      ['retag', '--id', '101', '--tags', 'auth;frontend', '--dry-run', '--json'],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    dryRun: boolean;
    targetCount: number;
    changedCount: number;
    changes: Array<{ id: number; before: string[]; after: string[]; applied: boolean }>;
  };
  assert.equal(retag.ok, true);
  assert.equal(retag.dryRun, true);
  assert.equal(retag.targetCount, 1);
  assert.equal(retag.changedCount, 1);
  assert.deepEqual(retag.changes[0], {
    id: 101,
    before: [],
    after: ['agent-managed', 'auth', 'frontend'],
    changed: true,
    applied: false,
  });

  const appliedRetag = JSON.parse(
    runCli(['retag', '--id', '101', '--tags', 'auth;frontend', '--json'], workspace, env),
  ) as {
    ok: boolean;
    dryRun: boolean;
    changedCount: number;
    changes: Array<{ applied: boolean; after: string[] }>;
  };
  assert.equal(appliedRetag.ok, true);
  assert.equal(appliedRetag.dryRun, false);
  assert.equal(appliedRetag.changedCount, 1);
  assert.equal(appliedRetag.changes[0]?.applied, true);
  assert.deepEqual(appliedRetag.changes[0]?.after, ['agent-managed', 'auth', 'frontend']);

  const azStateAfterRetag = JSON.parse(readFileSync(azStatePath, 'utf8')) as {
    workItems: Record<string, { fields: Record<string, unknown> }>;
  };
  assert.equal(
    azStateAfterRetag.workItems['101']?.fields['System.Tags'],
    'agent-managed;auth;frontend',
  );

  const report = JSON.parse(
    runCli(
      ['report', '--limit', '10', '--stale-days', '7', '--recent-days', '7', '--json'],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    counts: Record<string, number>;
    agentWorkload: Array<{ agent: string; activeCount: number }>;
    unclaimedNewCount: number;
    blockedItems: Array<{ id: number }>;
    humanBlockedItems: Array<{ id: number }>;
    overlapAreas: Array<{ tag: string; count: number; itemIds: number[] }>;
    hierarchyCounts: Array<{ type: string; count: number }>;
    branchTargets: Array<{ branch: string; count: number }>;
    activePullRequests: Array<{ pullRequestId: number; workItemCount: number; tags: string[] }>;
    recentDone: Array<{ id: number }>;
  };
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, {
    open: 3,
    new: 1,
    active: 2,
    blocked: 1,
    humanBlocked: 0,
    activePullRequests: 1,
    staleActive: 2,
    recentDone: 1,
    overlapAreas: 0,
  });
  assert.deepEqual(report.agentWorkload, [{ agent: 'codex', activeCount: 2 }]);
  assert.equal(report.unclaimedNewCount, 1);
  assert.deepEqual(
    report.blockedItems.map((item) => item.id),
    [103],
  );
  assert.deepEqual(report.humanBlockedItems, []);
  assert.deepEqual(report.overlapAreas, []);
  assert.deepEqual(report.branchTargets, [{ branch: 'refs/heads/main', count: 1 }]);
  assert.deepEqual(report.hierarchyCounts, [{ type: 'Task', count: 3 }]);
  assert.equal(report.activePullRequests[0].pullRequestId, 200);
  assert.equal(report.activePullRequests[0].workItemCount, 1);
  assert.deepEqual(report.activePullRequests[0].tags, []);
  assert.deepEqual(
    report.recentDone.map((item) => item.id),
    [102],
  );

  const audit = JSON.parse(
    runCli(
      ['audit', '--state', 'open', '--limit', '10', '--stale-days', '7', '--json'],
      workspace,
      env,
    ),
  ) as {
    ok: boolean;
    workItemsScanned: number;
    activePullRequestsScanned: number;
    findingCount: number;
    findingCounts: { warn: number; info: number; repaired: number };
    findings: Array<{ type: string; scope: string; repaired?: boolean }>;
  };
  assert.equal(audit.ok, true);
  assert.equal(audit.workItemsScanned, 3);
  assert.equal(audit.activePullRequestsScanned, 1);
  assert.equal(audit.findingCount, 4);
  assert.deepEqual(audit.findingCounts, { warn: 3, info: 1, repaired: 0 });
  assert.ok(
    audit.findings.some(
      (finding) => finding.type === 'description-format' && finding.scope === 'WI#100',
    ),
  );
  assert.ok(
    audit.findings.some((finding) => finding.type === 'stale-active' && finding.scope === 'WI#103'),
  );
  assert.ok(
    audit.findings.some(
      (finding) => finding.type === 'pr-description-format' && finding.scope === 'PR#200',
    ),
  );
  assert.ok(
    audit.findings.some((finding) => finding.type === 'pr-tags' && finding.scope === 'PR#200'),
  );
});
