import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePullRequestIdFromArtifactUrl } from '../scripts/lib/ado-cli-workflow.js';

test('parsePullRequestIdFromArtifactUrl handles encoded Azure DevOps artifact links', () => {
  assert.equal(
    parsePullRequestIdFromArtifactUrl(
      'vstfs:///Git/PullRequestId/54ef4053-9d2d-4d35-9b31-6f9a91bfc101%2fd8c07b54-e9c9-4665-bf96-e613a3c8f46d%2f1440',
    ),
    1440,
  );
});

test('parsePullRequestIdFromArtifactUrl handles web pull request URLs', () => {
  assert.equal(
    parsePullRequestIdFromArtifactUrl(
      'https://dev.azure.com/example-org/example-project/_git/example-repo/pullrequest/1440',
    ),
    1440,
  );
});
