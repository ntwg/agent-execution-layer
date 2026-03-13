import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseAzureDevOpsRemote } from './ado-bootstrap.js';
import type {
  AzureBoardNode,
  AzureDevOpsUserRecord,
  BranchPolicyRecord,
  CommandResult,
  DoctorCheck,
  PolicyLookupResult,
  PullRequestPolicyRecord,
  PullRequestRecord,
} from './ado-cli-types.js';
import {
  DEFAULT_AEL_GITIGNORE_FILENAME,
  DEFAULT_AGENT_DEFINITIONS,
  DEFAULT_AGENT_GUIDE_FILENAME,
  DEFAULT_CLEANUP_DEFAULTS,
  DEFAULT_CONFIG_FILENAME,
  DEFAULT_CONFIG_VERSION,
  DEFAULT_COORDINATION_SETTINGS,
  DEFAULT_HIERARCHY_DEFAULTS,
  DEFAULT_INSTALL_MANIFEST_FILENAME,
  DEFAULT_PR_DEFAULTS,
  DEFAULT_PROJECT_CONTRACT_FILENAME,
  DEFAULT_REPORT_DEFAULTS,
  DEFAULT_RUNTIME_SETTINGS,
  DEFAULT_SETTINGS_FILENAME,
  normalizeAgentKey,
  type AgentDefinition,
  type AgentExecutionConfig,
  type ConfigInspectionResult,
} from './config.js';
import {
  AZURE_DEVOPS_RESOURCE,
  CONFIG_DISCOVERY,
  CONFIG_INIT_PATH,
  CONFIG_PATH,
  detectGitRepoRoot,
  detectOriginDefaultBranch,
  detectOriginRemoteUrl,
  escapedWiql,
  fail,
  getAzureIdentity,
  getAuthMode,
  getConfiguredPat,
  hasFlag,
  inspectConfig,
  isRecord,
  loadConfig,
  parseArgValue,
  parseJsonResult,
  parseListArg,
  pluralize,
  preferredWorkflowCommand,
  printCheck,
  printJson,
  readWorkspacePackageJson,
  resolveRepositoryId,
  runCommand,
  saveConfig,
  summarizeCommandFailure,
  uniqueStrings,
  usesPatAuth,
  wantsJson,
} from './ado-cli-runtime.js';

function collectJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isRecord(value) && Array.isArray(value.value)) return value.value as T[];
  return [];
}

function formatIdentity(raw: unknown): string {
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

function extractResolvedIdentityValue(raw: unknown): string {
  if (!isRecord(raw)) return '';
  const candidate = isRecord(raw.user) ? raw.user : raw;
  return formatIdentity(candidate);
}

function validateConfiguredIdentities(config: AgentExecutionConfig): DoctorCheck {
  const configured = config.agents.map((agent) => agent.defaultAssignee.trim()).filter(Boolean);
  if (configured.length === 0) {
    return {
      label: 'configured identities',
      ok: true,
      detail: 'no configured default assignees',
    };
  }

  const uniqueConfigured = Array.from(new Set(configured.map((identity) => identity.trim())));
  for (const identity of uniqueConfigured) {
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
      return {
        label: 'configured identities',
        ok: false,
        detail: `${identity}: ${summarizeCommandFailure(result)}`,
      };
    }
    const parsed = parseJsonResult<AzureDevOpsUserRecord>(result);
    if (!extractResolvedIdentityValue(parsed)) {
      return {
        label: 'configured identities',
        ok: false,
        detail: `${identity}: Azure DevOps returned no canonical identity.`,
      };
    }
  }

  return {
    label: 'configured identities',
    ok: true,
    detail: `${uniqueConfigured.length} configured ${pluralize(uniqueConfigured.length, 'identity')} validated`,
  };
}

function collectBoardNodePaths(value: unknown, sink: string[] = []): string[] {
  const entries = collectJsonArray<AzureBoardNode>(value);
  if (entries.length === 0 && isRecord(value)) {
    entries.push(value as AzureBoardNode);
  }
  for (const entry of entries) {
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (path) sink.push(path);
    if (Array.isArray(entry.children) && entry.children.length > 0) {
      collectBoardNodePaths(entry.children, sink);
    }
  }
  return sink;
}

function normalizeBoardPathCandidate(path: string): string {
  return path.replaceAll('/', '\\').trim();
}

function selectDefaultBoardPath(paths: string[], project: string): string | undefined {
  if (paths.length === 0) return undefined;
  const normalizedProject = project.replaceAll('/', '\\').trim().toLowerCase();
  const rootProjectName = project.replaceAll('/', '\\').trim();
  const rootedProjectPrefix = `\\${normalizedProject}\\`;
  if (
    paths.some((path) =>
      normalizeBoardPathCandidate(path).toLowerCase().startsWith(rootedProjectPrefix),
    )
  ) {
    return rootProjectName;
  }
  const exact = paths.find(
    (path) => normalizeBoardPathCandidate(path).toLowerCase() === normalizedProject,
  );
  if (exact) return exact;
  const root = paths.find(
    (path) => normalizeBoardPathCandidate(path).toLowerCase() === `\\${normalizedProject}`,
  );
  if (root) return root;
  const startsWithProject = paths.find((path) =>
    normalizeBoardPathCandidate(path).toLowerCase().startsWith(`\\${normalizedProject}\\`),
  );
  return startsWithProject ?? paths[0];
}

function detectProjectBoardPath(
  organizationUrl: string,
  project: string,
  subject: 'area' | 'iteration',
): string | undefined {
  const result = runCommand([
    'az',
    'boards',
    subject,
    'project',
    'list',
    '--org',
    organizationUrl,
    '--project',
    project,
    '--depth',
    '10',
    '-o',
    'json',
  ]);
  if (!result.ok) return undefined;
  const parsed = parseJsonResult<unknown>(result);
  return selectDefaultBoardPath(
    collectBoardNodePaths(parsed).map(normalizeBoardPathCandidate),
    project,
  );
}

function listBranchPolicies(
  config: AgentExecutionConfig,
  branch: string,
): PolicyLookupResult<BranchPolicyRecord> {
  const result = runCommand([
    'az',
    'repos',
    'policy',
    'list',
    '--org',
    config.organizationUrl,
    '--project',
    config.project,
    '--repository-id',
    config.repositoryId,
    '--branch',
    branch,
    '-o',
    'json',
  ]);
  return {
    ok: result.ok,
    detail: result.ok ? 'query succeeded' : summarizeCommandFailure(result),
    records: collectJsonArray<BranchPolicyRecord>(parseJsonResult(result)),
  };
}

function summarizeBranchPolicies(policies: BranchPolicyRecord[], branch: string): string {
  const enabledPolicies = policies.filter((policy) => policy.isEnabled !== false);
  if (enabledPolicies.length === 0) {
    return `no policies configured on ${branch}`;
  }
  const blockingCount = enabledPolicies.filter((policy) => policy.isBlocking).length;
  const names = uniqueStrings(
    enabledPolicies.map((policy) => policy.type?.displayName ?? '').filter(Boolean),
  );
  const suffix = names.length > 0 ? `: ${names.join(', ')}` : '';
  return `${enabledPolicies.length} enabled ${pluralize(enabledPolicies.length, 'policy')} on ${branch} (${blockingCount} blocking)${suffix}`;
}

function listPullRequestPolicies(
  config: AgentExecutionConfig,
  prId: number,
): PolicyLookupResult<PullRequestPolicyRecord> {
  const result = runCommand([
    'az',
    'repos',
    'pr',
    'policy',
    'list',
    '--org',
    config.organizationUrl,
    '--id',
    String(prId),
    '-o',
    'json',
  ]);
  return {
    ok: result.ok,
    detail: result.ok ? 'query succeeded' : summarizeCommandFailure(result),
    records: collectJsonArray<PullRequestPolicyRecord>(parseJsonResult(result)),
  };
}

function isBlockingPolicy(policy: PullRequestPolicyRecord): boolean {
  return Boolean(policy.isBlocking ?? policy.configuration?.isBlocking);
}

function isPolicyFailureStatus(status: string): boolean {
  return ['rejected', 'failed', 'broken', 'error'].includes(status);
}

function isPolicySuccessStatus(status: string): boolean {
  return ['approved', 'succeeded', 'passed', 'notapplicable'].includes(status);
}

function summarizeActivePullRequestReadiness(
  config: AgentExecutionConfig,
  activePullRequests: PullRequestRecord[],
): DoctorCheck {
  if (activePullRequests.length === 0) {
    return {
      label: 'active pr merge readiness',
      ok: true,
      detail: 'no active pull requests',
    };
  }

  let mergeIssueCount = 0;
  let blockingFailureCount = 0;
  let pendingBlockingCount = 0;

  for (const pullRequest of activePullRequests) {
    if (!Number.isFinite(pullRequest.pullRequestId)) continue;
    const policies = listPullRequestPolicies(config, Number(pullRequest.pullRequestId));
    if (!policies.ok) {
      return {
        label: 'active pr merge readiness',
        ok: false,
        detail: `PR #${pullRequest.pullRequestId}: ${policies.detail}`,
      };
    }
    for (const policy of policies.records) {
      if (!isBlockingPolicy(policy)) continue;
      const status = String(policy.status ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
      if (!status) continue;
      if (isPolicyFailureStatus(status)) {
        blockingFailureCount += 1;
      } else if (!isPolicySuccessStatus(status)) {
        pendingBlockingCount += 1;
      }
    }

    const mergeStatus = String(pullRequest.mergeStatus ?? '')
      .trim()
      .toLowerCase();
    if (
      mergeStatus.includes('conflict') ||
      mergeStatus.includes('reject') ||
      mergeStatus.includes('failure')
    ) {
      mergeIssueCount += 1;
    }
  }

  return {
    label: 'active pr merge readiness',
    ok: blockingFailureCount === 0 && mergeIssueCount === 0,
    detail:
      `${activePullRequests.length} active ${pluralize(activePullRequests.length, 'PR')} checked, ` +
      `${blockingFailureCount} blocking policy ${pluralize(blockingFailureCount, 'failure')}, ` +
      `${pendingBlockingCount} pending blocking ${pluralize(pendingBlockingCount, 'policy')}, ` +
      `${mergeIssueCount} merge ${pluralize(mergeIssueCount, 'issue')}`,
  };
}

interface AdoptionInstallManifest {
  manifestVersion?: number;
  mode?: 'minimal' | 'with-scripts';
  rootInstructions?: {
    mode?: 'managed' | 'external';
    path?: string;
  };
  files?: {
    gitignore?: string;
    agentGuide?: string;
    projectContract?: string;
    config?: string;
    settings?: string;
  };
}

function readAdoptionInstallManifest(): AdoptionInstallManifest | undefined {
  const manifestPath = resolve(process.cwd(), DEFAULT_INSTALL_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    return isRecord(parsed) ? (parsed as AdoptionInstallManifest) : undefined;
  } catch {
    return undefined;
  }
}

function resolveAdoptionPaths(manifest?: AdoptionInstallManifest): {
  manifestPath: string;
  gitignorePath: string;
  agentGuidePath: string;
  projectContractPath: string;
  configPath: string;
  settingsPath: string;
  rootInstructionsMode: 'managed' | 'external';
  rootInstructionsPath: string;
  installMode: 'minimal' | 'with-scripts';
} {
  return {
    manifestPath: resolve(process.cwd(), DEFAULT_INSTALL_MANIFEST_FILENAME),
    gitignorePath: resolve(
      process.cwd(),
      manifest?.files?.gitignore || DEFAULT_AEL_GITIGNORE_FILENAME,
    ),
    agentGuidePath: resolve(
      process.cwd(),
      manifest?.files?.agentGuide || DEFAULT_AGENT_GUIDE_FILENAME,
    ),
    projectContractPath: resolve(
      process.cwd(),
      manifest?.files?.projectContract || DEFAULT_PROJECT_CONTRACT_FILENAME,
    ),
    configPath: resolve(process.cwd(), manifest?.files?.config || DEFAULT_CONFIG_FILENAME),
    settingsPath: resolve(process.cwd(), manifest?.files?.settings || DEFAULT_SETTINGS_FILENAME),
    rootInstructionsMode: manifest?.rootInstructions?.mode === 'external' ? 'external' : 'managed',
    rootInstructionsPath: resolve(process.cwd(), manifest?.rootInstructions?.path || 'AGENTS.md'),
    installMode: manifest?.mode === 'with-scripts' ? 'with-scripts' : 'minimal',
  };
}

function fileContains(path: string, snippets: string[]): boolean {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, 'utf8');
  return snippets.every((snippet) => content.includes(snippet));
}

function buildAdoptionChecks(): DoctorCheck[] {
  const manifest = readAdoptionInstallManifest();
  const paths = resolveAdoptionPaths(manifest);
  const checks: DoctorCheck[] = [];

  checks.push({
    label: 'ael install manifest',
    ok: Boolean(manifest && manifest.manifestVersion === 1),
    detail: manifest
      ? manifest.manifestVersion === 1
        ? paths.manifestPath
        : `unsupported manifest version ${String(manifest.manifestVersion ?? '(missing)')}`
      : `missing ${paths.manifestPath}`,
  });
  checks.push({
    label: 'ael agent guide',
    ok: existsSync(paths.agentGuidePath),
    detail: existsSync(paths.agentGuidePath)
      ? paths.agentGuidePath
      : `missing ${paths.agentGuidePath}`,
  });
  checks.push({
    label: 'ael project contract',
    ok: existsSync(paths.projectContractPath),
    detail: existsSync(paths.projectContractPath)
      ? paths.projectContractPath
      : `missing ${paths.projectContractPath}`,
  });
  checks.push({
    label: 'ael settings',
    ok: existsSync(paths.settingsPath),
    detail: existsSync(paths.settingsPath) ? paths.settingsPath : `missing ${paths.settingsPath}`,
  });

  const gitignoreRequiredEntries = [
    '*',
    '!.gitignore',
    '!agent-guide.md',
    '!install.json',
    '!project-contract.md',
    '!settings.json',
  ];
  checks.push({
    label: 'ael local ignore',
    ok:
      existsSync(paths.gitignorePath) &&
      fileContains(paths.gitignorePath, gitignoreRequiredEntries),
    detail:
      existsSync(paths.gitignorePath) && fileContains(paths.gitignorePath, gitignoreRequiredEntries)
        ? paths.gitignorePath
        : `expected ${paths.gitignorePath} to ignore local state and keep tracked AEL docs visible`,
  });

  const rootEntrySnippets = [
    paths.agentGuidePath
      .replaceAll('\\', '/')
      .replace(`${process.cwd().replaceAll('\\', '/')}/`, ''),
    paths.projectContractPath
      .replaceAll('\\', '/')
      .replace(`${process.cwd().replaceAll('\\', '/')}/`, ''),
  ];
  const rootEntryExists = existsSync(paths.rootInstructionsPath);
  const rootEntryWired =
    rootEntryExists && fileContains(paths.rootInstructionsPath, rootEntrySnippets);
  checks.push({
    label:
      paths.rootInstructionsMode === 'managed' ? 'ael root entrypoint' : 'ael external entrypoint',
    ok: rootEntryWired,
    detail: rootEntryWired
      ? paths.rootInstructionsPath
      : `expected ${paths.rootInstructionsPath} to reference ${rootEntrySnippets.join(' and ')}`,
  });

  const packageJsonScripts = ['ael:status', 'ael:init', 'ael:doctor'];
  const packageJson = readWorkspacePackageJson();
  const packageScripts = packageJson?.scripts;
  const hasPackageScripts =
    isRecord(packageScripts) &&
    packageJsonScripts.every((name) => typeof packageScripts[name] === 'string');
  checks.push({
    label: 'ael package scripts',
    ok: paths.installMode === 'minimal' ? true : hasPackageScripts,
    detail:
      paths.installMode === 'minimal'
        ? 'optional in minimal mode'
        : hasPackageScripts
          ? 'expected scripts present'
          : 'missing expected ael:* package scripts',
  });

  return checks;
}

function buildAdoptionNextSteps(checks: DoctorCheck[]): string[] {
  const failedLabels = new Set(checks.filter((check) => !check.ok).map((check) => check.label));
  if (failedLabels.size === 0) {
    return [preferredWorkflowCommand('init'), preferredWorkflowCommand('doctor')];
  }
  if (
    failedLabels.has('ael install manifest') ||
    failedLabels.has('ael agent guide') ||
    failedLabels.has('ael project contract') ||
    failedLabels.has('ael settings') ||
    failedLabels.has('ael local ignore')
  ) {
    return [`re-run ${preferredWorkflowCommand('install', ' --force')}`];
  }
  if (failedLabels.has('ael root entrypoint') || failedLabels.has('ael external entrypoint')) {
    const manifest = readAdoptionInstallManifest();
    const paths = resolveAdoptionPaths(manifest);
    if (paths.rootInstructionsMode === 'external') {
      return [`update ${paths.rootInstructionsPath} to point at ${paths.agentGuidePath}`];
    }
    return [
      `re-run ${preferredWorkflowCommand('install', ` --force --entrypoint-file ${manifest?.rootInstructions?.path || 'AGENTS.md'}`)}`,
    ];
  }
  if (failedLabels.has('ael package scripts')) {
    return [`re-run ${preferredWorkflowCommand('install', ' --with-scripts --force')}`];
  }
  return [
    `fix the failed AEL adoption checks above, then re-run ${preferredWorkflowCommand('doctor', ' --adoption')}`,
  ];
}

export function buildStatusNextSteps(inspection: ConfigInspectionResult): string[] {
  if (inspection.errors.length > 0) {
    if (inspection.errors.some((error) => error.startsWith('missing '))) {
      return [preferredWorkflowCommand('init'), preferredWorkflowCommand('doctor')];
    }
    return [preferredWorkflowCommand('validate-config')];
  }
  return [
    preferredWorkflowCommand('doctor'),
    preferredWorkflowCommand('next', ' -- --agent <agent-key>'),
  ];
}

export function buildDoctorNextSteps(checks: DoctorCheck[]): string[] {
  const failedLabels = new Set(checks.filter((check) => !check.ok).map((check) => check.label));
  if (failedLabels.size === 0) {
    return [preferredWorkflowCommand('next', ' -- --agent <agent-key>')];
  }

  if (failedLabels.has('config file')) {
    return [preferredWorkflowCommand('init')];
  }
  if (failedLabels.has('config validation')) {
    return [preferredWorkflowCommand('validate-config')];
  }
  if (failedLabels.has('git repository')) {
    return [
      `initialize or clone the target git repository, then re-run ${preferredWorkflowCommand('doctor')}`,
    ];
  }
  if (failedLabels.has('git origin remote')) {
    return [
      `add the origin remote for the target repository, then re-run ${preferredWorkflowCommand('doctor')}`,
    ];
  }
  if (failedLabels.has('origin default branch')) {
    return [
      `ensure origin/HEAD points at a real default branch, then re-run ${preferredWorkflowCommand('doctor')}`,
    ];
  }
  if (failedLabels.has('azure cli')) {
    return [`install Azure CLI, then re-run ${preferredWorkflowCommand('doctor')}`];
  }
  if (failedLabels.has('azure-devops extension')) {
    return ['az extension add --name azure-devops'];
  }
  if (failedLabels.has('azure login') || failedLabels.has('azure devops access token')) {
    return usesPatAuth()
      ? [
          `verify the configured Azure DevOps PAT, then re-run ${preferredWorkflowCommand('doctor')}`,
        ]
      : ['az login'];
  }
  if (failedLabels.has('project access') || failedLabels.has('repository access')) {
    return [`re-run ${preferredWorkflowCommand('init')} with the correct ADO project/repository`];
  }
  if (failedLabels.has('configured default branch')) {
    return [
      `update defaultBranch or ensure the remote branch exists, then re-run ${preferredWorkflowCommand('doctor')}`,
    ];
  }
  if (failedLabels.has('configured identities')) {
    return [
      `fix configured assignee/reviewer identities so they resolve in Azure DevOps, then re-run ${preferredWorkflowCommand('doctor')}`,
    ];
  }
  if (failedLabels.has('branch policies')) {
    return [
      `verify repository branch policy access for the target branch, then re-run ${preferredWorkflowCommand('doctor')}`,
    ];
  }
  if (failedLabels.has('active pr merge readiness')) {
    return [
      `inspect failing PR policies or merge conflicts in Azure DevOps, then re-run ${preferredWorkflowCommand('smoke')}`,
    ];
  }
  return [`fix the failed checks above, then re-run ${preferredWorkflowCommand('doctor')}`];
}

export function buildStatusPayload(): Record<string, unknown> {
  const inspection = inspectConfig();
  const payload: Record<string, unknown> = {
    backend: 'azure-devops',
    auth: {
      mode: getAuthMode(),
      capabilities: {
        pullRequestLabelWriteback: usesPatAuth(),
        commentRepair: usesPatAuth(),
      },
    },
    configPath: CONFIG_PATH,
    validation: {
      ok: inspection.errors.length === 0,
      errorCount: inspection.errors.length,
      warningCount: inspection.warnings.length,
      errors: inspection.errors,
      warnings: inspection.warnings,
    },
    nextSteps: buildStatusNextSteps(inspection),
  };
  if (inspection.config) {
    payload.config = inspection.config;
  }
  return payload;
}

function parseAgentKeyList(raw: string | undefined): string[] {
  const values = parseListArg(raw).map(normalizeAgentKey).filter(Boolean);
  return Array.from(new Set(values));
}

function buildAgentDefinitions(keys: string[], prior?: AgentExecutionConfig): AgentDefinition[] {
  return Array.from(new Set(keys.map(normalizeAgentKey).filter(Boolean))).map((key) => {
    const existing = prior?.agents.find((agent) => agent.key === key);
    return {
      key,
      tag: existing?.tag ?? `agent:${key}`,
      branchPrefix: existing?.branchPrefix ?? key,
      defaultAssignee: existing?.defaultAssignee ?? '',
    };
  });
}

async function promptForValue(
  prompt: string,
  defaultValue?: string,
  allowEmpty = false,
): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
      if (answer) return answer;
      if (defaultValue !== undefined) return defaultValue;
      if (allowEmpty) return '';
    }
  } finally {
    rl.close();
  }
}

async function promptForConfirm(prompt: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const suffix = defaultYes ? ' [Y/n]' : ' [y/N]';
      const answer = (await rl.question(`${prompt}${suffix}: `)).trim().toLowerCase();
      if (!answer) return defaultYes;
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
    }
  } finally {
    rl.close();
  }
}

export function printStatus(args: string[] = []): void {
  const inspection = inspectConfig();
  if (wantsJson(args)) {
    printJson(buildStatusPayload());
    return;
  }
  console.log('=== AGENT EXECUTION LAYER ===');
  console.log('backend: Azure DevOps');
  console.log(
    `auth mode: ${getAuthMode()}${usesPatAuth() ? ' (PAT-backed label/comment repair enabled)' : ' (set AEL_ADO_PAT for PAT-only write-back features)'}`,
  );
  console.log(`config: ${CONFIG_PATH}`);
  if (inspection.errors.length > 0) {
    console.log(
      `validation: invalid (${inspection.errors.length} ${pluralize(inspection.errors.length, 'error')})`,
    );
    for (const error of inspection.errors) {
      console.log(`error: ${error}`);
    }
    for (const warning of inspection.warnings) {
      console.log(`warning: ${warning}`);
    }
    for (const nextStep of buildStatusNextSteps(inspection)) {
      console.log(`next: ${nextStep}`);
    }
    return;
  }

  console.log(
    inspection.warnings.length > 0
      ? `validation: valid with warnings (${inspection.warnings.length})`
      : 'validation: valid',
  );
  for (const warning of inspection.warnings) {
    console.log(`warning: ${warning}`);
  }

  const config = inspection.config;
  if (!config) {
    fail('internal error: validated config is unavailable.');
  }
  const agentSummary = config.agents
    .map(
      (agent) =>
        `${agent.key}=${agent.tag} (branch=${agent.branchPrefix}${agent.defaultAssignee ? `, assigned=${agent.defaultAssignee}` : ''})`,
    )
    .join('; ');
  console.log(`config version: ${config.configVersion}`);
  console.log(`enabled: ${config.enabled}`);
  console.log(`organization: ${config.organizationUrl}`);
  console.log(`project: ${config.project}`);
  console.log(`repositoryId: ${config.repositoryId}`);
  console.log(`default branch: ${config.defaultBranch}`);
  console.log(`default agent: ${config.defaultAgent}`);
  console.log(`default type: ${config.defaultWorkItemType}`);
  console.log(`default area: ${config.defaultAreaPath}`);
  console.log(`default iteration: ${config.defaultIterationPath}`);
  console.log(
    `work item field defaults: create=${Object.keys(config.workItemFieldDefaults.create).length}, done=${Object.keys(config.workItemFieldDefaults.done).length}`,
  );
  console.log(`agents: ${agentSummary || '(none)'}`);
  console.log(`shared tags: ${config.sharedTags.join(', ') || '(none)'}`);
  console.log(
    `pr defaults: reviewer=${config.prDefaults.reviewerMode}, required=${config.prDefaults.reviewerRequired}, syncTags=${config.prDefaults.syncWorkItemTags}, tagMode=${config.prDefaults.syncTagMode}`,
  );
  console.log(
    `report defaults: staleDays=${config.reportDefaults.staleDays}, recentDays=${config.reportDefaults.recentDays}`,
  );
  console.log(
    `cleanup defaults: staleBranchDays=${config.cleanupDefaults.staleBranchDays}, stalePullRequestDays=${config.cleanupDefaults.stalePullRequestDays}`,
  );
  console.log(`coordination area tags: ${config.coordination.areaTags.join(', ') || '(none)'}`);
  console.log(
    `human-block tags: ${Object.entries(config.coordination.humanBlockReasons)
      .map(([reason, tag]) => `${reason}=${tag}`)
      .join(', ')}`,
  );
  console.log(
    `branching: development=${config.branching.developmentBranches.join(', ') || '(none)'}, rollout=${config.branching.rolloutBranches.join(', ') || '(none)'}`,
  );
  console.log(
    `hierarchy defaults: initiative=${config.hierarchyDefaults.initiativeType}, feature=${config.hierarchyDefaults.featureType}, backlog=${config.hierarchyDefaults.backlogItemType}, task=${config.hierarchyDefaults.taskType}`,
  );
  console.log(`runtime platform: ${config.runtime.platform}`);
  for (const nextStep of buildStatusNextSteps(inspection)) {
    console.log(`next: ${nextStep}`);
  }
}

export function commandValidateConfig(args: string[] = []): void {
  const inspection = inspectConfig();
  if (wantsJson(args)) {
    printJson({
      ok: inspection.errors.length === 0,
      configPath: CONFIG_PATH,
      errors: inspection.errors,
      warnings: inspection.warnings,
      config: inspection.config,
    });
    if (inspection.errors.length > 0) {
      process.exit(1);
    }
    return;
  }
  if (inspection.errors.length > 0) {
    console.error(
      `agent-execution: config is invalid (${inspection.errors.length} ${pluralize(inspection.errors.length, 'error')}).`,
    );
    for (const error of inspection.errors) {
      console.error(`- error: ${error}`);
    }
    for (const warning of inspection.warnings) {
      console.error(`- warning: ${warning}`);
    }
    process.exit(1);
  }

  console.log(
    inspection.warnings.length > 0
      ? `agent-execution: config is valid with ${inspection.warnings.length} ${pluralize(inspection.warnings.length, 'warning')}.`
      : 'agent-execution: config is valid.',
  );
  for (const warning of inspection.warnings) {
    console.log(`- warning: ${warning}`);
  }
}

export async function commandInit(args: string[]): Promise<void> {
  const forceOverwrite = hasFlag(args, '--force');
  const existingConfig = existsSync(CONFIG_PATH);
  const targetConfigPath = CONFIG_INIT_PATH;
  const targetConfigExists = existsSync(targetConfigPath);
  const migratingLegacyConfig =
    CONFIG_DISCOVERY.usedLegacyFallback && CONFIG_PATH !== targetConfigPath;
  const existingInspection = existingConfig ? inspectConfig() : undefined;
  const existingValidConfig =
    existingInspection && existingInspection.errors.length === 0
      ? existingInspection.config
      : undefined;

  if (targetConfigExists && !forceOverwrite) {
    if (!process.stdin.isTTY) {
      fail(`config already exists at ${targetConfigPath}. Re-run with --force to overwrite it.`);
    }
    const overwrite = await promptForConfirm(
      `Config already exists at ${targetConfigPath}. Overwrite it`,
      false,
    );
    if (!overwrite) {
      console.log('agent-execution: init cancelled.');
      return;
    }
  }

  const repoRoot = detectGitRepoRoot();
  const remoteUrl = detectOriginRemoteUrl();
  const remoteInfo = remoteUrl ? parseAzureDevOpsRemote(remoteUrl) : undefined;
  const detectedDefaultBranch = detectOriginDefaultBranch();
  const azureIdentity = getAzureIdentity();

  let organizationUrl =
    parseArgValue(args, '--organization-url')?.trim() ??
    existingValidConfig?.organizationUrl ??
    remoteInfo?.organizationUrl;
  let project =
    parseArgValue(args, '--project')?.trim() ?? existingValidConfig?.project ?? remoteInfo?.project;
  let repositoryName = parseArgValue(args, '--repository')?.trim() ?? remoteInfo?.repositoryName;
  let repositoryId =
    parseArgValue(args, '--repository-id')?.trim() ?? existingValidConfig?.repositoryId;
  let defaultBranch =
    parseArgValue(args, '--default-branch')?.trim() ??
    existingValidConfig?.defaultBranch ??
    detectedDefaultBranch;
  const runtimePlatform =
    parseArgValue(args, '--platform')?.trim().toLowerCase() ??
    existingValidConfig?.runtime.platform ??
    DEFAULT_RUNTIME_SETTINGS.platform;
  let defaultAreaPath =
    parseArgValue(args, '--area-path')?.trim() ??
    (forceOverwrite ? undefined : existingValidConfig?.defaultAreaPath);
  let defaultIterationPath =
    parseArgValue(args, '--iteration-path')?.trim() ??
    (forceOverwrite ? undefined : existingValidConfig?.defaultIterationPath);
  const areaTags = parseListArg(parseArgValue(args, '--area-tags'))
    .map((value) => value.trim())
    .filter(Boolean);
  const rolloutBranches = parseListArg(parseArgValue(args, '--rollout-branches'))
    .map((value) => value.trim())
    .filter(Boolean);
  let agentKeys = parseAgentKeyList(parseArgValue(args, '--agents'));
  if (agentKeys.length === 0) {
    agentKeys =
      existingValidConfig?.agents.map((agent) => agent.key) ??
      DEFAULT_AGENT_DEFINITIONS.map((agent) => agent.key);
  }
  let defaultAgent =
    normalizeAgentKey(parseArgValue(args, '--default-agent')) ||
    existingValidConfig?.defaultAgent ||
    agentKeys[0];

  if (process.stdin.isTTY) {
    organizationUrl =
      organizationUrl ||
      (await promptForValue('Azure DevOps organization URL', remoteInfo?.organizationUrl));
    project = project || (await promptForValue('Azure DevOps project', remoteInfo?.project));
    if (!repositoryName && !repositoryId) {
      repositoryName = await promptForValue(
        'Azure DevOps repository name',
        remoteInfo?.repositoryName,
      );
    }
    defaultBranch =
      defaultBranch || (await promptForValue('Default branch', detectedDefaultBranch ?? 'main'));

    const promptedAgents = await promptForValue(
      'Agent keys (semicolon separated)',
      agentKeys.join(';'),
    );
    agentKeys = parseAgentKeyList(promptedAgents);
    defaultAgent = normalizeAgentKey(
      await promptForValue('Default agent', defaultAgent || agentKeys[0]),
    );
  }

  if (!organizationUrl) fail('init requires an Azure DevOps organization URL.');
  if (!project) fail('init requires an Azure DevOps project.');
  defaultAreaPath =
    defaultAreaPath ?? detectProjectBoardPath(organizationUrl, project, 'area') ?? project;
  defaultIterationPath =
    defaultIterationPath ??
    detectProjectBoardPath(organizationUrl, project, 'iteration') ??
    project;
  if (!defaultBranch) fail('init requires a default branch.');
  if (agentKeys.length === 0) fail('init requires at least one agent key.');
  if (!defaultAgent) defaultAgent = agentKeys[0];
  if (!agentKeys.includes(defaultAgent)) {
    fail(`default agent "${defaultAgent}" is not in the configured agents list.`);
  }

  if (!repositoryId && repositoryName) {
    repositoryId = resolveRepositoryId(organizationUrl, project, repositoryName);
  }
  if (!repositoryId) {
    if (process.stdin.isTTY) {
      repositoryId = await promptForValue('Azure DevOps repository ID');
    } else {
      fail(
        'init could not resolve the repository ID automatically. Pass --repository-id or run interactively.',
      );
    }
  }

  const config: AgentExecutionConfig = {
    configVersion: DEFAULT_CONFIG_VERSION,
    enabled: existingValidConfig?.enabled ?? true,
    organizationUrl,
    project,
    repositoryId,
    defaultBranch,
    defaultAgent,
    defaultWorkItemType:
      parseArgValue(args, '--type')?.trim() ?? existingValidConfig?.defaultWorkItemType ?? 'Task',
    defaultAreaPath,
    defaultIterationPath,
    workItemFieldDefaults: existingValidConfig?.workItemFieldDefaults ?? {
      create: {},
      done: {},
    },
    sharedTags:
      parseListArg(parseArgValue(args, '--shared-tags')).length > 0
        ? parseListArg(parseArgValue(args, '--shared-tags'))
        : (existingValidConfig?.sharedTags ?? ['agent-managed']),
    agents: buildAgentDefinitions(agentKeys, existingValidConfig),
    stateMap: existingValidConfig?.stateMap ?? {
      new: 'New',
      active: 'Active',
      done: 'Closed',
    },
    prDefaults: existingValidConfig?.prDefaults ?? DEFAULT_PR_DEFAULTS,
    reportDefaults: existingValidConfig?.reportDefaults ?? DEFAULT_REPORT_DEFAULTS,
    cleanupDefaults: existingValidConfig?.cleanupDefaults ?? DEFAULT_CLEANUP_DEFAULTS,
    coordination: {
      areaTags:
        areaTags.length > 0
          ? areaTags
          : (existingValidConfig?.coordination.areaTags ?? [
              ...DEFAULT_COORDINATION_SETTINGS.areaTags,
            ]),
      humanBlockReasons: existingValidConfig?.coordination.humanBlockReasons ?? {
        ...DEFAULT_COORDINATION_SETTINGS.humanBlockReasons,
      },
    },
    branching: {
      developmentBranches: existingValidConfig?.branching.developmentBranches ?? [defaultBranch],
      rolloutBranches:
        rolloutBranches.length > 0
          ? rolloutBranches
          : (existingValidConfig?.branching.rolloutBranches ?? []),
      branchAliases: existingValidConfig?.branching.branchAliases ?? {
        default: defaultBranch,
        [defaultBranch]: defaultBranch,
        ...Object.fromEntries(rolloutBranches.map((branch) => [branch, branch])),
      },
    },
    hierarchyDefaults: existingValidConfig?.hierarchyDefaults ?? DEFAULT_HIERARCHY_DEFAULTS,
    runtime: {
      platform:
        runtimePlatform === 'windows' || runtimePlatform === 'mac' || runtimePlatform === 'linux'
          ? runtimePlatform
          : DEFAULT_RUNTIME_SETTINGS.platform,
    },
  };

  saveConfig(config, targetConfigPath);
  const inspection = inspectConfig();
  if (inspection.errors.length > 0) {
    const details = inspection.errors.map((message) => `- ${message}`).join('\n');
    fail(`init wrote an invalid config:\n${details}`);
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      configPath: targetConfigPath,
      ...(migratingLegacyConfig ? { migratedFromLegacyConfig: CONFIG_PATH } : {}),
      ...(repoRoot ? { repoRoot } : {}),
      ...(remoteUrl ? { origin: remoteUrl } : {}),
      ...(azureIdentity ? { azureIdentity } : {}),
      authMode: usesPatAuth() ? 'pat' : 'azure-cli',
      organizationUrl: config.organizationUrl,
      project: config.project,
      repositoryId: config.repositoryId,
      defaultBranch: config.defaultBranch,
      defaultAreaPath: config.defaultAreaPath,
      defaultIterationPath: config.defaultIterationPath,
      defaultAgent: config.defaultAgent,
      agents: config.agents.map((agent) => agent.key),
      cleanupDefaults: config.cleanupDefaults,
      coordination: config.coordination,
      branching: config.branching,
      hierarchyDefaults: config.hierarchyDefaults,
      runtime: config.runtime,
      warnings: inspection.warnings,
      nextSteps: [preferredWorkflowCommand('doctor')],
    });
    return;
  }

  console.log('=== AEL INIT ===');
  console.log(`config: ${targetConfigPath}`);
  if (migratingLegacyConfig) {
    console.log(`migrated from legacy config: ${CONFIG_PATH}`);
  }
  if (repoRoot) console.log(`repo root: ${repoRoot}`);
  if (remoteUrl) console.log(`origin: ${remoteUrl}`);
  if (azureIdentity?.userName) console.log(`azure identity: ${azureIdentity.userName}`);
  console.log(`organization: ${config.organizationUrl}`);
  console.log(`project: ${config.project}`);
  console.log(`repositoryId: ${config.repositoryId}`);
  console.log(`default branch: ${config.defaultBranch}`);
  console.log(`default area: ${config.defaultAreaPath}`);
  console.log(`default iteration: ${config.defaultIterationPath}`);
  console.log(`default agent: ${config.defaultAgent}`);
  console.log(`agents: ${config.agents.map((agent) => agent.key).join(', ')}`);
  console.log(`coordination area tags: ${config.coordination.areaTags.join(', ') || '(none)'}`);
  console.log(`rollout branches: ${config.branching.rolloutBranches.join(', ') || '(none)'}`);
  console.log(`runtime platform: ${config.runtime.platform}`);
  if (inspection.warnings.length > 0) {
    for (const warning of inspection.warnings) {
      console.log(`warning: ${warning}`);
    }
  }
  console.log(`Next: ${preferredWorkflowCommand('doctor')}`);
}

export function commandDoctor(args: string[]): void {
  const smoke = hasFlag(args, '--smoke');
  const adoption = hasFlag(args, '--adoption');
  if (smoke && adoption) {
    fail('doctor accepts either --smoke or --adoption, not both.');
  }
  if (adoption) {
    const checks = buildAdoptionChecks();
    const failed = checks.filter((check) => !check.ok);
    if (wantsJson(args)) {
      printJson({
        ok: failed.length === 0,
        mode: 'adoption',
        checks,
        nextSteps: buildAdoptionNextSteps(checks),
      });
      if (failed.length > 0) {
        process.exit(1);
      }
      return;
    }

    console.log('=== AEL ADOPTION DOCTOR ===');
    for (const check of checks) {
      printCheck(check.label, check.ok, check.detail);
    }
    for (const nextStep of buildAdoptionNextSteps(checks)) {
      console.log(`Next: ${nextStep}`);
    }
    if (failed.length > 0) {
      process.exit(1);
    }
    return;
  }

  const checks: DoctorCheck[] = [];
  const patAuth = getConfiguredPat();
  const authMode = patAuth ? 'pat' : 'azure-cli';
  const repoRoot = detectGitRepoRoot();
  const remoteUrl = detectOriginRemoteUrl();
  const originDefaultBranch = detectOriginDefaultBranch();
  const azCli = runCommand(['az', 'version']);
  const azExtension = azCli.ok
    ? runCommand(['az', 'extension', 'show', '--name', 'azure-devops'])
    : {
        ok: false,
        stdout: '',
        stderr: 'Azure CLI unavailable.',
        code: 1,
      };
  const azAccount = patAuth
    ? {
        ok: true,
        stdout: 'PAT auth configured',
        stderr: '',
        code: 0,
      }
    : azCli.ok
      ? runCommand(['az', 'account', 'show', '-o', 'json'])
      : {
          ok: false,
          stdout: '',
          stderr: 'Azure CLI unavailable.',
          code: 1,
        };
  const accessToken = patAuth
    ? {
        ok: true,
        stdout: patAuth,
        stderr: '',
        code: 0,
      }
    : azCli.ok
      ? runCommand([
          'az',
          'account',
          'get-access-token',
          '--resource',
          AZURE_DEVOPS_RESOURCE,
          '--query',
          'accessToken',
          '-o',
          'tsv',
        ])
      : {
          ok: false,
          stdout: '',
          stderr: 'Azure CLI unavailable.',
          code: 1,
        };

  checks.push({
    label: 'git repository',
    ok: Boolean(repoRoot),
    detail: repoRoot ?? 'not inside a git repository',
  });
  checks.push({
    label: 'git origin remote',
    ok: Boolean(remoteUrl),
    detail: remoteUrl ?? 'origin remote is missing',
  });
  checks.push({
    label: 'origin default branch',
    ok: Boolean(originDefaultBranch),
    detail: originDefaultBranch ?? 'unable to detect origin/HEAD',
  });
  checks.push({
    label: 'azure cli',
    ok: azCli.ok,
    detail: azCli.ok ? 'available' : summarizeCommandFailure(azCli),
  });
  checks.push({
    label: 'azure-devops extension',
    ok: azExtension.ok,
    detail: azExtension.ok ? 'installed' : summarizeCommandFailure(azExtension),
  });
  checks.push({
    label: 'azure login',
    ok: azAccount.ok,
    detail: azAccount.ok
      ? patAuth
        ? 'not required (PAT auth configured)'
        : 'authenticated'
      : summarizeCommandFailure(azAccount),
  });
  checks.push({
    label: 'azure devops access token',
    ok: accessToken.ok && Boolean(accessToken.stdout),
    detail:
      accessToken.ok && accessToken.stdout
        ? patAuth
          ? 'PAT auth configured'
          : 'available'
        : summarizeCommandFailure(accessToken),
  });

  if (!existsSync(CONFIG_PATH)) {
    checks.push({
      label: 'config file',
      ok: false,
      detail: `missing ${CONFIG_PATH}. Run ${preferredWorkflowCommand('init')}.`,
    });
  } else {
    const inspection = inspectConfig();
    checks.push({
      label: 'config validation',
      ok: inspection.errors.length === 0,
      detail:
        inspection.errors.length === 0
          ? inspection.warnings.length > 0
            ? `${inspection.warnings.length} warning(s)`
            : 'valid'
          : inspection.errors[0],
    });

    if (inspection.errors.length === 0 && inspection.config) {
      const config = inspection.config;
      const projectCheck = azCli.ok
        ? runCommand([
            'az',
            'devops',
            'project',
            'show',
            '--org',
            config.organizationUrl,
            '--project',
            config.project,
            '-o',
            'json',
          ])
        : { ok: false, stdout: '', stderr: 'Azure CLI unavailable.', code: 1 };
      const repositoryCheck = azCli.ok
        ? runCommand([
            'az',
            'repos',
            'show',
            '--org',
            config.organizationUrl,
            '--project',
            config.project,
            '--repository',
            config.repositoryId,
            '-o',
            'json',
          ])
        : { ok: false, stdout: '', stderr: 'Azure CLI unavailable.', code: 1 };
      const branchCheck = remoteUrl
        ? runCommand(['git', 'ls-remote', '--exit-code', '--heads', 'origin', config.defaultBranch])
        : { ok: false, stdout: '', stderr: 'origin remote is missing.', code: 1 };

      checks.push({
        label: 'project access',
        ok: projectCheck.ok,
        detail: projectCheck.ok ? config.project : summarizeCommandFailure(projectCheck),
      });
      checks.push({
        label: 'repository access',
        ok: repositoryCheck.ok,
        detail: repositoryCheck.ok ? config.repositoryId : summarizeCommandFailure(repositoryCheck),
      });
      checks.push({
        label: 'configured default branch',
        ok: branchCheck.ok,
        detail: branchCheck.ok ? config.defaultBranch : summarizeCommandFailure(branchCheck),
      });
      const branchPolicies = azCli.ok
        ? listBranchPolicies(config, config.defaultBranch)
        : {
            ok: false,
            detail: 'Azure CLI unavailable.',
            records: [],
          };
      checks.push({
        label: 'branch policies',
        ok: branchPolicies.ok,
        detail: branchPolicies.ok
          ? summarizeBranchPolicies(branchPolicies.records, config.defaultBranch)
          : branchPolicies.detail,
      });
      checks.push(
        azCli.ok
          ? validateConfiguredIdentities(config)
          : {
              label: 'configured identities',
              ok: false,
              detail: 'Azure CLI unavailable.',
            },
      );

      if (smoke) {
        const workItemQuery = runCommand([
          'az',
          'boards',
          'query',
          '--org',
          config.organizationUrl,
          '--project',
          config.project,
          '--wiql',
          `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${escapedWiql(config.project)}' ORDER BY [System.ChangedDate] DESC`,
          '-o',
          'json',
        ]);
        const prList = runCommand([
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
          'active',
          '-o',
          'json',
        ]);
        const activePullRequests = collectJsonArray<PullRequestRecord>(parseJsonResult(prList));
        checks.push({
          label: 'work item query smoke',
          ok: workItemQuery.ok,
          detail: workItemQuery.ok ? 'query succeeded' : summarizeCommandFailure(workItemQuery),
        });
        checks.push({
          label: 'pull request list smoke',
          ok: prList.ok,
          detail: prList.ok
            ? `query succeeded (${activePullRequests.length} active ${pluralize(activePullRequests.length, 'PR')})`
            : summarizeCommandFailure(prList),
        });
        checks.push(
          prList.ok
            ? summarizeActivePullRequestReadiness(config, activePullRequests)
            : {
                label: 'active pr merge readiness',
                ok: false,
                detail: summarizeCommandFailure(prList),
              },
        );
      }
    }
  }

  const failed = checks.filter((check) => !check.ok);
  if (wantsJson(args)) {
    printJson({
      ok: failed.length === 0,
      mode: smoke ? 'smoke' : 'doctor',
      authMode,
      configPath: CONFIG_PATH,
      checks,
      nextSteps: buildDoctorNextSteps(checks),
    });
    if (failed.length > 0) {
      process.exit(1);
    }
    return;
  }

  console.log(`=== AEL ${smoke ? 'SMOKE' : 'DOCTOR'} ===`);
  for (const check of checks) {
    printCheck(check.label, check.ok, check.detail);
  }

  if (failed.length > 0) {
    for (const nextStep of buildDoctorNextSteps(checks)) {
      console.log(`Next: ${nextStep}`);
    }
    process.exit(1);
  }
  for (const nextStep of buildDoctorNextSteps(checks)) {
    console.log(`Next: ${nextStep}`);
  }
}

export function printHelp(): void {
  console.log('Usage: ael <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  status [--json]');
  console.log('  validate-config [--json]');
  console.log('  backlog-create [--json]');
  console.log('  backlog-polish [--json]');
  console.log(
    '  install [--agent-key <agent-key>] [--default-branch <branch>] [--entrypoint-file <path>] [--with-scripts|--minimal] [--no-root-agents] [--dry-run] [--explain] [--force] [--json]',
  );
  console.log('  upgrade [--dry-run] [--explain] [--json]');
  console.log('  uninstall [--dry-run] [--explain] [--json]');
  console.log(
    '  init [--organization-url <url>] [--project <name>] [--repository <name>] [--repository-id <id>] [--default-branch <branch>] [--area-path "<path>"] [--iteration-path "<path>"] [--area-tags "auth;db"] [--rollout-branches "prod"] [--agents "codex;claude"] [--default-agent <agent-key>] [--platform auto|windows|mac|linux] [--force] [--json]',
  );
  console.log('  doctor [--smoke|--adoption] [--json]');
  console.log('  smoke [--json]');
  console.log('  enable [--json]');
  console.log('  disable [--json]');
  console.log(
    '  block --id 123 --reason waiting-on-human|human-approval-needed|external-setup-needed [--note "<text>"] [--json]',
  );
  console.log('  unblock --id 123 [--reason <reason>] [--note "<text>"] [--json]');
  console.log(
    '  create --title "<text>" [--assigned-to "<name>"] [--human-summary "<goal>"] [--agent-context "<technical implementation context>"] [--mapped-tables "db.schema.table;db.schema.table"] [--acceptance "item one;item two"] [--kind initiative|feature|backlog|pbi|task] [--type Task] [--tags "a;b"] [--priority 1..4] [--parent 123] [--depends-on "123;124"] [--related "125;126"] [--json]',
  );
  console.log(
    '         legacy aliases: --summary -> --human-summary, --description -> --agent-context',
  );
  console.log(
    '  claim --id 123 [--agent <agent-key>] [--assigned-to "<name>"] [--note "<text>"] [--json]',
  );
  console.log(
    '  start --id 123 [--agent <agent-key>] [--assigned-to "<name>"] [--branch-name "agent/123-task"] [--base <branch>] [--rollout] [--note "<text>"] [--json]',
  );
  console.log('  prioritize --id 123 --priority 1..4 [--json]');
  console.log(
    '  link --id 123 [--parent 100] [--depends-on "120;121"] [--related "122;123"] [--json]',
  );
  console.log(
    '  branch --id 123 [--agent <agent-key>] [--branch-name "agent/123-task"] [--base <branch>] [--rollout] [--json]',
  );
  console.log(
    '  commit --id 123 --message "<subject>" [--body "<details>"] [--all | --files "path1;path2"] [--json]',
  );
  console.log(
    '  pr --id 123 [--title "<text>"] [--description "<text>"] [--target-branch <branch>] [--target <alias>] [--rollout] [--ready] [--auto-complete] [--reviewer "<name>|assigned"] [--no-reviewer] [--required-reviewer] [--sync-pr-tags|--no-sync-pr-tags] [--json]',
  );
  console.log(
    '  done --id 123 [--summary "<outcome>"] [--impact "<business value>"] [--mapped-tables "db.schema.table;db.schema.table"] [--checks "build;fixtures;smoke"] [--changed-files "path1;path2"] [--pr "1234"] [--note "<extra context>"] [--skip-link-checks] [--json]',
  );
  console.log(
    '  retag [--id 123 | --ids "123;124"] [--state new|active|done|open|all] [--agent <agent-key>] [--tags "a;b"] [--limit 200] [--dry-run] [--json]',
  );
  console.log(
    '  list [--agent <agent-key>] [--state new|active|done|open|all] [--limit 20] [--json]',
  );
  console.log('  next [--agent <agent-key>] [--json]');
  console.log(
    '  cleanup-branches [--base <branch>] [--rollout] [--local-only|--remote-only] [--stale-days 14] [--delete-local] [--delete-remote] [--force] [--dry-run] [--json]',
  );
  console.log('  cleanup-prs [--stale-days 7] [--abandon] [--dry-run] [--json]');
  console.log(
    '  audit [--id 123 | --ids "123;124"] [--state new|active|done|open|all] [--limit 50] [--stale-days 7] [--repair] [--repair-formatting] [--repair-pr-tags] [--repair-pr-links] [--json]',
  );
  console.log('  report [--limit 20] [--stale-days 7] [--recent-days 7] [--json]');
  console.log('');
  console.log('Primary CLI surface: "ael" or repo-local "npm run ael:<command>".');
  console.log('Legacy "npm run ado:<command>" aliases remain for compatibility.');
  console.log('');
  console.log(
    'Auth: Azure CLI login is the default. Set AEL_ADO_PAT to use a PAT-backed Azure DevOps session.',
  );
  console.log('');
  console.log(
    'Tag aliases auto-normalized: benchmarking->benchmark, ci->ci-policy, coverage->coverage-policy, tokens->token-efficiency',
  );
}
