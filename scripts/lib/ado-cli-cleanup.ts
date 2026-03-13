import type {
  BranchCleanupCandidate,
  PullRequestCleanupCandidate,
  PullRequestRecord,
} from './ado-cli-types.js';
import type { AgentExecutionConfig } from './config.js';
import {
  currentBranchName,
  ensureModeEnabled,
  fail,
  hasFlag,
  parseArgValue,
  printJson,
  resolveBaseBranch,
  runCommand,
  wantsJson,
} from './ado-cli-runtime.js';
import {
  getWorkItem,
  getWorkItemStateValue,
  listPullRequestWorkItemIds,
  listPullRequests,
} from './ado-cli-workflow.js';

interface GitBranchRef {
  branch: string;
  timestamp?: number;
}

function parseDateValue(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? undefined : value;
}

function ageInDays(date: Date, now = new Date()): number {
  return Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function normalizeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '');
}

function parseBranchWorkItemId(branch: string): number | undefined {
  const match = normalizeBranchName(branch).match(/(?:^|\/)(\d+)-/);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseForEachRef(output: string): GitBranchRef[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [branchRaw, timestampRaw] = line.split('|');
      const branch = normalizeBranchName(branchRaw ?? '');
      const timestamp = Number.parseInt(timestampRaw ?? '', 10);
      return {
        branch,
        ...(Number.isFinite(timestamp) ? { timestamp } : {}),
      };
    })
    .filter((entry) => Boolean(entry.branch) && !entry.branch.endsWith('/HEAD'));
}

function listLocalBranches(): GitBranchRef[] {
  const result = runCommand([
    'git',
    'for-each-ref',
    'refs/heads',
    '--format=%(refname:short)|%(committerdate:unix)',
  ]);
  if (!result.ok || !result.stdout) return [];
  return parseForEachRef(result.stdout);
}

function listRemoteBranches(remote = 'origin'): GitBranchRef[] {
  const result = runCommand([
    'git',
    'for-each-ref',
    `refs/remotes/${remote}`,
    '--format=%(refname:short)|%(committerdate:unix)',
  ]);
  if (!result.ok || !result.stdout) return [];
  return parseForEachRef(result.stdout);
}

function listMergedBranches(baseBranch: string, remote = false): Set<string> {
  const args = remote
    ? ['git', 'branch', '-r', '--merged', `origin/${baseBranch}`]
    : ['git', 'branch', '--merged', baseBranch];
  const result = runCommand(args);
  if (!result.ok || !result.stdout) return new Set();
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => normalizeBranchName(line.replace(/^\*\s*/, '').trim()))
      .filter(Boolean)
      .filter((branch) => !branch.endsWith('/HEAD')),
  );
}

function branchExistsOnOrigin(branch: string): boolean {
  const result = runCommand(['git', 'ls-remote', '--exit-code', '--heads', 'origin', branch]);
  return result.ok;
}

function sourceAheadCount(sourceBranch: string, targetBranch: string): number | undefined {
  const result = runCommand([
    'git',
    'rev-list',
    '--left-right',
    '--count',
    `origin/${targetBranch}...origin/${sourceBranch}`,
  ]);
  if (!result.ok || !result.stdout) return undefined;
  const [behindRaw, aheadRaw] = result.stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw ?? '', 10);
  const behind = Number.parseInt(behindRaw ?? '', 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return undefined;
  return ahead;
}

function buildProtectedBranches(config: AgentExecutionConfig, baseBranch: string): Set<string> {
  return new Set(
    [
      baseBranch,
      config.defaultBranch,
      ...config.branching.developmentBranches,
      ...config.branching.rolloutBranches,
    ]
      .map((branch) => branch.trim())
      .filter(Boolean),
  );
}

function buildActiveSourceBranchSet(config: AgentExecutionConfig): Set<string> {
  return new Set(
    listPullRequests(config, 'active')
      .map((pr) => normalizeBranchName(String(pr.sourceRefName ?? '')))
      .filter(Boolean),
  );
}

function getWorkItemStateCache(config: AgentExecutionConfig): Map<number, string> {
  return new Map<number, string>();
}

function getCachedWorkItemState(
  config: AgentExecutionConfig,
  cache: Map<number, string>,
  workItemId: number,
): string {
  const cached = cache.get(workItemId);
  if (cached) return cached;
  const state = getWorkItemStateValue(getWorkItem(config, workItemId));
  cache.set(workItemId, state);
  return state;
}

function buildBranchCleanupCandidates(
  config: AgentExecutionConfig,
  args: string[],
): {
  baseBranch: string;
  candidates: BranchCleanupCandidate[];
  currentBranch: string;
} {
  const baseBranch = resolveBaseBranch(config, args);
  const current = normalizeBranchName(currentBranchName());
  const staleDays = Number.parseInt(
    parseArgValue(args, '--stale-days') ?? String(config.cleanupDefaults.staleBranchDays),
    10,
  );
  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    fail('cleanup-branches requires a positive --stale-days.');
  }

  const includeLocal = !hasFlag(args, '--remote-only');
  const includeRemote = !hasFlag(args, '--local-only');
  const protectedBranches = buildProtectedBranches(config, baseBranch);
  const mergedLocal = listMergedBranches(baseBranch, false);
  const mergedRemote = listMergedBranches(baseBranch, true);
  const activeSourceBranches = buildActiveSourceBranchSet(config);
  const stateCache = getWorkItemStateCache(config);
  const now = new Date();

  const collectCandidates = (refs: GitBranchRef[], remote: boolean): BranchCleanupCandidate[] =>
    refs.flatMap((ref) => {
      if (!ref.branch || protectedBranches.has(ref.branch) || (!remote && ref.branch === current)) {
        return [];
      }

      const reasons: string[] = [];
      const merged = remote ? mergedRemote.has(ref.branch) : mergedLocal.has(ref.branch);
      if (merged) {
        reasons.push(`merged into ${baseBranch}`);
      }

      const workItemId = parseBranchWorkItemId(ref.branch);
      let workItemState: string | undefined;
      if (workItemId !== undefined) {
        workItemState = getCachedWorkItemState(config, stateCache, workItemId);
        if (workItemState === config.stateMap.done) {
          reasons.push('linked work item is closed');
        }
      }

      const staleAge =
        ref.timestamp !== undefined ? ageInDays(new Date(ref.timestamp * 1000), now) : undefined;
      if (
        staleAge !== undefined &&
        staleAge >= staleDays &&
        !activeSourceBranches.has(ref.branch)
      ) {
        reasons.push(`stale for ${staleAge} day(s) with no active PR`);
      }

      if (reasons.length === 0) {
        return [];
      }

      return [
        {
          branch: ref.branch,
          remote,
          merged,
          ...(staleAge !== undefined ? { staleDays: staleAge } : {}),
          ...(workItemId !== undefined ? { workItemId } : {}),
          ...(workItemState ? { workItemState } : {}),
          reason: reasons.join('; '),
        },
      ];
    });

  const candidates = [
    ...(includeLocal ? collectCandidates(listLocalBranches(), false) : []),
    ...(includeRemote ? collectCandidates(listRemoteBranches(), true) : []),
  ];

  return {
    baseBranch,
    candidates,
    currentBranch: current,
  };
}

function deleteLocalBranch(branch: string, merged: boolean, force: boolean): void {
  runCommand(['git', 'branch', merged || !force ? '-d' : '-D', branch]);
}

function deleteRemoteBranch(branch: string): void {
  runCommand(['git', 'push', 'origin', '--delete', branch]);
}

export function commandCleanupBranches(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'cleanup-branches');
  const dryRun = hasFlag(args, '--dry-run');
  const deleteLocal = hasFlag(args, '--delete-local');
  const deleteRemote = hasFlag(args, '--delete-remote');
  const force = hasFlag(args, '--force');
  const { baseBranch, candidates, currentBranch } = buildBranchCleanupCandidates(config, args);

  const deleted: string[] = [];
  const warnings: string[] = [];
  for (const candidate of candidates) {
    if (candidate.remote && !deleteRemote) continue;
    if (!candidate.remote && !deleteLocal) continue;
    if (!candidate.merged && !force && !candidate.reason.includes('linked work item is closed')) {
      warnings.push(`skipped ${candidate.branch}: requires --force because it is not merged.`);
      continue;
    }
    if (dryRun) continue;
    if (candidate.remote) {
      deleteRemoteBranch(candidate.branch);
    } else {
      deleteLocalBranch(candidate.branch, candidate.merged, force);
    }
    deleted.push(candidate.branch);
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      dryRun,
      baseBranch,
      currentBranch,
      candidateCount: candidates.length,
      candidates,
      deleted,
      warnings,
    });
    return;
  }

  console.log('=== AEL BRANCH CLEANUP ===');
  console.log(`Base branch: ${baseBranch}`);
  console.log(`Current branch: ${currentBranch}`);
  if (candidates.length === 0) {
    console.log('No branch cleanup candidates.');
    return;
  }
  for (const candidate of candidates) {
    console.log(
      `- ${candidate.remote ? 'remote' : 'local'} ${candidate.branch}: ${candidate.reason}`,
    );
  }
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
  if (deleted.length > 0) {
    console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${deleted.join(', ')}`);
  }
}

function buildPullRequestCleanupCandidates(
  config: AgentExecutionConfig,
  args: string[],
): PullRequestCleanupCandidate[] {
  const staleDays = Number.parseInt(
    parseArgValue(args, '--stale-days') ?? String(config.cleanupDefaults.stalePullRequestDays),
    10,
  );
  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    fail('cleanup-prs requires a positive --stale-days.');
  }

  const stateCache = getWorkItemStateCache(config);
  const now = new Date();

  return listPullRequests(config, 'active').flatMap((pr) => {
    if (!Number.isFinite(pr.pullRequestId)) return [];
    const pullRequestId = Number(pr.pullRequestId);
    const sourceBranch = normalizeBranchName(String(pr.sourceRefName ?? ''));
    const targetBranch = normalizeBranchName(String(pr.targetRefName ?? ''));
    const workItemIds = listPullRequestWorkItemIds(config, pullRequestId);
    const reasons: string[] = [];

    const created = parseDateValue(pr.creationDate);
    const staleAge = created ? ageInDays(created, now) : undefined;
    if (pr.isDraft && staleAge !== undefined && staleAge >= staleDays) {
      reasons.push(`stale draft for ${staleAge} day(s)`);
    }

    if (
      workItemIds.length > 0 &&
      workItemIds.every(
        (id) => getCachedWorkItemState(config, stateCache, id) === config.stateMap.done,
      )
    ) {
      reasons.push('linked work items are already closed');
    }

    if (sourceBranch && !branchExistsOnOrigin(sourceBranch)) {
      reasons.push('source branch is missing on origin');
    }

    const aheadCount =
      sourceBranch && targetBranch ? sourceAheadCount(sourceBranch, targetBranch) : undefined;
    if (aheadCount === 0) {
      reasons.push('source branch is no longer ahead of target');
    }

    if (reasons.length === 0) {
      return [];
    }

    return [
      {
        pullRequestId,
        title: String(pr.title ?? ''),
        sourceBranch,
        targetBranch,
        isDraft: Boolean(pr.isDraft),
        status: String(pr.status ?? ''),
        workItemIds,
        ...(staleAge !== undefined ? { staleDays: staleAge } : {}),
        reason: reasons.join('; '),
      },
    ];
  });
}

function abandonPullRequest(config: AgentExecutionConfig, pullRequestId: number): void {
  const result = runCommand([
    'az',
    'repos',
    'pr',
    'update',
    '--org',
    config.organizationUrl,
    '--project',
    config.project,
    '--id',
    String(pullRequestId),
    '--status',
    'abandoned',
    '-o',
    'json',
  ]);
  if (!result.ok) {
    fail(result.stderr || result.message || `failed to abandon PR #${pullRequestId}.`);
  }
}

export function commandCleanupPullRequests(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'cleanup-prs');
  const dryRun = hasFlag(args, '--dry-run');
  const abandon = hasFlag(args, '--abandon');
  const candidates = buildPullRequestCleanupCandidates(config, args);
  const abandoned: number[] = [];

  if (abandon && !dryRun) {
    for (const candidate of candidates) {
      abandonPullRequest(config, candidate.pullRequestId);
      abandoned.push(candidate.pullRequestId);
    }
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      dryRun,
      candidateCount: candidates.length,
      candidates,
      abandoned,
    });
    return;
  }

  console.log('=== AEL PR CLEANUP ===');
  if (candidates.length === 0) {
    console.log('No PR cleanup candidates.');
    return;
  }
  for (const candidate of candidates) {
    console.log(
      `- PR #${candidate.pullRequestId} (${candidate.sourceBranch} -> ${candidate.targetBranch}): ${candidate.reason}`,
    );
  }
  if (abandoned.length > 0) {
    console.log(`${dryRun ? 'Would abandon' : 'Abandoned'} PRs: ${abandoned.join(', ')}`);
  }
}
