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
