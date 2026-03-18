import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestrationMode, OrchestrationRole, RunGranularityMode } from '../ado-cli-types.js';
import { DEFAULT_SETTINGS_FILENAME } from '../config.js';
import {
  CONFIG_DISCOVERY,
  detectPackageManagerCommand,
  fail,
  formatScriptCommand,
  inspectConfig,
  isRecord,
  preferredWorkflowCommand,
  readWorkspacePackageJson,
} from '../ado-cli-runtime.js';

type PromptTemplateKey =
  | 'backlogCreate'
  | 'backlogPolish'
  | 'orchestratorMaster'
  | 'orchestratorChild'
  | 'orchestratorFinalize';

export interface OrchestrationSettings {
  defaults: {
    maxParallelChildren: number;
    childSizeThreshold: number;
    prGranularityHeuristic: 'shared-area-tags';
    createValidationChild: boolean;
    createResearchChildOnKeywords: boolean;
    researchKeywords: string[];
  };
  roles: Record<OrchestrationRole, string>;
  tags: {
    orchestrated: string;
    orchestratorPrefix: string;
    runPrefix: string;
    rolePrefix: string;
    modePrefix: string;
    awaitingReview: string;
  };
  approvals: {
    maxChildrenBeforeApproval: number;
    requireApprovalForGroupedPr: boolean;
    requireApprovalForStop: boolean;
  };
  checkinPolicy: {
    requireSummaryOnDone: boolean;
    requireSummaryOnBlocked: boolean;
    requireSummaryOnFailed: boolean;
  };
}

export interface AelSettings {
  schemaVersion: number;
  promptTemplates: Record<PromptTemplateKey, string>;
  orchestration: OrchestrationSettings;
}

export interface LoadedAelSettings {
  settings: AelSettings;
  settingsPath: string;
  settingsSource: 'workspace' | 'template';
  warnings: string[];
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = findPackageRoot(MODULE_DIR);
const DEFAULT_SETTINGS_TEMPLATE_PATH = join(
  PACKAGE_ROOT,
  'templates',
  'downstream',
  'settings.json',
);

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

function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(override)) {
    return override;
  }
  if (isRecord(base) && isRecord(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged;
  }
  return override ?? base;
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed;
}

function requireString(value: unknown, path: string, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function requireBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function requirePositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function requireStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

function parseSettings(raw: Record<string, unknown>, source: string): AelSettings {
  const promptTemplates = isRecord(raw.promptTemplates) ? raw.promptTemplates : {};
  const orchestration = isRecord(raw.orchestration) ? raw.orchestration : {};
  const orchestrationDefaults = isRecord(orchestration.defaults) ? orchestration.defaults : {};
  const orchestrationRoles = isRecord(orchestration.roles) ? orchestration.roles : {};
  const orchestrationTags = isRecord(orchestration.tags) ? orchestration.tags : {};
  const orchestrationApprovals = isRecord(orchestration.approvals) ? orchestration.approvals : {};
  const orchestrationCheckinPolicy = isRecord(orchestration.checkinPolicy)
    ? orchestration.checkinPolicy
    : {};

  const result: AelSettings = {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    promptTemplates: {
      backlogCreate: requireString(
        promptTemplates.backlogCreate,
        `${source}.promptTemplates.backlogCreate`,
      ),
      backlogPolish: requireString(
        promptTemplates.backlogPolish,
        `${source}.promptTemplates.backlogPolish`,
      ),
      orchestratorMaster: requireString(
        promptTemplates.orchestratorMaster,
        `${source}.promptTemplates.orchestratorMaster`,
      ),
      orchestratorChild: requireString(
        promptTemplates.orchestratorChild,
        `${source}.promptTemplates.orchestratorChild`,
      ),
      orchestratorFinalize: requireString(
        promptTemplates.orchestratorFinalize,
        `${source}.promptTemplates.orchestratorFinalize`,
      ),
    },
    orchestration: {
      defaults: {
        maxParallelChildren: requirePositiveInt(orchestrationDefaults.maxParallelChildren, 3),
        childSizeThreshold: requirePositiveInt(orchestrationDefaults.childSizeThreshold, 80),
        prGranularityHeuristic:
          orchestrationDefaults.prGranularityHeuristic === 'shared-area-tags'
            ? 'shared-area-tags'
            : 'shared-area-tags',
        createValidationChild: requireBoolean(orchestrationDefaults.createValidationChild, true),
        createResearchChildOnKeywords: requireBoolean(
          orchestrationDefaults.createResearchChildOnKeywords,
          true,
        ),
        researchKeywords: requireStringArray(orchestrationDefaults.researchKeywords, [
          'research',
          'spike',
          'investigate',
          'analyze',
          'audit',
          'explore',
        ]),
      },
      roles: {
        research: requireString(
          orchestrationRoles.research,
          `${source}.orchestration.roles.research`,
        ),
        implement: requireString(
          orchestrationRoles.implement,
          `${source}.orchestration.roles.implement`,
        ),
        validate: requireString(
          orchestrationRoles.validate,
          `${source}.orchestration.roles.validate`,
        ),
        integration: requireString(
          orchestrationRoles.integration,
          `${source}.orchestration.roles.integration`,
        ),
      },
      tags: {
        orchestrated: requireString(
          orchestrationTags.orchestrated,
          `${source}.orchestration.tags.orchestrated`,
          'orchestrated',
        ),
        orchestratorPrefix: requireString(
          orchestrationTags.orchestratorPrefix,
          `${source}.orchestration.tags.orchestratorPrefix`,
          'orchestrator:',
        ),
        runPrefix: requireString(
          orchestrationTags.runPrefix,
          `${source}.orchestration.tags.runPrefix`,
          'orchestration-run:',
        ),
        rolePrefix: requireString(
          orchestrationTags.rolePrefix,
          `${source}.orchestration.tags.rolePrefix`,
          'orchestration-role:',
        ),
        modePrefix: requireString(
          orchestrationTags.modePrefix,
          `${source}.orchestration.tags.modePrefix`,
          'orchestration-mode:',
        ),
        awaitingReview: requireString(
          orchestrationTags.awaitingReview,
          `${source}.orchestration.tags.awaitingReview`,
          'awaiting-orchestrator-review',
        ),
      },
      approvals: {
        maxChildrenBeforeApproval: requirePositiveInt(
          orchestrationApprovals.maxChildrenBeforeApproval,
          6,
        ),
        requireApprovalForGroupedPr: requireBoolean(
          orchestrationApprovals.requireApprovalForGroupedPr,
          false,
        ),
        requireApprovalForStop: requireBoolean(
          orchestrationApprovals.requireApprovalForStop,
          false,
        ),
      },
      checkinPolicy: {
        requireSummaryOnDone: requireBoolean(orchestrationCheckinPolicy.requireSummaryOnDone, true),
        requireSummaryOnBlocked: requireBoolean(
          orchestrationCheckinPolicy.requireSummaryOnBlocked,
          true,
        ),
        requireSummaryOnFailed: requireBoolean(
          orchestrationCheckinPolicy.requireSummaryOnFailed,
          true,
        ),
      },
    },
  };

  for (const [key, value] of Object.entries(result.promptTemplates)) {
    if (!value.trim()) {
      throw new Error(`${source} must define a non-empty promptTemplates.${key} string.`);
    }
  }
  return result;
}

function loadTemplateSettings(): AelSettings {
  try {
    return parseSettings(
      readJsonObject(DEFAULT_SETTINGS_TEMPLATE_PATH),
      DEFAULT_SETTINGS_TEMPLATE_PATH,
    );
  } catch (error) {
    fail(
      `unable to read default AEL settings from ${DEFAULT_SETTINGS_TEMPLATE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function loadAelSettings(): LoadedAelSettings {
  const settingsPath = resolve(process.cwd(), DEFAULT_SETTINGS_FILENAME);
  const warnings: string[] = [];
  const templateSettings = loadTemplateSettings();
  if (!existsSync(settingsPath)) {
    warnings.push(
      `missing ${settingsPath}; using bundled defaults from ${DEFAULT_SETTINGS_TEMPLATE_PATH}.`,
    );
    return {
      settings: templateSettings,
      settingsPath,
      settingsSource: 'template',
      warnings,
    };
  }

  try {
    const merged = deepMerge(
      readJsonObject(DEFAULT_SETTINGS_TEMPLATE_PATH),
      readJsonObject(settingsPath),
    ) as Record<string, unknown>;
    return {
      settings: parseSettings(merged, settingsPath),
      settingsPath,
      settingsSource: 'workspace',
      warnings,
    };
  } catch (error) {
    warnings.push(
      `unable to read ${settingsPath}; using bundled defaults instead (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
    return {
      settings: templateSettings,
      settingsPath,
      settingsSource: 'template',
      warnings,
    };
  }
}

export function renderPromptTemplate(template: string, context: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(context)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

export function buildCommonPromptContext(): Record<string, string> {
  const packageJson = readWorkspacePackageJson();
  const inspection = inspectConfig();
  const config = inspection.config;
  const repositoryName =
    typeof packageJson?.name === 'string' && packageJson.name.trim()
      ? packageJson.name.trim()
      : basename(process.cwd());
  const runner = detectPackageManagerCommand();
  const helpCommand =
    packageJson &&
    isRecord(packageJson.scripts) &&
    typeof packageJson.scripts['ael:help'] === 'string'
      ? formatScriptCommand('ael:help', runner)
      : preferredWorkflowCommand('status').replace(/\sstatus(?:\s.*)?$/, '');

  return {
    REPOSITORY_NAME: repositoryName,
    ORGANIZATION_URL: config?.organizationUrl ?? '(configure with ael init)',
    PROJECT_NAME: config?.project ?? repositoryName,
    DEFAULT_BRANCH: config?.defaultBranch ?? 'main',
    DEFAULT_AGENT_KEY: config?.defaultAgent ?? 'codex',
    DEFAULT_WORK_ITEM_TYPE: config?.defaultWorkItemType ?? 'Task',
    SHARED_TAGS: config?.sharedTags?.join(', ') || '(none configured)',
    AEL_AGENT_GUIDE_PATH: '.ael/agent-guide.md',
    AEL_PROJECT_CONTRACT_PATH: '.ael/project-contract.md',
    AEL_SETTINGS_PATH: DEFAULT_SETTINGS_FILENAME,
    AEL_CONFIG_PATH: CONFIG_DISCOVERY.preferredPath,
    WORKFLOW_STATUS_COMMAND: preferredWorkflowCommand('status'),
    WORKFLOW_DOCTOR_COMMAND: preferredWorkflowCommand('doctor'),
    WORKFLOW_REPORT_COMMAND: preferredWorkflowCommand('report'),
    WORKFLOW_AUDIT_COMMAND: preferredWorkflowCommand('audit', ' -- --state open --limit 100'),
    WORKFLOW_LIST_OPEN_COMMAND: preferredWorkflowCommand('list', ' -- --state open --limit 100'),
    WORKFLOW_CREATE_COMMAND: preferredWorkflowCommand(
      'create',
      ' -- --title "<title>" --human-summary "<goal>" --agent-context "<technical context>"',
    ),
    WORKFLOW_PRIORITIZE_COMMAND: preferredWorkflowCommand(
      'prioritize',
      ' -- --id <id> --priority <1-4>',
    ),
    WORKFLOW_RETAG_COMMAND: preferredWorkflowCommand('retag', ' -- --id <id> --tags "<tag1;tag2>"'),
    WORKFLOW_LINK_COMMAND: preferredWorkflowCommand(
      'link',
      ' -- --id <id> --depends-on "<id;id>" --related "<id;id>"',
    ),
    WORKFLOW_ORCHESTRATE_COMMAND: preferredWorkflowCommand('orchestrate', ' -- --ids "<id;id;id>"'),
    WORKFLOW_ORCHESTRATE_STATUS_COMMAND: preferredWorkflowCommand(
      'orchestrate-status',
      ' -- --run <run-id>',
    ),
    WORKFLOW_ORCHESTRATE_SYNC_COMMAND: preferredWorkflowCommand(
      'orchestrate-sync',
      ' -- --run <run-id>',
    ),
    WORKFLOW_ORCHESTRATE_FINALIZE_COMMAND: preferredWorkflowCommand(
      'orchestrate-finalize',
      ' -- --run <run-id>',
    ),
    WORKFLOW_ORCHESTRATE_STOP_COMMAND: preferredWorkflowCommand(
      'orchestrate-stop',
      ' -- --run <run-id>',
    ),
    WORKFLOW_SUBAGENT_CHECKIN_COMMAND: preferredWorkflowCommand(
      'subagent-checkin',
      ' -- --run <run-id> --child <child-id> --status <started|done|blocked|failed>',
    ),
    HELP_COMMAND: helpCommand,
  };
}
