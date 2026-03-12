import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCommandInvocation } from '../scripts/lib/ado-cli-runtime.js';

test('resolveCommandInvocation keeps non-Windows commands unchanged', () => {
  assert.deepEqual(resolveCommandInvocation(['git', 'status'], 'linux'), {
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

test('resolveCommandInvocation routes Windows git commands through cmd.exe', () => {
  assert.deepEqual(resolveCommandInvocation(['git', 'status'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'git', 'status'],
  });
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
