import {
  PULL_REQUEST_DESCRIPTION_SECTIONS,
  WORK_ITEM_DESCRIPTION_SECTIONS,
  buildCompletionDiscussion,
  buildWorkItemDescription,
  extractPlainSection,
  normalizeText,
  renderPullRequestDescription,
} from './pr-description.js';
import type {
  AgentKey,
  AzureDevOpsUserRecord,
  PullRequestLabelResult,
  PullRequestRecord,
  WorkItemCommentResult,
  WorkItemShowResult,
} from './ado-cli-types.js';
import type { AgentExecutionConfig } from './config.js';
import {
  appendMultilineArg,
  azJson,
  buildFieldPairs,
  configuredAgentKeys,
  currentBranchName,
  devopsRestJson,
  ensureModeEnabled,
  execJsonOrEmpty,
  fail,
  getAgentDefaultAssignee,
  getAgentDefinition,
  getAgentTag,
  getDefaultAgentKey,
  hasFlag,
  isRecord,
  mergeFieldDefaults,
  normalizeAgent,
  normalizeTags,
  parseArgValue,
  parseIdListArg,
  parseJsonResult,
  parseListArg,
  parseOptionalIntArg,
  parsePriority,
  parseTagList,
  preferredWorkflowCommand,
  printJson,
  replaceWorkItemTagsExact,
  resolveBaseBranch,
  resolveTargetBranch,
  runCommand,
  saveConfig,
  shell,
  slugify,
  summarizeCommandFailure,
  uniqueTags,
  usesPatAuth,
  wantsJson,
} from './ado-cli-runtime.js';

const identityResolutionCache = new Map<string, string>();

function parseWorkItemIdFromRelationUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const match = url.match(/workItems\/(\d+)(?:$|[/?])/i);
  if (!match) return undefined;
  const id = Number.parseInt(match[1], 10);
  return Number.isFinite(id) ? id : undefined;
}

export function parsePullRequestIdFromArtifactUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;

  const candidates = [url];
  try {
    candidates.unshift(decodeURIComponent(url));
  } catch {
    // Ignore malformed encodings and fall back to the raw artifact URL.
  }

  for (const candidate of candidates) {
    const prArtifact = candidate.match(/PullRequestId\/[^/]+\/[^/]+\/(\d+)/i);
    if (prArtifact) {
      const id = Number.parseInt(prArtifact[1], 10);
      return Number.isFinite(id) ? id : undefined;
    }

    const prWeb = candidate.match(/pullrequest\/(\d+)/i);
    if (prWeb) {
      const id = Number.parseInt(prWeb[1], 10);
      return Number.isFinite(id) ? id : undefined;
    }
  }

  return undefined;
}

export function formatIdentity(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const uniqueName = (raw as { uniqueName?: unknown }).uniqueName;
  if (typeof uniqueName === 'string' && uniqueName.trim()) return uniqueName;
  const mailAddress = (raw as { mailAddress?: unknown }).mailAddress;
  if (typeof mailAddress === 'string' && mailAddress.trim()) return mailAddress;
  const principalName = (raw as { principalName?: unknown }).principalName;
  if (typeof principalName === 'string' && principalName.trim()) return principalName;
  const displayName = (raw as { displayName?: unknown }).displayName;
  return typeof displayName === 'string' ? displayName : '';
}

function collectJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isRecord(value) && Array.isArray(value.value)) return value.value as T[];
  return [];
}

function extractResolvedIdentityValue(raw: unknown): string {
  if (!isRecord(raw)) return '';
  const candidate = isRecord(raw.user) ? raw.user : raw;
  return formatIdentity(candidate);
}

function resolveAzureIdentity(
  config: AgentExecutionConfig,
  rawIdentity: string,
  context: string,
): string {
  const identity = rawIdentity.trim();
  if (!identity) return '';
  const cacheKey = `${config.organizationUrl.toLowerCase()}::${identity.toLowerCase()}`;
  const cached = identityResolutionCache.get(cacheKey);
  if (cached) return cached;

  const result = runCommand([
    'az',
    'devops',
    'user',
    'show',
    '--org',
    config.organizationUrl,
    '--user',
    identity,
    '-o',
    'json',
  ]);
  if (!result.ok) {
    fail(`unable to resolve ${context} identity "${identity}": ${summarizeCommandFailure(result)}`);
  }
  const parsed = parseJsonResult<AzureDevOpsUserRecord>(result);
  const resolved = extractResolvedIdentityValue(parsed);
  if (!resolved) {
    fail(
      `unable to resolve ${context} identity "${identity}": Azure DevOps returned no canonical identity.`,
    );
  }
  identityResolutionCache.set(cacheKey, resolved);
  return resolved;
}

export function getWorkItem(config: AgentExecutionConfig, id: number): WorkItemShowResult {
  return showWorkItem(config, id, 'fields');
}

function getWorkItemWithRelations(config: AgentExecutionConfig, id: number): WorkItemShowResult {
  return showWorkItem(config, id, 'relations');
}

function showWorkItem(
  config: AgentExecutionConfig,
  id: number,
  expand: 'fields' | 'relations' | 'all',
): WorkItemShowResult {
  return azJson(config, [
    'boards',
    'work-item',
    'show',
    '--id',
    String(id),
    '--expand',
    expand,
  ]) as WorkItemShowResult;
}

export function getWorkItemsBatch(
  config: AgentExecutionConfig,
  ids: number[],
  expand: 'fields' | 'relations' | 'all' = 'fields',
): WorkItemShowResult[] {
  const uniqueIds = Array.from(new Set(ids.filter(Number.isFinite)));
  if (uniqueIds.length === 0) return [];
  return uniqueIds.map((id) => showWorkItem(config, id, expand));
}

export function getWorkItemTags(config: AgentExecutionConfig, id: number): string[] {
  const item = getWorkItem(config, id);
  const raw = item.fields?.['System.Tags'];
  return parseTagList(typeof raw === 'string' ? raw : undefined);
}

export function getWorkItemTitle(config: AgentExecutionConfig, id: number): string {
  const item = getWorkItem(config, id);
  return String(item.fields?.['System.Title'] ?? `Work item ${id}`);
}

export function getWorkItemPriorityValue(item: WorkItemShowResult): number {
  const raw = item.fields?.['Microsoft.VSTS.Common.Priority'];
  const value =
    typeof raw === 'number' ? raw : Number.parseInt(typeof raw === 'string' ? raw : '', 10);
  return Number.isFinite(value) ? value : 999;
}

export function getWorkItemStateValue(item: WorkItemShowResult): string {
  return String(item.fields?.['System.State'] ?? '');
}

export function listWorkItemRelations(
  config: AgentExecutionConfig,
  id: number,
): Array<{
  rel: string;
  url?: string;
  name?: string;
  targetId?: number;
  pullRequestId?: number;
}> {
  const item = getWorkItemWithRelations(config, id);
  return (item.relations ?? []).map((relation) => {
    const targetId = parseWorkItemIdFromRelationUrl(relation.url);
    const pullRequestId = parsePullRequestIdFromArtifactUrl(relation.url);
    const name =
      typeof relation.attributes?.name === 'string' ? relation.attributes.name : undefined;
    return {
      rel: String(relation.rel ?? ''),
      ...(relation.url ? { url: relation.url } : {}),
      ...(name ? { name } : {}),
      ...(targetId ? { targetId } : {}),
      ...(pullRequestId ? { pullRequestId } : {}),
    };
  });
}

export function addRelationTargets(
  config: AgentExecutionConfig,
  id: number,
  relationType: string,
  targetIds: number[],
): void {
  const uniqueTargetIds = Array.from(new Set(targetIds.filter(Number.isFinite)));
  if (uniqueTargetIds.length === 0) return;
  azJson(config, [
    'boards',
    'work-item',
    'relation',
    'add',
    '--id',
    String(id),
    '--relation-type',
    relationType,
    '--target-id',
    uniqueTargetIds.join(','),
  ]);
}

export function getOpenPredecessorIds(config: AgentExecutionConfig, id: number): number[] {
  const relations = listWorkItemRelations(config, id);
  const predecessorIds = relations
    .filter((relation) => relation.rel === 'System.LinkTypes.Dependency-Reverse')
    .map((relation) => relation.targetId)
    .filter((value): value is number => Number.isFinite(value));

  return predecessorIds.filter((predecessorId) => {
    const item = getWorkItem(config, predecessorId);
    return getWorkItemStateValue(item) !== config.stateMap.done;
  });
}

export function getLinkedPullRequestIds(config: AgentExecutionConfig, id: number): number[] {
  const relations = listWorkItemRelations(config, id);
  return Array.from(
    new Set(
      relations
        .map((relation) => relation.pullRequestId)
        .filter((value): value is number => Number.isFinite(value)),
    ),
  );
}

export function listPullRequests(
  config: AgentExecutionConfig,
  status: 'active' | 'completed' | 'abandoned',
): PullRequestRecord[] {
  return execJsonOrEmpty([
    'az',
    'repos',
    'pr',
    'list',
    '--org',
    config.organizationUrl,
    '--project',
    config.project,
    '--repository',
    config.repositoryId,
    '--status',
    status,
    '-o',
    'json',
  ]) as PullRequestRecord[];
}

export function getPullRequest(config: AgentExecutionConfig, prId: number): PullRequestRecord {
  return execJsonOrEmpty([
    'az',
    'repos',
    'pr',
    'show',
    '--org',
    config.organizationUrl,
    '--detect',
    'true',
    '--id',
    String(prId),
    '-o',
    'json',
  ]) as PullRequestRecord;
}

export function listPullRequestWorkItemIds(config: AgentExecutionConfig, prId: number): number[] {
  const items = execJsonOrEmpty([
    'az',
    'repos',
    'pr',
    'work-item',
    'list',
    '--org',
    config.organizationUrl,
    '--detect',
    'true',
    '--id',
    String(prId),
    '-o',
    'json',
  ]) as Array<{ id?: number }>;
  return Array.from(
    new Set(
      items.map((item) => item.id).filter((value): value is number => Number.isFinite(value)),
    ),
  );
}

export function addPullRequestWorkItems(
  config: AgentExecutionConfig,
  prId: number,
  workItemIds: number[],
): void {
  if (workItemIds.length === 0) return;
  shell([
    'az',
    'repos',
    'pr',
    'work-item',
    'add',
    '--org',
    config.organizationUrl,
    '--detect',
    'true',
    '--id',
    String(prId),
    '--work-items',
    ...workItemIds.map(String),
  ]);
}

export function listPullRequestLabels(config: AgentExecutionConfig, prId: number): string[] {
  const pr = getPullRequest(config, prId) as PullRequestRecord & {
    labels?: Array<{ name?: string | null }> | null;
  };
  if (Array.isArray(pr.labels)) {
    return Array.from(
      new Set(
        pr.labels
          .map((label) => label.name?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    );
  }

  if (!usesPatAuth()) {
    return [];
  }

  const url =
    `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/git/repositories/${encodeURIComponent(config.repositoryId)}/pullRequests/${prId}/labels?api-version=7.1-preview.1`;
  const result = devopsRestJson(config, 'GET', url) as PullRequestLabelResult;
  return Array.from(
    new Set(
      (result.value ?? [])
        .map((label) => label.name?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

export function addPullRequestLabel(
  config: AgentExecutionConfig,
  prId: number,
  label: string,
): void {
  if (!usesPatAuth()) {
    return;
  }
  const url =
    `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/git/repositories/${encodeURIComponent(config.repositoryId)}/pullRequests/${prId}/labels?api-version=7.1-preview.1`;
  devopsRestJson(config, 'POST', url, JSON.stringify({ name: label }));
}

export function syncPullRequestLabels(
  config: AgentExecutionConfig,
  prId: number,
  workItemIds: number[],
  syncTagMode: 'non-agent' | 'all',
): string[] {
  if (workItemIds.length === 0 || !config.prDefaults.syncWorkItemTags) return [];
  if (!usesPatAuth()) return [];
  const targetTags = normalizeTags(
    workItemIds
      .flatMap((id) => getWorkItemTags(config, id))
      .filter((tag) => syncTagMode === 'all' || !tag.toLowerCase().startsWith('agent:')),
  );
  if (targetTags.length === 0) return [];
  const existing = listPullRequestLabels(config, prId);
  const existingKeys = new Set(existing.map((tag) => tag.toLowerCase()));
  const added: string[] = [];
  for (const tag of targetTags) {
    if (existingKeys.has(tag.toLowerCase())) continue;
    addPullRequestLabel(config, prId, tag);
    existingKeys.add(tag.toLowerCase());
    added.push(tag);
  }
  return added;
}

export function addPullRequestReviewer(
  config: AgentExecutionConfig,
  prId: number,
  reviewer: string,
  required: boolean,
): void {
  shell([
    'az',
    'repos',
    'pr',
    'reviewer',
    'add',
    '--org',
    config.organizationUrl,
    '--detect',
    'true',
    '--id',
    String(prId),
    '--reviewers',
    reviewer,
    ...(required ? ['--required', 'true'] : []),
  ]);
}

export function listWorkItemComments(
  config: AgentExecutionConfig,
  id: number,
): Array<{ id: number; text: string; format: string }> {
  if (!usesPatAuth()) {
    return [];
  }
  const url =
    `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`;
  const result = devopsRestJson(config, 'GET', url) as WorkItemCommentResult;
  return (result.comments ?? [])
    .map((comment) => ({
      id: Number(comment.id),
      text: String(comment.text ?? ''),
      format: String(comment.format ?? ''),
    }))
    .filter((comment) => Number.isFinite(comment.id));
}

export function updateWorkItemComment(
  config: AgentExecutionConfig,
  workItemId: number,
  commentId: number,
  text: string,
): void {
  if (!usesPatAuth()) {
    return;
  }
  const url =
    `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/wit/workItems/${workItemId}/comments/${commentId}?api-version=7.1-preview.4`;
  devopsRestJson(config, 'PATCH', url, JSON.stringify({ text }));
}

export function inferWorkItemIdFromPullRequest(pr: PullRequestRecord): number | undefined {
  const titleMatch = pr.title?.match(/\bAB#(\d+)\b/i);
  if (titleMatch) {
    const id = Number.parseInt(titleMatch[1], 10);
    if (Number.isFinite(id)) return id;
  }
  const branchMatch = pr.sourceRefName?.match(/\/(\d+)-/);
  if (branchMatch) {
    const id = Number.parseInt(branchMatch[1], 10);
    if (Number.isFinite(id)) return id;
  }
  return undefined;
}

export function hasLinkedCommit(id: number): boolean {
  const output = shell(['git', 'log', '--all', '--grep', `AB#${id}`, '--format=%H', '-n', '1']);
  return output.length > 0;
}

export function hasLinkedCommitArtifact(config: AgentExecutionConfig, id: number): boolean {
  return listWorkItemRelations(config, id).some(
    (relation) => relation.rel === 'ArtifactLink' && relation.name === 'Fixed in Commit',
  );
}

export function commandEnable(config: AgentExecutionConfig, args: string[] = []): void {
  if (config.enabled) {
    if (wantsJson(args)) {
      printJson({ ok: true, enabled: true, changed: false });
      return;
    }
    console.log('agent-execution: already enabled.');
    return;
  }
  saveConfig({ ...config, enabled: true });
  if (wantsJson(args)) {
    printJson({ ok: true, enabled: true, changed: true });
    return;
  }
  console.log('agent-execution: mode enabled.');
}

export function commandDisable(config: AgentExecutionConfig, args: string[] = []): void {
  if (!config.enabled) {
    if (wantsJson(args)) {
      printJson({ ok: true, enabled: false, changed: false });
      return;
    }
    console.log('agent-execution: already disabled.');
    return;
  }
  saveConfig({ ...config, enabled: false });
  if (wantsJson(args)) {
    printJson({ ok: true, enabled: false, changed: true });
    return;
  }
  console.log('agent-execution: mode disabled.');
}

export function commandCreate(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'create');
  const title = parseArgValue(args, '--title');
  if (!title) fail('create requires --title "<text>".');

  const createAgent = parseArgValue(args, '--agent');
  const warnings: string[] = [];
  if (createAgent) {
    normalizeAgent(config, createAgent);
    warnings.push('ignoring --agent on create; agent tag is applied when claimed.');
  }
  const assignedTo = (() => {
    const rawAssignedTo = parseArgValue(args, '--assigned-to') ?? '';
    return rawAssignedTo ? resolveAzureIdentity(config, rawAssignedTo, 'assignee') : '';
  })();
  const description = buildWorkItemDescription({
    humanSummary:
      normalizeText(parseArgValue(args, '--human-summary')) ??
      normalizeText(parseArgValue(args, '--summary')),
    agentContext:
      normalizeText(parseArgValue(args, '--agent-context')) ??
      normalizeText(parseArgValue(args, '--description')),
    mappedTables: parseListArg(parseArgValue(args, '--mapped-tables')),
    acceptance: parseListArg(parseArgValue(args, '--acceptance')),
  });
  const itemType = parseArgValue(args, '--type') ?? config.defaultWorkItemType;
  const parentIdRaw = parseArgValue(args, '--parent');
  const parentId = parentIdRaw ? Number.parseInt(parentIdRaw, 10) : undefined;
  if (parentIdRaw && !Number.isFinite(parentId)) {
    fail(`invalid --parent "${parentIdRaw}".`);
  }
  const priority = parsePriority(parseArgValue(args, '--priority'));
  const dependsOnIds = parseIdListArg(parseArgValue(args, '--depends-on'));
  const relatedIds = parseIdListArg(parseArgValue(args, '--related'));

  const manualTags = parseTagList(parseArgValue(args, '--tags'));
  const tags = normalizeTags([...config.sharedTags, ...manualTags]);

  const azArgs = [
    'boards',
    'work-item',
    'create',
    '--project',
    config.project,
    '--type',
    itemType,
    '--title',
    title,
    '--area',
    config.defaultAreaPath,
    '--iteration',
    config.defaultIterationPath,
  ];

  if (description) azArgs.push('--description', description);
  if (assignedTo) azArgs.push('--assigned-to', assignedTo);
  const fieldsApplied = mergeFieldDefaults(config.workItemFieldDefaults.create, {
    ...(tags.length > 0 ? { 'System.Tags': tags.join(';') } : {}),
    ...(priority !== undefined ? { 'Microsoft.VSTS.Common.Priority': priority } : {}),
  });
  const fieldPairs = buildFieldPairs(fieldsApplied);
  if (fieldPairs.length > 0) azArgs.push('--fields', ...fieldPairs);

  const created = azJson(config, azArgs) as WorkItemShowResult;
  const createdId = created.id;
  if (!Number.isFinite(createdId)) {
    fail('failed to create work item: no id returned.');
  }
  const workItemId = Number(createdId);

  if (parentId && Number.isFinite(parentId)) {
    addRelationTargets(config, workItemId, 'parent', [parentId]);
  }
  addRelationTargets(config, workItemId, 'predecessor', dependsOnIds);
  addRelationTargets(config, workItemId, 'related', relatedIds);

  const workItemUrl = `${config.organizationUrl}/${encodeURIComponent(config.project)}/_workitems/edit/${workItemId}`;
  if (wantsJson(args)) {
    printJson({
      ok: true,
      workItem: {
        id: workItemId,
        type: itemType,
        title,
        url: workItemUrl,
        assignedTo,
        priority,
        parentId,
        dependsOnIds,
        relatedIds,
        tags,
        fieldsApplied,
      },
      warnings,
    });
    return;
  }
  for (const warning of warnings) {
    console.log(`agent-execution: ${warning}`);
  }
  console.log(`Created work item #${workItemId} (${itemType})`);
  console.log('Agent tag: (none, added on claim)');
  if (priority !== undefined) console.log(`Priority: ${priority}`);
  if (dependsOnIds.length > 0) console.log(`Depends on: ${dependsOnIds.join(', ')}`);
  if (relatedIds.length > 0) console.log(`Related: ${relatedIds.join(', ')}`);
  console.log(`URL: ${workItemUrl}`);
}

function claimWorkItem(
  config: AgentExecutionConfig,
  id: number,
  agent: AgentKey,
  assignedTo: string,
  note?: string,
): {
  id: number;
  state: string;
  agent: AgentKey;
  assignedTo: string;
  note?: string;
  tags: string[];
} {
  const existingTags = getWorkItemTags(config, id);
  const nonAgentTags = existingTags.filter((tag) => !tag.toLowerCase().startsWith('agent:'));
  const mergedTags = normalizeTags([
    ...nonAgentTags,
    ...config.sharedTags,
    getAgentTag(config, agent),
  ]);

  const updateArgs = [
    'boards',
    'work-item',
    'update',
    '--id',
    String(id),
    '--state',
    config.stateMap.active,
    '--fields',
    `System.Tags=${mergedTags.join(';')}`,
  ];
  if (assignedTo) updateArgs.push('--assigned-to', assignedTo);
  if (note) updateArgs.push('--discussion', note);

  azJson(config, updateArgs);
  return {
    id,
    state: config.stateMap.active,
    agent,
    assignedTo,
    ...(note ? { note } : {}),
    tags: mergedTags,
  };
}

export function commandClaim(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'claim');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('claim requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);

  const agent = normalizeAgent(config, parseArgValue(args, '--agent'));
  const assignedTo = (() => {
    const rawAssignedTo =
      parseArgValue(args, '--assigned-to') ?? getAgentDefaultAssignee(config, agent);
    return rawAssignedTo ? resolveAzureIdentity(config, rawAssignedTo, 'assignee') : '';
  })();
  const note = normalizeText(parseArgValue(args, '--note'));

  const result = claimWorkItem(config, id, agent, assignedTo, note);
  if (wantsJson(args)) {
    printJson({ ok: true, ...result });
    return;
  }
  console.log(
    `Claimed work item #${id} -> state=${result.state}, agent=${getAgentTag(config, agent)}`,
  );
}

export function commandPrioritize(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'prioritize');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('prioritize requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);
  const priority = parsePriority(parseArgValue(args, '--priority'));
  if (priority === undefined) fail('prioritize requires --priority <1..4>.');

  azJson(config, [
    'boards',
    'work-item',
    'update',
    '--id',
    String(id),
    '--fields',
    `Microsoft.VSTS.Common.Priority=${priority}`,
  ]);
  if (wantsJson(args)) {
    printJson({ ok: true, id, priority });
    return;
  }
  console.log(`Updated work item #${id} priority -> ${priority}`);
}

export function commandLink(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'link');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('link requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);

  const parentId = parseOptionalIntArg(args, '--parent');
  const dependsOnIds = parseIdListArg(parseArgValue(args, '--depends-on'));
  const relatedIds = parseIdListArg(parseArgValue(args, '--related'));

  if (!parentId && dependsOnIds.length === 0 && relatedIds.length === 0) {
    fail('link requires at least one of --parent, --depends-on, or --related.');
  }

  if (parentId !== undefined) addRelationTargets(config, id, 'parent', [parentId]);
  addRelationTargets(config, id, 'predecessor', dependsOnIds);
  addRelationTargets(config, id, 'related', relatedIds);

  if (wantsJson(args)) {
    printJson({
      ok: true,
      id,
      ...(parentId !== undefined ? { parentId } : {}),
      dependsOnIds,
      relatedIds,
    });
    return;
  }
  console.log(`Updated relations for work item #${id}.`);
}

function deriveBranchName(config: AgentExecutionConfig, id: number, agent: AgentKey): string {
  const title = getWorkItemTitle(config, id);
  return `${getAgentDefinition(config, agent).branchPrefix}/${id}-${slugify(title)}`;
}

function checkoutBranch(branchName: string, baseBranch: string): void {
  const localExists = shell(['git', 'branch', '--list', branchName]).length > 0;
  if (localExists) {
    shell(['git', 'checkout', branchName]);
    return;
  }

  const remoteExists = shell(['git', 'branch', '-r', '--list', `origin/${branchName}`]).length > 0;
  if (remoteExists) {
    shell(['git', 'checkout', '--track', `origin/${branchName}`]);
    return;
  }

  shell(['git', 'checkout', '-b', branchName, baseBranch]);
}

function pushCurrentBranch(branchName: string): void {
  shell(['git', 'push', '-u', 'origin', branchName]);
}

export function commandBranch(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'branch');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('branch requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);
  const agent = normalizeAgent(config, parseArgValue(args, '--agent'), getDefaultAgentKey(config));
  const baseBranch = resolveBaseBranch(config, args);
  const branchName = parseArgValue(args, '--branch-name') ?? deriveBranchName(config, id, agent);

  checkoutBranch(branchName, baseBranch);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      id,
      agent,
      branchName,
      baseBranch,
    });
    return;
  }
  console.log(`Checked out branch ${branchName}`);
}

export function commandStart(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'start');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('start requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);
  const agent = normalizeAgent(config, parseArgValue(args, '--agent'), getDefaultAgentKey(config));
  const assignedTo = (() => {
    const rawAssignedTo =
      parseArgValue(args, '--assigned-to') ?? getAgentDefaultAssignee(config, agent);
    return rawAssignedTo ? resolveAzureIdentity(config, rawAssignedTo, 'assignee') : '';
  })();
  const note = normalizeText(parseArgValue(args, '--note'));
  const baseBranch = resolveBaseBranch(config, args);
  const branchName = parseArgValue(args, '--branch-name') ?? deriveBranchName(config, id, agent);

  const claim = claimWorkItem(config, id, agent, assignedTo, note);
  checkoutBranch(branchName, baseBranch);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      ...claim,
      branchName,
      baseBranch,
    });
    return;
  }
  console.log(
    `Claimed work item #${id} -> state=${claim.state}, agent=${getAgentTag(config, agent)}`,
  );
  console.log(`Checked out branch ${branchName}`);
}

export function commandCommit(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'commit');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('commit requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);
  const message = normalizeText(parseArgValue(args, '--message'));
  if (!message) fail('commit requires --message "<text>".');
  const body = normalizeText(parseArgValue(args, '--body'));
  const addAll = hasFlag(args, '--all');
  const files = parseListArg(parseArgValue(args, '--files'));

  if (addAll && files.length > 0) {
    fail('commit cannot use --all and --files together.');
  }

  if (addAll) {
    shell(['git', 'add', '-A']);
  } else if (files.length > 0) {
    shell(['git', 'add', '--', ...files]);
  }

  const subject = message.startsWith(`AB#${id}`) ? message : `AB#${id} ${message}`;
  const commitArgs = ['git', 'commit', '-m', subject];
  if (body) commitArgs.push('-m', body);
  shell(commitArgs);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      id,
      subject,
      ...(body ? { body } : {}),
      addAll,
      files,
    });
    return;
  }
  console.log(`Created linked commit for work item #${id}.`);
}

function resolveReviewerFromArgs(
  config: AgentExecutionConfig,
  args: string[],
  item: WorkItemShowResult,
): { reviewer?: string; required: boolean } {
  const explicitReviewer = normalizeText(parseArgValue(args, '--reviewer'));
  const reviewerRequired =
    hasFlag(args, '--required-reviewer') || config.prDefaults.reviewerRequired;
  if (hasFlag(args, '--no-reviewer')) {
    return { required: reviewerRequired };
  }

  const reviewerModeRaw = explicitReviewer?.toLowerCase() ?? config.prDefaults.reviewerMode;
  if (reviewerModeRaw === 'off' || reviewerModeRaw === 'none') {
    return { required: reviewerRequired };
  }

  if (reviewerModeRaw === 'assigned') {
    const assigned = formatIdentity(item.fields?.['System.AssignedTo']);
    if (!assigned) {
      if (explicitReviewer)
        fail('explicit --reviewer assigned was requested but the work item has no assignee.');
      return { required: reviewerRequired };
    }
    return {
      reviewer: resolveAzureIdentity(config, assigned, 'reviewer'),
      required: reviewerRequired,
    };
  }

  return {
    reviewer: explicitReviewer
      ? resolveAzureIdentity(config, explicitReviewer, 'reviewer')
      : undefined,
    required: reviewerRequired,
  };
}

function shouldSyncPrTags(config: AgentExecutionConfig, args: string[]): boolean {
  if (hasFlag(args, '--sync-pr-tags')) return true;
  if (hasFlag(args, '--no-sync-pr-tags')) return false;
  return config.prDefaults.syncWorkItemTags;
}

export function commandPr(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'pr');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('pr requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);

  const item = getWorkItem(config, id);
  const titleBase = String(item.fields?.['System.Title'] ?? `Work item ${id}`);
  const prTitleRaw = normalizeText(parseArgValue(args, '--title')) ?? titleBase;
  const prTitle = prTitleRaw.startsWith(`AB#${id}`) ? prTitleRaw : `AB#${id} ${prTitleRaw}`;
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
    renderPullRequestDescription(id, humanSummary, agentContext);
  const targetBranch = resolveTargetBranch(config, args);
  const currentBranch = currentBranchName();
  const draft = !hasFlag(args, '--ready');
  const reviewer = resolveReviewerFromArgs(config, args, item);
  const syncPrTags = shouldSyncPrTags(config, args);
  const prTagSyncSupported = usesPatAuth();

  pushCurrentBranch(currentBranch);

  const existing = execJsonOrEmpty([
    'az',
    'repos',
    'pr',
    'list',
    '--org',
    config.organizationUrl,
    '--project',
    config.project,
    '--repository',
    config.repositoryId,
    '--source-branch',
    currentBranch,
    '--target-branch',
    targetBranch,
    '--status',
    'active',
    '-o',
    'json',
  ]) as Array<{ pullRequestId?: number; repository?: { webUrl?: string } }>;
  if (existing[0]?.pullRequestId) {
    const existingPrUrl = existing[0].repository?.webUrl
      ? `${existing[0].repository?.webUrl}/pullrequest/${existing[0].pullRequestId}`
      : undefined;
    if (wantsJson(args)) {
      printJson({
        ok: true,
        created: false,
        pullRequestId: existing[0].pullRequestId,
        currentBranch,
        targetBranch,
        ...(existingPrUrl ? { url: existingPrUrl } : {}),
      });
      return;
    }
    console.log(`Active PR already exists for ${currentBranch}: #${existing[0].pullRequestId}`);
    return;
  }

  const createArgs = [
    'az',
    'repos',
    'pr',
    'create',
    '--org',
    config.organizationUrl,
    '--project',
    config.project,
    '--repository',
    config.repositoryId,
    '--source-branch',
    currentBranch,
    '--target-branch',
    targetBranch,
    '--title',
    prTitle,
    '--work-items',
    String(id),
    '--transition-work-items',
    'false',
    '-o',
    'json',
  ];
  appendMultilineArg(createArgs, '--description', description);
  if (draft) createArgs.push('--draft', 'true');
  if (hasFlag(args, '--auto-complete')) createArgs.push('--auto-complete', 'true');

  const created = execJsonOrEmpty(createArgs) as {
    pullRequestId?: number;
    repository?: { webUrl?: string };
  };
  if (!created.pullRequestId) fail('PR creation did not return a pull request id.');

  if (reviewer.reviewer) {
    addPullRequestReviewer(config, created.pullRequestId, reviewer.reviewer, reviewer.required);
  }
  const addedTags = syncPrTags
    ? syncPullRequestLabels(config, created.pullRequestId, [id], config.prDefaults.syncTagMode)
    : [];

  azJson(config, [
    'boards',
    'work-item',
    'update',
    '--id',
    String(id),
    '--discussion',
    `Opened linked PR #${created.pullRequestId} from branch ${currentBranch}.`,
  ]);

  const prUrl = created.repository?.webUrl
    ? `${created.repository.webUrl}/pullrequest/${created.pullRequestId}`
    : undefined;
  if (wantsJson(args)) {
    printJson({
      ok: true,
      created: true,
      pullRequestId: created.pullRequestId,
      title: prTitle,
      description,
      currentBranch,
      targetBranch,
      draft,
      autoComplete: hasFlag(args, '--auto-complete'),
      reviewer,
      syncPrTags,
      prTagSyncSupported,
      addedTags,
      ...(prUrl ? { url: prUrl } : {}),
    });
    return;
  }
  console.log(`Created linked PR #${created.pullRequestId}${draft ? ' (draft)' : ''}`);
  if (reviewer.reviewer) {
    console.log(`Reviewer: ${reviewer.reviewer}${reviewer.required ? ' (required)' : ''}`);
  } else {
    console.log('Reviewer: (none)');
  }
  if (syncPrTags) {
    if (!prTagSyncSupported) {
      console.log('PR tags: skipped write-back under Azure CLI auth (use a PAT to sync labels)');
    } else {
      console.log(
        `PR tags: ${addedTags.length > 0 ? addedTags.join(', ') : '(no new tags added)'}`,
      );
    }
  } else {
    console.log('PR tags: sync disabled');
  }
  if (prUrl) console.log(`URL: ${prUrl}`);
}

function validateDevelopmentLinks(
  config: AgentExecutionConfig,
  id: number,
  explicitPr?: string,
): { ok: boolean; reasons: string[] } {
  const linkedPrIds = getLinkedPullRequestIds(config, id);
  const hasPr = linkedPrIds.length > 0 || Boolean(explicitPr);
  const hasCommit = hasLinkedCommitArtifact(config, id) || hasLinkedCommit(id);
  const reasons: string[] = [];

  if (!hasPr) {
    reasons.push(
      `No linked PR found for work item #${id}. Create PRs with ${preferredWorkflowCommand('pr', ` -- --id ${id}`)} or az repos pr create --work-items ${id}.`,
    );
  }
  if (!hasCommit) {
    reasons.push(
      `No commit referencing AB#${id} was found. Use ${preferredWorkflowCommand('commit', ` -- --id ${id}`)} or prefix commit messages with AB#${id}.`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

export function commandDone(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'done');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('done requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);
  const summary = normalizeText(parseArgValue(args, '--summary'));
  const impact = normalizeText(parseArgValue(args, '--impact'));
  const checks = parseListArg(parseArgValue(args, '--checks'));
  const mappedTables = parseListArg(parseArgValue(args, '--mapped-tables'));
  const changedFiles = parseListArg(parseArgValue(args, '--changed-files'));
  const note = normalizeText(parseArgValue(args, '--note'));
  const pr = normalizeText(parseArgValue(args, '--pr'));
  const skipLinkChecks = hasFlag(args, '--skip-link-checks');

  if (!skipLinkChecks) {
    const validation = validateDevelopmentLinks(config, id, pr);
    if (!validation.ok) {
      fail(validation.reasons.join('\n'));
    }
  }

  const discussion = buildCompletionDiscussion({
    summary,
    impact,
    mappedTables,
    changedFiles,
    checks,
    note,
    pr,
  });

  azJson(config, ['boards', 'work-item', 'update', '--id', String(id), '--discussion', discussion]);
  if (!wantsJson(args)) {
    console.log(`Added completion summary comment to work item #${id}.`);
  }

  const updateArgs = [
    'boards',
    'work-item',
    'update',
    '--id',
    String(id),
    '--state',
    config.stateMap.done,
  ];
  const doneFieldsApplied = mergeFieldDefaults(config.workItemFieldDefaults.done);
  const doneFieldPairs = buildFieldPairs(doneFieldsApplied);
  if (doneFieldPairs.length > 0) {
    updateArgs.push('--fields', ...doneFieldPairs);
  }

  azJson(config, updateArgs);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      id,
      state: config.stateMap.done,
      ...(summary ? { summary } : {}),
      ...(impact ? { impact } : {}),
      checks,
      mappedTables,
      changedFiles,
      fieldsApplied: doneFieldsApplied,
      ...(note ? { note } : {}),
      ...(pr ? { pr } : {}),
      skipLinkChecks,
    });
    return;
  }
  console.log(`Marked work item #${id} -> state=${config.stateMap.done}`);
}
