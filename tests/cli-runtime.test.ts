import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCommandInvocation,
  resolveCommandRuntimeProfile,
  resolveConfiguredExecutionPlatform,
} from '../scripts/lib/command-runtime.js';

test('resolveCommandInvocation keeps non-Windows commands unchanged', () => {
  assert.deepEqual(resolveCommandInvocation(['git', 'status'], 'linux'), {
    command: 'git',
    args: ['status'],
  });
});

test('resolveCommandInvocation keeps Mac command execution direct', () => {
  assert.deepEqual(resolveCommandInvocation(['git', 'status'], 'darwin'), {
    command: 'git',
    args: ['status'],
  });
});

test('resolveCommandInvocation keeps unrelated Windows commands unchanged', () => {
  assert.deepEqual(resolveCommandInvocation(['node', '--version'], 'win32'), {
    command: 'node',
    args: ['--version'],
  });
});

test('resolveCommandInvocation routes Windows az commands through cmd.exe', () => {
  assert.deepEqual(resolveCommandInvocation(['az', 'account', 'show', '-o', 'json'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'az', 'account', 'show', '-o', 'json'],
  });
});

test('resolveCommandInvocation routes Windows npm commands through cmd.exe', () => {
  assert.deepEqual(
    resolveCommandInvocation(['npm', 'install', '--save-dev', 'agent-execution-layer'], 'win32'),
    {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm', 'install', '--save-dev', 'agent-execution-layer'],
    },
  );
});

test('resolveCommandInvocation routes Windows git commands through cmd.exe', () => {
  assert.deepEqual(resolveCommandInvocation(['git', 'status'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'git', 'status'],
  });
});

test('resolveCommandInvocation preserves git format placeholders on Windows', () => {
  assert.deepEqual(
    resolveCommandInvocation(
      ['git', 'for-each-ref', 'refs/heads', '--format=%(refname:short)|%(committerdate:unix)'],
      'win32',
    ),
    {
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'git',
        'for-each-ref',
        'refs/heads',
        '--format=%%^(refname:short^)^|%%^(committerdate:unix^)',
      ],
    },
  );
});

test('resolveCommandInvocation routes Windows curl commands through cmd.exe', () => {
  assert.deepEqual(
    resolveCommandInvocation(['curl', '-sS', 'https://example.com?a=1&b=2'], 'win32'),
    {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'curl', '-sS', 'https://example.com?a=1^&b=2'],
    },
  );
});

test('resolveCommandInvocation keeps WIQL comparison operators intact on Windows', () => {
  const wiql =
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'repo' AND [System.State] <> 'Closed'";
  assert.deepEqual(resolveCommandInvocation(['az', 'boards', 'query', '--wiql', wiql], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'az', 'boards', 'query', '--wiql', wiql],
  });
});

test('resolveCommandInvocation honors JavaScript command overrides', () => {
  assert.deepEqual(
    resolveCommandInvocation(['git', 'status'], 'win32', {
      AEL_CMD_GIT: 'C:\\stubs\\git.js',
    }),
    {
      command: process.execPath,
      args: ['C:\\stubs\\git.js', 'status'],
    },
  );
});

test('resolveConfiguredExecutionPlatform maps configured mac and windows overrides', () => {
  assert.equal(resolveConfiguredExecutionPlatform('mac', 'win32'), 'darwin');
  assert.equal(resolveConfiguredExecutionPlatform('windows', 'darwin'), 'win32');
  assert.equal(resolveConfiguredExecutionPlatform('linux', 'darwin'), 'linux');
});

test('resolveCommandRuntimeProfile exposes explicit platform profiles', () => {
  assert.equal(resolveCommandRuntimeProfile('darwin').key, 'mac');
  assert.equal(resolveCommandRuntimeProfile('linux').key, 'linux');
  assert.equal(resolveCommandRuntimeProfile('win32').key, 'windows');
});
