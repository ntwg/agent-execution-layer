import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstallScriptConflict, InstallSummary } from './ado-cli-types.js';
import {
  detectPackageManagerCommand,
  ensureTrailingNewline,
  fail,
  formatScriptCommand,
  getPackageScriptCommand,
  hasFlag,
  isRecord,
  parseArgValue,
  preferredWorkflowCommand,
  printJson,
  uniqueStrings,
  wantsJson,
} from './ado-cli-runtime.js';

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

function loadDownstreamTemplate(name: string): string {
  return readFileSync(join(DOWNSTREAM_TEMPLATE_DIR, name), 'utf8');
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
    .replaceAll('{{VALIDATION_COMMANDS}}', validationBlock);
}

function normalizeAelWorkflowBlock(content: string): string {
  return ensureTrailingNewline(
    [AEL_WORKFLOW_MARKER_START, content.trim(), AEL_WORKFLOW_MARKER_END].join('\n'),
  );
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
  writeFileSync(
    agentsPath,
    ensureTrailingNewline(`${current.trimEnd()}${separator}${block}`),
    'utf8',
  );
  return { status: 'updated', path: agentsPath };
}

function ensureGitignoreEntry(
  workspacePath: string,
  entry: string,
): { status: 'created' | 'updated' | 'unchanged'; path: string } {
  const gitignorePath = join(workspacePath, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${entry}\n`, 'utf8');
    return { status: 'created', path: gitignorePath };
  }

  const current = readFileSync(gitignorePath, 'utf8');
  const lines = current.split(/\r?\n/).map((line) => line.trim());
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

export function commandInstall(args: string[]): void {
  const workspace = process.cwd();
  const packageJsonPath = join(workspace, 'package.json');
  if (resolve(workspace) === resolve(PACKAGE_ROOT)) {
    fail(
      'install targets downstream repos. Run it from the repo that is adopting AEL, not inside the AEL package repo.',
    );
  }
  if (!existsSync(packageJsonPath)) {
    fail(`install requires a package.json in ${workspace}.`);
  }

  const manifestRaw = readFileSync(packageJsonPath, 'utf8');
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  if (!isRecord(manifest)) {
    fail(`${packageJsonPath} must contain a JSON object.`);
  }

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
  };

  const rawRecommendedScripts = JSON.parse(
    loadDownstreamTemplate('package-scripts.json'),
  ) as unknown;
  if (!isRecord(rawRecommendedScripts) || !isRecord(rawRecommendedScripts.scripts)) {
    fail('invalid downstream package-scripts template.');
  }
  const recommendedScripts = rawRecommendedScripts.scripts;
  const addedScripts: string[] = [];
  const updatedScripts: string[] = [];
  const unchangedScripts: string[] = [];
  const conflicts: InstallScriptConflict[] = [];

  for (const [name, command] of Object.entries(recommendedScripts)) {
    if (typeof command !== 'string') continue;
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

  const summary: InstallSummary = {
    ok: conflicts.length === 0,
    workspace,
    packageJsonPath,
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
      `review ${join(workspace, 'AGENTS.md')}`,
      `review ${join(workspace, 'docs', 'AEL-PROJECT-CONTRACT.md')}`,
      formatScriptCommand('ael:init', runner),
      formatScriptCommand('ael:doctor', runner),
    ],
  };

  if (conflicts.length > 0 && !force) {
    if (wantsJson(args)) {
      printJson(summary);
      process.exit(1);
    }
    console.log('=== AEL INSTALL ===');
    console.log(`workspace: ${workspace}`);
    console.log(`package.json: ${packageJsonPath}`);
    console.log('conflicting package scripts:');
    for (const conflict of conflicts) {
      console.log(
        `- ${conflict.name}: current="${conflict.current}" recommended="${conflict.recommended}"`,
      );
    }
    console.log('Next: re-run ael install --force or resolve package script conflicts manually');
    process.exit(1);
  }

  manifest.scripts = scripts;
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (addedScripts.length === 0 && updatedScripts.length === 0) {
    summary.files.unchanged.push(packageJsonPath);
  } else {
    summary.files.updated.push(packageJsonPath);
  }

  const agentsTemplate = applyInstallTemplate(loadDownstreamTemplate('AGENTS.md'), templateContext);
  const agentsResult = updateAgentsFile(workspace, agentsTemplate, force);
  summary.files[
    agentsResult.status === 'created'
      ? 'created'
      : agentsResult.status === 'updated'
        ? 'updated'
        : 'unchanged'
  ].push(agentsResult.path);

  const contractPath = join(workspace, 'docs', 'AEL-PROJECT-CONTRACT.md');
  const contractTemplate = applyInstallTemplate(
    loadDownstreamTemplate('AEL-PROJECT-CONTRACT.md'),
    templateContext,
  );
  const contractResult = writeTemplateFile(contractPath, contractTemplate, force);
  summary.files[
    contractResult.status === 'created'
      ? 'created'
      : contractResult.status === 'updated'
        ? 'updated'
        : 'unchanged'
  ].push(contractResult.path);

  const gitignoreResult = ensureGitignoreEntry(workspace, 'agent-execution.config.local.json');
  summary.files[
    gitignoreResult.status === 'created'
      ? 'created'
      : gitignoreResult.status === 'updated'
        ? 'updated'
        : 'unchanged'
  ].push(gitignoreResult.path);

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
