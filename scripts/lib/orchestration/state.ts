import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OrchestrationChild, OrchestrationRun } from '../ado-cli-types.js';
import {
  DEFAULT_ORCHESTRATION_CHILDREN_DIRECTORY,
  DEFAULT_ORCHESTRATION_DIRECTORY,
  DEFAULT_ORCHESTRATION_EVENTS_DIRECTORY,
  DEFAULT_ORCHESTRATION_RUNS_DIRECTORY,
} from '../config.js';
import { fail, isRecord } from '../ado-cli-runtime.js';

interface OrchestrationPaths {
  root: string;
  runs: string;
  children: string;
  events: string;
}

function getPaths(workspace = process.cwd()): OrchestrationPaths {
  return {
    root: resolve(workspace, DEFAULT_ORCHESTRATION_DIRECTORY),
    runs: resolve(workspace, DEFAULT_ORCHESTRATION_RUNS_DIRECTORY),
    children: resolve(workspace, DEFAULT_ORCHESTRATION_CHILDREN_DIRECTORY),
    events: resolve(workspace, DEFAULT_ORCHESTRATION_EVENTS_DIRECTORY),
  };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function ensurePaths(workspace = process.cwd()): OrchestrationPaths {
  const paths = getPaths(workspace);
  ensureDir(paths.root);
  ensureDir(paths.runs);
  ensureDir(paths.children);
  ensureDir(paths.events);
  return paths;
}

function parseJsonFile(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      fail(`${path} must contain a JSON object.`);
    }
    return parsed;
  } catch (error) {
    fail(
      `unable to read orchestration state ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stableSortChildren(children: OrchestrationChild[]): OrchestrationChild[] {
  return [...children].sort((left, right) => left.childId.localeCompare(right.childId));
}

function normalizeRun(run: OrchestrationRun): OrchestrationRun {
  const children = stableSortChildren(run.children).map((child) => ({
    ...child,
    checkins: [...child.checkins].sort((left, right) => left.at.localeCompare(right.at)),
  }));
  return {
    ...run,
    parentIds: [...run.parentIds].sort((left, right) => left - right),
    parentPlans: [...run.parentPlans].sort((left, right) => left.workItemId - right.workItemId),
    activeChildIds: [...run.activeChildIds].sort(),
    children,
    approvalCheckpoints: [...run.approvalCheckpoints].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    integrationChecklist: [...run.integrationChecklist],
    finalization: {
      ...run.finalization,
      pullRequestIds: [...run.finalization.pullRequestIds].sort((left, right) => left - right),
      outstandingValidation: [...run.finalization.outstandingValidation],
    },
  };
}

export function buildOrchestrationRunManifestPath(
  runId: string,
  workspace = process.cwd(),
): string {
  return join(getPaths(workspace).runs, `${runId}.json`);
}

export function buildOrchestrationRunBriefPath(runId: string, workspace = process.cwd()): string {
  return join(getPaths(workspace).runs, `${runId}.md`);
}

export function buildOrchestrationChildDirectory(runId: string, workspace = process.cwd()): string {
  return join(getPaths(workspace).children, runId);
}

export function buildOrchestrationChildManifestPath(
  runId: string,
  childId: string,
  workspace = process.cwd(),
): string {
  return join(buildOrchestrationChildDirectory(runId, workspace), `${childId}.json`);
}

export function buildOrchestrationChildBriefPath(
  runId: string,
  childId: string,
  workspace = process.cwd(),
): string {
  return join(buildOrchestrationChildDirectory(runId, workspace), `${childId}.md`);
}

export function buildOrchestrationEventPath(runId: string, workspace = process.cwd()): string {
  return join(getPaths(workspace).events, `${runId}.jsonl`);
}

export function ensureOrchestrationLayout(workspace = process.cwd()): OrchestrationPaths {
  return ensurePaths(workspace);
}

export function saveOrchestrationRun(
  run: OrchestrationRun,
  options?: {
    workspace?: string;
    runBrief?: string;
    childBriefs?: Record<string, string>;
  },
): OrchestrationRun {
  const workspace = options?.workspace ?? process.cwd();
  ensurePaths(workspace);
  const normalizedRun = normalizeRun(run);
  const runManifestPath = buildOrchestrationRunManifestPath(normalizedRun.runId, workspace);
  const runBriefPath =
    normalizedRun.briefPath || buildOrchestrationRunBriefPath(normalizedRun.runId, workspace);
  ensureDir(buildOrchestrationChildDirectory(normalizedRun.runId, workspace));
  writeFileSync(runManifestPath, `${JSON.stringify(normalizedRun, null, 2)}\n`, 'utf8');
  if (options?.runBrief !== undefined) {
    writeFileSync(runBriefPath, options.runBrief, 'utf8');
  }

  for (const child of normalizedRun.children) {
    const manifestPath =
      child.manifestPath ||
      buildOrchestrationChildManifestPath(normalizedRun.runId, child.childId, workspace);
    const briefPath =
      child.briefPath ||
      buildOrchestrationChildBriefPath(normalizedRun.runId, child.childId, workspace);
    writeFileSync(manifestPath, `${JSON.stringify(child, null, 2)}\n`, 'utf8');
    const brief = options?.childBriefs?.[child.childId];
    if (brief !== undefined) {
      writeFileSync(briefPath, brief, 'utf8');
    }
  }

  return normalizedRun;
}

export function loadOrchestrationRun(runId: string, workspace = process.cwd()): OrchestrationRun {
  const manifestPath = buildOrchestrationRunManifestPath(runId, workspace);
  if (!existsSync(manifestPath)) {
    fail(`missing orchestration run ${runId} at ${manifestPath}.`);
  }
  return parseJsonFile(manifestPath) as unknown as OrchestrationRun;
}

export function loadOrchestrationChild(
  runId: string,
  childId: string,
  workspace = process.cwd(),
): OrchestrationChild {
  const manifestPath = buildOrchestrationChildManifestPath(runId, childId, workspace);
  if (!existsSync(manifestPath)) {
    fail(`missing orchestration child ${childId} for run ${runId}.`);
  }
  return parseJsonFile(manifestPath) as unknown as OrchestrationChild;
}

export function listOrchestrationRuns(workspace = process.cwd()): OrchestrationRun[] {
  const runsDir = getPaths(workspace).runs;
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadOrchestrationRun(entry.replace(/\.json$/u, ''), workspace))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function appendOrchestrationEvent(
  runId: string,
  event: Record<string, unknown>,
  workspace = process.cwd(),
): void {
  ensurePaths(workspace);
  const eventPath = buildOrchestrationEventPath(runId, workspace);
  const serialized = `${JSON.stringify(event)}\n`;
  const existing = existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : '';
  writeFileSync(eventPath, `${existing}${serialized}`, 'utf8');
}
