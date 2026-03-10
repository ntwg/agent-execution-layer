import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstallScriptConflict, InstallSummary, UninstallSummary } from './ado-cli-types.js';
import {
  DEFAULT_AEL_GITIGNORE_FILENAME,
  DEFAULT_AGENT_GUIDE_FILENAME,
  DEFAULT_CONFIG_FILENAME,
  DEFAULT_INSTALL_MANIFEST_FILENAME,
  DEFAULT_PROJECT_CONTRACT_FILENAME,
  DEFAULT_SETTINGS_FILENAME,
} from './config.js';
import {
  detectPackageManagerCommand,
  ensureTrailingNewline,
  fail,
  formatAelExecCommand,
  formatScriptCommand,
  getPackageScriptCommand,
  hasFlag,
  isRecord,
  parseArgValue,
  printJson,
  uniqueStrings,
  wantsJson,
} from './ado-cli-runtime.js';

const AEL_WORKFLOW_MARKER_START = '<!-- AEL WORKFLOW START -->';
const AEL_WORKFLOW_MARKER_END = '<!-- AEL WORKFLOW END -->';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = findPackageRoot(MODULE_DIR);
const DOWNSTREAM_TEMPLATE_DIR = join(PACKAGE_ROOT, 'templates', 'downstream');

type InstallMode = 'minimal' | 'with-scripts';
type RootInstructionsMode = 'managed' | 'external';
type TemplateWriteStatus = 'created' | 'updated' | 'unchanged';
type RemovalStatus = 'removed' | 'updated' | 'unchanged';

interface InstallManifest {
  manifestVersion: number;
  mode: InstallMode;
  rootInstructions: {
    mode: RootInstructionsMode;
    path: string;
  };
  files: {
    gitignore: string;
    agentGuide: string;
    projectContract: string;
    config: string;
    settings: string;
  };
}

interface WorkspacePackageData {
  manifest: Record<string, unknown>;
  path?: string;
}

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

function loadDownstreamTemplate(name: string): string {
  return readFileSync(join(DOWNSTREAM_TEMPLATE_DIR, name), 'utf8');
}

function loadRecommendedPackageScripts(): Record<string, string> {
  const rawTemplate = JSON.parse(loadDownstreamTemplate('package-scripts.json')) as unknown;
  if (!isRecord(rawTemplate) || !isRecord(rawTemplate.scripts)) {
    fail('invalid downstream package-scripts template.');
  }
  return Object.fromEntries(
    Object.entries(rawTemplate.scripts).filter((entry): entry is [string, string] => {
      const [, value] = entry;
      return typeof value === 'string';
    }),
  );
}

function loadWorkspacePackageData(workspace: string): WorkspacePackageData {
  const packageJsonPath = join(workspace, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      manifest: {},
    };
  }
  const rawManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
  if (!isRecord(rawManifest)) {
    fail(`${packageJsonPath} must contain a JSON object.`);
  }
  return {
    manifest: rawManifest,
    path: packageJsonPath,
  };
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

function applyInstallTemplate(
  raw: string,
  context: {
    agentKey: string;
    repositoryName: string;
    defaultBranch?: string;
    buildCommand?: string;
    unitTestCommand?: string;
    integrationTestCommand?: string;
    lintCommand?: string;
    validationCommands: string[];
    workflowStatusCommand: string;
    workflowInitCommand: string;
    workflowDoctorCommand: string;
    workflowNextCommand: string;
    workflowStartCommand: string;
    workflowCommitCommand: string;
    workflowPrCommand: string;
    workflowDoneCommand: string;
    workflowAuditCommand: string;
    workflowReportCommand: string;
    workflowBacklogCreateCommand: string;
    workflowBacklogPolishCommand: string;
  },
): string {
  const validationBlock =
    context.validationCommands.length > 0
      ? context.validationCommands.map((command) => `- \`${command}\``).join('\n')
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
    .replaceAll('{{VALIDATION_COMMANDS}}', validationBlock)
    .replaceAll('{{WORKFLOW_STATUS_COMMAND}}', context.workflowStatusCommand)
    .replaceAll('{{WORKFLOW_INIT_COMMAND}}', context.workflowInitCommand)
    .replaceAll('{{WORKFLOW_DOCTOR_COMMAND}}', context.workflowDoctorCommand)
    .replaceAll('{{WORKFLOW_NEXT_COMMAND}}', context.workflowNextCommand)
    .replaceAll('{{WORKFLOW_START_COMMAND}}', context.workflowStartCommand)
    .replaceAll('{{WORKFLOW_COMMIT_COMMAND}}', context.workflowCommitCommand)
    .replaceAll('{{WORKFLOW_PR_COMMAND}}', context.workflowPrCommand)
    .replaceAll('{{WORKFLOW_DONE_COMMAND}}', context.workflowDoneCommand)
    .replaceAll('{{WORKFLOW_AUDIT_COMMAND}}', context.workflowAuditCommand)
    .replaceAll('{{WORKFLOW_REPORT_COMMAND}}', context.workflowReportCommand)
    .replaceAll('{{WORKFLOW_BACKLOG_CREATE_COMMAND}}', context.workflowBacklogCreateCommand)
    .replaceAll('{{WORKFLOW_BACKLOG_POLISH_COMMAND}}', context.workflowBacklogPolishCommand);
}

function normalizeAelWorkflowBlock(content: string): string {
  return ensureTrailingNewline(
    [AEL_WORKFLOW_MARKER_START, content.trim(), AEL_WORKFLOW_MARKER_END].join('\n'),
  );
}

function stripAelWorkflowBlock(content: string): { changed: boolean; content: string } {
  const pattern = new RegExp(
    `\\n?${AEL_WORKFLOW_MARKER_START}[\\s\\S]*?${AEL_WORKFLOW_MARKER_END}\\n?`,
    'm',
  );
  if (!pattern.test(content)) {
    return {
      changed: false,
      content,
    };
  }

  const withoutBlock = content
    .replace(pattern, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    changed: true,
    content: withoutBlock ? ensureTrailingNewline(withoutBlock) : '',
  };
}

function updateAgentsFile(
  entrypointPath: string,
  renderedTemplate: string,
  force: boolean,
  dryRun: boolean,
): { status: TemplateWriteStatus; path: string } {
  const block = normalizeAelWorkflowBlock(renderedTemplate);
  if (!existsSync(entrypointPath)) {
    if (!dryRun) {
      mkdirSync(dirname(entrypointPath), { recursive: true });
      writeFileSync(entrypointPath, block, 'utf8');
    }
    return { status: 'created', path: entrypointPath };
  }

  const current = readFileSync(entrypointPath, 'utf8');
  if (current.includes(AEL_WORKFLOW_MARKER_START) && current.includes(AEL_WORKFLOW_MARKER_END)) {
    if (!force) {
      return { status: 'unchanged', path: entrypointPath };
    }
    const pattern = new RegExp(
      `${AEL_WORKFLOW_MARKER_START}[\\s\\S]*?${AEL_WORKFLOW_MARKER_END}\\n?`,
      'm',
    );
    if (!dryRun) {
      writeFileSync(entrypointPath, ensureTrailingNewline(current.replace(pattern, block)), 'utf8');
    }
    return { status: 'updated', path: entrypointPath };
  }

  if (!dryRun) {
    mkdirSync(dirname(entrypointPath), { recursive: true });
    const separator = current.trim().length > 0 ? '\n\n' : '';
    writeFileSync(
      entrypointPath,
      ensureTrailingNewline(`${current.trimEnd()}${separator}${block}`),
      'utf8',
    );
  }
  return { status: 'updated', path: entrypointPath };
}

function resolveInstallMode(args: string[]): InstallMode {
  const wantsMinimal = hasFlag(args, '--minimal');
  const wantsScripts = hasFlag(args, '--with-scripts') || hasFlag(args, '--standard');
  if (wantsMinimal && wantsScripts) {
    fail('install accepts either --minimal or --with-scripts/--standard, not both.');
  }
  return wantsScripts ? 'with-scripts' : 'minimal';
}

function formatDownstreamWorkflowCommand(
  command: string,
  installMode: InstallMode,
  runner = detectPackageManagerCommand(),
  suffix = '',
  preferExecShim = true,
): string {
  if (installMode === 'with-scripts') {
    return `${formatScriptCommand(`ael:${command}`, runner)}${suffix}`;
  }
  if (!preferExecShim) {
    return `ael ${command}${suffix}`;
  }
  return formatAelExecCommand(command, suffix, runner);
}

function resolveEntrypointPath(
  workspace: string,
  rawPath: string | undefined,
): { absolutePath: string; relativePath: string } {
  const targetPath = rawPath?.trim() || 'AGENTS.md';
  if (!targetPath) {
    fail('install requires a non-empty --entrypoint-file path.');
  }
  const absolutePath = resolve(workspace, targetPath);
  const relativePath = relative(workspace, absolutePath).replaceAll('\\', '/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
    fail(`--entrypoint-file must stay inside ${workspace}.`);
  }
  return {
    absolutePath,
    relativePath,
  };
}

function renderInstallManifest(summary: {
  installMode: InstallMode;
  manageRootAgents: boolean;
  rootInstructionsPath: string;
}): string {
  return JSON.stringify(
    {
      manifestVersion: 1,
      mode: summary.installMode,
      rootInstructions: {
        mode: summary.manageRootAgents ? 'managed' : 'external',
        path: summary.rootInstructionsPath,
      },
      files: {
        gitignore: DEFAULT_AEL_GITIGNORE_FILENAME,
        agentGuide: DEFAULT_AGENT_GUIDE_FILENAME,
        projectContract: DEFAULT_PROJECT_CONTRACT_FILENAME,
        config: DEFAULT_CONFIG_FILENAME,
        settings: DEFAULT_SETTINGS_FILENAME,
      },
    },
    null,
    2,
  );
}

function writeTemplateFile(
  path: string,
  content: string,
  force: boolean,
  dryRun: boolean,
): { status: TemplateWriteStatus; path: string } {
  if (!existsSync(path)) {
    if (!dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ensureTrailingNewline(content), 'utf8');
    }
    return { status: 'created', path };
  }
  if (!force) {
    return { status: 'unchanged', path };
  }
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ensureTrailingNewline(content), 'utf8');
  }
  return { status: 'updated', path };
}

function readInstallManifest(path: string): InstallManifest | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const rawManifest = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(rawManifest)) {
      return undefined;
    }
    const rootInstructions = isRecord(rawManifest.rootInstructions)
      ? rawManifest.rootInstructions
      : {};
    const files = isRecord(rawManifest.files) ? rawManifest.files : {};
    return {
      manifestVersion:
        typeof rawManifest.manifestVersion === 'number' ? rawManifest.manifestVersion : 1,
      mode: rawManifest.mode === 'with-scripts' ? 'with-scripts' : 'minimal',
      rootInstructions: {
        mode: rootInstructions.mode === 'external' ? 'external' : 'managed',
        path:
          typeof rootInstructions.path === 'string' && rootInstructions.path.trim()
            ? rootInstructions.path.trim()
            : 'AGENTS.md',
      },
      files: {
        gitignore:
          typeof files.gitignore === 'string' && files.gitignore.trim()
            ? files.gitignore.trim()
            : DEFAULT_AEL_GITIGNORE_FILENAME,
        agentGuide:
          typeof files.agentGuide === 'string' && files.agentGuide.trim()
            ? files.agentGuide.trim()
            : DEFAULT_AGENT_GUIDE_FILENAME,
        projectContract:
          typeof files.projectContract === 'string' && files.projectContract.trim()
            ? files.projectContract.trim()
            : DEFAULT_PROJECT_CONTRACT_FILENAME,
        config:
          typeof files.config === 'string' && files.config.trim()
            ? files.config.trim()
            : DEFAULT_CONFIG_FILENAME,
        settings:
          typeof files.settings === 'string' && files.settings.trim()
            ? files.settings.trim()
            : DEFAULT_SETTINGS_FILENAME,
      },
    };
  } catch {
    return undefined;
  }
}

function recordInstallFile(
  summary: InstallSummary,
  status: TemplateWriteStatus,
  path: string,
): void {
  summary.files[
    status === 'created' ? 'created' : status === 'updated' ? 'updated' : 'unchanged'
  ].push(path);
}

function removeFileIfExists(
  path: string,
  dryRun: boolean,
): { status: RemovalStatus; path: string } {
  if (!existsSync(path)) {
    return {
      status: 'unchanged',
      path,
    };
  }
  if (!dryRun) {
    rmSync(path, { force: true });
  }
  return {
    status: 'removed',
    path,
  };
}

function removeManagedEntrypoint(
  entrypointPath: string,
  dryRun: boolean,
): { status: RemovalStatus; path: string; warning?: string } {
  if (!existsSync(entrypointPath)) {
    return {
      status: 'unchanged',
      path: entrypointPath,
    };
  }

  const current = readFileSync(entrypointPath, 'utf8');
  const stripped = stripAelWorkflowBlock(current);
  if (!stripped.changed) {
    return {
      status: 'unchanged',
      path: entrypointPath,
      warning: `managed root instructions did not contain an AEL block: ${entrypointPath}`,
    };
  }

  if (!dryRun) {
    if (!stripped.content) {
      rmSync(entrypointPath, { force: true });
      return {
        status: 'removed',
        path: entrypointPath,
      };
    }
    writeFileSync(entrypointPath, stripped.content, 'utf8');
  }

  return {
    status: stripped.content ? 'updated' : 'removed',
    path: entrypointPath,
  };
}

function cleanupAelDirectory(workspace: string, dryRun: boolean): void {
  const aelDirectory = join(workspace, '.ael');
  let current = aelDirectory;
  while (
    resolve(current).startsWith(resolve(workspace)) &&
    resolve(current) !== resolve(workspace)
  ) {
    if (!existsSync(current)) {
      current = dirname(current);
      continue;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) {
      return;
    }
    if (!dryRun) {
      rmSync(current, { recursive: true, force: true });
    }
    current = dirname(current);
  }
}

function recordUninstallFile(summary: UninstallSummary, status: RemovalStatus, path: string): void {
  summary.files[
    status === 'removed' ? 'removed' : status === 'updated' ? 'updated' : 'unchanged'
  ].push(path);
}

function inferInstallModeFromScripts(scripts: Record<string, unknown>): InstallMode {
  const recommendedScripts = loadRecommendedPackageScripts();
  const matchesRecommended = Object.entries(recommendedScripts).some(([name, command]) => {
    return scripts[name] === command;
  });
  return matchesRecommended ? 'with-scripts' : 'minimal';
}

export function commandInstall(args: string[]): void {
  const workspace = process.cwd();
  const dryRun = hasFlag(args, '--dry-run');
  if (resolve(workspace) === resolve(PACKAGE_ROOT)) {
    fail(
      'install targets downstream repos. Run it from the repo that is adopting AEL, not inside the AEL package repo.',
    );
  }
  const installMode = resolveInstallMode(args);
  const manageRootAgents = !hasFlag(args, '--no-root-agents');
  const entrypoint = resolveEntrypointPath(workspace, parseArgValue(args, '--entrypoint-file'));
  const packageData = loadWorkspacePackageData(workspace);
  const packageJsonExists = Boolean(packageData.path);
  if (installMode === 'with-scripts' && !packageJsonExists) {
    fail(`install --with-scripts requires a package.json in ${workspace}.`);
  }

  const manifest = packageData.manifest;
  const scripts = isRecord(manifest.scripts) ? { ...manifest.scripts } : {};
  const force = hasFlag(args, '--force');
  const runner = detectPackageManagerCommand();
  const repositoryName =
    typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name.trim()
      : basename(workspace);
  const agentKey = parseArgValue(args, '--agent-key')?.trim() || 'codex';
  const defaultBranch = parseArgValue(args, '--default-branch')?.trim() || 'main';

  const buildCommand = getPackageScriptCommand(scripts, ['build'], runner);
  const unitTestCommand = getPackageScriptCommand(scripts, ['test'], runner);
  const lintCommand = getPackageScriptCommand(
    scripts,
    ['lint', 'typecheck', 'check', 'validate'],
    runner,
  );
  const validationCommands = renderValidationCommands(scripts, runner);

  const templateContext = {
    agentKey,
    repositoryName,
    defaultBranch,
    buildCommand,
    unitTestCommand,
    integrationTestCommand: undefined,
    lintCommand,
    validationCommands,
    workflowStatusCommand: formatDownstreamWorkflowCommand(
      'status',
      installMode,
      runner,
      '',
      packageJsonExists,
    ),
    workflowInitCommand: formatDownstreamWorkflowCommand(
      'init',
      installMode,
      runner,
      '',
      packageJsonExists,
    ),
    workflowDoctorCommand: formatDownstreamWorkflowCommand(
      'doctor',
      installMode,
      runner,
      '',
      packageJsonExists,
    ),
    workflowNextCommand: formatDownstreamWorkflowCommand(
      'next',
      installMode,
      runner,
      ' -- --agent <agent-key>',
      packageJsonExists,
    ),
    workflowStartCommand: formatDownstreamWorkflowCommand(
      'start',
      installMode,
      runner,
      ' -- --id <id> --agent <agent-key>',
      packageJsonExists,
    ),
    workflowCommitCommand: formatDownstreamWorkflowCommand(
      'commit',
      installMode,
      runner,
      ' -- --id <id> --all --message "<subject>"',
      packageJsonExists,
    ),
    workflowPrCommand: formatDownstreamWorkflowCommand(
      'pr',
      installMode,
      runner,
      ' -- --id <id> --ready',
      packageJsonExists,
    ),
    workflowDoneCommand: formatDownstreamWorkflowCommand(
      'done',
      installMode,
      runner,
      ' -- --id <id> --summary "<outcome>" --impact "<value>"',
      packageJsonExists,
    ),
    workflowAuditCommand: formatDownstreamWorkflowCommand(
      'audit',
      installMode,
      runner,
      ' -- --state open --limit 100',
      packageJsonExists,
    ),
    workflowReportCommand: formatDownstreamWorkflowCommand(
      'report',
      installMode,
      runner,
      '',
      packageJsonExists,
    ),
    workflowBacklogCreateCommand: formatDownstreamWorkflowCommand(
      'backlog-create',
      installMode,
      runner,
      '',
      packageJsonExists,
    ),
    workflowBacklogPolishCommand: formatDownstreamWorkflowCommand(
      'backlog-polish',
      installMode,
      runner,
      '',
      packageJsonExists,
    ),
  };

  const addedScripts: string[] = [];
  const updatedScripts: string[] = [];
  const unchangedScripts: string[] = [];
  const conflicts: InstallScriptConflict[] = [];

  if (installMode === 'with-scripts') {
    const recommendedScripts = loadRecommendedPackageScripts();
    for (const [name, command] of Object.entries(recommendedScripts)) {
      const current = scripts[name];
      if (current === undefined) {
        scripts[name] = command;
        addedScripts.push(name);
        continue;
      }
      if (current === command) {
        unchangedScripts.push(name);
        continue;
      }
      if (!force) {
        conflicts.push({
          name,
          current: String(current),
          recommended: command,
        });
        continue;
      }
      scripts[name] = command;
      updatedScripts.push(name);
    }
  }

  const summary: InstallSummary = {
    ok: conflicts.length === 0,
    dryRun,
    mode: installMode,
    rootInstructions: manageRootAgents ? 'managed' : 'external',
    rootInstructionsPath: entrypoint.relativePath,
    workspace,
    packageJsonPath: packageData.path,
    agentKey,
    scripts: {
      added: addedScripts,
      updated: updatedScripts,
      unchanged: unchangedScripts,
      conflicts,
    },
    files: {
      created: [],
      updated: [],
      unchanged: [],
    },
    nextSteps: [
      ...(manageRootAgents
        ? [`review ${entrypoint.absolutePath}`]
        : [
            `update ${entrypoint.absolutePath} to point at ${join(workspace, DEFAULT_AGENT_GUIDE_FILENAME)}`,
          ]),
      `review ${join(workspace, DEFAULT_AGENT_GUIDE_FILENAME)}`,
      `review ${join(workspace, DEFAULT_PROJECT_CONTRACT_FILENAME)}`,
      formatDownstreamWorkflowCommand('init', installMode, runner, '', packageJsonExists),
      formatDownstreamWorkflowCommand('doctor', installMode, runner, '', packageJsonExists),
    ],
  };

  if (conflicts.length > 0 && !force) {
    if (wantsJson(args)) {
      printJson(summary);
      process.exit(1);
    }
    console.log(`=== AEL INSTALL${dryRun ? ' DRY RUN' : ''} ===`);
    console.log(`workspace: ${workspace}`);
    if (packageData.path) {
      console.log(`package.json: ${packageData.path}`);
    }
    console.log('conflicting package scripts:');
    for (const conflict of conflicts) {
      console.log(
        `- ${conflict.name}: current="${conflict.current}" recommended="${conflict.recommended}"`,
      );
    }
    console.log('Next: re-run ael install --force or resolve package script conflicts manually');
    process.exit(1);
  }

  if (installMode === 'with-scripts' && packageData.path) {
    manifest.scripts = scripts;
    if (!dryRun) {
      writeFileSync(packageData.path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    if (addedScripts.length === 0 && updatedScripts.length === 0) {
      summary.files.unchanged.push(packageData.path);
    } else {
      summary.files.updated.push(packageData.path);
    }
  }

  if (manageRootAgents) {
    const agentsTemplate = applyInstallTemplate(
      loadDownstreamTemplate('AGENTS.md'),
      templateContext,
    );
    const agentsResult = updateAgentsFile(entrypoint.absolutePath, agentsTemplate, force, dryRun);
    recordInstallFile(summary, agentsResult.status, agentsResult.path);
  }

  const agentGuidePath = join(workspace, DEFAULT_AGENT_GUIDE_FILENAME);
  const agentGuideTemplate = applyInstallTemplate(
    loadDownstreamTemplate('agent-guide.md'),
    templateContext,
  );
  const agentGuideResult = writeTemplateFile(agentGuidePath, agentGuideTemplate, force, dryRun);
  recordInstallFile(summary, agentGuideResult.status, agentGuideResult.path);

  const contractPath = join(workspace, DEFAULT_PROJECT_CONTRACT_FILENAME);
  const contractTemplate = applyInstallTemplate(
    loadDownstreamTemplate('AEL-PROJECT-CONTRACT.md'),
    templateContext,
  );
  const contractResult = writeTemplateFile(contractPath, contractTemplate, force, dryRun);
  recordInstallFile(summary, contractResult.status, contractResult.path);

  const aelGitignorePath = join(workspace, DEFAULT_AEL_GITIGNORE_FILENAME);
  const aelGitignoreResult = writeTemplateFile(
    aelGitignorePath,
    loadDownstreamTemplate('ael.gitignore'),
    force,
    dryRun,
  );
  recordInstallFile(summary, aelGitignoreResult.status, aelGitignoreResult.path);

  const settingsPath = join(workspace, DEFAULT_SETTINGS_FILENAME);
  const settingsResult = writeTemplateFile(
    settingsPath,
    loadDownstreamTemplate('settings.json'),
    force,
    dryRun,
  );
  recordInstallFile(summary, settingsResult.status, settingsResult.path);

  const installManifestPath = join(workspace, DEFAULT_INSTALL_MANIFEST_FILENAME);
  const installManifestResult = writeTemplateFile(
    installManifestPath,
    renderInstallManifest({
      installMode,
      manageRootAgents,
      rootInstructionsPath: entrypoint.relativePath,
    }),
    force,
    dryRun,
  );
  recordInstallFile(summary, installManifestResult.status, installManifestResult.path);

  if (wantsJson(args)) {
    printJson(summary);
    return;
  }

  console.log(`=== AEL INSTALL${dryRun ? ' DRY RUN' : ''} ===`);
  console.log(`workspace: ${workspace}`);
  if (packageData.path) {
    console.log(`package.json: ${packageData.path}`);
  }
  console.log(`mode: ${installMode}`);
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

export function commandUninstall(args: string[]): void {
  const workspace = process.cwd();
  const dryRun = hasFlag(args, '--dry-run');
  if (resolve(workspace) === resolve(PACKAGE_ROOT)) {
    fail(
      'uninstall targets downstream repos. Run it from the repo that adopted AEL, not inside the AEL package repo.',
    );
  }

  const packageData = loadWorkspacePackageData(workspace);
  const packageJsonPath = packageData.path;
  const scripts = isRecord(packageData.manifest.scripts) ? { ...packageData.manifest.scripts } : {};
  const recommendedScripts = loadRecommendedPackageScripts();
  const manifestPath = join(workspace, DEFAULT_INSTALL_MANIFEST_FILENAME);
  const installManifest = readInstallManifest(manifestPath);
  const installMode = installManifest?.mode ?? inferInstallModeFromScripts(scripts);
  const rootInstructionsMode = installManifest?.rootInstructions.mode ?? 'managed';
  const rootInstructionsPath = installManifest?.rootInstructions.path ?? 'AGENTS.md';
  const entrypoint = resolveEntrypointPath(workspace, rootInstructionsPath);

  const summary: UninstallSummary = {
    ok: true,
    dryRun,
    workspace,
    packageJsonPath,
    files: {
      removed: [],
      updated: [],
      unchanged: [],
    },
    scripts: {
      removed: [],
      preserved: [],
    },
    nextSteps: [],
    warnings: [],
  };

  if (!installManifest) {
    summary.warnings.push(
      `missing ${manifestPath}; uninstall is using best-effort detection for file ownership.`,
    );
  }

  if (rootInstructionsMode === 'managed') {
    const entrypointResult = removeManagedEntrypoint(entrypoint.absolutePath, dryRun);
    recordUninstallFile(summary, entrypointResult.status, entrypointResult.path);
    if (entrypointResult.warning) {
      summary.warnings.push(entrypointResult.warning);
    }
  } else {
    summary.files.unchanged.push(entrypoint.absolutePath);
    summary.warnings.push(
      `root instructions are externally managed; update ${entrypoint.absolutePath} manually if it still points at .ael/agent-guide.md.`,
    );
  }

  const managedRelativePaths = uniqueStrings([
    installManifest?.files.agentGuide ?? DEFAULT_AGENT_GUIDE_FILENAME,
    installManifest?.files.projectContract ?? DEFAULT_PROJECT_CONTRACT_FILENAME,
    installManifest?.files.gitignore ?? DEFAULT_AEL_GITIGNORE_FILENAME,
    installManifest?.files.config ?? DEFAULT_CONFIG_FILENAME,
    installManifest?.files.settings ?? DEFAULT_SETTINGS_FILENAME,
    DEFAULT_INSTALL_MANIFEST_FILENAME,
  ]);

  for (const relativePath of managedRelativePaths) {
    const removal = removeFileIfExists(join(workspace, relativePath), dryRun);
    recordUninstallFile(summary, removal.status, removal.path);
  }

  if (packageJsonPath && installMode === 'with-scripts') {
    let removedAnyScripts = false;
    for (const [name, command] of Object.entries(recommendedScripts)) {
      const current = scripts[name];
      if (current === command) {
        delete scripts[name];
        summary.scripts.removed.push(name);
        removedAnyScripts = true;
      } else if (current !== undefined) {
        summary.scripts.preserved.push(name);
        summary.warnings.push(
          `preserved custom package script ${name} because it does not match the AEL default.`,
        );
      }
    }
    if (removedAnyScripts) {
      if (Object.keys(scripts).length > 0) {
        packageData.manifest.scripts = scripts;
      } else {
        packageData.manifest.scripts = undefined;
      }
      if (!dryRun) {
        writeFileSync(
          packageJsonPath,
          `${JSON.stringify(packageData.manifest, null, 2)}\n`,
          'utf8',
        );
      }
      summary.files.updated.push(packageJsonPath);
    } else {
      summary.files.unchanged.push(packageJsonPath);
    }
  } else if (packageJsonPath) {
    summary.files.unchanged.push(packageJsonPath);
  }

  cleanupAelDirectory(workspace, dryRun);

  summary.nextSteps = [
    dryRun ? 're-run ael uninstall without --dry-run to apply the removal' : 'review the repo diff',
    're-run ael install if you want to re-adopt AEL later',
  ];
  if (rootInstructionsMode === 'external') {
    summary.nextSteps.unshift(`remove any remaining root references in ${entrypoint.absolutePath}`);
  }

  if (wantsJson(args)) {
    printJson(summary);
    return;
  }

  console.log(`=== AEL UNINSTALL${dryRun ? ' DRY RUN' : ''} ===`);
  console.log(`workspace: ${workspace}`);
  if (packageJsonPath) {
    console.log(`package.json: ${packageJsonPath}`);
  }
  if (summary.files.removed.length > 0) {
    console.log(`files removed: ${summary.files.removed.join(', ')}`);
  }
  if (summary.files.updated.length > 0) {
    console.log(`files updated: ${summary.files.updated.join(', ')}`);
  }
  if (summary.files.unchanged.length > 0) {
    console.log(`files unchanged: ${summary.files.unchanged.join(', ')}`);
  }
  if (summary.scripts.removed.length > 0) {
    console.log(`scripts removed: ${summary.scripts.removed.join(', ')}`);
  }
  if (summary.scripts.preserved.length > 0) {
    console.log(`scripts preserved: ${summary.scripts.preserved.join(', ')}`);
  }
  for (const warning of summary.warnings) {
    console.log(`warning: ${warning}`);
  }
  for (const nextStep of summary.nextSteps) {
    console.log(`next: ${nextStep}`);
  }
}
