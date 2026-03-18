import { randomUUID } from 'node:crypto';
import type {
  ApprovalCheckpoint,
  OrchestrationCheckin,
  OrchestrationChild,
  OrchestrationChildStatus,
  OrchestrationParentPlan,
  OrchestrationRole,
  OrchestrationRun,
  OrchestrationRunStatus,
  RunGranularityMode,
  WorkItemShowResult,
} from '../ado-cli-types.js';
import type { AgentExecutionConfig } from '../config.js';
import {
  WORK_ITEM_DESCRIPTION_SECTIONS,
  buildWorkItemDescription,
  extractPlainSection,
  normalizeText,
  renderPullRequestDescription,
} from '../pr-description.js';
import {
  azJson,
  buildFieldPairs,
  configuredAreaTags,
  ensureModeEnabled,
  fail,
  getAgentDefaultAssignee,
  getAgentDefinition,
  getDefaultAgentKey,
  getHumanBlockTag,
  hasFlag,
  mergeFieldDefaults,
  normalizeAgent,
  normalizeTags,
  parseArgValue,
  parseIdListArg,
  parseListArg,
  parseTagList,
  preferredWorkflowCommand,
  printJson,
  resolveBaseBranch,
  resolveTargetBranch,
  slugify,
  wantsJson,
} from '../ado-cli-runtime.js';
import {
  addRelationTargets,
  claimWorkItem,
  createLinkedPullRequest,
  getWorkItem,
  getWorkItemPriorityValue,
  getWorkItemsBatch,
  getWorkItemStateValue,
  getWorkItemTags,
  resolveReviewerFromArgs,
  shouldSyncPrTags,
  updateWorkItemStateAndTags,
} from '../ado-cli-workflow.js';
import { buildCommonPromptContext, loadAelSettings, renderPromptTemplate } from './settings.js';
import {
  appendOrchestrationEvent,
  buildOrchestrationChildBriefPath,
  buildOrchestrationChildManifestPath,
  buildOrchestrationRunBriefPath,
  buildOrchestrationRunManifestPath,
  ensureOrchestrationLayout,
  listOrchestrationRuns,
  loadOrchestrationRun,
  saveOrchestrationRun,
} from './state.js';

interface ParentContext {
  item: WorkItemShowResult;
  workItemId: number;
  title: string;
  description: string;
  humanSummary: string;
  agentContext: string;
  tags: string[];
  areaTags: string[];
  textForPlanning: string;
}

interface PlannedChild {
  childId: string;
  parentWorkItemId: number;
  relatedParentIds?: number[];
  title: string;
  role: OrchestrationRole;
  mode: 'tool' | 'handoff';
  areaTags: string[];
  description: string;
  prompt: string;
}

function buildRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `run-${stamp}-${randomUUID().slice(0, 8)}`;
}

function buildApprovalId(): string {
  return `approval-${randomUUID().slice(0, 8)}`;
}

function collectParentIds(args: string[]): number[] {
  const rawIds = parseArgValue(args, '--ids');
  if (rawIds) {
    return parseIdListArg(rawIds);
  }
  const rawId = parseArgValue(args, '--id');
  if (!rawId) fail('orchestrate requires --ids "<id;id;id>" or --id <workItemId>.');
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${rawId}".`);
  return [id];
}

function isResearchWork(text: string, keywords: string[]): boolean {
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function estimateWorkSize(text: string): number {
  return text
    .split(/\s+/u)
    .map((value) => value.trim())
    .filter(Boolean).length;
}

function chooseGranularityMode(
  explicitValue: string | undefined,
  parents: ParentContext[],
): RunGranularityMode {
  if (explicitValue === 'grouped' || explicitValue === 'isolated') {
    return explicitValue;
  }
  if (parents.length <= 1) return 'isolated';
  const sharedAreaTags = parents
    .map((parent) => new Set(parent.areaTags.map((tag) => tag.toLowerCase())))
    .reduce<Set<string> | undefined>((current, next) => {
      if (!current) return next;
      const intersection = new Set<string>();
      for (const value of current) {
        if (next.has(value)) {
          intersection.add(value);
        }
      }
      return intersection;
    }, undefined);
  return sharedAreaTags && sharedAreaTags.size > 0 ? 'grouped' : 'isolated';
}

function deriveGroupedBranchName(
  config: AgentExecutionConfig,
  agent: string,
  runId: string,
  parents: ParentContext[],
): string {
  const branchPrefix = getAgentDefinition(config, agent).branchPrefix;
  const titleSeed = parents.map((parent) => parent.title).join(' ');
  return `${branchPrefix}/orchestrate-${runId}-${slugify(titleSeed, 24)}`;
}

function deriveParentPlans(
  config: AgentExecutionConfig,
  agent: string,
  runId: string,
  parents: ParentContext[],
  mode: RunGranularityMode,
): {
  groupedBranchName?: string;
  parentPlans: OrchestrationParentPlan[];
} {
  const branchPrefix = getAgentDefinition(config, agent).branchPrefix;
  const groupedBranchName =
    mode === 'grouped' ? deriveGroupedBranchName(config, agent, runId, parents) : undefined;
  return {
    groupedBranchName,
    parentPlans: parents.map((parent) => ({
      workItemId: parent.workItemId,
      title: parent.title,
      branchName:
        groupedBranchName ?? `${branchPrefix}/${parent.workItemId}-${slugify(parent.title)}`,
      areaTags: parent.areaTags,
    })),
  };
}

function createApprovalCheckpoint(
  reason: string,
  note: string,
  child?: OrchestrationChild,
  parentWorkItemId?: number,
): ApprovalCheckpoint {
  return {
    id: buildApprovalId(),
    reason,
    status: 'pending',
    ...(child ? { childId: child.childId, childWorkItemId: child.workItemId } : {}),
    ...(parentWorkItemId ? { parentWorkItemId } : {}),
    note,
    createdAt: new Date().toISOString(),
  };
}

function getParentContexts(
  config: AgentExecutionConfig,
  ids: number[],
  orchestrationAreaTags: string[],
): ParentContext[] {
  return getWorkItemsBatch(config, ids).map((item) => {
    const workItemId = Number(item.id);
    const title = String(item.fields?.['System.Title'] ?? `Work item ${workItemId}`);
    const description = String(item.fields?.['System.Description'] ?? '');
    const humanSummary =
      extractPlainSection(description, 'Human Summary', WORK_ITEM_DESCRIPTION_SECTIONS) || title;
    const agentContext = extractPlainSection(
      description,
      'Agent Context',
      WORK_ITEM_DESCRIPTION_SECTIONS,
    );
    const tags = parseTagList(
      typeof item.fields?.['System.Tags'] === 'string' ? item.fields['System.Tags'] : undefined,
    );
    const areaTags = orchestrationAreaTags.filter((tag) =>
      tags.some((existing) => existing.toLowerCase() === tag.toLowerCase()),
    );
    return {
      item,
      workItemId,
      title,
      description,
      humanSummary,
      agentContext,
      tags,
      areaTags,
      textForPlanning: [title, humanSummary, agentContext].filter(Boolean).join('\n'),
    };
  });
}

function buildOrchestrationTags(
  settings: ReturnType<typeof loadAelSettings>['settings'],
  runId: string,
  orchestratorAgent: string,
  role: OrchestrationRole,
  mode: 'tool' | 'handoff',
  areaTags: string[],
  extraTags: string[] = [],
): string[] {
  const orchestrationTags = settings.orchestration.tags;
  return normalizeTags([
    ...areaTags,
    ...extraTags,
    orchestrationTags.orchestrated,
    `${orchestrationTags.orchestratorPrefix}${orchestratorAgent}`,
    `${orchestrationTags.runPrefix}${runId}`,
    `${orchestrationTags.rolePrefix}${role}`,
    `${orchestrationTags.modePrefix}${mode}`,
  ]);
}

function createChildWorkItem(
  config: AgentExecutionConfig,
  parent: ParentContext,
  child: PlannedChild,
): number {
  const priority = getWorkItemPriorityValue(parent.item);
  const azArgs = [
    'boards',
    'work-item',
    'create',
    '--project',
    config.project,
    '--type',
    config.hierarchyDefaults.taskType,
    '--title',
    child.title,
    '--area',
    config.defaultAreaPath,
    '--iteration',
    config.defaultIterationPath,
  ];
  if (child.description) {
    azArgs.push('--description', child.description);
  }
  const fieldsApplied = mergeFieldDefaults(config.workItemFieldDefaults.create, {
    'System.Tags': child.areaTags.length > 0 ? child.areaTags.join(';') : '',
    ...(priority !== undefined ? { 'Microsoft.VSTS.Common.Priority': priority } : {}),
  });
  const fieldPairs = buildFieldPairs(fieldsApplied);
  if (fieldPairs.length > 0) {
    azArgs.push('--fields', ...fieldPairs);
  }
  const created = azJson(config, azArgs) as WorkItemShowResult;
  const createdId = Number(created.id);
  if (!Number.isFinite(createdId)) {
    fail(`failed to create orchestration child work item for parent #${parent.workItemId}.`);
  }
  addRelationTargets(config, createdId, 'parent', [parent.workItemId]);
  if (child.relatedParentIds && child.relatedParentIds.length > 0) {
    addRelationTargets(config, createdId, 'related', child.relatedParentIds);
  }
  return createdId;
}

function resolveRunStatus(run: OrchestrationRun): OrchestrationRunStatus {
  if (run.finalization.status === 'finalized') return 'completed';
  if (run.finalization.status === 'stopped' || run.stoppedAt) return 'stopped';
  if (run.approvalCheckpoints.some((checkpoint) => checkpoint.status === 'pending'))
    return 'blocked';
  if (run.children.some((child) => child.status === 'blocked' || child.status === 'failed')) {
    return 'blocked';
  }
  if (run.children.every((child) => child.status === 'done' || child.status === 'stopped')) {
    return 'ready';
  }
  return 'active';
}

function refreshRunDerivedFields(run: OrchestrationRun): OrchestrationRun {
  const normalizedChildren = run.children.map((child) => ({
    ...child,
    updatedAt: child.updatedAt || run.updatedAt,
  }));
  const readyForFinalization = normalizedChildren.every(
    (child) => child.status === 'done' || child.status === 'stopped',
  );
  const finalizationStatus =
    run.finalization.status === 'finalized' || run.finalization.status === 'stopped'
      ? run.finalization.status
      : readyForFinalization
        ? 'ready'
        : 'pending';
  const refreshed: OrchestrationRun = {
    ...run,
    children: normalizedChildren,
    activeChildIds: normalizedChildren
      .filter((child) => child.status !== 'done' && child.status !== 'stopped')
      .map((child) => child.childId),
    finalization: {
      ...run.finalization,
      status: finalizationStatus,
    },
    updatedAt: new Date().toISOString(),
  };
  refreshed.status = resolveRunStatus(refreshed);
  return refreshed;
}

function buildIntegrationChecklist(baseBranch: string): string[] {
  return [
    `Integrate accepted child changes onto the working branch that will target ${baseBranch}.`,
    'Run the project validation commands defined for this repo before finalizing the run.',
    'Open the final PR only after every required child is reviewed and accepted by the orchestrator.',
  ];
}

function buildOrchestratorPrompt(
  run: OrchestrationRun,
  parentContexts: ParentContext[],
  settings: ReturnType<typeof loadAelSettings>,
): string {
  const context = {
    ...buildCommonPromptContext(),
    RUN_ID: run.runId,
    PARENT_IDS: run.parentIds.join(', '),
    PARENT_TITLES: parentContexts
      .map((parent) => `#${parent.workItemId} ${parent.title}`)
      .join('\n'),
    GRANULARITY_MODE: run.granularityMode,
    GROUPED_BRANCH_NAME: run.groupedBranchName ?? '(none)',
    MAX_PARALLEL_CHILDREN: String(settings.settings.orchestration.defaults.maxParallelChildren),
    INTEGRATION_CHECKLIST: run.integrationChecklist.map((entry) => `- ${entry}`).join('\n'),
  };
  return renderPromptTemplate(settings.settings.promptTemplates.orchestratorMaster, context);
}

function buildChildPrompt(
  run: OrchestrationRun,
  child: OrchestrationChild,
  settings: ReturnType<typeof loadAelSettings>,
): string {
  const context = {
    ...buildCommonPromptContext(),
    RUN_ID: run.runId,
    CHILD_ID: child.childId,
    CHILD_WORK_ITEM_ID: child.workItemId ? String(child.workItemId) : '(not created)',
    PARENT_WORK_ITEM_ID: String(child.parentWorkItemId),
    CHILD_ROLE: child.role,
    CHILD_MODE: child.mode,
    CHILD_TITLE: child.title,
    CHILD_AREA_TAGS: child.areaTags.join(', ') || '(none)',
    ALLOWED_SCOPE:
      child.areaTags.length > 0
        ? child.areaTags.join(', ')
        : 'Only files needed to complete the assigned child work.',
    COMPLETION_COMMAND: preferredWorkflowCommand(
      'subagent-checkin',
      ` -- --run ${run.runId} --child ${child.childId} --status <started|done|blocked|failed> --summary "<summary>"`,
    ),
    GROUPED_BRANCH_NAME: run.groupedBranchName ?? '(none)',
  };
  return renderPromptTemplate(settings.settings.promptTemplates.orchestratorChild, context);
}

function buildFinalizePrompt(
  run: OrchestrationRun,
  settings: ReturnType<typeof loadAelSettings>,
): string {
  const context = {
    ...buildCommonPromptContext(),
    RUN_ID: run.runId,
    PARENT_IDS: run.parentIds.join(', '),
    PULL_REQUEST_IDS: run.finalization.pullRequestIds.join(', ') || '(none yet)',
    INTEGRATION_CHECKLIST: run.integrationChecklist.map((entry) => `- ${entry}`).join('\n'),
  };
  return renderPromptTemplate(settings.settings.promptTemplates.orchestratorFinalize, context);
}

function planChildrenForParents(
  runId: string,
  parents: ParentContext[],
  settings: ReturnType<typeof loadAelSettings>['settings'],
  granularityMode: RunGranularityMode,
): PlannedChild[] {
  const children: PlannedChild[] = [];
  const threshold = settings.orchestration.defaults.childSizeThreshold;

  for (const parent of parents) {
    const parentSize = estimateWorkSize(parent.textForPlanning);
    const needsResearch =
      settings.orchestration.defaults.createResearchChildOnKeywords &&
      isResearchWork(parent.textForPlanning, settings.orchestration.defaults.researchKeywords);
    const shouldDelegate =
      granularityMode === 'grouped' || needsResearch || parentSize >= threshold;

    if (!shouldDelegate) {
      continue;
    }

    if (needsResearch) {
      children.push({
        childId: `${parent.workItemId}-research`,
        parentWorkItemId: parent.workItemId,
        title: `Research: ${parent.title}`,
        role: 'research',
        mode: 'tool',
        areaTags: parent.areaTags,
        description:
          buildWorkItemDescription({
            humanSummary: `Research constraints, risks, and open questions for ${parent.title}.`,
            agentContext: parent.agentContext || parent.humanSummary,
            mappedTables: [],
            acceptance: ['Capture findings and recommended implementation direction.'],
          }) ?? '',
        prompt: '',
      });
    }

    children.push({
      childId: `${parent.workItemId}-implement`,
      parentWorkItemId: parent.workItemId,
      title: `Implement: ${parent.title}`,
      role: 'implement',
      mode: 'handoff',
      areaTags: parent.areaTags,
      description:
        buildWorkItemDescription({
          humanSummary: parent.humanSummary,
          agentContext: parent.agentContext || parent.title,
          mappedTables: [],
          acceptance: ['Complete the scoped implementation and report back to the orchestrator.'],
        }) ?? '',
      prompt: '',
    });

    if (settings.orchestration.defaults.createValidationChild) {
      children.push({
        childId: `${parent.workItemId}-validate`,
        parentWorkItemId: parent.workItemId,
        title: `Validate: ${parent.title}`,
        role: 'validate',
        mode: 'tool',
        areaTags: parent.areaTags,
        description:
          buildWorkItemDescription({
            humanSummary: `Validate the implementation for ${parent.title}.`,
            agentContext: 'Confirm tests, checks, and acceptance criteria are satisfied.',
            mappedTables: [],
            acceptance: ['Summarize validation results and any residual risk.'],
          }) ?? '',
        prompt: '',
      });
    }
  }

  if (granularityMode === 'grouped' && parents.length > 1) {
    const sharedAreaTags = normalizeTags(parents.flatMap((parent) => parent.areaTags));
    const anchorParent = parents[0];
    children.push({
      childId: `${anchorParent.workItemId}-integration`,
      parentWorkItemId: anchorParent.workItemId,
      relatedParentIds: parents.slice(1).map((parent) => parent.workItemId),
      title: `Integration: ${parents.map((parent) => `#${parent.workItemId}`).join(', ')}`,
      role: 'integration',
      mode: 'handoff',
      areaTags: sharedAreaTags,
      description:
        buildWorkItemDescription({
          humanSummary:
            'Integrate the grouped orchestration work into a coherent branch and verify readiness for one PR.',
          agentContext:
            'This child owns merge conflict resolution, final integration checks, and grouped PR preparation.',
          mappedTables: [],
          acceptance: ['Summarize integration readiness and remaining gaps for the orchestrator.'],
        }) ?? '',
      prompt: '',
    });
  }

  return children;
}

function createChildManifests(
  config: AgentExecutionConfig,
  run: OrchestrationRun,
  plannedChildren: PlannedChild[],
  settings: ReturnType<typeof loadAelSettings>,
  planOnly: boolean,
): {
  children: OrchestrationChild[];
  childBriefs: Record<string, string>;
} {
  const childBriefs: Record<string, string> = {};
  const children = plannedChildren.map((plan) => {
    const promptStub =
      buildWorkItemDescription({
        humanSummary: plan.title,
        agentContext: plan.description,
        mappedTables: [],
        acceptance: [],
      }) ?? '';
    const initialTags = buildOrchestrationTags(
      settings.settings,
      run.runId,
      run.orchestratorAgent,
      plan.role,
      plan.mode,
      plan.areaTags,
      config.sharedTags,
    );
    const childDescription = plan.description || promptStub;
    const workItemId = planOnly
      ? undefined
      : createChildWorkItem(
          config,
          getParentContexts(config, [plan.parentWorkItemId], configuredAreaTags(config))[0],
          {
            ...plan,
            areaTags: initialTags,
          },
        );
    const child: OrchestrationChild = {
      childId: plan.childId,
      parentWorkItemId: plan.parentWorkItemId,
      ...(plan.relatedParentIds && plan.relatedParentIds.length > 0
        ? { relatedParentIds: plan.relatedParentIds }
        : {}),
      ...(workItemId ? { workItemId } : {}),
      title: plan.title,
      role: plan.role,
      mode: plan.mode,
      status: 'planned',
      awaitingOrchestratorReview: false,
      areaTags: plan.areaTags,
      tags: initialTags,
      briefPath: buildOrchestrationChildBriefPath(run.runId, plan.childId),
      manifestPath: buildOrchestrationChildManifestPath(run.runId, plan.childId),
      prompt: childDescription,
      checkins: [],
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
    };
    const prompt = buildChildPrompt(run, child, settings);
    child.prompt = prompt;
    childBriefs[child.childId] = prompt;
    return child;
  });
  return { children, childBriefs };
}

function findReusableRun(parentIds: number[]): OrchestrationRun | undefined {
  const normalizedIds = [...parentIds].sort((left, right) => left - right);
  return listOrchestrationRuns().find((run) => {
    if (run.status === 'completed' || run.status === 'stopped') return false;
    return JSON.stringify(run.parentIds) === JSON.stringify(normalizedIds);
  });
}

function summarizeRun(run: OrchestrationRun): {
  totalChildren: number;
  childCounts: Record<OrchestrationChildStatus, number>;
  pendingApprovals: number;
} {
  const childCounts = run.children.reduce<Record<OrchestrationChildStatus, number>>(
    (counts, child) => {
      counts[child.status] = (counts[child.status] ?? 0) + 1;
      return counts;
    },
    {
      planned: 0,
      started: 0,
      done: 0,
      blocked: 0,
      failed: 0,
      stopped: 0,
    },
  );
  return {
    totalChildren: run.children.length,
    childCounts,
    pendingApprovals: run.approvalCheckpoints.filter(
      (checkpoint) => checkpoint.status === 'pending',
    ).length,
  };
}

function childStatusFromWorkItem(
  config: AgentExecutionConfig,
  child: OrchestrationChild,
): OrchestrationChildStatus {
  if (!child.workItemId) return child.status;
  const item = getWorkItem(config, child.workItemId);
  const state = getWorkItemStateValue(item).toLowerCase();
  const tags = getWorkItemTags(config, child.workItemId).map((tag) => tag.toLowerCase());
  if (state === config.stateMap.done.toLowerCase()) return 'done';
  if (tags.includes(getHumanBlockTag(config, 'human-approval-needed').toLowerCase())) {
    return 'blocked';
  }
  if (tags.includes('awaiting-orchestrator-review')) {
    return 'done';
  }
  return child.status;
}

function finalizeGroupedRun(
  config: AgentExecutionConfig,
  run: OrchestrationRun,
  args: string[],
): ReturnType<typeof createLinkedPullRequest> {
  const parentItems = getWorkItemsBatch(config, run.parentIds);
  const primaryItem = parentItems[0];
  const parentTitles = run.parentPlans
    .map((plan) => `#${plan.workItemId} ${plan.title}`)
    .join('; ');
  const titleBase =
    normalizeText(parseArgValue(args, '--title')) ??
    `Grouped orchestration delivery for ${run.parentPlans.map((plan) => `#${plan.workItemId}`).join(', ')}`;
  const titlePrefix = run.parentIds.map((id) => `AB#${id}`).join(' ');
  const prTitle = titleBase.startsWith('AB#') ? titleBase : `${titlePrefix} ${titleBase}`;
  const description =
    normalizeText(parseArgValue(args, '--description')) ??
    renderPullRequestDescription(
      run.parentIds[0],
      parentTitles,
      buildFinalizePrompt(run, loadAelSettings()),
    );
  const reviewer = resolveReviewerFromArgs(config, args, primaryItem);
  const sourceBranch = parseArgValue(args, '--source-branch') ?? run.groupedBranchName;
  if (!sourceBranch) {
    fail(`run ${run.runId} has no grouped branch plan. Provide --source-branch explicitly.`);
  }
  return createLinkedPullRequest(config, {
    workItemIds: run.parentIds,
    title: prTitle,
    description,
    sourceBranch,
    targetBranch: resolveTargetBranch(config, args),
    draft: !hasFlag(args, '--ready'),
    autoComplete: hasFlag(args, '--auto-complete'),
    reviewer,
    syncPrTags: shouldSyncPrTags(config, args),
    syncTagMode: config.prDefaults.syncTagMode,
  });
}

function finalizeIsolatedParentRun(
  config: AgentExecutionConfig,
  run: OrchestrationRun,
  args: string[],
  parentId: number,
): ReturnType<typeof createLinkedPullRequest> {
  const item = getWorkItem(config, parentId);
  const titleBase = String(item.fields?.['System.Title'] ?? `Work item ${parentId}`);
  const prTitleRaw = normalizeText(parseArgValue(args, '--title')) ?? titleBase;
  const prTitle = prTitleRaw.startsWith(`AB#${parentId}`)
    ? prTitleRaw
    : `AB#${parentId} ${prTitleRaw}`;
  const workItemDescription = String(item.fields?.['System.Description'] ?? '');
  const humanSummary =
    extractPlainSection(workItemDescription, 'Human Summary', WORK_ITEM_DESCRIPTION_SECTIONS) ||
    titleBase;
  const agentContext = extractPlainSection(
    workItemDescription,
    'Agent Context',
    WORK_ITEM_DESCRIPTION_SECTIONS,
  );
  const description =
    normalizeText(parseArgValue(args, '--description')) ??
    renderPullRequestDescription(parentId, humanSummary, agentContext);
  const reviewer = resolveReviewerFromArgs(config, args, item);
  const parentPlan = run.parentPlans.find((plan) => plan.workItemId === parentId);
  const sourceBranch = parseArgValue(args, '--source-branch') ?? parentPlan?.branchName;
  if (!sourceBranch) {
    fail(
      `run ${run.runId} has no branch plan for parent #${parentId}. Provide --source-branch explicitly.`,
    );
  }
  return createLinkedPullRequest(config, {
    workItemIds: [parentId],
    title: prTitle,
    description,
    sourceBranch,
    targetBranch: resolveTargetBranch(config, args),
    draft: !hasFlag(args, '--ready'),
    autoComplete: hasFlag(args, '--auto-complete'),
    reviewer,
    syncPrTags: shouldSyncPrTags(config, args),
    syncTagMode: config.prDefaults.syncTagMode,
  });
}

export function commandOrchestrate(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'orchestrate');
  ensureOrchestrationLayout();
  const json = wantsJson(args);
  const planOnly = hasFlag(args, '--plan-only');
  const parentIds = Array.from(new Set(collectParentIds(args)));
  const orchestratorAgent = normalizeAgent(
    config,
    parseArgValue(args, '--agent'),
    getDefaultAgentKey(config),
  );
  const settings = loadAelSettings();
  const existing = findReusableRun(parentIds);
  if (existing && !hasFlag(args, '--force')) {
    const summary = summarizeRun(existing);
    if (json) {
      printJson({
        ok: true,
        reused: true,
        run: existing,
        summary,
        warnings: settings.warnings,
      });
      return;
    }
    console.log(`Reusing orchestration run ${existing.runId}.`);
    console.log(`Status: ${existing.status}`);
    console.log(`Children: ${summary.totalChildren}`);
    console.log(
      `Next: ${preferredWorkflowCommand('orchestrate-status', ` -- --run ${existing.runId}`)}`,
    );
    return;
  }

  const parentContexts = getParentContexts(config, parentIds, configuredAreaTags(config));
  const runId = buildRunId();
  const granularityMode = chooseGranularityMode(
    parseArgValue(args, '--granularity'),
    parentContexts,
  );
  const baseBranch = resolveBaseBranch(config, args);
  const branchPlan = deriveParentPlans(
    config,
    orchestratorAgent,
    runId,
    parentContexts,
    granularityMode,
  );
  const createdAt = new Date().toISOString();

  const initialRun: OrchestrationRun = {
    runId,
    orchestratorAgent,
    parentIds,
    status: 'active',
    granularityMode,
    baseBranch,
    ...(branchPlan.groupedBranchName ? { groupedBranchName: branchPlan.groupedBranchName } : {}),
    parentPlans: branchPlan.parentPlans,
    activeChildIds: [],
    children: [],
    approvalCheckpoints: [],
    finalization: {
      status: 'pending',
      pullRequestIds: [],
      outstandingValidation: [],
    },
    integrationChecklist: buildIntegrationChecklist(baseBranch),
    orchestratorPrompt: '',
    briefPath: buildOrchestrationRunBriefPath(runId),
    manifestPath: buildOrchestrationRunManifestPath(runId),
    createdAt,
    updatedAt: createdAt,
  };

  const plannedChildren = planChildrenForParents(
    runId,
    parentContexts,
    settings.settings,
    granularityMode,
  );
  const approvalCheckpoints: ApprovalCheckpoint[] = [];
  if (
    plannedChildren.length > settings.settings.orchestration.approvals.maxChildrenBeforeApproval
  ) {
    approvalCheckpoints.push(
      createApprovalCheckpoint(
        'too-many-children',
        `Planned ${plannedChildren.length} children which exceeds the configured threshold of ${settings.settings.orchestration.approvals.maxChildrenBeforeApproval}.`,
      ),
    );
  }

  if (!planOnly) {
    for (const parent of parentContexts) {
      const rawAssignedTo = getAgentDefaultAssignee(config, orchestratorAgent);
      claimWorkItem(
        config,
        parent.workItemId,
        orchestratorAgent,
        rawAssignedTo,
        `Attached to orchestration run ${runId}.`,
      );
    }
  }

  const runWithPrompt = {
    ...initialRun,
    approvalCheckpoints,
  };
  const { children, childBriefs } = createChildManifests(
    config,
    runWithPrompt,
    plannedChildren,
    settings,
    planOnly,
  );
  const run: OrchestrationRun = refreshRunDerivedFields({
    ...runWithPrompt,
    children,
    orchestratorPrompt: '',
  });
  run.orchestratorPrompt = buildOrchestratorPrompt(run, parentContexts, settings);

  if (!planOnly) {
    saveOrchestrationRun(run, {
      runBrief: run.orchestratorPrompt,
      childBriefs,
    });
    appendOrchestrationEvent(run.runId, {
      type: 'run.created',
      at: run.createdAt,
      runId: run.runId,
      parentIds: run.parentIds,
      childIds: run.children.map((child) => child.childId),
    });
  }

  const summary = summarizeRun(run);
  if (json) {
    printJson({
      ok: true,
      reused: false,
      planOnly,
      run,
      summary,
      warnings: settings.warnings,
      nextSteps:
        run.children.length > 0
          ? [
              preferredWorkflowCommand('orchestrate-status', ` -- --run ${run.runId}`),
              preferredWorkflowCommand(
                'subagent-checkin',
                ` -- --run ${run.runId} --child <child-id> --status started`,
              ),
            ]
          : [preferredWorkflowCommand('orchestrate-finalize', ` -- --run ${run.runId} --ready`)],
    });
    return;
  }

  console.log(
    `${planOnly ? 'Planned' : 'Created'} orchestration run ${run.runId} (${run.granularityMode}).`,
  );
  console.log(`Parents: ${run.parentIds.map((id) => `#${id}`).join(', ')}`);
  console.log(`Children: ${summary.totalChildren}`);
  console.log(`Run brief: ${run.briefPath}`);
  if (run.children.length > 0) {
    console.log(
      `Next: ${preferredWorkflowCommand('orchestrate-status', ` -- --run ${run.runId}`)}`,
    );
  } else {
    console.log(
      `Next: ${preferredWorkflowCommand('orchestrate-finalize', ` -- --run ${run.runId} --ready`)}`,
    );
  }
}

export function commandOrchestrateStatus(_config: AgentExecutionConfig, args: string[]): void {
  ensureOrchestrationLayout();
  const runId = parseArgValue(args, '--run');
  if (!runId) fail('orchestrate-status requires --run <run-id>.');
  const run = loadOrchestrationRun(runId);
  const summary = summarizeRun(run);
  const nextSteps: string[] = [];
  if (run.approvalCheckpoints.some((checkpoint) => checkpoint.status === 'pending')) {
    nextSteps.push(
      'Resolve the pending orchestration approval checkpoints and then re-run status.',
    );
  } else if (run.status === 'ready') {
    nextSteps.push(
      preferredWorkflowCommand('orchestrate-finalize', ` -- --run ${run.runId} --ready`),
    );
  } else if (run.children.length > 0) {
    nextSteps.push(
      'Spawn Codex app subagents using the generated child briefs and have them call ael subagent-checkin on progress.',
    );
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      run,
      summary,
      nextSteps,
    });
    return;
  }
  console.log(`Run: ${run.runId}`);
  console.log(`Status: ${run.status}`);
  console.log(`Mode: ${run.granularityMode}`);
  console.log(`Parents: ${run.parentIds.map((id) => `#${id}`).join(', ')}`);
  console.log(`Children: ${summary.totalChildren}`);
  for (const child of run.children) {
    console.log(
      `- ${child.childId} | ${child.role} | ${child.status} | ${child.workItemId ? `#${child.workItemId}` : '(no work item)'} | ${child.briefPath}`,
    );
  }
  if (nextSteps.length > 0) {
    console.log(`Next: ${nextSteps.join(' | ')}`);
  }
}

export function commandSubagentCheckin(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'subagent-checkin');
  ensureOrchestrationLayout();
  const runId = parseArgValue(args, '--run');
  const childId = parseArgValue(args, '--child');
  const statusRaw = parseArgValue(args, '--status');
  if (!runId || !childId || !statusRaw) {
    fail(
      'subagent-checkin requires --run <run-id> --child <child-id> --status <started|done|blocked|failed>.',
    );
  }
  if (!['started', 'done', 'blocked', 'failed'].includes(statusRaw)) {
    fail(`unsupported --status "${statusRaw}".`);
  }
  const run = loadOrchestrationRun(runId);
  const childIndex = run.children.findIndex((child) => child.childId === childId);
  if (childIndex < 0) {
    fail(`run ${runId} does not include child ${childId}.`);
  }

  const settings = loadAelSettings();
  const summary = normalizeText(parseArgValue(args, '--summary'));
  const note = normalizeText(parseArgValue(args, '--note'));
  const reason = normalizeText(parseArgValue(args, '--reason'));
  const status = statusRaw as 'started' | 'done' | 'blocked' | 'failed';
  const checkinPolicy = settings.settings.orchestration.checkinPolicy;
  if (status === 'done' && checkinPolicy.requireSummaryOnDone && !summary) {
    fail('subagent-checkin requires --summary when --status done.');
  }
  if (status === 'blocked' && checkinPolicy.requireSummaryOnBlocked && !summary) {
    fail('subagent-checkin requires --summary when --status blocked.');
  }
  if (status === 'failed' && checkinPolicy.requireSummaryOnFailed && !summary) {
    fail('subagent-checkin requires --summary when --status failed.');
  }

  const child = run.children[childIndex];
  const now = new Date().toISOString();
  const checkin: OrchestrationCheckin = {
    runId,
    childId,
    status,
    ...(summary ? { summary } : {}),
    ...(note ? { note } : {}),
    ...(reason ? { reason } : {}),
    at: now,
  };

  const awaitingReview =
    status === 'done' ? true : status === 'started' ? false : child.awaitingOrchestratorReview;
  const updatedTags =
    status === 'done'
      ? normalizeTags([...child.tags, settings.settings.orchestration.tags.awaitingReview])
      : child.tags;
  const updatedChild: OrchestrationChild = {
    ...child,
    status,
    awaitingOrchestratorReview: awaitingReview,
    tags: updatedTags,
    ...(summary ? { summary } : child.summary ? { summary: child.summary } : {}),
    ...(note ? { note } : child.note ? { note: child.note } : {}),
    checkins: [...child.checkins, checkin],
    updatedAt: now,
  };
  run.children[childIndex] = updatedChild;

  if (updatedChild.workItemId) {
    const workItemTags =
      status === 'done'
        ? normalizeTags([
            ...getWorkItemTags(config, updatedChild.workItemId),
            settings.settings.orchestration.tags.awaitingReview,
          ])
        : status === 'blocked'
          ? normalizeTags([
              ...getWorkItemTags(config, updatedChild.workItemId),
              getHumanBlockTag(config, 'human-approval-needed'),
            ])
          : getWorkItemTags(config, updatedChild.workItemId);
    updateWorkItemStateAndTags(
      config,
      updatedChild.workItemId,
      status === 'started'
        ? config.stateMap.active
        : getWorkItemStateValue(getWorkItem(config, updatedChild.workItemId)),
      workItemTags,
      summary ?? note ?? `Subagent check-in: ${status}.`,
    );
  }

  if (status === 'blocked' || status === 'failed') {
    run.approvalCheckpoints.push(
      createApprovalCheckpoint(
        `child-${status}`,
        summary ?? `${updatedChild.childId} reported ${status}.`,
        updatedChild,
        updatedChild.parentWorkItemId,
      ),
    );
    const parentTags = normalizeTags([
      ...getWorkItemTags(config, updatedChild.parentWorkItemId),
      getHumanBlockTag(config, 'human-approval-needed'),
    ]);
    updateWorkItemStateAndTags(
      config,
      updatedChild.parentWorkItemId,
      getWorkItemStateValue(getWorkItem(config, updatedChild.parentWorkItemId)) ||
        config.stateMap.active,
      parentTags,
      summary ?? `${updatedChild.childId} reported ${status}.`,
    );
  }

  const refreshedRun = refreshRunDerivedFields(run);
  saveOrchestrationRun(refreshedRun);
  appendOrchestrationEvent(runId, {
    type: 'child.checkin',
    at: now,
    childId,
    status,
    ...(summary ? { summary } : {}),
  });

  if (wantsJson(args)) {
    printJson({
      ok: true,
      run: refreshedRun,
      child: updatedChild,
    });
    return;
  }
  console.log(`Recorded ${status} check-in for ${childId} on run ${runId}.`);
}

export function commandOrchestrateSync(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'orchestrate-sync');
  ensureOrchestrationLayout();
  const runId = parseArgValue(args, '--run');
  if (!runId) fail('orchestrate-sync requires --run <run-id>.');
  const run = loadOrchestrationRun(runId);
  const syncedRun: OrchestrationRun = {
    ...run,
    children: run.children.map((child) => {
      const status = childStatusFromWorkItem(config, child);
      return {
        ...child,
        status,
        awaitingOrchestratorReview:
          status === 'done'
            ? getWorkItemTags(config, child.workItemId ?? 0).some(
                (tag) =>
                  tag.toLowerCase() ===
                  loadAelSettings().settings.orchestration.tags.awaitingReview.toLowerCase(),
              )
            : child.awaitingOrchestratorReview,
        updatedAt: new Date().toISOString(),
      };
    }),
  };
  const refreshedRun = refreshRunDerivedFields(syncedRun);
  saveOrchestrationRun(refreshedRun);
  appendOrchestrationEvent(runId, {
    type: 'run.synced',
    at: refreshedRun.updatedAt,
    runId,
  });

  if (wantsJson(args)) {
    printJson({ ok: true, run: refreshedRun, summary: summarizeRun(refreshedRun) });
    return;
  }
  console.log(`Synchronized orchestration run ${runId}.`);
}

export function commandOrchestrateFinalize(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'orchestrate-finalize');
  ensureOrchestrationLayout();
  const runId = parseArgValue(args, '--run');
  if (!runId) fail('orchestrate-finalize requires --run <run-id>.');
  let run = refreshRunDerivedFields(loadOrchestrationRun(runId));
  if (run.approvalCheckpoints.some((checkpoint) => checkpoint.status === 'pending')) {
    fail(
      `run ${run.runId} has pending approval checkpoints. Review them with ${preferredWorkflowCommand('orchestrate-status', ` -- --run ${run.runId}`)} first.`,
    );
  }
  const incompleteChildren = run.children.filter(
    (child) => child.status !== 'done' && child.status !== 'stopped',
  );
  if (incompleteChildren.length > 0) {
    fail(
      `run ${run.runId} is not ready to finalize. Remaining children: ${incompleteChildren.map((child) => child.childId).join(', ')}.`,
    );
  }

  for (const child of run.children) {
    if (!child.workItemId) continue;
    const currentTags = getWorkItemTags(config, child.workItemId);
    const updatedTags = normalizeTags(
      currentTags.filter(
        (tag) =>
          tag.toLowerCase() !==
          loadAelSettings().settings.orchestration.tags.awaitingReview.toLowerCase(),
      ),
    );
    updateWorkItemStateAndTags(
      config,
      child.workItemId,
      config.stateMap.done,
      updatedTags,
      'Accepted by the orchestrator and ready for final delivery.',
    );
  }

  if (run.granularityMode === 'grouped') {
    const settings = loadAelSettings();
    if (
      settings.settings.orchestration.approvals.requireApprovalForGroupedPr &&
      !hasFlag(args, '--approve-grouped-pr')
    ) {
      const checkpoint = createApprovalCheckpoint(
        'grouped-pr-approval',
        `Grouped PR approval required before finalizing run ${run.runId}.`,
      );
      run.approvalCheckpoints.push(checkpoint);
      run = refreshRunDerivedFields(run);
      saveOrchestrationRun(run);
      fail(
        `grouped PR approval is required. Re-run with --approve-grouped-pr after human approval, or inspect ${preferredWorkflowCommand('orchestrate-status', ` -- --run ${run.runId}`)}.`,
      );
    }
    const created = finalizeGroupedRun(config, run, args);
    run.finalization.pullRequestIds = Array.from(
      new Set([...run.finalization.pullRequestIds, created.pullRequestId]),
    );
  } else {
    const parentRaw = parseArgValue(args, '--parent');
    const parentId =
      parentRaw !== undefined
        ? Number.parseInt(parentRaw, 10)
        : run.parentIds.length === 1
          ? run.parentIds[0]
          : undefined;
    if (!parentId || !run.parentIds.includes(parentId)) {
      fail(
        'isolated orchestration finalization requires --parent <id> when the run contains multiple parents.',
      );
    }
    const created = finalizeIsolatedParentRun(config, run, args, parentId);
    run.finalization.pullRequestIds = Array.from(
      new Set([...run.finalization.pullRequestIds, created.pullRequestId]),
    );
    run.parentPlans = run.parentPlans.map((plan) =>
      plan.workItemId === parentId
        ? { ...plan, pullRequestId: created.pullRequestId, finalizedAt: new Date().toISOString() }
        : plan,
    );
  }

  const allIsolatedParentsFinalized =
    run.granularityMode === 'isolated'
      ? run.parentPlans.every((plan) => Number.isFinite(plan.pullRequestId))
      : true;
  run.finalization.status = allIsolatedParentsFinalized ? 'finalized' : 'ready';
  run.finalization.finalizedAt = allIsolatedParentsFinalized ? new Date().toISOString() : undefined;
  run = refreshRunDerivedFields(run);
  saveOrchestrationRun(run);
  appendOrchestrationEvent(run.runId, {
    type: 'run.finalized',
    at: run.updatedAt,
    pullRequestIds: run.finalization.pullRequestIds,
  });

  if (wantsJson(args)) {
    printJson({
      ok: true,
      run,
      summary: summarizeRun(run),
    });
    return;
  }
  console.log(`Finalized orchestration run ${run.runId}.`);
}

export function commandOrchestrateStop(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'orchestrate-stop');
  ensureOrchestrationLayout();
  const runId = parseArgValue(args, '--run');
  if (!runId) fail('orchestrate-stop requires --run <run-id>.');
  let run = loadOrchestrationRun(runId);
  const settings = loadAelSettings();
  if (
    settings.settings.orchestration.approvals.requireApprovalForStop &&
    !hasFlag(args, '--approve-stop')
  ) {
    run.approvalCheckpoints.push(
      createApprovalCheckpoint(
        'stop-approval',
        `Stopping orchestration run ${run.runId} requires human approval.`,
      ),
    );
    run = refreshRunDerivedFields(run);
    saveOrchestrationRun(run);
    fail('stop approval is required. Re-run with --approve-stop after human approval.');
  }
  run.stoppedAt = new Date().toISOString();
  run.finalization.status = 'stopped';
  run.children = run.children.map((child) =>
    child.status === 'done'
      ? child
      : { ...child, status: 'stopped', updatedAt: run.stoppedAt ?? child.updatedAt },
  );
  run = refreshRunDerivedFields(run);
  saveOrchestrationRun(run);
  appendOrchestrationEvent(run.runId, {
    type: 'run.stopped',
    at: run.stoppedAt,
  });

  if (wantsJson(args)) {
    printJson({ ok: true, run });
    return;
  }
  console.log(`Stopped orchestration run ${run.runId}.`);
}
