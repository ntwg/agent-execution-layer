# Azure DevOps Workflow

Use this repo as the reusable execution layer for Azure DevOps-backed agent delivery.

The original `semantic-layer` implementation remains intact. This extracted repo exists so the workflow engine can be reused elsewhere.

## Flow

1. Create a neutral work item
2. Claim or start the item for an agent
3. Implement on a linked branch
4. Create linked commits with `AB#<id>`
5. Open a linked PR
6. Add closeout summary and mark the item done after merge

## Core Commands

```bash
npm run ael:help
npx ael install
npm run ael:init
npm run ael:doctor
npm run ael:smoke
npm run ael:validate-config
npm run ael:status
npm run ael:create -- --title "<task>" --human-summary "<goal>" --agent-context "<technical context>"
npm run ael:start -- --id <id> --agent codex --assigned-to "<ado-email-or-id>"
npm run ael:commit -- --id <id> --all --message "<subject>"
npm run ael:pr -- --id <id> --ready
npm run ael:done -- --id <id> --summary "<outcome>" --impact "<business value>" --pr "<pr-id>"
```

## Work Item Structure

Descriptions are split into:

- Human Summary
- Agent Context
- Tables in Scope
- Definition of Done

Work item descriptions and closeout comments are written as rich text so section headers and lists render correctly in Azure DevOps.

## PR Behavior

PR descriptions are emitted as sectioned plain text with real line breaks.

Optional reviewer behavior:

- `--reviewer "<email-or-ado-id>"`
- `--reviewer assigned`
- `--no-reviewer`
- `--required-reviewer`

Assignee and reviewer identities are resolved through Azure DevOps before write operations run.

PR tag behavior:

- linked PR creation pushes the current branch before opening the PR
- linked PR creation syncs key work item tags onto the PR by default
- `--no-sync-pr-tags` turns that off for one PR

## Audit and Reporting

```bash
npm run ael:audit -- --state open --limit 100
npm run ael:audit -- --state open --limit 100 --repair
npm run ael:report
```

`ael:audit` can detect and optionally repair safe issues like:

- markdown-style work item descriptions still stored as plain text
- markdown-style closeout comments in HTML-rendered discussion fields
- PR descriptions with escaped markdown/newline artifacts
- inferred missing PR-to-work-item links
- missing PR tags

`ael:report` gives a quick human-readable view of:

- open work items
- active work by agent
- blocked items
- active PRs
- stale active work
- recently closed items

## Config Validation

Validate the current config before running operational commands:

```bash
npm run ael:init
npm run ael:doctor
npm run ael:smoke
npm run ael:validate-config
```

`ael:status` also reports whether the loaded config passes validation.

`ael:init` writes a versioned config and can auto-detect:

- Azure identity from `az login`
- Azure DevOps org/project/repository from the current `origin` remote when it points at Azure DevOps
- repository ID from Azure DevOps
- default branch from `origin/HEAD`
- default area path from Azure Boards project nodes
- default iteration path from Azure Boards project nodes

`ael:doctor` verifies the local environment and config, including:

- Azure CLI or PAT-backed Azure DevOps auth
- configured default assignee identity resolution
- target-branch policy visibility

`ael:smoke` adds read-only work item and PR queries on top of the doctor checks, plus active PR merge-readiness inspection.

If you need PAT-backed auth instead of `az login`, export `AEL_ADO_PAT` before running `ael` commands.

For agent-safe parsing, these commands support `--json`:

- `status`
- `validate-config`
- `init`
- `doctor`
- `smoke`
- `list`
- `next`
- `create`
- `claim`
- `branch`
- `start`
- `commit`
- `pr`
- `done`
- `retag`
- `audit`
- `report`
- `enable`
- `disable`

## Config Override

By default the CLI reads `agent-execution.config.local.json` from the repo root.

If that file is missing, the legacy filename `agent-execution.config.json` is still accepted for compatibility.

To use a different target without editing the generated local file:

```bash
AGENT_EXECUTION_CONFIG=/absolute/path/to/config.json npm run ael:status
```

## Package Use

The long-term downstream integration model is package-based:

- install this repo as a dependency
- run `ael install` in the downstream repo root
- use the `ael` bin entrypoint from downstream package scripts
- keep repo-specific validation and escalation rules in the downstream repo

See [docs/ADOPTING-AEL.md](./ADOPTING-AEL.md) and `templates/downstream/*`.

Repo-local `npm run ado:*` aliases still exist for compatibility, but `npm run ael:*` is the primary surface going forward.
