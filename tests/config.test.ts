import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG_FILENAME,
  LEGACY_CONFIG_FILENAME,
  discoverConfigPath,
  inspectConfigAtPath,
} from '../scripts/lib/config.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ael-config-test-'));
}

test('config discovery prefers local config and only falls back to legacy when needed', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const empty = discoverConfigPath(dir, undefined);
  assert.equal(empty.path, join(dir, DEFAULT_CONFIG_FILENAME));
  assert.equal(empty.preferredPath, join(dir, DEFAULT_CONFIG_FILENAME));
  assert.equal(empty.usedLegacyFallback, false);

  writeFileSync(join(dir, LEGACY_CONFIG_FILENAME), '{}\n', 'utf8');
  const legacy = discoverConfigPath(dir, undefined);
  assert.equal(legacy.path, join(dir, LEGACY_CONFIG_FILENAME));
  assert.equal(legacy.preferredPath, join(dir, DEFAULT_CONFIG_FILENAME));
  assert.equal(legacy.usedLegacyFallback, true);

  writeFileSync(join(dir, DEFAULT_CONFIG_FILENAME), '{}\n', 'utf8');
  const local = discoverConfigPath(dir, undefined);
  assert.equal(local.path, join(dir, DEFAULT_CONFIG_FILENAME));
  assert.equal(local.usedLegacyFallback, false);
});

test('legacy config still validates with warnings and branch fallback', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const legacyPath = join(dir, LEGACY_CONFIG_FILENAME);
  writeFileSync(
    legacyPath,
    `${JSON.stringify(
      {
        configVersion: 1,
        enabled: true,
        organizationUrl: 'https://dev.azure.com/example-org',
        project: 'example-project',
        repositoryId: '11111111-1111-1111-1111-111111111111',
        defaultAgent: 'codex',
        defaultWorkItemType: 'Task',
        defaultAreaPath: 'example-project',
        defaultIterationPath: 'example-project',
        workItemFieldDefaults: {
          create: {},
          done: {},
        },
        sharedTags: ['agent-managed'],
        agentTags: {
          codex: 'agent:codex',
          claude: 'agent:claude',
        },
        defaultAssignees: {
          codex: '',
          claude: '',
        },
        stateMap: {
          new: 'New',
          active: 'Active',
          done: 'Closed',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const inspection = inspectConfigAtPath(legacyPath, {
    legacyMigrationWarning: 'using legacy config path for compatibility',
  });

  assert.deepEqual(inspection.errors, []);
  assert.ok(inspection.config);
  assert.equal(inspection.config?.defaultBranch, 'master');
  assert.match(
    inspection.warnings.join('\n'),
    /legacy "agentTags"\/"defaultAssignees" config detected/,
  );
  assert.match(inspection.warnings.join('\n'), /defaultBranch" is missing/);
  assert.match(inspection.warnings.join('\n'), /using legacy config path for compatibility/);
});

test('config supports work item field defaults', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = join(dir, DEFAULT_CONFIG_FILENAME);
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        configVersion: 3,
        enabled: true,
        organizationUrl: 'https://dev.azure.com/example-org',
        project: 'example-project',
        repositoryId: '11111111-1111-1111-1111-111111111111',
        defaultBranch: 'main',
        defaultAgent: 'codex',
        defaultWorkItemType: 'Task',
        defaultAreaPath: '\\example-project',
        defaultIterationPath: '\\example-project',
        workItemFieldDefaults: {
          create: {
            'Custom.RequestedByAgent': true,
            'Microsoft.VSTS.Scheduling.RemainingWork': 3,
          },
          done: {
            'Custom.VerifiedByHuman': false,
          },
        },
        sharedTags: ['agent-managed'],
        agents: [
          {
            key: 'codex',
            tag: 'agent:codex',
            branchPrefix: 'codex',
            defaultAssignee: 'owner@example.com',
          },
        ],
        stateMap: {
          new: 'New',
          active: 'Active',
          done: 'Closed',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const inspection = inspectConfigAtPath(configPath);
  assert.deepEqual(inspection.errors, []);
  assert.equal(inspection.config?.workItemFieldDefaults.create['Custom.RequestedByAgent'], true);
  assert.equal(
    inspection.config?.workItemFieldDefaults.create['Microsoft.VSTS.Scheduling.RemainingWork'],
    3,
  );
  assert.equal(inspection.config?.workItemFieldDefaults.done['Custom.VerifiedByHuman'], false);
});
