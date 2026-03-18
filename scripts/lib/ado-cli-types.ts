export type AgentKey = string;

export type AzQueryResult = Array<{ id?: number }> | { workItems?: Array<{ id?: number }> };

export interface WorkItemShowResult {
  id?: number;
  fields?: Record<string, unknown>;
  relations?: WorkItemRelationResult[];
}

export interface WorkItemRelationResult {
  rel?: string;
  url?: string;
  attributes?: Record<string, unknown>;
}

export interface PullRequestRecord {
  pullRequestId?: number;
  title?: string;
  description?: string;
  sourceRefName?: string;
  targetRefName?: string;
  status?: string;
  mergeStatus?: string;
  isDraft?: boolean;
  creationDate?: string;
  closedDate?: string;
  repository?: { webUrl?: string };
  reviewers?: Array<{
    displayName?: string;
    uniqueName?: string;
    vote?: number;
    isRequired?: boolean;
  }>;
}

export interface PullRequestLabelResult {
  value?: Array<{ name?: string }>;
}

export interface WorkItemCommentResult {
  comments?: Array<{
    id?: number;
    text?: string;
    format?: string;
  }>;
}

export interface AuditFinding {
  level: 'warn' | 'info';
  type: string;
  scope: string;
  message: string;
  repaired?: boolean;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  message?: string;
}

export interface AzureIdentity {
  userName: string;
  tenantId: string;
  subscriptionId: string;
}

export interface AzureDevOpsUserRecord {
  id?: string;
  descriptor?: string;
  uniqueName?: string;
  principalName?: string;
  mailAddress?: string;
  displayName?: string;
  user?: {
    id?: string;
    descriptor?: string;
    uniqueName?: string;
    principalName?: string;
    mailAddress?: string;
    displayName?: string;
  };
}

export interface AzureBoardNode {
  id?: number;
  identifier?: string;
  name?: string;
  path?: string;
  children?: AzureBoardNode[];
}

export interface BranchPolicyRecord {
  id?: number;
  isEnabled?: boolean;
  isBlocking?: boolean;
  type?: {
    displayName?: string;
  };
}

export interface PullRequestPolicyRecord {
  status?: string;
  isBlocking?: boolean;
  type?: {
    displayName?: string;
  };
  configuration?: {
    isBlocking?: boolean;
    type?: {
      displayName?: string;
    };
  };
}

export interface PolicyLookupResult<T> {
  ok: boolean;
  detail: string;
  records: T[];
}

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface WorkItemSummary {
  id: number;
  state: string;
  priority?: number;
  blocked: boolean;
  humanBlocked?: boolean;
  humanBlockTags?: string[];
  areaTags?: string[];
  agentTag?: string;
  assignedTo?: string;
  workItemType?: string;
  parentId?: number;
  predecessorIds?: number[];
  relatedIds?: number[];
  title: string;
}

export interface BranchCleanupCandidate {
  branch: string;
  remote: boolean;
  merged: boolean;
  staleDays?: number;
  workItemId?: number;
  workItemState?: string;
  reason: string;
}

export interface PullRequestCleanupCandidate {
  pullRequestId: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  isDraft: boolean;
  status: string;
  workItemIds: number[];
  reason: string;
  staleDays?: number;
}

export interface InstallScriptConflict {
  name: string;
  current: string;
  recommended: string;
}

export interface InstallSummary {
  ok: boolean;
  dryRun: boolean;
  mode: 'minimal' | 'with-scripts';
  rootInstructions: 'managed' | 'external';
  rootInstructionsPath?: string;
  workspace: string;
  packageJsonPath?: string;
  agentKey: string;
  scripts: {
    added: string[];
    updated: string[];
    unchanged: string[];
    conflicts: InstallScriptConflict[];
  };
  files: {
    created: string[];
    updated: string[];
    unchanged: string[];
  };
  ownership: {
    managedFiles: string[];
    userOwnedFiles: string[];
    localOnlyFiles: string[];
  };
  nextSteps: string[];
}

export interface UpgradeSummary {
  ok: boolean;
  dryRun: boolean;
  mode: 'minimal' | 'with-scripts';
  rootInstructions: 'managed' | 'external';
  rootInstructionsPath?: string;
  workspace: string;
  packageJsonPath?: string;
  defaults: {
    agentKey: string;
    defaultBranch: string;
  };
  scripts: {
    added: string[];
    updated: string[];
    unchanged: string[];
  };
  files: {
    created: string[];
    updated: string[];
    unchanged: string[];
    preserved: string[];
  };
  ownership: {
    managedFiles: string[];
    userOwnedFiles: string[];
    localOnlyFiles: string[];
  };
  warnings: string[];
  nextSteps: string[];
}

export interface RefreshSummary {
  ok: boolean;
  dryRun: boolean;
  workspace: string;
  packageJsonPath: string;
  packageManager: string;
  dependency: {
    name: string;
    section: 'dependencies' | 'devDependencies';
    spec: string;
    installedVersionBefore?: string;
    installedVersionAfter?: string;
  };
  commands: {
    update: string;
    upgrade: string;
  };
  upgrade?: UpgradeSummary;
  warnings: string[];
  nextSteps: string[];
}

export interface UninstallSummary {
  ok: boolean;
  dryRun: boolean;
  workspace: string;
  packageJsonPath?: string;
  files: {
    removed: string[];
    updated: string[];
    unchanged: string[];
  };
  scripts: {
    removed: string[];
    preserved: string[];
  };
  nextSteps: string[];
  warnings: string[];
  ownership: {
    managedFiles: string[];
    userOwnedFiles: string[];
    localOnlyFiles: string[];
  };
}

export interface WorkItemGroupSelection {
  primaryId: number;
  workItemIds: number[];
}

export type OrchestrationRole = 'research' | 'implement' | 'validate' | 'integration';
export type OrchestrationMode = 'tool' | 'handoff';
export type RunGranularityMode = 'isolated' | 'grouped';
export type OrchestrationChildStatus =
  | 'planned'
  | 'started'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'stopped';
export type OrchestrationRunStatus = 'active' | 'blocked' | 'ready' | 'stopped' | 'completed';
export type ApprovalCheckpointStatus = 'pending' | 'resolved';

export interface ApprovalCheckpoint {
  id: string;
  reason: string;
  status: ApprovalCheckpointStatus;
  childId?: string;
  childWorkItemId?: number;
  parentWorkItemId?: number;
  note?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface OrchestrationCheckin {
  runId: string;
  childId: string;
  status: 'started' | 'done' | 'blocked' | 'failed';
  summary?: string;
  note?: string;
  reason?: string;
  at: string;
}

export interface OrchestrationParentPlan {
  workItemId: number;
  title: string;
  branchName: string;
  areaTags: string[];
  pullRequestId?: number;
  finalizedAt?: string;
}

export interface OrchestrationChild {
  childId: string;
  parentWorkItemId: number;
  relatedParentIds?: number[];
  workItemId?: number;
  title: string;
  role: OrchestrationRole;
  mode: OrchestrationMode;
  status: OrchestrationChildStatus;
  awaitingOrchestratorReview: boolean;
  areaTags: string[];
  tags: string[];
  branchName?: string;
  briefPath: string;
  manifestPath: string;
  prompt: string;
  summary?: string;
  note?: string;
  checkins: OrchestrationCheckin[];
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationFinalizationState {
  status: 'pending' | 'ready' | 'finalized' | 'stopped';
  finalizedAt?: string;
  pullRequestIds: number[];
  outstandingValidation: string[];
}

export interface OrchestrationRun {
  runId: string;
  orchestratorAgent: string;
  parentIds: number[];
  status: OrchestrationRunStatus;
  granularityMode: RunGranularityMode;
  baseBranch: string;
  groupedBranchName?: string;
  parentPlans: OrchestrationParentPlan[];
  activeChildIds: string[];
  children: OrchestrationChild[];
  approvalCheckpoints: ApprovalCheckpoint[];
  finalization: OrchestrationFinalizationState;
  integrationChecklist: string[];
  orchestratorPrompt: string;
  briefPath: string;
  manifestPath: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
}
