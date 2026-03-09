export const WORK_ITEM_DESCRIPTION_SECTIONS = [
  'Human Summary',
  'Agent Context',
  'Tables in Scope',
  'Definition of Done',
] as const;

export const COMPLETION_DISCUSSION_SECTIONS = [
  'Completion Summary',
  'Business Impact',
  'Tables Mapped',
  'Validation Checks',
  'Key Files Updated',
  'Pull Request',
  'Notes',
] as const;

export const PULL_REQUEST_DESCRIPTION_SECTIONS = [
  'Summary',
  'Agent Context',
  'Why It Matters',
  'Tables Added',
  'Validation Status',
  'Checks Run',
  'Changed Files',
  'Coverage Impact',
  'Reviewer Checklist',
  'Rollback',
  'Evidence',
] as const;

export function decodeEscapedText(raw: string): string {
  return raw
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

export function normalizeText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const decoded = decodeEscapedText(raw).trim();
  return decoded || undefined;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractPlainSectionFromHtml(raw: string, sectionTitle: string): string {
  if (!raw) return '';
  const sectionRegex = new RegExp(
    `<strong[^>]*>\\s*${escapeRegex(sectionTitle)}\\s*<\\/strong>[\\s\\S]*?<ul[^>]*>([\\s\\S]*?)<\\/ul>`,
    'i',
  );
  const sectionMatch = raw.match(sectionRegex);
  if (!sectionMatch) return '';
  const itemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  const items = Array.from(sectionMatch[1].matchAll(itemRegex))
    .map(match => decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '').trim()))
    .filter(Boolean);
  return items.join('\n');
}

export function normalizeMarkdownishText(raw: string): string {
  return decodeEscapedText(raw)
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractSectionBlocksFromText(
  raw: string,
  titles: readonly string[],
): Array<{ title: string; items: string[] }> {
  const normalized = decodeEscapedText(raw).replace(/\r/g, '').trim();
  if (!normalized) return [];
  const alternation = titles
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  const regex = new RegExp(
    `(?:^|\\n)\\s*(?:##+\\s*)?(${alternation})(?:\\s*[-:])?\\s*(.*?)(?=(?:\\n\\s*(?:##+\\s*)?(?:${alternation})(?:\\s*[-:])?)|$)`,
    'gis',
  );
  const sections: Array<{ title: string; items: string[] }> = [];
  for (const match of normalized.matchAll(regex)) {
    const title = match[1]?.trim();
    if (!title) continue;
    const content = (match[2] ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/^[-*]\s+/, '').trim())
      .filter(Boolean);
    sections.push({
      title,
      items: content.length > 0 ? content : [''],
    });
  }
  return sections;
}

export function extractPlainSection(
  raw: string,
  sectionTitle: string,
  sectionTitles: readonly string[],
): string {
  const fromHtml = extractPlainSectionFromHtml(raw, sectionTitle);
  if (fromHtml) return fromHtml;

  const normalized = normalizeMarkdownishText(raw);
  if (!normalized) return '';
  const fromText = extractSectionBlocksFromText(normalized, sectionTitles)
    .find(section => section.title.toLowerCase() === sectionTitle.toLowerCase());
  return fromText ? fromText.items.join('\n') : '';
}

function renderHtmlSection(title: string, items: string[]): string {
  const safeItems = items.length > 0 ? items : [''];
  const listItems = safeItems
    .map(item => `<li>${escapeHtml(item)}</li>`)
    .join('');
  return `<div><p><strong>${escapeHtml(title)}</strong></p><ul>${listItems}</ul></div>`;
}

function renderHtmlSections(sections: Array<{ title: string; items: string[] }>): string {
  return sections.map(section => renderHtmlSection(section.title, section.items)).join('');
}

function renderPlainTextSection(title: string, items: string[]): string {
  const safeItems = items.length > 0 ? items : [''];
  return [title, ...safeItems.map(item => `- ${item}`), ''].join('\n');
}

function renderPlainTextSections(
  sections: Array<{ title: string; items: string[] }>,
  prefixLines: string[] = [],
): string {
  return [...prefixLines, ...sections.map(section => renderPlainTextSection(section.title, section.items))]
    .join('\n')
    .trim();
}

export function isMarkdownish(raw: string): boolean {
  const normalized = decodeEscapedText(raw);
  return normalized.includes('## ') || raw.includes('\\n');
}

export function buildCompletionDiscussion(params: {
  summary?: string;
  impact?: string;
  mappedTables: string[];
  changedFiles: string[];
  checks: string[];
  note?: string;
  pr?: string;
}): string {
  const sections = [
    renderHtmlSection('Completion Summary', [
      params.summary ?? 'Work is complete and ready for review.',
    ]),
    renderHtmlSection(
      'Business Impact',
      params.impact ? [params.impact] : ['Business impact was not provided.'],
    ),
    renderHtmlSection(
      'Tables Mapped',
      params.mappedTables.length > 0
        ? params.mappedTables
        : ['No new tables were mapped in this task.'],
    ),
    renderHtmlSection(
      'Validation Checks',
      params.checks.length > 0
        ? params.checks
        : ['Validation checks were not listed. Add with --checks for traceability.'],
    ),
  ];

  if (params.changedFiles.length > 0) {
    sections.push(renderHtmlSection('Key Files Updated', params.changedFiles));
  }

  if (params.pr) {
    sections.push(renderHtmlSection('Pull Request', [`PR ${params.pr}`]));
  }

  if (params.note) {
    sections.push(renderHtmlSection('Notes', [params.note]));
  }

  return sections.join('');
}

export function buildRepairedWorkItemDescription(raw: string): string | undefined {
  const sections = extractSectionBlocksFromText(raw, WORK_ITEM_DESCRIPTION_SECTIONS);
  if (sections.length === 0) return undefined;
  return renderHtmlSections(sections);
}

export function buildRepairedCompletionComment(raw: string): string | undefined {
  const sections = extractSectionBlocksFromText(raw, COMPLETION_DISCUSSION_SECTIONS);
  if (sections.length === 0) return undefined;
  return renderHtmlSections(sections);
}

export function buildRepairedPullRequestDescription(raw: string): string | undefined {
  const normalized = normalizeMarkdownishText(raw);
  if (!normalized) return undefined;
  const workItemPrefix = normalized.match(/^AB#\d+\b/m)?.[0];
  const sections = extractSectionBlocksFromText(normalized, PULL_REQUEST_DESCRIPTION_SECTIONS);
  if (sections.length > 0) {
    return renderPlainTextSections(sections, workItemPrefix ? [workItemPrefix, ''] : []);
  }
  if (isMarkdownish(raw)) {
    return normalized;
  }
  return undefined;
}

export function buildWorkItemDescription(params: {
  humanSummary?: string;
  agentContext?: string;
  mappedTables: string[];
  acceptance: string[];
}): string | undefined {
  if (
    !params.humanSummary &&
    !params.agentContext &&
    params.mappedTables.length === 0 &&
    params.acceptance.length === 0
  ) {
    return undefined;
  }

  const agentContextItems = params.agentContext
    ? params.agentContext
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    : ['Technical implementation context to be added during execution.'];

  const mappedTableItems = params.mappedTables.length > 0
    ? params.mappedTables
    : ['To be identified during implementation.'];

  const acceptanceItems = params.acceptance.length > 0
    ? params.acceptance
    : ['Implement changes and pass required validation checks.'];

  return [
    renderHtmlSection('Human Summary', [
      params.humanSummary ?? 'Human-readable summary to be confirmed.',
    ]),
    renderHtmlSection('Agent Context', agentContextItems),
    renderHtmlSection('Tables in Scope', mappedTableItems),
    renderHtmlSection('Definition of Done', acceptanceItems),
  ].join('');
}

export function renderPullRequestDescription(
  id: number,
  humanSummary: string,
  agentContext: string,
): string {
  const lines = [`AB#${id}`, ''];
  const summaryLines = humanSummary
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean);
  lines.push(
    renderPlainTextSection(
      'Summary',
      summaryLines.length > 0 ? summaryLines : ['Human-readable summary was not provided on the work item.'],
    ),
  );
  if (agentContext) {
    lines.push(
      renderPlainTextSection(
        'Agent Context',
        agentContext.split('\n').map(value => value.trim()).filter(Boolean),
      ),
    );
  }
  return lines.join('\n').trim();
}
