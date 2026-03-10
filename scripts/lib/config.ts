import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ReviewerMode = 'off' | 'assigned';
export type PullRequestTagMode = 'non-agent' | 'all';
export type WorkItemFieldValue = string | number | boolean;

export interface AgentExecutionConfig {
  configVersion: number;
  enabled: boolean;
  organizationUrl: string;
  project: string;
  repositoryId: string;
  defaultBranch: string;
  defaultAgent: string;
  defaultWorkItemType: string;
  defaultAreaPath: string;
  defaultIterationPath: string;
  workItemFieldDefaults: {
    create: Record<string, WorkItemFieldValue>;
    done: Record<string, WorkItemFieldValue>;
  };
  sharedTags: string[];
  agents: AgentDefinition[];
  stateMap: {
    new: string;
    active: string;
    done: string;
  };
  prDefaults: {
    reviewerMode: ReviewerMode;
    reviewerRequired: boolean;
    syncWorkItemTags: boolean;
    syncTagMode: PullRequestTagMode;
  };
  reportDefaults: {
    staleDays: number;
    recentDays: number;
  };
}

export interface AgentDefinition {
  key: string;
  tag: string;
  branchPrefix: string;
  defaultAssignee: string;
}

export interface ConfigInspectionResult {
  config?: AgentExecutionConfig;
  errors: string[];
  warnings: string[];
}

export interface ConfigPathDiscovery {
  path: string;
  preferredPath: string;
  source: 'env' | 'local' | 'legacy';
  preferredSource: 'env' | 'local';
  usedLegacyFallback: boolean;
}

export interface InspectConfigOptions {
  legacyMigrationWarning?: string;
}

export const DEFAULT_CONFIG_FILENAME = 'agent-execution.config.local.json';
export const LEGACY_CONFIG_FILENAME = 'agent-execution.config.json';

export const DEFAULT_PR_DEFAULTS = {
  reviewerMode: 'off' as ReviewerMode,
  reviewerRequired: false,
  syncWorkItemTags: true,
  syncTagMode: 'non-agent' as PullRequestTagMode,
};

export const DEFAULT_CONFIG_VERSION = 3;

export const DEFAULT_AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    key: 'codex',
    tag: 'agent:codex',
    branchPrefix: 'codex',
    defaultAssignee: '',
  },
  {
    key: 'claude',
    tag: 'agent:claude',
    branchPrefix: 'claude',
    defaultAssignee: '',
  },
];

export const DEFAULT_REPORT_DEFAULTS = {
  staleDays: 7,
  recentDays: 7,
};

const CONFIG_TOP_LEVEL_KEYS = new Set([
  'configVersion',
  'enabled',
  'organizationUrl',
  'project',
  'repositoryId',
  'defaultBranch',
  'defaultAgent',
  'defaultWorkItemType',
  'defaultAreaPath',
  'defaultIterationPath',
  'workItemFieldDefaults',
  'sharedTags',
  'agents',
  'agentTags',
  'defaultAssignees',
  'stateMap',
  'prDefaults',
  'reportDefaults',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeAgentKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function normalizeAgentDefinitions(raw: Record<string, unknown>): AgentDefinition[] {
  const configuredAgents = raw.agents;
  if (Array.isArray(configuredAgents) && configuredAgents.length > 0) {
    return configuredAgents
      .filter(isRecord)
      .map((entry) => {
        const key = normalizeAgentKey(typeof entry.key === 'string' ? entry.key : undefined);
        return {
          key,
          tag: String(entry.tag ?? `agent:${key}`),
          branchPrefix: String(entry.branchPrefix ?? key),
          defaultAssignee: String(entry.defaultAssignee ?? ''),
        };
      })
      .filter((agent) => agent.key.length > 0);
  }

  const legacyAgentTags = isRecord(raw.agentTags)
    ? Object.fromEntries(
        Object.entries(raw.agentTags).map(([key, value]) => [normalizeAgentKey(key), value]),
      )
    : {};
  const legacyAssignees = isRecord(raw.defaultAssignees)
    ? Object.fromEntries(
        Object.entries(raw.defaultAssignees).map(([key, value]) => [normalizeAgentKey(key), value]),
      )
    : {};
  const discoveredKeys = Array.from(
    new Set(
      [
        ...Object.keys(legacyAgentTags),
        ...Object.keys(legacyAssignees),
        ...DEFAULT_AGENT_DEFINITIONS.map((agent) => agent.key),
      ]
        .map(normalizeAgentKey)
        .filter(Boolean),
    ),
  );

  return discoveredKeys.map((key) => ({
    key,
    tag: String(legacyAgentTags[key] ?? `agent:${key}`),
    branchPrefix: key,
    defaultAssignee: String(legacyAssignees[key] ?? ''),
  }));
}

function normalizeConfig(raw: Record<string, unknown>): AgentExecutionConfig {
  const parsed = raw as Partial<AgentExecutionConfig>;
  const agents = normalizeAgentDefinitions(raw);
  const firstAgentKey = agents[0]?.key ?? DEFAULT_AGENT_DEFINITIONS[0].key;
  const defaultAgent =
    normalizeAgentKey(typeof raw.defaultAgent === 'string' ? raw.defaultAgent : undefined) ||
    firstAgentKey;
  return {
    configVersion: Number.isInteger(parsed.configVersion)
      ? Number(parsed.configVersion)
      : DEFAULT_CONFIG_VERSION,
    enabled: Boolean(parsed.enabled),
    organizationUrl: String(parsed.organizationUrl ?? ''),
    project: String(parsed.project ?? ''),
    repositoryId: String(parsed.repositoryId ?? ''),
    defaultBranch: String(parsed.defaultBranch ?? 'master'),
    defaultAgent,
    defaultWorkItemType: String(parsed.defaultWorkItemType ?? 'Task'),
    defaultAreaPath: String(parsed.defaultAreaPath ?? ''),
    defaultIterationPath: String(parsed.defaultIterationPath ?? ''),
    workItemFieldDefaults: {
      create: normalizeFieldDefaults(parsed.workItemFieldDefaults?.create),
      done: normalizeFieldDefaults(parsed.workItemFieldDefaults?.done),
    },
    sharedTags: Array.isArray(parsed.sharedTags) ? parsed.sharedTags.map(String) : [],
    agents,
    stateMap: {
      new: String(parsed.stateMap?.new ?? 'New'),
      active: String(parsed.stateMap?.active ?? 'Active'),
      done: String(parsed.stateMap?.done ?? 'Closed'),
    },
    prDefaults: {
      reviewerMode:
        parsed.prDefaults?.reviewerMode === 'assigned'
          ? 'assigned'
          : DEFAULT_PR_DEFAULTS.reviewerMode,
      reviewerRequired: parsed.prDefaults?.reviewerRequired ?? DEFAULT_PR_DEFAULTS.reviewerRequired,
      syncWorkItemTags: parsed.prDefaults?.syncWorkItemTags ?? DEFAULT_PR_DEFAULTS.syncWorkItemTags,
      syncTagMode:
        parsed.prDefaults?.syncTagMode === 'all' ? 'all' : DEFAULT_PR_DEFAULTS.syncTagMode,
    },
    reportDefaults: {
      staleDays: Number.isFinite(parsed.reportDefaults?.staleDays)
        ? Number(parsed.reportDefaults?.staleDays)
        : DEFAULT_REPORT_DEFAULTS.staleDays,
      recentDays: Number.isFinite(parsed.reportDefaults?.recentDays)
        ? Number(parsed.reportDefaults?.recentDays)
        : DEFAULT_REPORT_DEFAULTS.recentDays,
    },
  };
}

function normalizeFieldValue(value: unknown): WorkItemFieldValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function normalizeFieldDefaults(raw: unknown): Record<string, WorkItemFieldValue> {
  if (!isRecord(raw)) return {};
  const normalized: Record<string, WorkItemFieldValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = key.trim();
    const normalizedValue = normalizeFieldValue(value);
    if (!normalizedKey || normalizedValue === undefined) continue;
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
}

function validateRequiredString(
  root: Record<string, unknown>,
  field: string,
  errors: string[],
  placeholderValues: string[] = [],
): void {
  const value = root[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`"${field}" must be a non-empty string.`);
    return;
  }
  if (placeholderValues.includes(value.trim())) {
    errors.push(`"${field}" still uses the example placeholder "${value.trim()}".`);
  }
}

function validateStringArray(root: Record<string, unknown>, field: string, errors: string[]): void {
  const value = root[field];
  if (!Array.isArray(value)) {
    errors.push(`"${field}" must be an array of strings.`);
    return;
  }

  const invalidIndex = value.findIndex(
    (entry) => typeof entry !== 'string' || entry.trim().length === 0,
  );
  if (invalidIndex >= 0) {
    errors.push(`"${field}" item ${invalidIndex + 1} must be a non-empty string.`);
  }
}

function validateLegacyAgentMap(
  root: Record<string, unknown>,
  field: string,
  errors: string[],
  allowEmpty: boolean,
): string[] {
  const value = root[field];
  if (!isRecord(value)) {
    errors.push(`"${field}" must be an object keyed by agent name.`);
    return [];
  }

  const entries = Object.entries(value)
    .map(([key, entry]) => ({ key: normalizeAgentKey(key), entry }))
    .filter((entry) => Boolean(entry.key));
  const keys = entries.map((entry) => entry.key);
  if (keys.length === 0) {
    errors.push(`"${field}" must include at least one agent key.`);
    return [];
  }

  for (const { key, entry } of entries) {
    if (typeof entry !== 'string' || (!allowEmpty && entry.trim().length === 0)) {
      errors.push(`"${field}.${key}" must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
    }
  }

  return keys;
}

function validateAgents(root: Record<string, unknown>, errors: string[], warnings: string[]): void {
  const value = root.agents;
  if (Array.isArray(value) && value.length > 0) {
    const seenKeys = new Set<string>();
    const seenTags = new Set<string>();
    const seenBranchPrefixes = new Set<string>();

    value.forEach((entry, index) => {
      if (!isRecord(entry)) {
        errors.push(`"agents" item ${index + 1} must be an object.`);
        return;
      }

      const key = normalizeAgentKey(typeof entry.key === 'string' ? entry.key : undefined);
      if (!key) {
        errors.push(`"agents" item ${index + 1} must include a non-empty "key".`);
      } else if (seenKeys.has(key)) {
        errors.push(`"agents" contains duplicate key "${key}".`);
      } else {
        seenKeys.add(key);
      }

      const tag = typeof entry.tag === 'string' ? entry.tag.trim() : '';
      if (!tag) {
        errors.push(`"agents" item ${index + 1} must include a non-empty "tag".`);
      } else if (seenTags.has(tag.toLowerCase())) {
        errors.push(`"agents" contains duplicate tag "${tag}".`);
      } else {
        seenTags.add(tag.toLowerCase());
      }

      const branchPrefix = typeof entry.branchPrefix === 'string' ? entry.branchPrefix.trim() : '';
      if (!branchPrefix) {
        errors.push(`"agents" item ${index + 1} must include a non-empty "branchPrefix".`);
      } else if (seenBranchPrefixes.has(branchPrefix.toLowerCase())) {
        errors.push(`"agents" contains duplicate branchPrefix "${branchPrefix}".`);
      } else {
        seenBranchPrefixes.add(branchPrefix.toLowerCase());
      }

      if (entry.defaultAssignee !== undefined && typeof entry.defaultAssignee !== 'string') {
        errors.push(`"agents" item ${index + 1} field "defaultAssignee" must be a string.`);
      }

      const unknownKeys = Object.keys(entry).filter(
        (keyName) => !['key', 'tag', 'branchPrefix', 'defaultAssignee'].includes(keyName),
      );
      if (unknownKeys.length > 0) {
        warnings.push(
          `"agents" item ${index + 1} has unrecognized keys: ${unknownKeys.join(', ')}.`,
        );
      }
    });

    return;
  }

  const hasLegacyAgents = root.agentTags !== undefined || root.defaultAssignees !== undefined;
  if (!hasLegacyAgents) {
    errors.push('"agents" must be a non-empty array.');
    return;
  }

  warnings.push(
    'legacy "agentTags"/"defaultAssignees" config detected; re-run init to rewrite to "agents".',
  );
  const tagKeys = validateLegacyAgentMap(root, 'agentTags', errors, false);
  const assigneeKeys = validateLegacyAgentMap(root, 'defaultAssignees', errors, true);
  const allKeys = new Set([...tagKeys, ...assigneeKeys]);
  if (allKeys.size === 0) {
    errors.push('legacy agent config must define at least one agent.');
  }
}

function validateStateMap(
  root: Record<string, unknown>,
  errors: string[],
  warnings: string[],
): void {
  const value = root.stateMap;
  if (!isRecord(value)) {
    errors.push('"stateMap" must be an object with keys new, active, done.');
    return;
  }

  for (const key of ['new', 'active', 'done']) {
    const entry = value[key];
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      errors.push(`"stateMap.${key}" must be a non-empty string.`);
    }
  }

  const unknownKeys = Object.keys(value).filter((key) => !['new', 'active', 'done'].includes(key));
  if (unknownKeys.length > 0) {
    warnings.push(`"stateMap" has unrecognized keys: ${unknownKeys.join(', ')}.`);
  }
}

function validatePrDefaults(
  root: Record<string, unknown>,
  errors: string[],
  warnings: string[],
): void {
  const value = root.prDefaults;
  if (value === undefined) {
    warnings.push('"prDefaults" is missing; built-in PR defaults will be used.');
    return;
  }
  if (!isRecord(value)) {
    errors.push('"prDefaults" must be an object.');
    return;
  }

  if (
    value.reviewerMode !== undefined &&
    value.reviewerMode !== 'off' &&
    value.reviewerMode !== 'assigned'
  ) {
    errors.push('"prDefaults.reviewerMode" must be "off" or "assigned".');
  }
  if (value.reviewerRequired !== undefined && typeof value.reviewerRequired !== 'boolean') {
    errors.push('"prDefaults.reviewerRequired" must be a boolean.');
  }
  if (value.syncWorkItemTags !== undefined && typeof value.syncWorkItemTags !== 'boolean') {
    errors.push('"prDefaults.syncWorkItemTags" must be a boolean.');
  }
  if (
    value.syncTagMode !== undefined &&
    value.syncTagMode !== 'non-agent' &&
    value.syncTagMode !== 'all'
  ) {
    errors.push('"prDefaults.syncTagMode" must be "non-agent" or "all".');
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => !['reviewerMode', 'reviewerRequired', 'syncWorkItemTags', 'syncTagMode'].includes(key),
  );
  if (unknownKeys.length > 0) {
    warnings.push(`"prDefaults" has unrecognized keys: ${unknownKeys.join(', ')}.`);
  }
}

function validateFieldDefaultMap(
  value: unknown,
  field: string,
  errors: string[],
  warnings: string[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`"${field}" must be an object keyed by Azure DevOps field reference name.`);
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) {
      errors.push(`"${field}" contains an empty field name.`);
      continue;
    }
    if (!['string', 'number', 'boolean'].includes(typeof entry)) {
      errors.push(`"${field}.${key}" must be a string, number, or boolean.`);
    }
  }

  const unknownKeys = Object.keys(value).filter((key) => !key.trim());
  if (unknownKeys.length > 0) {
    warnings.push(`"${field}" has blank field keys that will be ignored.`);
  }
}

function validateWorkItemFieldDefaults(
  root: Record<string, unknown>,
  errors: string[],
  warnings: string[],
): void {
  const value = root.workItemFieldDefaults;
  if (value === undefined) {
    warnings.push(
      '"workItemFieldDefaults" is missing; no extra Azure DevOps fields will be written.',
    );
    return;
  }
  if (!isRecord(value)) {
    errors.push('"workItemFieldDefaults" must be an object.');
    return;
  }

  validateFieldDefaultMap(value.create, 'workItemFieldDefaults.create', errors, warnings);
  validateFieldDefaultMap(value.done, 'workItemFieldDefaults.done', errors, warnings);

  const unknownKeys = Object.keys(value).filter((key) => !['create', 'done'].includes(key));
  if (unknownKeys.length > 0) {
    warnings.push(`"workItemFieldDefaults" has unrecognized keys: ${unknownKeys.join(', ')}.`);
  }
}

function validateReportDefaults(
  root: Record<string, unknown>,
  errors: string[],
  warnings: string[],
): void {
  const value = root.reportDefaults;
  if (value === undefined) {
    warnings.push('"reportDefaults" is missing; built-in report defaults will be used.');
    return;
  }
  if (!isRecord(value)) {
    errors.push('"reportDefaults" must be an object.');
    return;
  }

  for (const key of ['staleDays', 'recentDays']) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (!Number.isInteger(entry) || Number(entry) <= 0) {
      errors.push(`"reportDefaults.${key}" must be a positive integer.`);
    }
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => !['staleDays', 'recentDays'].includes(key),
  );
  if (unknownKeys.length > 0) {
    warnings.push(`"reportDefaults" has unrecognized keys: ${unknownKeys.join(', ')}.`);
  }
}

export function discoverConfigPath(
  cwd = process.cwd(),
  envPath = process.env.AGENT_EXECUTION_CONFIG,
  fileExists: (path: string) => boolean = existsSync,
): ConfigPathDiscovery {
  if (envPath) {
    const path = resolve(cwd, envPath);
    return {
      path,
      preferredPath: path,
      source: 'env',
      preferredSource: 'env',
      usedLegacyFallback: false,
    };
  }

  const preferredPath = resolve(cwd, DEFAULT_CONFIG_FILENAME);
  if (fileExists(preferredPath)) {
    return {
      path: preferredPath,
      preferredPath,
      source: 'local',
      preferredSource: 'local',
      usedLegacyFallback: false,
    };
  }

  const legacyPath = resolve(cwd, LEGACY_CONFIG_FILENAME);
  if (fileExists(legacyPath)) {
    return {
      path: legacyPath,
      preferredPath,
      source: 'legacy',
      preferredSource: 'local',
      usedLegacyFallback: true,
    };
  }

  return {
    path: preferredPath,
    preferredPath,
    source: 'local',
    preferredSource: 'local',
    usedLegacyFallback: false,
  };
}

export function inspectConfigAtPath(
  configPath: string,
  options: InspectConfigOptions = {},
): ConfigInspectionResult {
  const warnings = options.legacyMigrationWarning ? [options.legacyMigrationWarning] : [];

  try {
    if (!existsSync(configPath)) {
      return {
        errors: [`missing ${configPath}. Run "ael init".`],
        warnings,
      };
    }

    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        errors: ['config root must be a JSON object.'],
        warnings,
      };
    }

    const errors: string[] = [];
    const unknownKeys = Object.keys(parsed).filter((key) => !CONFIG_TOP_LEVEL_KEYS.has(key));
    if (unknownKeys.length > 0) {
      warnings.push(`unrecognized top-level fields: ${unknownKeys.join(', ')}.`);
    }

    if (parsed.configVersion !== undefined) {
      if (!Number.isInteger(parsed.configVersion) || Number(parsed.configVersion) < 1) {
        errors.push('"configVersion" must be a positive integer.');
      } else if (Number(parsed.configVersion) !== DEFAULT_CONFIG_VERSION) {
        warnings.push(
          `"configVersion" is ${String(parsed.configVersion)}; current writer emits ${DEFAULT_CONFIG_VERSION}.`,
        );
      }
    }

    if (typeof parsed.enabled !== 'boolean') {
      errors.push('"enabled" must be a boolean.');
    }

    validateRequiredString(parsed, 'organizationUrl', errors, ['https://dev.azure.com/your-org']);
    const organizationUrl = parsed.organizationUrl;
    if (typeof organizationUrl === 'string' && organizationUrl.trim().length > 0) {
      try {
        const url = new URL(organizationUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
          errors.push('"organizationUrl" must use http or https.');
        }
      } catch {
        errors.push('"organizationUrl" must be a valid URL.');
      }
    }

    validateRequiredString(parsed, 'project', errors, ['your-project']);
    validateRequiredString(parsed, 'repositoryId', errors, ['your-repository-id']);
    if (parsed.defaultBranch === undefined) {
      warnings.push(
        '"defaultBranch" is missing; built-in branch fallback will be used until init rewrites the config.',
      );
    } else if (
      typeof parsed.defaultBranch !== 'string' ||
      parsed.defaultBranch.trim().length === 0
    ) {
      errors.push('"defaultBranch" must be a non-empty string.');
    }
    validateRequiredString(parsed, 'defaultWorkItemType', errors);
    validateRequiredString(parsed, 'defaultAreaPath', errors);
    validateRequiredString(parsed, 'defaultIterationPath', errors);
    validateWorkItemFieldDefaults(parsed, errors, warnings);
    validateStringArray(parsed, 'sharedTags', errors);
    validateAgents(parsed, errors, warnings);
    if (
      parsed.defaultAgent !== undefined &&
      (typeof parsed.defaultAgent !== 'string' || !parsed.defaultAgent.trim())
    ) {
      errors.push('"defaultAgent" must be a non-empty string.');
    }
    validateStateMap(parsed, errors, warnings);
    validatePrDefaults(parsed, errors, warnings);
    validateReportDefaults(parsed, errors, warnings);

    const normalized = normalizeConfig(parsed);
    if (normalized.agents.length === 0) {
      errors.push('config must define at least one agent.');
    }
    if (!normalized.agents.some((agent) => agent.key === normalized.defaultAgent)) {
      errors.push(
        `"defaultAgent" must match one of the configured agents. Found "${normalized.defaultAgent}".`,
      );
    }

    return {
      config: normalized,
      errors,
      warnings,
    };
  } catch (err) {
    return {
      errors: [`unable to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`],
      warnings,
    };
  }
}

export function loadConfigFromPath(
  configPath: string,
  options: InspectConfigOptions = {},
): AgentExecutionConfig {
  const inspection = inspectConfigAtPath(configPath, options);
  if (inspection.errors.length > 0 || !inspection.config) {
    const details = inspection.errors.map((message) => `- ${message}`).join('\n');
    throw new Error(
      `invalid config at ${configPath}:\n${details}\nRun "ael validate-config" for details.`,
    );
  }
  return inspection.config;
}

export function saveConfigToPath(configPath: string, config: AgentExecutionConfig): void {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
