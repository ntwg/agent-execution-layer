import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseAzureDevOpsRemote } from './lib/ado-bootstrap.js';
import {
  DEFAULT_AGENT_DEFINITIONS,
  DEFAULT_CONFIG_VERSION,
  DEFAULT_PR_DEFAULTS,
  DEFAULT_REPORT_DEFAULTS,
  discoverConfigPath,
  inspectConfigAtPath,
  loadConfigFromPath,
  normalizeAgentKey,
  saveConfigToPath,
  type AgentDefinition,
  type AgentExecutionConfig,
  type ConfigInspectionResult,
  type PullRequestTagMode,
} from './lib/config.js';
import {
  PULL_REQUEST_DESCRIPTION_SECTIONS,
  WORK_ITEM_DESCRIPTION_SECTIONS,
  buildCompletionDiscussion,
  buildRepairedCompletionComment,
  buildRepairedPullRequestDescription,
  buildRepairedWorkItemDescription,
  buildWorkItemDescription,
  decodeEscapedText,
  extractPlainSection,
  isMarkdownish,
  normalizeText,
  renderPullRequestDescription,
} from './lib/pr-description.js';

type AgentKey = string;

interface AzQueryResult {
  workItems?: Array<{ id?: number }>;
}

interface WorkItemShowResult {
  id?: number;
  fields?: Record<string, unknown>;
  relations?: WorkItemRelationResult[];
}

interface WorkItemRelationResult {
  rel?: string;
  url?: string;
  attributes?: Record<string, unknown>;
}

interface PullRequestRecord {
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

interface PullRequestLabelResult {
  value?: Array<{ name?: string }>;
}

interface WorkItemCommentResult {
  comments?: Array<{
    id?: number;
    text?: string;
    format?: string;
  }>;
}

interface AuditFinding {
  level: 'warn' | 'info';
  type: string;
  scope: string;
  message: string;
  repaired?: boolean;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  message?: string;
}

interface AzureIdentity {
  userName: string;
  tenantId: string;
  subscriptionId: string;
}

interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
}

interface WorkItemSummary {
  id: number;
  state: string;
  priority?: number;
  blocked: boolean;
  agentTag?: string;
  assignedTo?: string;
  title: string;
}

interface InstallScriptConflict {
  name: string;
  current: string;
  recommended: string;
}

interface InstallSummary {
  ok: boolean;
  workspace: string;
  packageJsonPath: string;
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
  nextSteps: string[];
}

const CONFIG_DISCOVERY = discoverConfigPath();
const CONFIG_PATH = CONFIG_DISCOVERY.path;
const CONFIG_INIT_PATH = CONFIG_DISCOVERY.preferredPath;
const CONFIG_LEGACY_WARNING = CONFIG_DISCOVERY.usedLegacyFallback
  ? `using legacy config path ${CONFIG_PATH}; re-run init to migrate to ${CONFIG_INIT_PATH}.`
  : undefined;
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const TAG_ALIAS_MAP: Record<string, string> = {
  benchmarking: 'benchmark',
  ci: 'ci-policy',
  coverage: 'semantic-coverage',
  tokens: 'token-efficiency',
};
const AEL_WORKFLOW_MARKER_START = '<!-- AEL WORKFLOW START -->';
const AEL_WORKFLOW_MARKER_END = '<!-- AEL WORKFLOW END -->';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = findPackageRoot(MODULE_DIR);
const DOWNSTREAM_TEMPLATE_DIR = join(PACKAGE_ROOT, 'templates', 'downstream');

function findPackageRoot(startDir: string): string {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      fail(`unable to resolve package root from ${startDir}.`);
    }
    current = parent;
  }
}

function fail(message: string): never {
  console.error(`agent-execution: ${message}`);
  process.exit(1);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function wantsJson(args: string[]): boolean {
  return hasFlag(args, '--json');
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function buildStatusNextSteps(inspection: ConfigInspectionResult): string[] {
  if (inspection.errors.length > 0) {
    if (inspection.errors.some(error => error.startsWith('missing '))) {
      return [preferredWorkflowCommand('init'), preferredWorkflowCommand('doctor')];
    }
    return [preferredWorkflowCommand('validate-config')];
  }
  return [
    preferredWorkflowCommand('doctor'),
    preferredWorkflowCommand('next', ' -- --agent <agent-key>'),
  ];
}

function buildDoctorNextSteps(checks: DoctorCheck[]): string[] {
  const failedLabels = new Set(checks.filter(check => !check.ok).map(check => check.label));
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
    return [`initialize or clone the target git repository, then re-run ${preferredWorkflowCommand('doctor')}`];
  }
  if (failedLabels.has('git origin remote')) {
    return [`add the origin remote for the target repository, then re-run ${preferredWorkflowCommand('doctor')}`];
  }
  if (failedLabels.has('origin default branch')) {
    return [`ensure origin/HEAD points at a real default branch, then re-run ${preferredWorkflowCommand('doctor')}`];
  }
  if (failedLabels.has('azure cli')) {
    return [`install Azure CLI, then re-run ${preferredWorkflowCommand('doctor')}`];
  }
  if (failedLabels.has('azure-devops extension')) {
    return ['az extension add --name azure-devops'];
  }
  if (failedLabels.has('azure login') || failedLabels.has('azure devops access token')) {
    return ['az login'];
  }
  if (failedLabels.has('project access') || failedLabels.has('repository access')) {
    return [`re-run ${preferredWorkflowCommand('init')} with the correct ADO project/repository`];
  }
  if (failedLabels.has('configured default branch')) {
    return [`update defaultBranch or ensure the remote branch exists, then re-run ${preferredWorkflowCommand('doctor')}`];
  }
  return [`fix the failed checks above, then re-run ${preferredWorkflowCommand('doctor')}`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function loadDownstreamTemplate(name: string): string {
  return readFileSync(join(DOWNSTREAM_TEMPLATE_DIR, name), 'utf8');
}

function detectPackageManagerCommand(): string {
  const packageManager = process.env.npm_config_user_agent ?? '';
  if (packageManager.startsWith('pnpm/')) return 'pnpm';
  if (packageManager.startsWith('yarn/')) return 'yarn';
  return 'npm';
}

function formatScriptCommand(scriptName: string, runner = detectPackageManagerCommand()): string {
  if (runner === 'yarn') {
    return scriptName === 'test' ? 'yarn test' : `yarn ${scriptName}`;
  }
  if (runner === 'pnpm') {
    return scriptName === 'test' ? 'pnpm test' : `pnpm ${scriptName}`;
  }
  return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
}

function readWorkspacePackageJson(cwd = process.cwd()): Record<string, unknown> | undefined {
  const packageJsonPath = join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function preferredWorkflowCommand(
  command: string,
  suffix = '',
  runner = detectPackageManagerCommand(),
): string {
  const manifest = readWorkspacePackageJson();
  const scripts = manifest?.scripts;
  if (isRecord(scripts)) {
    if (typeof scripts[`ael:${command}`] === 'string') {
      return `${formatScriptCommand(`ael:${command}`, runner)}${suffix}`;
    }
    if (typeof scripts[`ado:${command}`] === 'string') {
      return `${formatScriptCommand(`ado:${command}`, runner)}${suffix}`;
    }
  }
  return `ael ${command}${suffix}`;
}

function getPackageScriptCommand(
  scripts: Record<string, unknown>,
  names: string[],
  runner = detectPackageManagerCommand(),
): string | undefined {
  for (const name of names) {
    const value = scripts[name];
    if (typeof value === 'string' && value.trim()) {
      return formatScriptCommand(name, runner);
    }
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function renderValidationCommands(
  scripts: Record<string, unknown>,
  runner = detectPackageManagerCommand(),
): string[] {
  return uniqueStrings([
    getPackageScriptCommand(scripts, ['build'], runner) ?? '',
    getPackageScriptCommand(scripts, ['test'], runner) ?? '',
    getPackageScriptCommand(scripts, ['lint', 'typecheck', 'check', 'validate'], runner) ?? '',
  ]).filter(Boolean);
}

function applyInstallTemplate(raw: string, context: {
  agentKey: string;
  repositoryName: string;
  defaultBranch?: string;
  buildCommand?: string;
  unitTestCommand?: string;
  integrationTestCommand?: string;
  lintCommand?: string;
  validationCommands: string[];
}): string {
  const validationBlock = context.validationCommands.length > 0
    ? context.validationCommands.map(command => `- \`${command}\``).join('\n')
    : [
      '- `<fill-in-build-command>`',
      '- `<fill-in-test-command>`',
      '- `<fill-in-any-domain-validation>`',
    ].join('\n');
  return raw
    .replaceAll('{{AGENT_KEY}}', context.agentKey)
    .replaceAll('{{REPOSITORY_NAME}}', context.repositoryName)
    .replaceAll('{{DEFAULT_BRANCH}}', context.defaultBranch ?? '')
    .replaceAll('{{BUILD_COMMAND}}', context.buildCommand ?? '')
    .replaceAll('{{UNIT_TEST_COMMAND}}', context.unitTestCommand ?? '')
    .replaceAll('{{INTEGRATION_TEST_COMMAND}}', context.integrationTestCommand ?? '')
    .replaceAll('{{LINT_COMMAND}}', context.lintCommand ?? '')
    .replaceAll('{{VALIDATION_COMMANDS}}', validationBlock);
}

function normalizeAelWorkflowBlock(content: string): string {
  return ensureTrailingNewline([
    AEL_WORKFLOW_MARKER_START,
    content.trim(),
    AEL_WORKFLOW_MARKER_END,
  ].join('\n'));
}

function updateAgentsFile(
  workspacePath: string,
  renderedTemplate: string,
  force: boolean,
): { status: 'created' | 'updated' | 'unchanged'; path: string } {
  const agentsPath = join(workspacePath, 'AGENTS.md');
  const block = normalizeAelWorkflowBlock(renderedTemplate);
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, block, 'utf8');
    return { status: 'created', path: agentsPath };
  }

  const current = readFileSync(agentsPath, 'utf8');
  if (current.includes(AEL_WORKFLOW_MARKER_START) && current.includes(AEL_WORKFLOW_MARKER_END)) {
    if (!force) {
      return { status: 'unchanged', path: agentsPath };
    }
    const pattern = new RegExp(
      `${AEL_WORKFLOW_MARKER_START}[\\s\\S]*?${AEL_WORKFLOW_MARKER_END}\\n?`,
      'm',
    );
    writeFileSync(agentsPath, ensureTrailingNewline(current.replace(pattern, block)), 'utf8');
    return { status: 'updated', path: agentsPath };
  }

  const separator = current.trim().length > 0 ? '\n\n' : '';
  writeFileSync(agentsPath, ensureTrailingNewline(`${current.trimEnd()}${separator}${block}`), 'utf8');
  return { status: 'updated', path: agentsPath };
}

function ensureGitignoreEntry(workspacePath: string, entry: string): { status: 'created' | 'updated' | 'unchanged'; path: string } {
  const gitignorePath = join(workspacePath, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${entry}\n`, 'utf8');
    return { status: 'created', path: gitignorePath };
  }

  const current = readFileSync(gitignorePath, 'utf8');
  const lines = current.split(/\r?\n/).map(line => line.trim());
  if (lines.includes(entry)) {
    return { status: 'unchanged', path: gitignorePath };
  }
  writeFileSync(gitignorePath, ensureTrailingNewline(`${current.trimEnd()}\n${entry}`), 'utf8');
  return { status: 'updated', path: gitignorePath };
}

function writeTemplateFile(
  path: string,
  content: string,
  force: boolean,
): { status: 'created' | 'updated' | 'unchanged'; path: string } {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, ensureTrailingNewline(content), 'utf8');
    return { status: 'created', path };
  }
  if (!force) {
    return { status: 'unchanged', path };
  }
  writeFileSync(path, ensureTrailingNewline(content), 'utf8');
  return { status: 'updated', path };
}

function buildStatusPayload(): Record<string, unknown> {
  const inspection = inspectConfig();
  const payload: Record<string, unknown> = {
    backend: 'azure-devops',
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

function inspectConfig(): ConfigInspectionResult {
  return inspectConfigAtPath(CONFIG_PATH, { legacyMigrationWarning: CONFIG_LEGACY_WARNING });
}

function loadConfig(): AgentExecutionConfig {
  try {
    return loadConfigFromPath(CONFIG_PATH, { legacyMigrationWarning: CONFIG_LEGACY_WARNING });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function saveConfig(config: AgentExecutionConfig, configPath = CONFIG_PATH): void {
  saveConfigToPath(configPath, config);
}

function parseArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function parseOptionalIntArg(args: string[], flag: string): number | undefined {
  const raw = parseArgValue(args, flag);
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) fail(`invalid ${flag} "${raw}".`);
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getConfiguredAgents(config: AgentExecutionConfig): AgentDefinition[] {
  return config.agents;
}

function getDefaultAgentKey(config: AgentExecutionConfig): AgentKey {
  return config.defaultAgent || config.agents[0]?.key || DEFAULT_AGENT_DEFINITIONS[0].key;
}

function getAgentDefinition(config: AgentExecutionConfig, key: AgentKey): AgentDefinition {
  const normalizedKey = normalizeAgentKey(key);
  const match = config.agents.find(agent => agent.key === normalizedKey);
  if (match) return match;
  fail(
    `unsupported --agent "${key}". Use one of: ${config.agents.map(agent => agent.key).join(', ')}.`,
  );
}

function getAgentTag(config: AgentExecutionConfig, key: AgentKey): string {
  return getAgentDefinition(config, key).tag;
}

function getAgentDefaultAssignee(config: AgentExecutionConfig, key: AgentKey): string {
  return getAgentDefinition(config, key).defaultAssignee;
}

function normalizeAgent(
  config: AgentExecutionConfig,
  value: string | undefined,
  fallback?: AgentKey,
): AgentKey {
  if (!value) {
    if (fallback) return fallback;
    fail(`missing --agent. Use one of: ${config.agents.map(agent => agent.key).join(', ')}.`);
  }
  const normalized = normalizeAgentKey(value);
  if (config.agents.some(agent => agent.key === normalized)) {
    return normalized;
  }
  fail(`unsupported --agent "${value}". Use one of: ${config.agents.map(agent => agent.key).join(', ')}.`);
}

function runCommand(args: string[]): CommandResult {
  try {
    const stdout = execFileSync(args[0], args.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: '',
      code: 0,
    };
  } catch (err) {
    const e = err as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout).trim() : '',
      stderr: e.stderr ? String(e.stderr).trim() : '',
      code: typeof e.status === 'number' ? e.status : 1,
      message: e.message,
    };
  }
}

function shell(args: string[]): string {
  const result = runCommand(args);
  if (result.ok) return result.stdout;
  const msg = [result.stdout, result.stderr, result.message ?? 'command failed']
    .filter(Boolean)
    .join('\n');
  fail(msg);
}

function azJson(config: AgentExecutionConfig, args: string[]): unknown {
  const output = shell([
    'az',
    ...args,
    '--org',
    config.organizationUrl,
    '-o',
    'json',
  ]);
  if (!output) return {};
  return JSON.parse(output);
}

function execJsonOrEmpty(args: string[]): unknown {
  const output = shell(args);
  return output ? JSON.parse(output) : {};
}

function appendMultilineArg(args: string[], flag: string, value: string): void {
  const lines = value.split('\n');
  args.push(flag, ...lines);
}

function getDevOpsAccessToken(): string {
  return shell([
    'az',
    'account',
    'get-access-token',
    '--resource',
    AZURE_DEVOPS_RESOURCE,
    '--query',
    'accessToken',
    '-o',
    'tsv',
  ]);
}

function devopsRestJson(
  config: AgentExecutionConfig,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: string,
  contentType = 'application/json',
): unknown {
  const args = [
    'curl',
    '-sS',
    '-X',
    method,
    '-H',
    `Authorization: Bearer ${getDevOpsAccessToken()}`,
    '-H',
    `Content-Type: ${contentType}`,
  ];
  if (body !== undefined) args.push('--data', body);
  args.push(url);
  const output = shell(args);
  return output ? JSON.parse(output) : {};
}

function replaceWorkItemTagsExact(
  config: AgentExecutionConfig,
  id: number,
  tags: string[],
  accessToken: string,
): void {
  const url =
    `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/wit/workitems/${id}?api-version=7.1`;
  const payload = JSON.stringify([
    {
      op: 'replace',
      path: '/fields/System.Tags',
      value: tags.join(';'),
    },
  ]);

  shell([
    'curl',
    '-sS',
    '-o',
    '/dev/null',
    '-X',
    'PATCH',
    '-H',
    `Authorization: Bearer ${accessToken}`,
    '-H',
    'Content-Type: application/json-patch+json',
    '--data',
    payload,
    url,
  ]);
}

function ensureModeEnabled(config: AgentExecutionConfig, args: string[], command: string): void {
  if (config.enabled || hasFlag(args, '--force')) return;
  fail(
    `mode is disabled in ${CONFIG_PATH}. Enable first: ${preferredWorkflowCommand('enable')} (or pass --force for one-off ${command}).`,
  );
}

function escapedWiql(value: string): string {
  return value.replace(/'/g, "''");
}

function parseTagList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(';')
    .map(v => v.trim())
    .filter(Boolean);
}

function parseListArg(raw: string | undefined): string[] {
  if (!raw) return [];
  return decodeEscapedText(raw)
    .split(/\r?\n|;/)
    .map(v => v.trim())
    .filter(Boolean);
}

function parsePriority(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 4) {
    fail(`invalid --priority "${raw}". Use 1..4.`);
  }
  return value;
}

function normalizeTag(tag: string): string {
  const lower = tag.trim().toLowerCase();
  if (!lower) return '';
  const compact = lower
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/-+/g, '-');
  if (compact.startsWith('agent:')) return compact;
  return TAG_ALIAS_MAP[compact] ?? compact;
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(normalized);
  }
  return ordered;
}

function normalizeTags(tags: string[]): string[] {
  return uniqueTags(tags.map(normalizeTag).filter(Boolean));
}

function parseIdListArg(raw: string | undefined): number[] {
  if (!raw) return [];
  const values = parseListArg(raw);
  const ids: number[] = [];
  for (const value of values) {
    const id = Number.parseInt(value, 10);
    if (!Number.isFinite(id)) {
      fail(`invalid work item id "${value}".`);
    }
    ids.push(id);
  }
  return ids;
}

function slugify(value: string, maxLength = 48): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return (slug || 'work-item').slice(0, maxLength).replace(/-+$/g, '');
}

function currentBranchName(): string {
  return shell(['git', 'branch', '--show-current']);
}

function configuredAgentKeys(config: AgentExecutionConfig): string[] {
  return getConfiguredAgents(config).map(agent => agent.key);
}

function configuredAgentTags(config: AgentExecutionConfig): string[] {
  return getConfiguredAgents(config).map(agent => agent.tag);
}

function resolveBaseBranch(config: AgentExecutionConfig, args: string[]): string {
  return parseArgValue(args, '--base') ?? config.defaultBranch;
}

function resolveTargetBranch(config: AgentExecutionConfig, args: string[]): string {
  return parseArgValue(args, '--target-branch') ?? config.defaultBranch;
}

function parseWorkItemIdFromRelationUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const match = url.match(/workItems\/(\d+)(?:$|[/?])/i);
  if (!match) return undefined;
  const id = Number.parseInt(match[1], 10);
  return Number.isFinite(id) ? id : undefined;
}

function parsePullRequestIdFromArtifactUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const prArtifact = url.match(/PullRequestId\/[^/]+\/[^/]+\/(\d+)/i);
  if (prArtifact) {
    const id = Number.parseInt(prArtifact[1], 10);
    return Number.isFinite(id) ? id : undefined;
  }
  const prWeb = url.match(/pullrequest\/(\d+)/i);
  if (prWeb) {
    const id = Number.parseInt(prWeb[1], 10);
    return Number.isFinite(id) ? id : undefined;
  }
  return undefined;
}

function formatIdentity(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const uniqueName = (raw as { uniqueName?: unknown }).uniqueName;
  if (typeof uniqueName === 'string' && uniqueName.trim()) return uniqueName;
  const displayName = (raw as { displayName?: unknown }).displayName;
  return typeof displayName === 'string' ? displayName : '';
}

function getWorkItem(config: AgentExecutionConfig, id: number): WorkItemShowResult {
  return azJson(config, [
    'boards',
    'work-item',
    'show',
    '--id',
    String(id),
    '--expand',
    'fields',
  ]) as WorkItemShowResult;
}

function getWorkItemWithRelations(config: AgentExecutionConfig, id: number): WorkItemShowResult {
  return azJson(config, [
    'boards',
    'work-item',
    'show',
    '--id',
    String(id),
    '--expand',
    'relations',
  ]) as WorkItemShowResult;
}

function getWorkItemsBatch(
  config: AgentExecutionConfig,
  ids: number[],
  expand: 'fields' | 'relations' | 'all' = 'fields',
): WorkItemShowResult[] {
  const uniqueIds = Array.from(new Set(ids.filter(Number.isFinite)));
  if (uniqueIds.length === 0) return [];
  const items: WorkItemShowResult[] = [];
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const chunk = uniqueIds.slice(index, index + 100);
    const url =
      `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
      `/_apis/wit/workitems?ids=${chunk.join(',')}&$expand=${expand}&api-version=7.1`;
    const result = devopsRestJson(config, 'GET', url) as { value?: WorkItemShowResult[] };
    items.push(...(result.value ?? []));
  }
  return items;
}

function getWorkItemTags(config: AgentExecutionConfig, id: number): string[] {
  const item = getWorkItem(config, id);
  const raw = item.fields?.['System.Tags'];
  return parseTagList(typeof raw === 'string' ? raw : undefined);
}

function getWorkItemTitle(config: AgentExecutionConfig, id: number): string {
  const item = getWorkItem(config, id);
  return String(item.fields?.['System.Title'] ?? `Work item ${id}`);
}

function getWorkItemPriorityValue(item: WorkItemShowResult): number {
  const raw = item.fields?.['Microsoft.VSTS.Common.Priority'];
  const value = typeof raw === 'number'
    ? raw
    : Number.parseInt(typeof raw === 'string' ? raw : '', 10);
  return Number.isFinite(value) ? value : 999;
}

function getWorkItemStateValue(item: WorkItemShowResult): string {
  return String(item.fields?.['System.State'] ?? '');
}

function listWorkItemRelations(config: AgentExecutionConfig, id: number): Array<{
  rel: string;
  url?: string;
  name?: string;
  targetId?: number;
  pullRequestId?: number;
}> {
  const item = getWorkItemWithRelations(config, id);
  return (item.relations ?? []).map(relation => {
    const targetId = parseWorkItemIdFromRelationUrl(relation.url);
    const pullRequestId = parsePullRequestIdFromArtifactUrl(relation.url);
    const name = typeof relation.attributes?.name === 'string'
      ? relation.attributes.name
      : undefined;
    return {
      rel: String(relation.rel ?? ''),
      ...(relation.url ? { url: relation.url } : {}),
      ...(name ? { name } : {}),
      ...(targetId ? { targetId } : {}),
      ...(pullRequestId ? { pullRequestId } : {}),
    };
  });
}

function addRelationTargets(
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

function getOpenPredecessorIds(config: AgentExecutionConfig, id: number): number[] {
  const relations = listWorkItemRelations(config, id);
  const predecessorIds = relations
    .filter(relation => relation.rel === 'System.LinkTypes.Dependency-Reverse')
    .map(relation => relation.targetId)
    .filter((value): value is number => Number.isFinite(value));

  return predecessorIds.filter(predecessorId => {
    const item = getWorkItem(config, predecessorId);
    return getWorkItemStateValue(item) !== config.stateMap.done;
  });
}

function getLinkedPullRequestIds(config: AgentExecutionConfig, id: number): number[] {
  const relations = listWorkItemRelations(config, id);
  return Array.from(
    new Set(
      relations
        .map(relation => relation.pullRequestId)
        .filter((value): value is number => Number.isFinite(value)),
    ),
  );
}

function listPullRequests(
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

function getPullRequest(config: AgentExecutionConfig, prId: number): PullRequestRecord {
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

function listPullRequestWorkItemIds(config: AgentExecutionConfig, prId: number): number[] {
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
  return Array.from(new Set(items.map(item => item.id).filter((value): value is number => Number.isFinite(value))));
}

function addPullRequestWorkItems(config: AgentExecutionConfig, prId: number, workItemIds: number[]): void {
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

function listPullRequestLabels(config: AgentExecutionConfig, prId: number): string[] {
  const url =
    `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/git/repositories/${encodeURIComponent(config.repositoryId)}/pullRequests/${prId}/labels?api-version=7.1-preview.1`;
  const result = devopsRestJson(config, 'GET', url) as PullRequestLabelResult;
  return Array.from(
    new Set((result.value ?? [])
      .map(label => label.name?.trim())
      .filter((value): value is string => Boolean(value))),
  );
}

function addPullRequestLabel(config: AgentExecutionConfig, prId: number, label: string): void {
  const url =
    `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/git/repositories/${encodeURIComponent(config.repositoryId)}/pullRequests/${prId}/labels?api-version=7.1-preview.1`;
  devopsRestJson(config, 'POST', url, JSON.stringify({ name: label }));
}

function syncPullRequestLabels(
  config: AgentExecutionConfig,
  prId: number,
  workItemIds: number[],
  syncTagMode: PullRequestTagMode,
): string[] {
  if (workItemIds.length === 0 || !config.prDefaults.syncWorkItemTags) return [];
  const targetTags = normalizeTags(
    workItemIds.flatMap(id => getWorkItemTags(config, id))
      .filter(tag => syncTagMode === 'all' || !tag.toLowerCase().startsWith('agent:')),
  );
  if (targetTags.length === 0) return [];
  const existing = listPullRequestLabels(config, prId);
  const existingKeys = new Set(existing.map(tag => tag.toLowerCase()));
  const added: string[] = [];
  for (const tag of targetTags) {
    if (existingKeys.has(tag.toLowerCase())) continue;
    addPullRequestLabel(config, prId, tag);
    existingKeys.add(tag.toLowerCase());
    added.push(tag);
  }
  return added;
}

function addPullRequestReviewer(
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

function listWorkItemComments(config: AgentExecutionConfig, id: number): Array<{ id: number; text: string; format: string }> {
  const url =
    `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`;
  const result = devopsRestJson(config, 'GET', url) as WorkItemCommentResult;
  return (result.comments ?? [])
    .map(comment => ({
      id: Number(comment.id),
      text: String(comment.text ?? ''),
      format: String(comment.format ?? ''),
    }))
    .filter(comment => Number.isFinite(comment.id));
}

function updateWorkItemComment(config: AgentExecutionConfig, workItemId: number, commentId: number, text: string): void {
  const url =
    `${config.organizationUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/wit/workItems/${workItemId}/comments/${commentId}?api-version=7.1-preview.4`;
  devopsRestJson(config, 'PATCH', url, JSON.stringify({ text }));
}

function inferWorkItemIdFromPullRequest(pr: PullRequestRecord): number | undefined {
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

function hasLinkedCommit(id: number): boolean {
  const output = shell([
    'git',
    'log',
    '--all',
    '--grep',
    `AB#${id}`,
    '--format=%H',
    '-n',
    '1',
  ]);
  return output.length > 0;
}

function hasLinkedCommitArtifact(config: AgentExecutionConfig, id: number): boolean {
  return listWorkItemRelations(config, id).some(relation =>
    relation.rel === 'ArtifactLink' && relation.name === 'Fixed in Commit',
  );
}

function printStatus(args: string[] = []): void {
  const inspection = inspectConfig();
  if (wantsJson(args)) {
    printJson(buildStatusPayload());
    return;
  }
  console.log('=== AGENT EXECUTION LAYER ===');
  console.log('backend: Azure DevOps');
  console.log(`config: ${CONFIG_PATH}`);
  if (inspection.errors.length > 0) {
    console.log(`validation: invalid (${inspection.errors.length} ${pluralize(inspection.errors.length, 'error')})`);
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

  const config = inspection.config!;
  const agentSummary = config.agents
    .map(agent => `${agent.key}=${agent.tag} (branch=${agent.branchPrefix}${agent.defaultAssignee ? `, assigned=${agent.defaultAssignee}` : ''})`)
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
  console.log(`agents: ${agentSummary || '(none)'}`);
  console.log(`shared tags: ${config.sharedTags.join(', ') || '(none)'}`);
  console.log(`pr defaults: reviewer=${config.prDefaults.reviewerMode}, required=${config.prDefaults.reviewerRequired}, syncTags=${config.prDefaults.syncWorkItemTags}, tagMode=${config.prDefaults.syncTagMode}`);
  console.log(`report defaults: staleDays=${config.reportDefaults.staleDays}, recentDays=${config.reportDefaults.recentDays}`);
  for (const nextStep of buildStatusNextSteps(inspection)) {
    console.log(`next: ${nextStep}`);
  }
}

function commandValidateConfig(args: string[] = []): void {
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

function commandEnable(config: AgentExecutionConfig, args: string[] = []): void {
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

function commandDisable(config: AgentExecutionConfig, args: string[] = []): void {
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

function commandCreate(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'create');
  const title = parseArgValue(args, '--title');
  if (!title) fail('create requires --title "<text>".');

  const createAgent = parseArgValue(args, '--agent');
  const warnings: string[] = [];
  if (createAgent) {
    normalizeAgent(config, createAgent);
    warnings.push('ignoring --agent on create; agent tag is applied when claimed.');
  }
  const assignedTo = parseArgValue(args, '--assigned-to') ?? '';
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
  const tags = normalizeTags([
    ...config.sharedTags,
    ...manualTags,
  ]);

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
  const fieldPairs: string[] = [];
  if (tags.length > 0) fieldPairs.push(`System.Tags=${tags.join(';')}`);
  if (priority !== undefined) fieldPairs.push(`Microsoft.VSTS.Common.Priority=${priority}`);
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
): { id: number; state: string; agent: AgentKey; assignedTo: string; note?: string; tags: string[] } {
  const existingTags = getWorkItemTags(config, id);
  const nonAgentTags = existingTags.filter(tag => !tag.toLowerCase().startsWith('agent:'));
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

function commandClaim(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'claim');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('claim requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);

  const agent = normalizeAgent(config, parseArgValue(args, '--agent'));
  const assignedTo = parseArgValue(args, '--assigned-to') ?? getAgentDefaultAssignee(config, agent);
  const note = normalizeText(parseArgValue(args, '--note'));

  const result = claimWorkItem(config, id, agent, assignedTo, note);
  if (wantsJson(args)) {
    printJson({ ok: true, ...result });
    return;
  }
  console.log(`Claimed work item #${id} -> state=${result.state}, agent=${getAgentTag(config, agent)}`);
}

function commandPrioritize(config: AgentExecutionConfig, args: string[]): void {
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

function commandLink(config: AgentExecutionConfig, args: string[]): void {
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

function commandBranch(config: AgentExecutionConfig, args: string[]): void {
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

function commandStart(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'start');
  const idRaw = parseArgValue(args, '--id');
  if (!idRaw) fail('start requires --id <workItemId>.');
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) fail(`invalid --id "${idRaw}".`);
  const agent = normalizeAgent(config, parseArgValue(args, '--agent'), getDefaultAgentKey(config));
  const assignedTo = parseArgValue(args, '--assigned-to') ?? getAgentDefaultAssignee(config, agent);
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
  console.log(`Claimed work item #${id} -> state=${claim.state}, agent=${getAgentTag(config, agent)}`);
  console.log(`Checked out branch ${branchName}`);
}

function commandCommit(config: AgentExecutionConfig, args: string[]): void {
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
  const reviewerRequired = hasFlag(args, '--required-reviewer') || config.prDefaults.reviewerRequired;
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
      if (explicitReviewer) fail('explicit --reviewer assigned was requested but the work item has no assignee.');
      return { required: reviewerRequired };
    }
    return { reviewer: assigned, required: reviewerRequired };
  }

  return {
    reviewer: explicitReviewer,
    required: reviewerRequired,
  };
}

function shouldSyncPrTags(config: AgentExecutionConfig, args: string[]): boolean {
  if (hasFlag(args, '--sync-pr-tags')) return true;
  if (hasFlag(args, '--no-sync-pr-tags')) return false;
  return config.prDefaults.syncWorkItemTags;
}

function commandPr(config: AgentExecutionConfig, args: string[]): void {
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
  const description = normalizeText(parseArgValue(args, '--description')) ??
    renderPullRequestDescription(
      id,
      humanSummary,
      agentContext,
    );
  const targetBranch = resolveTargetBranch(config, args);
  const currentBranch = currentBranchName();
  const draft = !hasFlag(args, '--ready');
  const reviewer = resolveReviewerFromArgs(config, args, item);
  const syncPrTags = shouldSyncPrTags(config, args);

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

  const created = execJsonOrEmpty(createArgs) as { pullRequestId?: number; repository?: { webUrl?: string } };
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
    console.log(`PR tags: ${addedTags.length > 0 ? addedTags.join(', ') : '(no new tags added)'}`);
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

function commandDone(config: AgentExecutionConfig, args: string[]): void {
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

  azJson(config, [
    'boards',
    'work-item',
    'update',
    '--id',
    String(id),
    '--discussion',
    discussion,
  ]);
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
      ...(note ? { note } : {}),
      ...(pr ? { pr } : {}),
      skipLinkChecks,
    });
    return;
  }
  console.log(`Marked work item #${id} -> state=${config.stateMap.done}`);
}

function commandRetag(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'retag');
  const dryRun = hasFlag(args, '--dry-run');

  const singleIdRaw = parseArgValue(args, '--id');
  const explicitIds = parseIdListArg(parseArgValue(args, '--ids'));
  const ids: number[] = [];
  if (singleIdRaw) {
    const singleId = Number.parseInt(singleIdRaw, 10);
    if (!Number.isFinite(singleId)) fail(`invalid --id "${singleIdRaw}".`);
    ids.push(singleId);
  }
  ids.push(...explicitIds);

  const dedupedExplicitIds = uniqueTags(ids.map(String)).map(v => Number.parseInt(v, 10));
  const candidateIds = dedupedExplicitIds.filter(id => Number.isFinite(id));

  const targetIds = candidateIds.length > 0
    ? candidateIds
    : (() => {
      const agentArg = parseArgValue(args, '--agent');
      const agent = agentArg ? normalizeAgent(config, agentArg) : undefined;
      const state = parseArgValue(args, '--state') ?? 'open';
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
  const accessToken = dryRun ? undefined : getDevOpsAccessToken();
  for (const id of targetIds) {
    const existing = getWorkItemTags(config, id);
    const normalizedTarget = normalizeTags([...existing, ...config.sharedTags]);
    const before = uniqueTags(existing).join(';');
    const after = normalizedTarget.join(';');

    if (before.toLowerCase() === after.toLowerCase()) {
      continue;
    }

    if (!dryRun) {
      replaceWorkItemTagsExact(config, id, normalizedTarget, accessToken!);
    }

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
    console.log(`${dryRun ? 'Would normalize' : 'Normalized'} #${id}: ${before || '(none)'} -> ${after || '(none)'}`);
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
  console.log(`${dryRun ? 'Preview' : 'Completed'} tag normalization: ${changed}/${targetIds.length} work item(s) changed.`);
}

function queryWorkItems(
  config: AgentExecutionConfig,
  params: {
    agent?: AgentKey;
    withoutAgentTags?: boolean;
    state?: string;
    limit: number;
  },
): number[] {
  const whereClauses: string[] = [
    `[System.TeamProject] = '${escapedWiql(config.project)}'`,
    `[System.WorkItemType] = '${escapedWiql(config.defaultWorkItemType)}'`,
  ];

  if (params.agent && params.withoutAgentTags) {
    fail('query cannot use --agent and without-agent filter at the same time.');
  }

  if (params.agent) {
    whereClauses.push(`[System.Tags] CONTAINS '${escapedWiql(getAgentTag(config, params.agent))}'`);
  }

  if (params.withoutAgentTags) {
    for (const agentTag of uniqueTags(configuredAgentTags(config))) {
      whereClauses.push(`[System.Tags] NOT CONTAINS '${escapedWiql(agentTag)}'`);
    }
  }

  const rawState = (params.state ?? 'open').toLowerCase();
  if (rawState === 'new') {
    whereClauses.push(`[System.State] = '${escapedWiql(config.stateMap.new)}'`);
  } else if (rawState === 'active') {
    whereClauses.push(`[System.State] = '${escapedWiql(config.stateMap.active)}'`);
  } else if (rawState === 'done') {
    whereClauses.push(`[System.State] = '${escapedWiql(config.stateMap.done)}'`);
  } else if (rawState === 'open') {
    whereClauses.push(`[System.State] <> '${escapedWiql(config.stateMap.done)}'`);
  } else if (rawState !== 'all') {
    fail(`unsupported --state "${params.state}". Use new|active|done|open|all.`);
  }

  const wiql =
    `SELECT [System.Id] FROM WorkItems WHERE ${whereClauses.join(' AND ')} ` +
    'ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC';

  const queryResult = azJson(config, [
    'boards',
    'query',
    '--project',
    config.project,
    '--wiql',
    wiql,
  ]) as AzQueryResult | Array<{ id?: number }>;
  const rows = Array.isArray(queryResult)
    ? queryResult
    : (queryResult.workItems ?? []);
  const ids = rows
    .map(item => item.id)
    .filter((id): id is number => Number.isFinite(id));
  return ids.slice(0, params.limit);
}

function findFirstUnblockedWorkItem(config: AgentExecutionConfig, ids: number[]): number | undefined {
  for (const id of ids) {
    if (getOpenPredecessorIds(config, id).length === 0) {
      return id;
    }
  }
  return ids[0];
}

function formatAssigned(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const displayName = (raw as { displayName?: unknown }).displayName;
  return typeof displayName === 'string' ? displayName : '';
}

function summarizeWorkItem(
  config: AgentExecutionConfig,
  id: number,
  item: WorkItemShowResult,
  blocked = getOpenPredecessorIds(config, id).length > 0,
): WorkItemSummary {
  const fields = item.fields ?? {};
  const state = String(fields['System.State'] ?? '');
  const title = String(fields['System.Title'] ?? '');
  const priority = getWorkItemPriorityValue(item);
  const tags = parseTagList(typeof fields['System.Tags'] === 'string' ? fields['System.Tags'] : undefined);
  const agentTag = tags.find(tag => tag.toLowerCase().startsWith('agent:')) ?? '';
  const assignedTo = formatAssigned(fields['System.AssignedTo']);
  return {
    id,
    state,
    ...(priority === 999 ? {} : { priority }),
    blocked,
    ...(agentTag ? { agentTag } : {}),
    ...(assignedTo ? { assignedTo } : {}),
    title,
  };
}

function collectWorkItemSummaries(config: AgentExecutionConfig, ids: number[]): WorkItemSummary[] {
  return ids.map(id => summarizeWorkItem(config, id, getWorkItem(config, id)));
}

function printWorkItems(config: AgentExecutionConfig, ids: number[]): void {
  if (ids.length === 0) {
    console.log('No matching work items.');
    return;
  }

  console.log('ID\tState\tPriority\tBlocked\tAgent\tAssigned\tTitle');
  for (const item of collectWorkItemSummaries(config, ids)) {
    console.log(
      `${item.id}\t${item.state}\t${item.priority ?? ''}\t${item.blocked ? 'yes' : 'no'}\t${item.agentTag ?? ''}\t${item.assignedTo ?? ''}\t${item.title}`,
    );
  }
}

function parseDateValue(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function ageInDays(date: Date, now = new Date()): number {
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function collectTargetWorkItemIds(
  config: AgentExecutionConfig,
  args: string[],
  defaultState: string,
  defaultLimit: number,
): number[] {
  const singleIdRaw = parseArgValue(args, '--id');
  const explicitIds = parseIdListArg(parseArgValue(args, '--ids'));
  const ids: number[] = [];
  if (singleIdRaw) {
    const singleId = Number.parseInt(singleIdRaw, 10);
    if (!Number.isFinite(singleId)) fail(`invalid --id "${singleIdRaw}".`);
    ids.push(singleId);
  }
  ids.push(...explicitIds);
  const explicit = Array.from(new Set(ids.filter(Number.isFinite)));
  if (explicit.length > 0) return explicit;

  const agentArg = parseArgValue(args, '--agent');
  const agent = agentArg ? normalizeAgent(config, agentArg) : undefined;
  const state = parseArgValue(args, '--state') ?? defaultState;
  const limitRaw = parseArgValue(args, '--limit') ?? String(defaultLimit);
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit <= 0) fail(`invalid --limit "${limitRaw}".`);
  return queryWorkItems(config, { agent, state, limit });
}

function updatePullRequestDescription(config: AgentExecutionConfig, prId: number, description: string): void {
  const args = [
    'az',
    'repos',
    'pr',
    'update',
    '--org',
    config.organizationUrl,
    '--detect',
    'true',
    '--id',
    String(prId),
  ];
  appendMultilineArg(args, '--description', description);
  args.push('-o', 'json');
  execJsonOrEmpty(args);
}

function printAuditFindings(findings: AuditFinding[]): void {
  if (findings.length === 0) {
    console.log('No audit findings.');
    return;
  }
  for (const finding of findings) {
    console.log(
      `[${finding.level.toUpperCase()}] ${finding.scope} ${finding.type}: ${finding.message}${finding.repaired ? ' [repaired]' : ''}`,
    );
  }
}

function commandAudit(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'audit');
  const workItemIds = collectTargetWorkItemIds(config, args, 'open', 50);
  const repairAll = hasFlag(args, '--repair');
  const repairFormatting = repairAll || hasFlag(args, '--repair-formatting');
  const repairPrTags = repairAll || hasFlag(args, '--repair-pr-tags');
  const repairPrLinks = repairAll || hasFlag(args, '--repair-pr-links');
  const staleDaysRaw = parseArgValue(args, '--stale-days');
  const staleDays = staleDaysRaw ? Number.parseInt(staleDaysRaw, 10) : config.reportDefaults.staleDays;
  if (!Number.isFinite(staleDays) || staleDays < 0) fail(`invalid --stale-days "${staleDaysRaw}".`);

  const findings: AuditFinding[] = [];
  const touchedPrIds = new Set<number>();
  const activePullRequests = listPullRequests(config, 'active');

  for (const id of workItemIds) {
    const item = getWorkItemWithRelations(config, id);
    const state = getWorkItemStateValue(item);
    const title = String(item.fields?.['System.Title'] ?? `Work item ${id}`);
    const description = String(item.fields?.['System.Description'] ?? '');
    if (description && !description.includes('<strong>') && isMarkdownish(description)) {
      const repaired = repairFormatting ? buildRepairedWorkItemDescription(description) : undefined;
      if (repaired) {
        azJson(config, ['boards', 'work-item', 'update', '--id', String(id), '--description', repaired]);
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

    for (const comment of listWorkItemComments(config, id)) {
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
        message: linkedWorkItems.length > 0
          ? `Linked inferred work item #${linkedWorkItems[0]} from the PR title/branch.`
          : 'PR has no linked work item.',
        repaired: linkedWorkItems.length > 0,
      });
    }

    const rawDescription = String(pr.description ?? '');
    if (rawDescription && isMarkdownish(rawDescription)) {
      const repaired = repairFormatting ? buildRepairedPullRequestDescription(rawDescription) : undefined;
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
        linkedWorkItems.flatMap(id => getWorkItemTags(config, id))
          .filter(tag => config.prDefaults.syncTagMode === 'all' || !tag.toLowerCase().startsWith('agent:')),
      );
      const existingLabels = listPullRequestLabels(config, pullRequestId);
      const missingLabels = desiredTags.filter(
        tag => !existingLabels.some(existing => existing.toLowerCase() === tag.toLowerCase()),
      );
      if (missingLabels.length > 0) {
        const added = repairPrTags
          ? syncPullRequestLabels(config, pullRequestId, linkedWorkItems, config.prDefaults.syncTagMode)
          : [];
        findings.push({
          level: 'info',
          type: 'pr-tags',
          scope: `PR#${pullRequestId}`,
          message: added.length > 0
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
      findingCount: findings.length,
      findingCounts: {
        warn: findings.filter(finding => finding.level === 'warn').length,
        info: findings.filter(finding => finding.level === 'info').length,
        repaired: findings.filter(finding => finding.repaired).length,
      },
      findings,
    });
    return;
  }

  console.log('=== AEL AUDIT ===');
  console.log(`Work items scanned: ${workItemIds.length}`);
  console.log(`Active PRs scanned: ${activePullRequests.length}`);
  console.log(`Repair mode: ${repairAll ? 'all safe repairs' : [
    repairFormatting ? 'formatting' : '',
    repairPrTags ? 'pr-tags' : '',
    repairPrLinks ? 'pr-links' : '',
  ].filter(Boolean).join(', ') || 'off'}`);
  printAuditFindings(findings);
}

function commandReport(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'report');
  const limitRaw = parseArgValue(args, '--limit') ?? '20';
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit <= 0) fail(`invalid --limit "${limitRaw}".`);
  const staleDaysRaw = parseArgValue(args, '--stale-days');
  const recentDaysRaw = parseArgValue(args, '--recent-days');
  const staleDays = staleDaysRaw ? Number.parseInt(staleDaysRaw, 10) : config.reportDefaults.staleDays;
  const recentDays = recentDaysRaw ? Number.parseInt(recentDaysRaw, 10) : config.reportDefaults.recentDays;
  if (!Number.isFinite(staleDays) || staleDays < 0) fail(`invalid --stale-days "${staleDaysRaw}".`);
  if (!Number.isFinite(recentDays) || recentDays < 0) fail(`invalid --recent-days "${recentDaysRaw}".`);

  const openIds = queryWorkItems(config, { state: 'open', limit: 200 });
  const openItemMap = new Map(
    getWorkItemsBatch(config, openIds, 'fields')
      .map(item => [Number(item.id), item] as const)
      .filter(([id]) => Number.isFinite(id)),
  );
  const openItems = openIds
    .map(id => ({ id, item: openItemMap.get(id) }))
    .filter((entry): entry is { id: number; item: WorkItemShowResult } => Boolean(entry.item));
  const activeItems = openItems.filter(({ item }) => getWorkItemStateValue(item) === config.stateMap.active);
  const newItems = openItems.filter(({ item }) => getWorkItemStateValue(item) === config.stateMap.new);
  const blockedItems = openItems.filter(({ id }) => getOpenPredecessorIds(config, id).length > 0);
  const staleItems = activeItems.filter(({ item }) => {
    const changed = parseDateValue(item.fields?.['System.ChangedDate']);
    return changed ? ageInDays(changed) >= staleDays : false;
  });
  const doneIds = queryWorkItems(config, { state: 'done', limit: 50 });
  const doneItemMap = new Map(
    getWorkItemsBatch(config, doneIds, 'fields')
      .map(item => [Number(item.id), item] as const)
      .filter(([id]) => Number.isFinite(id)),
  );
  const recentDone = doneIds
    .map(id => ({ id, item: doneItemMap.get(id) }))
    .filter((entry): entry is { id: number; item: WorkItemShowResult } => Boolean(entry.item))
    .filter(({ item }) => {
      const changed = parseDateValue(item.fields?.['System.ChangedDate']);
      return changed ? ageInDays(changed) <= recentDays : false;
    })
    .slice(0, limit);
  const activePrs = listPullRequests(config, 'active');
  const unclaimedNewCount = newItems.filter(({ item }) => {
    const tags = parseTagList(typeof item.fields?.['System.Tags'] === 'string' ? item.fields?.['System.Tags'] : undefined);
    return !tags.some(tag => tag.toLowerCase().startsWith('agent:'));
  }).length;
  const countByAgent = (agent: AgentKey) => activeItems.filter(({ item }) => {
    const tags = parseTagList(typeof item.fields?.['System.Tags'] === 'string' ? item.fields?.['System.Tags'] : undefined);
    return tags.includes(getAgentTag(config, agent));
  }).length;
  const agentWorkload = getConfiguredAgents(config).map(agent => ({
    agent: agent.key,
    activeCount: countByAgent(agent.key),
  }));
  const blockedSummaries = blockedItems
    .slice(0, limit)
    .map(({ id, item }) => summarizeWorkItem(config, id, item, true));
  const recentDoneSummaries = recentDone.map(({ id, item }) => summarizeWorkItem(config, id, item, false));
  const activePullRequestSummaries = activePrs
    .slice(0, limit)
    .flatMap(pr => {
      const prId = pr.pullRequestId;
      if (!Number.isFinite(prId)) return [];
      const pullRequestId = Number(prId);
      return [{
        pullRequestId,
        title: pr.title ?? '',
        status: pr.status ?? 'unknown',
        isDraft: Boolean(pr.isDraft),
        reviewerCount: pr.reviewers?.length ?? 0,
        workItemCount: listPullRequestWorkItemIds(config, pullRequestId).length,
        tags: listPullRequestLabels(config, pullRequestId),
      }];
    });

  if (wantsJson(args)) {
    printJson({
      ok: true,
      counts: {
        open: openItems.length,
        new: newItems.length,
        active: activeItems.length,
        blocked: blockedItems.length,
        activePullRequests: activePrs.length,
        staleActive: staleItems.length,
        recentDone: recentDone.length,
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

  console.log('=== AEL STATUS REPORT ===');
  console.log(`Open work items: ${openItems.length}`);
  console.log(`- New: ${newItems.length}`);
  console.log(`- Active: ${activeItems.length}`);
  console.log(`- Blocked: ${blockedItems.length}`);
  console.log(`Active PRs: ${activePrs.length}`);
  console.log(`Stale active items (>= ${staleDays}d): ${staleItems.length}`);
  console.log('');

  console.log('Agent Workload');
  for (const agent of getConfiguredAgents(config)) {
    console.log(`- ${agent.key} active: ${countByAgent(agent.key)}`);
  }
  console.log(`- unclaimed new: ${unclaimedNewCount}`);
  console.log('');

  console.log('Blocked Items');
  if (blockedItems.length === 0) {
    console.log('- none');
  } else {
    for (const { id, item } of blockedItems.slice(0, limit)) {
      console.log(`- #${id} ${String(item.fields?.['System.Title'] ?? '')}`);
    }
  }
  console.log('');

  console.log('Active PRs');
  if (activePrs.length === 0) {
    console.log('- none');
  } else {
    for (const pr of activePrs.slice(0, limit)) {
      const prId = pr.pullRequestId;
      if (!Number.isFinite(prId)) continue;
      const pullRequestId = Number(prId);
      const reviewerCount = pr.reviewers?.length ?? 0;
      const linkedWorkItems = listPullRequestWorkItemIds(config, pullRequestId).length;
      const labels = listPullRequestLabels(config, pullRequestId);
      console.log(`- PR#${pullRequestId} ${pr.title ?? ''}`);
      console.log(`  status: ${pr.status ?? 'unknown'}${pr.isDraft ? ' (draft)' : ''}, reviewers: ${reviewerCount}, work items: ${linkedWorkItems}`);
      console.log(`  tags: ${labels.length > 0 ? labels.join(', ') : '(none)'}`);
    }
  }
  console.log('');

  console.log(`Recently Closed (${recentDays}d)`);
  if (recentDone.length === 0) {
    console.log('- none');
  } else {
    for (const { id, item } of recentDone) {
      console.log(`- #${id} ${String(item.fields?.['System.Title'] ?? '')}`);
    }
  }
}

function commandList(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'list');
  const agentArg = parseArgValue(args, '--agent');
  const agent = agentArg ? normalizeAgent(config, agentArg) : undefined;
  const state = parseArgValue(args, '--state') ?? 'open';
  const limitRaw = parseArgValue(args, '--limit') ?? '20';
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit <= 0) fail(`invalid --limit "${limitRaw}".`);

  const ids = queryWorkItems(config, { agent, state, limit });
  if (wantsJson(args)) {
    printJson({
      ok: true,
      state,
      ...(agent ? { agent } : {}),
      limit,
      count: ids.length,
      workItems: collectWorkItemSummaries(config, ids),
    });
    return;
  }
  printWorkItems(config, ids);
}

function commandInstall(args: string[]): void {
  const workspace = process.cwd();
  const force = hasFlag(args, '--force');
  const runner = detectPackageManagerCommand();
  const packageJsonPath = join(workspace, 'package.json');
  if (resolve(workspace) === resolve(PACKAGE_ROOT)) {
    fail('install targets downstream repos. Run it from the repo that is adopting AEL, not inside the AEL package repo.');
  }
  if (!existsSync(packageJsonPath)) {
    fail(`install requires ${packageJsonPath}. Run it from the downstream repo root.`);
  }

  const rawPackage = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
  if (!isRecord(rawPackage)) {
    fail(`invalid ${packageJsonPath}: root must be a JSON object.`);
  }

  const packageScripts = rawPackage.scripts;
  if (packageScripts !== undefined && !isRecord(packageScripts)) {
    fail(`invalid ${packageJsonPath}: "scripts" must be an object when present.`);
  }

  const manifest = { ...rawPackage };
  const scripts = { ...(isRecord(packageScripts) ? packageScripts : {}) };
  const rawRecommendedScripts = JSON.parse(loadDownstreamTemplate('package-scripts.json')) as unknown;
  if (!isRecord(rawRecommendedScripts) || !isRecord(rawRecommendedScripts.scripts)) {
    fail('invalid downstream package-scripts template.');
  }
  const recommendedScripts = rawRecommendedScripts.scripts;

  const addedScripts: string[] = [];
  const updatedScripts: string[] = [];
  const unchangedScripts: string[] = [];
  const scriptConflicts: InstallScriptConflict[] = [];

  for (const [name, recommended] of Object.entries(recommendedScripts)) {
    if (typeof recommended !== 'string') continue;
    const current = scripts[name];
    if (current === undefined) {
      scripts[name] = recommended;
      addedScripts.push(name);
      continue;
    }
    if (current === recommended) {
      unchangedScripts.push(name);
      continue;
    }
    if (!force) {
      scriptConflicts.push({
        name,
        current: String(current),
        recommended,
      });
      continue;
    }
    scripts[name] = recommended;
    updatedScripts.push(name);
  }

  const repoName = typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name.trim()
    : basename(workspace);
  const agentKey = normalizeAgentKey(parseArgValue(args, '--agent-key')) || 'codex';
  const defaultBranch =
    normalizeText(parseArgValue(args, '--default-branch')) ??
    detectOriginDefaultBranch() ??
    'main';
  const buildCommand = getPackageScriptCommand(scripts, ['build'], runner);
  const unitTestCommand = getPackageScriptCommand(scripts, ['test'], runner);
  const integrationTestCommand = getPackageScriptCommand(scripts, ['test:integration', 'integration-test'], runner);
  const lintCommand = getPackageScriptCommand(scripts, ['lint', 'typecheck', 'check', 'validate'], runner);
  const validationCommands = renderValidationCommands(scripts, runner);
  const templateContext = {
    agentKey,
    repositoryName: repoName,
    defaultBranch,
    buildCommand,
    unitTestCommand,
    integrationTestCommand,
    lintCommand,
    validationCommands,
  };

  const summary: InstallSummary = {
    ok: scriptConflicts.length === 0,
    workspace,
    packageJsonPath,
    agentKey,
    scripts: {
      added: addedScripts,
      updated: updatedScripts,
      unchanged: unchangedScripts,
      conflicts: scriptConflicts,
    },
    files: {
      created: [],
      updated: [],
      unchanged: [],
    },
    nextSteps: scriptConflicts.length === 0
      ? [
        `review ${join(workspace, 'AGENTS.md')}`,
        `review ${join(workspace, 'docs', 'AEL-PROJECT-CONTRACT.md')}`,
        `${formatScriptCommand('ael:init', runner)}`,
        `${formatScriptCommand('ael:doctor', runner)}`,
      ]
      : ['re-run ael install --force or resolve package script conflicts manually'],
  };

  if (scriptConflicts.length > 0) {
    if (wantsJson(args)) {
      printJson(summary);
    } else {
      console.log('=== AEL INSTALL ===');
      console.log(`workspace: ${workspace}`);
      console.log(`package.json: ${packageJsonPath}`);
      console.log('Conflicting package scripts:');
      for (const conflict of scriptConflicts) {
        console.log(`- ${conflict.name}: current="${conflict.current}" recommended="${conflict.recommended}"`);
      }
      console.log('Next: re-run ael install --force or resolve package script conflicts manually');
    }
    process.exit(1);
  }

  manifest.scripts = scripts;
  writeFileSync(packageJsonPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (addedScripts.length === 0 && updatedScripts.length === 0) {
    summary.files.unchanged.push(packageJsonPath);
  } else {
    summary.files.updated.push(packageJsonPath);
  }

  const agentsTemplate = applyInstallTemplate(loadDownstreamTemplate('AGENTS.md'), templateContext);
  const agentsResult = updateAgentsFile(workspace, agentsTemplate, force);
  summary.files[agentsResult.status === 'created' ? 'created' : agentsResult.status === 'updated' ? 'updated' : 'unchanged'].push(agentsResult.path);

  const contractPath = join(workspace, 'docs', 'AEL-PROJECT-CONTRACT.md');
  const contractTemplate = applyInstallTemplate(
    loadDownstreamTemplate('AEL-PROJECT-CONTRACT.md'),
    templateContext,
  );
  const contractResult = writeTemplateFile(contractPath, contractTemplate, force);
  summary.files[contractResult.status === 'created' ? 'created' : contractResult.status === 'updated' ? 'updated' : 'unchanged'].push(contractResult.path);

  const gitignoreResult = ensureGitignoreEntry(workspace, 'agent-execution.config.local.json');
  summary.files[gitignoreResult.status === 'created' ? 'created' : gitignoreResult.status === 'updated' ? 'updated' : 'unchanged'].push(gitignoreResult.path);

  if (wantsJson(args)) {
    printJson(summary);
    return;
  }

  console.log('=== AEL INSTALL ===');
  console.log(`workspace: ${workspace}`);
  console.log(`package.json: ${packageJsonPath}`);
  if (addedScripts.length > 0) {
    console.log(`scripts added: ${addedScripts.join(', ')}`);
  }
  if (updatedScripts.length > 0) {
    console.log(`scripts updated: ${updatedScripts.join(', ')}`);
  }
  if (summary.files.created.length > 0) {
    console.log(`files created: ${summary.files.created.join(', ')}`);
  }
  if (summary.files.updated.length > 0) {
    console.log(`files updated: ${summary.files.updated.join(', ')}`);
  }
  if (summary.files.unchanged.length > 0) {
    console.log(`files unchanged: ${summary.files.unchanged.join(', ')}`);
  }
  for (const nextStep of summary.nextSteps) {
    console.log(`next: ${nextStep}`);
  }
}

function parseAgentKeyList(raw: string | undefined): string[] {
  const values = parseListArg(raw)
    .map(normalizeAgentKey)
    .filter(Boolean);
  return Array.from(new Set(values));
}

function buildAgentDefinitions(keys: string[], prior?: AgentExecutionConfig): AgentDefinition[] {
  return Array.from(new Set(keys.map(normalizeAgentKey).filter(Boolean))).map(key => {
    const existing = prior?.agents.find(agent => agent.key === key);
    return {
      key,
      tag: existing?.tag ?? `agent:${key}`,
      branchPrefix: existing?.branchPrefix ?? key,
      defaultAssignee: existing?.defaultAssignee ?? '',
    };
  });
}

function detectGitRepoRoot(): string | undefined {
  const result = runCommand(['git', 'rev-parse', '--show-toplevel']);
  return result.ok ? result.stdout : undefined;
}

function detectOriginRemoteUrl(): string | undefined {
  const result = runCommand(['git', 'remote', 'get-url', 'origin']);
  return result.ok ? result.stdout : undefined;
}

function detectOriginDefaultBranch(): string | undefined {
  const symbolicRef = runCommand(['git', 'rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (symbolicRef.ok) {
    const match = symbolicRef.stdout.match(/^origin\/(.+)$/);
    if (match?.[1]) return match[1];
  }

  const remoteShow = runCommand(['git', 'remote', 'show', 'origin']);
  if (!remoteShow.ok) return undefined;
  const match = remoteShow.stdout.match(/HEAD branch:\s+([^\n]+)/i);
  return match?.[1]?.trim() || undefined;
}

function getAzureIdentity(): AzureIdentity | undefined {
  const result = runCommand(['az', 'account', 'show', '-o', 'json']);
  if (!result.ok) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as {
      user?: { name?: string };
      tenantId?: string;
      id?: string;
    };
    return {
      userName: String(parsed.user?.name ?? ''),
      tenantId: String(parsed.tenantId ?? ''),
      subscriptionId: String(parsed.id ?? ''),
    };
  } catch {
    return undefined;
  }
}

function resolveRepositoryId(
  organizationUrl: string,
  project: string,
  repository: string,
): string | undefined {
  const result = runCommand([
    'az',
    'repos',
    'show',
    '--org',
    organizationUrl,
    '--project',
    project,
    '--repository',
    repository,
    '--query',
    'id',
    '-o',
    'tsv',
  ]);
  return result.ok && result.stdout ? result.stdout : undefined;
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

function summarizeCommandFailure(result: CommandResult): string {
  return result.stderr || result.stdout || result.message || `exit code ${result.code}`;
}

function printCheck(label: string, ok: boolean, detail: string): void {
  console.log(`- ${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
}

async function commandInit(args: string[]): Promise<void> {
  const existingConfig = existsSync(CONFIG_PATH);
  const targetConfigPath = CONFIG_INIT_PATH;
  const targetConfigExists = existsSync(targetConfigPath);
  const migratingLegacyConfig = CONFIG_DISCOVERY.usedLegacyFallback && CONFIG_PATH !== targetConfigPath;
  const existingInspection = existingConfig ? inspectConfig() : undefined;
  const existingValidConfig =
    existingInspection && existingInspection.errors.length === 0
      ? existingInspection.config
      : undefined;

  if (targetConfigExists && !hasFlag(args, '--force')) {
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
    normalizeText(parseArgValue(args, '--organization-url')) ??
    existingValidConfig?.organizationUrl ??
    remoteInfo?.organizationUrl;
  let project =
    normalizeText(parseArgValue(args, '--project')) ??
    existingValidConfig?.project ??
    remoteInfo?.project;
  let repositoryName =
    normalizeText(parseArgValue(args, '--repository')) ??
    remoteInfo?.repositoryName;
  let repositoryId =
    normalizeText(parseArgValue(args, '--repository-id')) ??
    existingValidConfig?.repositoryId;
  let defaultBranch =
    normalizeText(parseArgValue(args, '--default-branch')) ??
    existingValidConfig?.defaultBranch ??
    detectedDefaultBranch;
  let agentKeys = parseAgentKeyList(parseArgValue(args, '--agents'));
  if (agentKeys.length === 0) {
    agentKeys = existingValidConfig?.agents.map(agent => agent.key) ??
      DEFAULT_AGENT_DEFINITIONS.map(agent => agent.key);
  }
  let defaultAgent =
    normalizeAgentKey(parseArgValue(args, '--default-agent')) ||
    existingValidConfig?.defaultAgent ||
    agentKeys[0];

  if (process.stdin.isTTY) {
    organizationUrl = organizationUrl || await promptForValue(
      'Azure DevOps organization URL',
      remoteInfo?.organizationUrl,
    );
    project = project || await promptForValue('Azure DevOps project', remoteInfo?.project);
    if (!repositoryName && !repositoryId) {
      repositoryName = await promptForValue(
        'Azure DevOps repository name',
        remoteInfo?.repositoryName,
      );
    }
    defaultBranch = defaultBranch || await promptForValue(
      'Default branch',
      detectedDefaultBranch ?? 'main',
    );

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
      normalizeText(parseArgValue(args, '--type')) ??
      existingValidConfig?.defaultWorkItemType ??
      'Task',
    defaultAreaPath:
      normalizeText(parseArgValue(args, '--area-path')) ??
      existingValidConfig?.defaultAreaPath ??
      project,
    defaultIterationPath:
      normalizeText(parseArgValue(args, '--iteration-path')) ??
      existingValidConfig?.defaultIterationPath ??
      project,
    sharedTags:
      parseTagList(parseArgValue(args, '--shared-tags')).length > 0
        ? parseTagList(parseArgValue(args, '--shared-tags'))
        : (existingValidConfig?.sharedTags ?? ['agent-managed']),
    agents: buildAgentDefinitions(agentKeys, existingValidConfig),
    stateMap: existingValidConfig?.stateMap ?? {
      new: 'New',
      active: 'Active',
      done: 'Closed',
    },
    prDefaults: existingValidConfig?.prDefaults ?? DEFAULT_PR_DEFAULTS,
    reportDefaults: existingValidConfig?.reportDefaults ?? DEFAULT_REPORT_DEFAULTS,
  };

  saveConfig(config, targetConfigPath);
  const inspection = inspectConfigAtPath(targetConfigPath);
  if (inspection.errors.length > 0) {
    const details = inspection.errors.map(message => `- ${message}`).join('\n');
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
      organizationUrl: config.organizationUrl,
      project: config.project,
      repositoryId: config.repositoryId,
      defaultBranch: config.defaultBranch,
      defaultAgent: config.defaultAgent,
      agents: config.agents.map(agent => agent.key),
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
  console.log(`default agent: ${config.defaultAgent}`);
  console.log(`agents: ${config.agents.map(agent => agent.key).join(', ')}`);
  if (inspection.warnings.length > 0) {
    for (const warning of inspection.warnings) {
      console.log(`warning: ${warning}`);
    }
  }
  console.log(`Next: ${preferredWorkflowCommand('doctor')}`);
}

function commandDoctor(args: string[]): void {
  const smoke = hasFlag(args, '--smoke');
  const checks: DoctorCheck[] = [];
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
  const azAccount = azCli.ok
    ? runCommand(['az', 'account', 'show', '-o', 'json'])
    : {
      ok: false,
      stdout: '',
      stderr: 'Azure CLI unavailable.',
      code: 1,
    };
  const accessToken = azCli.ok
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
    detail: azAccount.ok ? 'authenticated' : summarizeCommandFailure(azAccount),
  });
  checks.push({
    label: 'azure devops access token',
    ok: accessToken.ok && Boolean(accessToken.stdout),
    detail:
      accessToken.ok && accessToken.stdout
        ? 'available'
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
        ? runCommand([
          'git',
          'ls-remote',
          '--exit-code',
          '--heads',
          'origin',
          config.defaultBranch,
        ])
        : { ok: false, stdout: '', stderr: 'origin remote is missing.', code: 1 };

      checks.push({
        label: 'project access',
        ok: projectCheck.ok,
        detail: projectCheck.ok ? config.project : summarizeCommandFailure(projectCheck),
      });
      checks.push({
        label: 'repository access',
        ok: repositoryCheck.ok,
        detail: repositoryCheck.ok
          ? config.repositoryId
          : summarizeCommandFailure(repositoryCheck),
      });
      checks.push({
        label: 'configured default branch',
        ok: branchCheck.ok,
        detail: branchCheck.ok
          ? config.defaultBranch
          : summarizeCommandFailure(branchCheck),
      });

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
        checks.push({
          label: 'work item query smoke',
          ok: workItemQuery.ok,
          detail: workItemQuery.ok ? 'query succeeded' : summarizeCommandFailure(workItemQuery),
        });
        checks.push({
          label: 'pull request list smoke',
          ok: prList.ok,
          detail: prList.ok ? 'query succeeded' : summarizeCommandFailure(prList),
        });
      }
    }
  }

  const failed = checks.filter(check => !check.ok);
  if (wantsJson(args)) {
    printJson({
      ok: failed.length === 0,
      mode: smoke ? 'smoke' : 'doctor',
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

function commandNext(config: AgentExecutionConfig, args: string[]): void {
  ensureModeEnabled(config, args, 'next');
  const agent = normalizeAgent(config, parseArgValue(args, '--agent'), getDefaultAgentKey(config));

  const newUnclaimedIds = queryWorkItems(config, {
    state: 'new',
    withoutAgentTags: true,
    limit: 25,
  });
  if (newUnclaimedIds.length > 0) {
    const selectedId = findFirstUnblockedWorkItem(config, newUnclaimedIds)!;
    if (wantsJson(args)) {
      printJson({
        ok: true,
        agent,
        source: 'new-unclaimed',
        count: 1,
        workItems: collectWorkItemSummaries(config, [selectedId]),
      });
      return;
    }
    printWorkItems(config, [selectedId]);
    return;
  }

  const newIds = queryWorkItems(config, {
    agent,
    state: 'new',
    limit: 25,
  });
  if (newIds.length > 0) {
    const selectedId = findFirstUnblockedWorkItem(config, newIds)!;
    if (wantsJson(args)) {
      printJson({
        ok: true,
        agent,
        source: 'new-assigned',
        count: 1,
        workItems: collectWorkItemSummaries(config, [selectedId]),
      });
      return;
    }
    printWorkItems(config, [selectedId]);
    return;
  }

  const activeIds = queryWorkItems(config, {
    agent,
    state: 'active',
    limit: 25,
  });
  if (activeIds.length > 0) {
    const selectedId = findFirstUnblockedWorkItem(config, activeIds)!;
    if (wantsJson(args)) {
      printJson({
        ok: true,
        agent,
        source: 'active-assigned',
        count: 1,
        workItems: collectWorkItemSummaries(config, [selectedId]),
      });
      return;
    }
    printWorkItems(config, [selectedId]);
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
  console.log(`No unclaimed New tasks and no New/Active tasks found for ${getAgentTag(config, agent)}.`);
}

function printHelp(): void {
  console.log('Usage: ael <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  status [--json]');
  console.log('  validate-config [--json]');
  console.log('  install [--agent-key <agent-key>] [--default-branch <branch>] [--force] [--json]');
  console.log('  init [--organization-url <url>] [--project <name>] [--repository <name>] [--repository-id <id>] [--default-branch <branch>] [--agents "codex;claude"] [--default-agent <agent-key>] [--force] [--json]');
  console.log('  doctor [--smoke] [--json]');
  console.log('  smoke [--json]');
  console.log('  enable [--json]');
  console.log('  disable [--json]');
  console.log('  create --title "<text>" [--assigned-to "<name>"] [--human-summary "<goal>"] [--agent-context "<technical implementation context>"] [--mapped-tables "db.schema.table;db.schema.table"] [--acceptance "item one;item two"] [--type Task] [--tags "a;b"] [--priority 1..4] [--parent 123] [--depends-on "123;124"] [--related "125;126"] [--json]');
  console.log('         legacy aliases: --summary -> --human-summary, --description -> --agent-context');
  console.log('  claim --id 123 [--agent <agent-key>] [--assigned-to "<name>"] [--note "<text>"] [--json]');
  console.log('  start --id 123 [--agent <agent-key>] [--assigned-to "<name>"] [--branch-name "agent/123-task"] [--base <branch>] [--note "<text>"] [--json]');
  console.log('  prioritize --id 123 --priority 1..4 [--json]');
  console.log('  link --id 123 [--parent 100] [--depends-on "120;121"] [--related "122;123"] [--json]');
  console.log('  branch --id 123 [--agent <agent-key>] [--branch-name "agent/123-task"] [--base <branch>] [--json]');
  console.log('  commit --id 123 --message "<subject>" [--body "<details>"] [--all | --files "path1;path2"] [--json]');
  console.log('  pr --id 123 [--title "<text>"] [--description "<text>"] [--target-branch <branch>] [--ready] [--auto-complete] [--reviewer "<name>|assigned"] [--no-reviewer] [--required-reviewer] [--sync-pr-tags|--no-sync-pr-tags] [--json]');
  console.log('  done --id 123 [--summary "<outcome>"] [--impact "<business value>"] [--mapped-tables "db.schema.table;db.schema.table"] [--checks "build;fixtures;smoke"] [--changed-files "path1;path2"] [--pr "1234"] [--note "<extra context>"] [--skip-link-checks] [--json]');
  console.log('  retag [--id 123 | --ids "123;124"] [--state new|active|done|open|all] [--agent <agent-key>] [--limit 200] [--dry-run] [--json]');
  console.log('  list [--agent <agent-key>] [--state new|active|done|open|all] [--limit 20] [--json]');
  console.log('  next [--agent <agent-key>] [--json]');
  console.log('  audit [--id 123 | --ids "123;124"] [--state new|active|done|open|all] [--limit 50] [--stale-days 7] [--repair] [--repair-formatting] [--repair-pr-tags] [--repair-pr-links] [--json]');
  console.log('  report [--limit 20] [--stale-days 7] [--recent-days 7] [--json]');
  console.log('');
  console.log('Primary CLI surface: "ael" or repo-local "npm run ael:<command>".');
  console.log('Legacy "npm run ado:<command>" aliases remain for compatibility.');
  console.log('');
  console.log('Tag aliases auto-normalized: benchmarking->benchmark, ci->ci-policy, coverage->semantic-coverage, tokens->token-efficiency');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = argv.slice(1);

  switch (command) {
    case 'status':
      printStatus(args);
      return;
    case 'validate-config':
      commandValidateConfig(args);
      return;
    case 'install':
      commandInstall(args);
      return;
    case 'init':
      await commandInit(args);
      return;
    case 'doctor':
      commandDoctor(args);
      return;
    case 'smoke':
      commandDoctor(['--smoke', ...args]);
      return;
    case 'enable':
      commandEnable(loadConfig(), args);
      return;
    case 'disable':
      commandDisable(loadConfig(), args);
      return;
    case 'create':
      commandCreate(loadConfig(), args);
      return;
    case 'claim':
      commandClaim(loadConfig(), args);
      return;
    case 'start':
      commandStart(loadConfig(), args);
      return;
    case 'prioritize':
      commandPrioritize(loadConfig(), args);
      return;
    case 'link':
      commandLink(loadConfig(), args);
      return;
    case 'branch':
      commandBranch(loadConfig(), args);
      return;
    case 'commit':
      commandCommit(loadConfig(), args);
      return;
    case 'pr':
      commandPr(loadConfig(), args);
      return;
    case 'done':
      commandDone(loadConfig(), args);
      return;
    case 'retag':
      commandRetag(loadConfig(), args);
      return;
    case 'list':
      commandList(loadConfig(), args);
      return;
    case 'next':
      commandNext(loadConfig(), args);
      return;
    case 'audit':
      commandAudit(loadConfig(), args);
      return;
    case 'report':
      commandReport(loadConfig(), args);
      return;
    default:
      printHelp();
      process.exit(command ? 1 : 0);
  }
}

main().catch(err => {
  fail(err instanceof Error ? err.message : String(err));
});
