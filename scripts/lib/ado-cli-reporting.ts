import {
  buildRepairedCompletionComment,
  buildRepairedPullRequestDescription,
  buildRepairedWorkItemDescription,
  isMarkdownish,
} from './pr-description.js';
import type {
  AuditFinding,
  AzQueryResult,
  PullRequestRecord,
  WorkItemSummary,
} from './ado-cli-types.js';
import type { AgentExecutionConfig } from './config.js';
import {
  azJson,
  configuredAgentTags,
  ensureModeEnabled,
  escapedWiql,
  fail,
  getAgentTag,
  hasFlag,
  normalizeAgent,
  normalizeTags,
  parseArgValue,
  parseTagList,
  preferredWorkflowCommand,
  printJson,
  replaceWorkItemTagsExact,
  runCommand,
  usesPatAuth,
  uniqueTags,
  wantsJson,
} from './ado-cli-runtime.js';
import {
  addPullRequestWorkItems,
  formatIdentity,
  getLinkedPullRequestIds,
  getOpenPredecessorIds,
  getPullRequest,
  getWorkItem,
  getWorkItemPriorityValue,
  getWorkItemsBatch,
  getWorkItemStateValue,
  getWorkItemTags,
  inferWorkItemIdFromPullRequest,
  listPullRequestLabels,
  listPullRequestWorkItemIds,
  listPullRequests,
  listWorkItemComments,
  syncPullRequestLabels,
  updateWorkItemComment,
} from './ado-cli-workflow.js';

function queryWorkItems(
  config: AgentExecutionConfig,
  options: {
    agent?: string;
    state?: 'new' | 'active' | 'done' | 'open' | 'all';
    withoutAgentTags?: boolean;
    limit?: number;
  },
): number[] {
  const clauses = [`[System.TeamProject] = '${escapedWiql(config.project)}'`];
  if (options.state === 'new') {
    clauses.push(`[System.State] = '${escapedWiql(config.stateMap.new)}'`);
  } else if (options.state === 'active') {
    clauses.push(`[System.State] = '${escapedWiql(config.stateMap.active)}'`);
  } else if (options.state === 'done') {
    clauses.push(`[System.State] = '${escapedWiql(config.stateMap.done)}'`);
  } else if (options.state === 'open') {
    clauses.push(`[System.State] <> '${escapedWiql(config.stateMap.done)}'`);
  }

  if (options.agent) {
    clauses.push(
      `[System.Tags] CONTAINS '${escapedWiql(getAgentTag(config, normalizeAgent(config, options.agent)))}'`,
    );
  }
  if (options.withoutAgentTags) {
    for (const tag of configuredAgentTags(config)) {
      clauses.push(`[System.Tags] NOT CONTAINS '${escapedWiql(tag)}'`);
    }
  }

  const limit = options.limit ?? 50;
  const wiql = [
    'SELECT [System.Id]',
    'FROM WorkItems',
    `WHERE ${clauses.join(' AND ')}`,
    'ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC',
  ].join(' ');

  const result = azJson(config, [
    'boards',
    'query',
    '--project',
    config.project,
    '--wiql',
    wiql,
  ]) as AzQueryResult;
  const workItems = Array.isArray(result) ? result : (result.workItems ?? []);
  return workItems
    .map((item) => item.id)
    .filter((value): value is number => Number.isFinite(value))
    .slice(0, limit);
}

function findFirstUnblockedWorkItem(
  config: AgentExecutionConfig,
  ids: number[],
): number | undefined {
  for (const id of ids) {
    if (getOpenPredecessorIds(config, id).length === 0) {
      return id;
    }
  }
  return ids[0];
}

function formatAssigned(raw: unknown): string {
  return formatIdentity(raw);
}

function summarizeWorkItem(
  config: AgentExecutionConfig,
  id: number,
  item: ReturnType<typeof getWorkItemsBatch>[number],
  blocked?: boolean,
): WorkItemSummary {
  const fields = item.fields ?? {};
  const assignedTo = formatAssigned(fields['System.AssignedTo']);
  const tags = parseTagList(
    typeof fields['System.Tags'] === 'string' ? fields['System.Tags'] : undefined,
  );
  const agentTag = tags.find((tag) => tag.toLowerCase().startsWith('agent:'));
  const blockedValue = blocked ?? getOpenPredecessorIds(config, id).length > 0;
  return {
    id,
    state: String(fields['System.State'] ?? ''),
    priority: getWorkItemPriorityValue(item),
    blocked: blockedValue,
    ...(agentTag ? { agentTag } : {}),
    ...(assignedTo ? { assignedTo } : {}),
    title: String(fields['System.Title'] ?? `Work item ${id}`),
  };
}

export function collectWorkItemSummaries(
  config: AgentExecutionConfig,
  ids: number[],
): WorkItemSummary[] {
  return getWorkItemsBatch(config, ids).map((item) =>
    summarizeWorkItem(config, Number(item.id), item),
  );
}

function printWorkItems(config: AgentExecutionConfig, ids: number[]): void {
  const summaries = collectWorkItemSummaries(config, ids);
  if (summaries.length === 0) {
    console.log('No matching work items.');
    return;
  }
  for (const summary of summaries) {
    const bits = [`#${summary.id}`, summary.state, summary.title];
    if (summary.priority !== undefined) bits.push(`P${summary.priority}`);
    if (summary.blocked) bits.push('blocked');
    if (summary.agentTag) bits.push(summary.agentTag);
    if (summary.assignedTo) bits.push(summary.assignedTo);
    console.log(bits.join(' | '));
  }
}

function parseDateValue(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? undefined : value;
}

function ageInDays(date: Date, now = new Date()): number {
  return Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function collectTargetWorkItemIds(
  config: AgentExecutionConfig,
  args: string[],
  defaultState = 'open',
  defaultLimit = 50,
): number[] {
  const idRaw = parseArgValue(args, '--id');
  const idsRaw = parseArgValue(args, '--ids');
  if (idRaw) {
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);
    return [id];
  }
  if (idsRaw) {
    return idsRaw
      .split(/[;,]/)
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter(Number.isFinite);
  }
  const state = (parseArgValue(args, '--state') ?? defaultState) as
    | 'new'
    | 'active'
    | 'done'
    | 'open'
    | 'all';
  const agent = parseArgValue(args, '--agent');
  const limitRaw = parseArgValue(args, '--limit') ?? String(defaultLimit);
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit <= 0) fail(`invalid --limit "${limitRaw}".`);
  return queryWorkItems(config, { agent, state, limit });
}

function updatePullRequestDescription(
  config: AgentExecutionConfig,
  prId: number,
  description: string,
): void {
  const args = [
    'az',
    'repos',
    'pr',
    'update',
    '--org',
    config.organizationUrl,
    '--project',
    config.project,
    '--id',
    String(prId),
  ];
  const lines = description.split('\n');
  args.push('--description', ...lines);
  args.push('-o', 'json');
  runCommand(args);
}

function printAuditFindings(findings: AuditFinding[]): void {
  if (findings.length === 0) {
    console.log('No audit findings.');
    return;
  }
  for (const finding of findings) {
    const repaired = finding.repaired ? ' repaired' : '';
    console.log(
      `[${finding.level.toUpperCase()}] ${finding.scope} ${finding.type}${repaired}: ${finding.message}`,
    );
  }
}

export function commandRetag(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'retag');
  const dryRun = hasFlag(args, '--dry-run');
  const targetIds = (() => {
    const idRaw = parseArgValue(args, '--id');
    const idsRaw = parseArgValue(args, '--ids');
    if (idRaw || idsRaw) {
      return collectTargetWorkItemIds(config, args);
    }
    const state = (parseArgValue(args, '--state') ?? 'open') as
      | 'new'
      | 'active'
      | 'done'
      | 'open'
      | 'all';
    const agent = parseArgValue(args, '--agent');
    const limitRaw = parseArgValue(args, '--limit') ?? '200';
    const limit = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(limit) || limit <= 0) fail(`invalid --limit "${limitRaw}".`);
    return queryWorkItems(config, { agent, state, limit });
  })();

  if (targetIds.length === 0) {
    if (wantsJson(args)) {
      printJson({
        ok: true,
        dryRun,
        targetCount: 0,
        changedCount: 0,
        changes: [],
      });
      return;
    }
    console.log('No matching work items.');
    return;
  }

  let changed = 0;
  const changes: Array<{
    id: number;
    before: string[];
    after: string[];
    changed: boolean;
    applied: boolean;
  }> = [];
  for (const id of targetIds) {
    const existing = getWorkItemTags(config, id);
    const normalizedTarget = normalizeTags([...existing, ...config.sharedTags]);
    const before = uniqueTags(existing).join(';');
    const after = normalizedTarget.join(';');

    if (before.toLowerCase() === after.toLowerCase()) {
      continue;
    }

    if (!dryRun) replaceWorkItemTagsExact(config, id, normalizedTarget);

    changed += 1;
    changes.push({
      id,
      before: uniqueTags(existing),
      after: normalizedTarget,
      changed: true,
      applied: !dryRun,
    });
    if (wantsJson(args)) {
      continue;
    }
    console.log(
      `${dryRun ? 'Would normalize' : 'Normalized'} #${id}: ${before || '(none)'} -> ${after || '(none)'}`,
    );
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      dryRun,
      targetCount: targetIds.length,
      changedCount: changed,
      changes,
    });
    return;
  }
  if (changed === 0) {
    console.log('No work items needed tag normalization.');
    return;
  }
  console.log(
    `${dryRun ? 'Would normalize' : 'Normalized'} ${changed} work ${changed === 1 ? 'item' : 'items'}.`,
  );
}

export function commandAudit(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'audit');
  const workItemIds = collectTargetWorkItemIds(config, args, 'open', 50);
  const repairAll = hasFlag(args, '--repair');
  const repairFormatting = repairAll || hasFlag(args, '--repair-formatting');
  const repairPrTags = repairAll || hasFlag(args, '--repair-pr-tags');
  const repairPrLinks = repairAll || hasFlag(args, '--repair-pr-links');
  const staleDaysRaw = parseArgValue(args, '--stale-days');
  const staleDays = staleDaysRaw
    ? Number.parseInt(staleDaysRaw, 10)
    : config.reportDefaults.staleDays;
  if (!Number.isFinite(staleDays) || staleDays < 0) fail(`invalid --stale-days "${staleDaysRaw}".`);

  const findings: AuditFinding[] = [];
  const warnings: string[] = [];
  const touchedPrIds = new Set<number>();
  const activePullRequests = listPullRequests(config, 'active');

  if (!usesPatAuth()) {
    warnings.push(
      'Azure CLI auth is active. Audit can still read work items and PRs, but PR label write-back and existing comment repair stay limited without a PAT.',
    );
  }

  for (const id of workItemIds) {
    const item = getWorkItem(config, id);
    const state = getWorkItemStateValue(item);
    const title = String(item.fields?.['System.Title'] ?? `Work item ${id}`);
    const description = String(item.fields?.['System.Description'] ?? '');
    if (description && !description.includes('<strong>') && isMarkdownish(description)) {
      const repaired = repairFormatting ? buildRepairedWorkItemDescription(description) : undefined;
      if (repaired) {
        azJson(config, [
          'boards',
          'work-item',
          'update',
          '--id',
          String(id),
          '--description',
          repaired,
        ]);
      }
      findings.push({
        level: 'warn',
        type: 'description-format',
        scope: `WI#${id}`,
        message: repaired
          ? 'Converted markdown-style description content into rich text sections.'
          : `${title} still has markdown-style description content.`,
        repaired: Boolean(repaired),
      });
    }

    const comments = listWorkItemComments(config, id);
    for (const comment of comments) {
      if (comment.format.toLowerCase() !== 'html' || !isMarkdownish(comment.text)) continue;
      const repaired = repairFormatting ? buildRepairedCompletionComment(comment.text) : undefined;
      if (repaired) {
        updateWorkItemComment(config, id, comment.id, repaired);
      }
      findings.push({
        level: 'warn',
        type: 'comment-format',
        scope: `WI#${id}/comment#${comment.id}`,
        message: repaired
          ? 'Converted markdown-style closeout content into rich text sections.'
          : 'Comment still contains markdown-style content in an HTML-rendered discussion field.',
        repaired: Boolean(repaired),
      });
    }

    const linkedPrIds = getLinkedPullRequestIds(config, id);
    for (const prId of linkedPrIds) {
      touchedPrIds.add(prId);
      const pr = getPullRequest(config, prId);
      if (state !== config.stateMap.done && pr.status === 'completed') {
        findings.push({
          level: 'warn',
          type: 'completed-pr-open-item',
          scope: `WI#${id}`,
          message: `Linked PR #${prId} is completed but the work item is still ${state}.`,
        });
      }
    }

    if (state === config.stateMap.active) {
      const changedDate = parseDateValue(item.fields?.['System.ChangedDate']);
      if (changedDate && ageInDays(changedDate) >= staleDays && linkedPrIds.length === 0) {
        findings.push({
          level: 'warn',
          type: 'stale-active',
          scope: `WI#${id}`,
          message: `${title} has been Active for ${ageInDays(changedDate)} day(s) without a linked PR.`,
        });
      }
    }
  }

  for (const pr of activePullRequests) {
    const prId = pr.pullRequestId;
    if (!Number.isFinite(prId)) continue;
    const pullRequestId = Number(prId);
    if (touchedPrIds.has(pullRequestId)) {
      // already checked from linked work items, but still allow PR-side repairs below
    }
    let linkedWorkItems = listPullRequestWorkItemIds(config, pullRequestId);
    if (linkedWorkItems.length === 0) {
      const inferredId = inferWorkItemIdFromPullRequest(pr);
      if (inferredId !== undefined && repairPrLinks) {
        addPullRequestWorkItems(config, pullRequestId, [inferredId]);
        linkedWorkItems = [inferredId];
      }
      findings.push({
        level: 'warn',
        type: 'pr-missing-work-item',
        scope: `PR#${pullRequestId}`,
        message:
          linkedWorkItems.length > 0
            ? `Linked inferred work item #${linkedWorkItems[0]} from the PR title/branch.`
            : 'PR has no linked work item.',
        repaired: linkedWorkItems.length > 0,
      });
    }

    const rawDescription = String(pr.description ?? '');
    if (rawDescription && isMarkdownish(rawDescription)) {
      const repaired = repairFormatting
        ? buildRepairedPullRequestDescription(rawDescription)
        : undefined;
      if (repaired) {
        updatePullRequestDescription(config, pullRequestId, repaired);
      }
      findings.push({
        level: 'warn',
        type: 'pr-description-format',
        scope: `PR#${pullRequestId}`,
        message: repaired
          ? 'Normalized the PR description into Azure DevOps-friendly plain text sections.'
          : 'PR description still contains markdown-style headings or escaped newlines.',
        repaired: Boolean(repaired),
      });
    }

    if (linkedWorkItems.length > 0) {
      const desiredTags = normalizeTags(
        linkedWorkItems
          .flatMap((id) => getWorkItemTags(config, id))
          .filter(
            (tag) =>
              config.prDefaults.syncTagMode === 'all' || !tag.toLowerCase().startsWith('agent:'),
          ),
      );
      const existingLabels = listPullRequestLabels(config, pullRequestId);
      const missingLabels = desiredTags.filter(
        (tag) => !existingLabels.some((existing) => existing.toLowerCase() === tag.toLowerCase()),
      );
      if (missingLabels.length > 0) {
        const added = repairPrTags
          ? syncPullRequestLabels(
              config,
              pullRequestId,
              linkedWorkItems,
              config.prDefaults.syncTagMode,
            )
          : [];
        findings.push({
          level: 'info',
          type: 'pr-tags',
          scope: `PR#${pullRequestId}`,
          message:
            added.length > 0
              ? `Added missing PR tags: ${added.join(', ')}.`
              : `Missing PR tags: ${missingLabels.join(', ')}.`,
          repaired: added.length > 0,
        });
      }
    }
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      workItemsScanned: workItemIds.length,
      activePullRequestsScanned: activePullRequests.length,
      staleDays,
      repair: {
        all: repairAll,
        formatting: repairFormatting,
        prTags: repairPrTags,
        prLinks: repairPrLinks,
      },
      warnings,
      findingCount: findings.length,
      findingCounts: {
        warn: findings.filter((finding) => finding.level === 'warn').length,
        info: findings.filter((finding) => finding.level === 'info').length,
        repaired: findings.filter((finding) => finding.repaired).length,
      },
      findings,
    });
    return;
  }
  console.log('=== AEL AUDIT ===');
  console.log(`Work items scanned: ${workItemIds.length}`);
  console.log(`Active PRs scanned: ${activePullRequests.length}`);
  console.log(
    `Repair mode: ${
      repairAll
        ? 'all safe repairs'
        : [
            repairFormatting ? 'formatting' : '',
            repairPrTags ? 'pr-tags' : '',
            repairPrLinks ? 'pr-links' : '',
          ]
            .filter(Boolean)
            .join(', ') || 'off'
    }`,
  );
  for (const warning of warnings) {
    console.log(`Warning: ${warning}`);
  }
  printAuditFindings(findings);
}

export function commandReport(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'report');
  const limit = Number.parseInt(parseArgValue(args, '--limit') ?? '20', 10);
  if (!Number.isFinite(limit) || limit <= 0) fail('report requires a positive --limit.');
  const staleDays = Number.parseInt(
    parseArgValue(args, '--stale-days') ?? String(config.reportDefaults.staleDays),
    10,
  );
  const recentDays = Number.parseInt(
    parseArgValue(args, '--recent-days') ?? String(config.reportDefaults.recentDays),
    10,
  );
  if (!Number.isFinite(staleDays) || staleDays <= 0)
    fail('report requires a positive --stale-days.');
  if (!Number.isFinite(recentDays) || recentDays <= 0)
    fail('report requires a positive --recent-days.');

  const openIds = queryWorkItems(config, { state: 'open', limit: 200 });
  const newIds = queryWorkItems(config, { state: 'new', limit: 200 });
  const activeIds = queryWorkItems(config, { state: 'active', limit: 200 });
  const doneIds = queryWorkItems(config, { state: 'done', limit: 200 });
  const blockedIds = activeIds.filter((id) => getOpenPredecessorIds(config, id).length > 0);
  const now = new Date();
  const activeItems = getWorkItemsBatch(config, activeIds);
  const staleActiveIds = activeItems
    .filter((item) => {
      const changed = parseDateValue(item.fields?.['System.ChangedDate']);
      return changed ? ageInDays(changed, now) >= staleDays : false;
    })
    .map((item) => Number(item.id))
    .filter(Number.isFinite);
  const doneItems = getWorkItemsBatch(config, doneIds);
  const recentDoneIds = doneItems
    .filter((item) => {
      const changed = parseDateValue(item.fields?.['System.ChangedDate']);
      return changed ? ageInDays(changed, now) <= recentDays : false;
    })
    .map((item) => Number(item.id))
    .filter(Number.isFinite)
    .slice(0, limit);
  const activePullRequests = listPullRequests(config, 'active');
  const unclaimedNewCount = queryWorkItems(config, {
    state: 'new',
    withoutAgentTags: true,
    limit: 200,
  }).length;
  const agentWorkload = config.agents
    .map((agent) => ({
      agent: agent.key,
      activeCount: queryWorkItems(config, {
        agent: agent.key,
        state: 'active',
        limit: 200,
      }).length,
    }))
    .filter((item) => item.activeCount > 0);
  const blockedSummaries = collectWorkItemSummaries(config, blockedIds.slice(0, limit));
  const recentDoneSummaries = collectWorkItemSummaries(config, recentDoneIds.slice(0, limit));
  const activePullRequestSummaries = activePullRequests.slice(0, limit).map((pr) => ({
    pullRequestId: Number(pr.pullRequestId),
    title: String(pr.title ?? ''),
    status: String(pr.status ?? ''),
    sourceBranch: String(pr.sourceRefName ?? ''),
    targetBranch: String(pr.targetRefName ?? ''),
    isDraft: Boolean(pr.isDraft),
    workItemCount: listPullRequestWorkItemIds(config, Number(pr.pullRequestId)).length,
    tags: listPullRequestLabels(config, Number(pr.pullRequestId)),
  }));

  if (wantsJson(args)) {
    printJson({
      ok: true,
      counts: {
        open: openIds.length,
        new: newIds.length,
        active: activeIds.length,
        blocked: blockedIds.length,
        activePullRequests: activePullRequests.length,
        staleActive: staleActiveIds.length,
        recentDone: recentDoneIds.length,
      },
      staleDays,
      recentDays,
      agentWorkload,
      unclaimedNewCount,
      blockedItems: blockedSummaries,
      activePullRequests: activePullRequestSummaries,
      recentDone: recentDoneSummaries,
    });
    return;
  }

  console.log('=== AEL REPORT ===');
  console.log(`Open work items: ${openIds.length}`);
  console.log(`New work items: ${newIds.length} (${unclaimedNewCount} unclaimed)`);
  console.log(`Active work items: ${activeIds.length}`);
  console.log(`Blocked active items: ${blockedIds.length}`);
  console.log(`Active PRs: ${activePullRequests.length}`);
  console.log(`Stale active items (>= ${staleDays} days): ${staleActiveIds.length}`);
  console.log(`Recently done (<= ${recentDays} days): ${recentDoneIds.length}`);

  if (agentWorkload.length > 0) {
    console.log('Active by agent:');
    for (const workload of agentWorkload) {
      console.log(`- ${workload.agent}: ${workload.activeCount}`);
    }
  }

  if (blockedSummaries.length > 0) {
    console.log('Blocked items:');
    printWorkItems(
      config,
      blockedSummaries.map((item) => item.id),
    );
  }

  if (activePullRequests.length > 0) {
    console.log('Active PRs:');
    for (const pr of activePullRequests.slice(0, limit)) {
      const prId = Number(pr.pullRequestId);
      const workItemCount = listPullRequestWorkItemIds(config, prId).length;
      console.log(
        `#${prId} | ${pr.title ?? '(untitled)'} | ${pr.status ?? 'unknown'} | items=${workItemCount}`,
      );
    }
  }

  if (recentDoneSummaries.length > 0) {
    console.log('Recent done:');
    printWorkItems(
      config,
      recentDoneSummaries.map((item) => item.id),
    );
  }
}

export function commandList(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'list');
  const state = (parseArgValue(args, '--state') ?? 'open') as
    | 'new'
    | 'active'
    | 'done'
    | 'open'
    | 'all';
  const agent = parseArgValue(args, '--agent');
  const limitRaw = parseArgValue(args, '--limit') ?? '20';
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit <= 0) fail(`invalid --limit "${limitRaw}".`);

  const ids = queryWorkItems(config, {
    agent,
    state,
    limit,
  });
  if (wantsJson(args)) {
    printJson({
      ok: true,
      count: ids.length,
      workItems: collectWorkItemSummaries(config, ids),
    });
    return;
  }
  printWorkItems(config, ids);
}

export function commandNext(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'next');
  const agent = normalizeAgent(config, parseArgValue(args, '--agent'), config.defaultAgent);

  const newUnclaimedIds = queryWorkItems(config, {
    state: 'new',
    withoutAgentTags: true,
    limit: 25,
  });
  const nextUnclaimedId = findFirstUnblockedWorkItem(config, newUnclaimedIds);
  if (nextUnclaimedId) {
    if (wantsJson(args)) {
      printJson({
        ok: true,
        agent,
        source: 'new-unclaimed',
        count: 1,
        workItems: collectWorkItemSummaries(config, [nextUnclaimedId]),
      });
      return;
    }
    printWorkItems(config, [nextUnclaimedId]);
    return;
  }

  const newIds = queryWorkItems(config, {
    agent,
    state: 'new',
    limit: 25,
  });
  const nextAssignedId = findFirstUnblockedWorkItem(config, newIds);
  if (nextAssignedId) {
    if (wantsJson(args)) {
      printJson({
        ok: true,
        agent,
        source: 'new-assigned',
        count: 1,
        workItems: collectWorkItemSummaries(config, [nextAssignedId]),
      });
      return;
    }
    printWorkItems(config, [nextAssignedId]);
    return;
  }

  const activeIds = queryWorkItems(config, {
    agent,
    state: 'active',
    limit: 25,
  });
  const nextActiveId = findFirstUnblockedWorkItem(config, activeIds);
  if (nextActiveId) {
    if (wantsJson(args)) {
      printJson({
        ok: true,
        agent,
        source: 'active-assigned',
        count: 1,
        workItems: collectWorkItemSummaries(config, [nextActiveId]),
      });
      return;
    }
    printWorkItems(config, [nextActiveId]);
    return;
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      agent,
      source: 'none',
      count: 0,
      workItems: [],
    });
    return;
  }
  console.log(
    `No unclaimed New tasks and no New/Active tasks found for ${getAgentTag(config, agent)}.`,
  );
}
