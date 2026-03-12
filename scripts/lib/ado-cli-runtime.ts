import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_AGENT_DEFINITIONS,
  discoverConfigPath,
  inspectConfigAtPath,
  loadConfigFromPath,
  normalizeAgentKey,
  readRuntimePlatformFromPath,
  saveConfigToPath,
  type AgentDefinition,
  type AgentExecutionConfig,
  type ConfigInspectionResult,
  type RuntimePlatform,
  type WorkItemFieldValue,
} from './config.js';
import type { AgentKey, AzureIdentity, CommandResult } from './ado-cli-types.js';

export const CONFIG_DISCOVERY = discoverConfigPath();
export const CONFIG_PATH = CONFIG_DISCOVERY.path;
export const CONFIG_INIT_PATH = CONFIG_DISCOVERY.preferredPath;
export const CONFIG_LEGACY_WARNING = CONFIG_DISCOVERY.usedLegacyFallback
  ? `using legacy config path ${CONFIG_PATH}; re-run init to migrate to ${CONFIG_INIT_PATH}.`
  : undefined;
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
export const TAG_ALIAS_MAP: Record<string, string> = {
  benchmarking: 'benchmark',
  ci: 'ci-policy',
  coverage: 'coverage-policy',
  tokens: 'token-efficiency',
};
const WINDOWS_SHELL_COMMANDS = new Set(['az', 'git', 'curl']);

export function fail(message: string): never {
  console.error(`agent-execution: ${message}`);
  process.exit(1);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function wantsJson(args: string[]): boolean {
  return hasFlag(args, '--json');
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function detectPackageManagerCommand(): string {
  const packageManager = process.env.npm_config_user_agent ?? '';
  if (packageManager.startsWith('pnpm/')) return 'pnpm';
  if (packageManager.startsWith('yarn/')) return 'yarn';
  return 'npm';
}

export function formatScriptCommand(
  scriptName: string,
  runner = detectPackageManagerCommand(),
): string {
  if (runner === 'yarn') {
    return scriptName === 'test' ? 'yarn test' : `yarn ${scriptName}`;
  }
  if (runner === 'pnpm') {
    return scriptName === 'test' ? 'pnpm test' : `pnpm ${scriptName}`;
  }
  return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
}

export function formatAelExecCommand(
  command: string,
  suffix = '',
  runner = detectPackageManagerCommand(),
): string {
  if (runner === 'yarn') {
    return `yarn ael ${command}${suffix}`;
  }
  if (runner === 'pnpm') {
    return `pnpm exec ael ${command}${suffix}`;
  }
  return `npx ael ${command}${suffix}`;
}

export function readWorkspacePackageJson(cwd = process.cwd()): Record<string, unknown> | undefined {
  const packageJsonPath = resolve(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function preferredWorkflowCommand(
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
  if (manifest) {
    return formatAelExecCommand(command, suffix, runner);
  }
  return `ael ${command}${suffix}`;
}

export function getPackageScriptCommand(
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

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function inspectConfig(): ConfigInspectionResult {
  return inspectConfigAtPath(CONFIG_PATH, { legacyMigrationWarning: CONFIG_LEGACY_WARNING });
}

export function loadConfig(): AgentExecutionConfig {
  try {
    return loadConfigFromPath(CONFIG_PATH, { legacyMigrationWarning: CONFIG_LEGACY_WARNING });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function saveConfig(config: AgentExecutionConfig, configPath = CONFIG_PATH): void {
  saveConfigToPath(configPath, config);
}

export function parseArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

export function parseOptionalIntArg(args: string[], flag: string): number | undefined {
  const raw = parseArgValue(args, flag);
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) fail(`invalid ${flag} "${raw}".`);
  return value;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function getConfiguredAgents(config: AgentExecutionConfig): AgentDefinition[] {
  return config.agents;
}

export function getDefaultAgentKey(config: AgentExecutionConfig): AgentKey {
  return config.defaultAgent || config.agents[0]?.key || DEFAULT_AGENT_DEFINITIONS[0].key;
}

export function getAgentDefinition(config: AgentExecutionConfig, key: AgentKey): AgentDefinition {
  const normalizedKey = normalizeAgentKey(key);
  const match = config.agents.find((agent) => agent.key === normalizedKey);
  if (match) return match;
  fail(
    `unsupported --agent "${key}". Use one of: ${config.agents.map((agent) => agent.key).join(', ')}.`,
  );
}

export function getAgentTag(config: AgentExecutionConfig, key: AgentKey): string {
  return getAgentDefinition(config, key).tag;
}

export function getAgentDefaultAssignee(config: AgentExecutionConfig, key: AgentKey): string {
  return getAgentDefinition(config, key).defaultAssignee;
}

export function normalizeAgent(
  config: AgentExecutionConfig,
  value: string | undefined,
  fallback?: AgentKey,
): AgentKey {
  if (!value) {
    if (fallback) return fallback;
    fail(`missing --agent. Use one of: ${config.agents.map((agent) => agent.key).join(', ')}.`);
  }
  const normalized = normalizeAgentKey(value);
  if (config.agents.some((agent) => agent.key === normalized)) {
    return normalized;
  }
  fail(
    `unsupported --agent "${value}". Use one of: ${config.agents.map((agent) => agent.key).join(', ')}.`,
  );
}

export function resolveCommandInvocation(
  args: string[],
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const override = resolveCommandOverride(args, platform, env);
  if (override) return override;

  if (platform === 'win32' && WINDOWS_SHELL_COMMANDS.has(args[0]?.toLowerCase() ?? '')) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', ...args.map(escapeWindowsShellArg)],
    };
  }
  return {
    command: args[0],
    args: args.slice(1),
  };
}

function escapeWindowsShellArg(arg: string): string {
  return arg.replaceAll(/[()%!^&|]/g, (match) => `^${match}`);
}

function resolveCommandOverride(
  args: string[],
  platform: string,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | undefined {
  const rawCommand = args[0]?.trim();
  if (!rawCommand) return undefined;

  const override = env[`AEL_CMD_${rawCommand.toUpperCase()}`]?.trim();
  if (!override) return undefined;

  if (/\.(?:[cm]?js)$/i.test(override)) {
    return {
      command: process.execPath,
      args: [override, ...args.slice(1)],
    };
  }

  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(override)) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', override, ...args.slice(1).map(escapeWindowsShellArg)],
    };
  }

  return {
    command: override,
    args: args.slice(1),
  };
}

export function runCommand(args: string[]): CommandResult {
  const env = buildCommandEnv();
  try {
    const invocation = resolveCommandInvocation(args, resolveExecutionPlatform(env), env);
    const stdout = execFileSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
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

export function shell(args: string[]): string {
  const result = runCommand(args);
  if (result.ok) return result.stdout;
  const msg = [result.stdout, result.stderr, result.message ?? 'command failed']
    .filter(Boolean)
    .join('\n');
  fail(msg);
}

export function azJson(config: AgentExecutionConfig, args: string[]): unknown {
  const output = shell(['az', ...args, '--org', config.organizationUrl, '-o', 'json']);
  if (!output) return {};
  return JSON.parse(output);
}

export function execJsonOrEmpty(args: string[]): unknown {
  const output = shell(args);
  return output ? JSON.parse(output) : {};
}

export function parseJsonResult<T>(result: CommandResult): T | undefined {
  if (!result.ok) return undefined;
  if (!result.stdout) return {} as T;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

export function appendMultilineArg(args: string[], flag: string, value: string): void {
  const lines = value.split('\n');
  args.push(flag, ...lines);
}

export function getConfiguredPat(): string | undefined {
  for (const variable of ['AEL_ADO_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT']) {
    const value = process.env[variable]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function usesPatAuth(): boolean {
  return Boolean(getConfiguredPat());
}

export function buildCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pat = getConfiguredPat();
  if (pat && !env.AZURE_DEVOPS_EXT_PAT) {
    env.AZURE_DEVOPS_EXT_PAT = pat;
  }
  return env;
}

export function getDevOpsAccessToken(): string {
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

export function getDevOpsAuthorizationHeader(): string {
  const pat = getConfiguredPat();
  if (pat) {
    return `Authorization: Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  }
  return `Authorization: Bearer ${getDevOpsAccessToken()}`;
}

export function devopsRestJson(
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
    getDevOpsAuthorizationHeader(),
    '-H',
    `Content-Type: ${contentType}`,
  ];
  if (body !== undefined) args.push('--data', body);
  args.push(url);
  const output = shell(args);
  return output ? JSON.parse(output) : {};
}

export function replaceWorkItemTagsExact(
  config: AgentExecutionConfig,
  id: number,
  tags: string[],
): void {
  azJson(config, [
    'boards',
    'work-item',
    'update',
    '--id',
    String(id),
    '--fields',
    `System.Tags=${tags.join(';')}`,
  ]);
}

export function ensureModeEnabled(
  config: AgentExecutionConfig,
  args: string[],
  command: string,
): void {
  if (config.enabled || hasFlag(args, '--force')) return;
  fail(
    `mode is disabled in ${CONFIG_PATH}. Enable first: ${preferredWorkflowCommand('enable')} (or pass --force for one-off ${command}).`,
  );
}

export function escapedWiql(value: string): string {
  return value.replace(/'/g, "''");
}

export function parseTagList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function parseListArg(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n|;/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function parsePriority(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 4) {
    fail(`invalid --priority "${raw}". Use 1..4.`);
  }
  return value;
}

export function normalizeTag(tag: string): string {
  const lower = tag.trim().toLowerCase();
  if (!lower) return '';
  const compact = lower.replace(/\s+/g, '-').replace(/_/g, '-').replace(/-+/g, '-');
  if (compact.startsWith('agent:')) return compact;
  return TAG_ALIAS_MAP[compact] ?? compact;
}

export function uniqueTags(tags: string[]): string[] {
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

export function normalizeTags(tags: string[]): string[] {
  return uniqueTags(tags.map(normalizeTag).filter(Boolean));
}

export function parseIdListArg(raw: string | undefined): number[] {
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

export function slugify(value: string, maxLength = 48): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return (slug || 'work-item').slice(0, maxLength).replace(/-+$/g, '');
}

export function currentBranchName(): string {
  return shell(['git', 'branch', '--show-current']);
}

export function configuredAgentKeys(config: AgentExecutionConfig): string[] {
  return getConfiguredAgents(config).map((agent) => agent.key);
}

export function configuredAgentTags(config: AgentExecutionConfig): string[] {
  return getConfiguredAgents(config).map((agent) => agent.tag);
}

export function resolveBaseBranch(config: AgentExecutionConfig, args: string[]): string {
  return parseArgValue(args, '--base') ?? config.defaultBranch;
}

export function resolveTargetBranch(config: AgentExecutionConfig, args: string[]): string {
  return parseArgValue(args, '--target-branch') ?? config.defaultBranch;
}

export function serializeWorkItemFieldValue(value: WorkItemFieldValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export function mergeFieldDefaults(
  defaults: Record<string, WorkItemFieldValue>,
  overrides: Record<string, WorkItemFieldValue | undefined> = {},
): Record<string, WorkItemFieldValue> {
  const merged: Record<string, WorkItemFieldValue> = {};
  for (const [key, value] of Object.entries(defaults)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    merged[normalizedKey] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || value === undefined) continue;
    merged[normalizedKey] = value;
  }
  return merged;
}

export function buildFieldPairs(fields: Record<string, WorkItemFieldValue>): string[] {
  return Object.entries(fields).map(
    ([key, value]) => `${key}=${serializeWorkItemFieldValue(value)}`,
  );
}

export function detectGitRepoRoot(): string | undefined {
  const result = runCommand(['git', 'rev-parse', '--show-toplevel']);
  return result.ok ? result.stdout : undefined;
}

export function detectOriginRemoteUrl(): string | undefined {
  const result = runCommand(['git', 'remote', 'get-url', 'origin']);
  return result.ok ? result.stdout : undefined;
}

export function detectOriginDefaultBranch(): string | undefined {
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

export function getAzureIdentity(): AzureIdentity | undefined {
  if (usesPatAuth()) {
    return undefined;
  }
  const result = runCommand(['az', 'account', 'show', '-o', 'json']);
  const parsed = parseJsonResult<{
    user?: { name?: string };
    tenantId?: string;
    id?: string;
  }>(result);
  if (!parsed) {
    return undefined;
  }
  return {
    userName: String(parsed.user?.name ?? ''),
    tenantId: String(parsed.tenantId ?? ''),
    subscriptionId: String(parsed.id ?? ''),
  };
}

export function resolveRepositoryId(
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

export function summarizeCommandFailure(result: CommandResult): string {
  return result.stderr || result.stdout || result.message || `exit code ${result.code}`;
}

export function printCheck(label: string, ok: boolean, detail: string): void {
  console.log(`- ${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
}

function resolveExecutionPlatform(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.Platform {
  const configured = normalizeRuntimePlatform(
    env.AEL_PLATFORM?.trim() || readRuntimePlatformFromPath(CONFIG_PATH),
  );
  if (configured === 'windows') return 'win32';
  if (configured === 'mac') return 'darwin';
  if (configured === 'linux') return 'linux';
  return process.platform;
}

function normalizeRuntimePlatform(value: string | RuntimePlatform | undefined): RuntimePlatform {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'windows' || normalized === 'mac' || normalized === 'linux') {
    return normalized;
  }
  return 'auto';
}
