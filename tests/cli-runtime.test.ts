import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCommandInvocation } from '../scripts/lib/ado-cli-runtime.js';

test('resolveCommandInvocation keeps non-Windows commands unchanged', () => {
  assert.deepEqual(resolveCommandInvocation(['git', 'status'], 'linux'), {
    command: 'git',
    args: ['status'],
  });
});

test('resolveCommandInvocation keeps non-az Windows commands unchanged', () => {
  assert.deepEqual(resolveCommandInvocation(['git', 'status'], 'win32'), {
    command: 'git',
    args: ['status'],
  });
});

test('resolveCommandInvocation routes Windows az commands through cmd.exe', () => {
  assert.deepEqual(resolveCommandInvocation(['az', 'account', 'show', '-o', 'json'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'az', 'account', 'show', '-o', 'json'],
  });
});
