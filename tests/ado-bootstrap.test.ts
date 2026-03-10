import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAzureDevOpsRemote } from '../scripts/lib/ado-bootstrap.js';

test('parseAzureDevOpsRemote handles https remotes', () => {
  assert.deepEqual(
    parseAzureDevOpsRemote('https://dev.azure.com/example-org/example-project/_git/example-repo'),
    {
      organizationUrl: 'https://dev.azure.com/example-org',
      project: 'example-project',
      repositoryName: 'example-repo',
    },
  );
});

test('parseAzureDevOpsRemote handles ssh remotes', () => {
  assert.deepEqual(
    parseAzureDevOpsRemote('git@ssh.dev.azure.com:v3/example-org/example-project/example-repo'),
    {
      organizationUrl: 'https://dev.azure.com/example-org',
      project: 'example-project',
      repositoryName: 'example-repo',
    },
  );
});

test('parseAzureDevOpsRemote handles legacy visualstudio remotes', () => {
  assert.deepEqual(
    parseAzureDevOpsRemote(
      'https://example-org.visualstudio.com/example-project/_git/example-repo',
    ),
    {
      organizationUrl: 'https://example-org.visualstudio.com',
      project: 'example-project',
      repositoryName: 'example-repo',
    },
  );
});
