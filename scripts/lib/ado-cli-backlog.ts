import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS_FILENAME } from './config.js';
import {
  CONFIG_DISCOVERY,
  detectPackageManagerCommand,
  fail,
  formatScriptCommand,
  inspectConfig,
  isRecord,
  preferredWorkflowCommand,
  printJson,
  readWorkspacePackageJson,
  wantsJson,
} from './ado-cli-runtime.js';

type BacklogPromptKind = 'backlogCreate' | 'backlogPolish';

interface BacklogSettings {
  schemaVersion: number;
  promptTemplates: Record<BacklogPromptKind, string>;
}

interface BacklogPromptPayload {
  ok: boolean;
  command: 'backlog-create' | 'backlog-polish';
  templateKey: BacklogPromptKind;
  settingsPath: string;
  settingsSource: 'workspace' | 'template';
  warnings: string[];
  prompt: string;
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

function parseBacklogSettings(raw: unknown, source: string): BacklogSettings {
  if (!isRecord(raw)) {
    throw new Error(`${source} must contain a JSON object.`);
  }
  const templates = isRecord(raw.promptTemplates) ? raw.promptTemplates : {};
  const backlogCreate = typeof templates.backlogCreate === 'string' ? templates.backlogCreate : '';
  const backlogPolish = typeof templates.backlogPolish === 'string' ? templates.backlogPolish : '';
  if (!backlogCreate.trim() || !backlogPolish.trim()) {
    throw new Error(
      `${source} must define non-empty promptTemplates.backlogCreate and promptTemplates.backlogPolish strings.`,
    );
  }
  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    promptTemplates: {
      backlogCreate,
      backlogPolish,
    },
  };
}

function loadTemplateSettings(): BacklogSettings {
  try {
    const parsed = JSON.parse(readFileSync(DEFAULT_SETTINGS_TEMPLATE_PATH, 'utf8')) as unknown;
    return parseBacklogSettings(parsed, DEFAULT_SETTINGS_TEMPLATE_PATH);
  } catch (error) {
    fail(
      `unable to read default backlog settings from ${DEFAULT_SETTINGS_TEMPLATE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function loadBacklogSettings(): {
  settings: BacklogSettings;
  settingsPath: string;
  settingsSource: 'workspace' | 'template';
  warnings: string[];
} {
  const settingsPath = resolve(process.cwd(), DEFAULT_SETTINGS_FILENAME);
  const warnings: string[] = [];
  const defaultSettings = loadTemplateSettings();
  if (!existsSync(settingsPath)) {
    warnings.push(
      `missing ${settingsPath}; using bundled backlog prompt defaults from ${DEFAULT_SETTINGS_TEMPLATE_PATH}.`,
    );
    return {
      settings: defaultSettings,
      settingsPath,
      settingsSource: 'template',
      warnings,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
    return {
      settings: parseBacklogSettings(parsed, settingsPath),
      settingsPath,
      settingsSource: 'workspace',
      warnings,
    };
  } catch (error) {
    warnings.push(
      `unable to read ${settingsPath}; using bundled backlog prompt defaults instead (${error instanceof Error ? error.message : String(error)}).`,
    );
    return {
      settings: defaultSettings,
      settingsPath,
      settingsSource: 'template',
      warnings,
    };
  }
}

function buildPromptContext(): Record<string, string> {
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
    HELP_COMMAND: helpCommand,
  };
}

function renderPromptTemplate(template: string, context: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(context)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

function emitPrompt(
  command: 'backlog-create' | 'backlog-polish',
  kind: BacklogPromptKind,
  args: string[],
): void {
  const { settings, settingsPath, settingsSource, warnings } = loadBacklogSettings();
  const prompt = renderPromptTemplate(settings.promptTemplates[kind], buildPromptContext());
  const payload: BacklogPromptPayload = {
    ok: true,
    command,
    templateKey: kind,
    settingsPath,
    settingsSource,
    warnings,
    prompt,
  };

  if (wantsJson(args)) {
    printJson(payload);
    return;
  }

  console.log(`=== AEL ${command.toUpperCase()} PROMPT ===`);
  console.log(`settings: ${settingsPath} (${settingsSource})`);
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
  console.log('');
  console.log(prompt);
  console.log('');
  console.log(`Edit ${settingsPath} to customize this prompt.`);
}

export function commandBacklogCreate(args: string[]): void {
  emitPrompt('backlog-create', 'backlogCreate', args);
}

export function commandBacklogPolish(args: string[]): void {
  emitPrompt('backlog-polish', 'backlogPolish', args);
}
