import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORK_ITEM_DESCRIPTION_SECTIONS,
  extractPlainSection,
  extractPlainSectionFromHtml,
  renderPullRequestDescription,
} from '../scripts/lib/pr-description.js';

test('extractPlainSectionFromHtml handles richer Azure DevOps markup', () => {
  const html = [
    '<div>',
    '<p><strong class="bolt-text">Human Summary</strong></p>',
    '<ul class="bolt-list">',
    '<li><span>Line one</span></li>',
    '<li>Line two &amp; more</li>',
    '</ul>',
    '</div>',
  ].join('');

  assert.equal(extractPlainSectionFromHtml(html, 'Human Summary'), 'Line one\nLine two & more');
});

test('extractPlainSection falls back to markdown-style text blocks', () => {
  const raw = [
    '## Human Summary',
    '- Explain the user-facing change',
    '- Include rollout caveats',
    '',
    '## Agent Context',
    '- Add the CLI flag',
  ].join('\n');

  assert.equal(
    extractPlainSection(raw, 'Human Summary', WORK_ITEM_DESCRIPTION_SECTIONS),
    'Explain the user-facing change\nInclude rollout caveats',
  );
});

test('renderPullRequestDescription never leaves Summary blank', () => {
  const description = renderPullRequestDescription(1821, '', 'Update bootstrap defaults');

  assert.match(description, /^AB#1821/m);
  assert.match(
    description,
    /Summary\n- Human-readable summary was not provided on the work item\./m,
  );
  assert.match(description, /Agent Context\n- Update bootstrap defaults/m);
});
