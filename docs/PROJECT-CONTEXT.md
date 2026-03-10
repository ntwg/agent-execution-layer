# Project Context

Use this file when starting work in this repo without prior conversation context.

## Purpose

This repo exists to separate the Azure DevOps execution workflow from the `semantic-layer` codebase.

The goal is to make the workflow engine reusable across projects while keeping the original implementation in `semantic-layer` intact during the extraction phase.

## What Was Extracted

The extracted engine currently covers:

- work item creation with separate human summary and agent context
- work item claiming and agent ownership tagging
- linked branch workflow
- linked commit workflow with `AB#<id>`
- linked PR creation
- optional PR reviewer assignment
- PR tag sync from linked work item tags
- closeout validation before marking work done
- Azure DevOps audit and safe repair commands
- Azure DevOps human-readable status reporting

Current entrypoint:

- `scripts/ael.ts`

Core internal modules:

- `scripts/lib/ado-cli-runtime.ts`
- `scripts/lib/ado-cli-bootstrap.ts`
- `scripts/lib/ado-cli-workflow.ts`
- `scripts/lib/ado-cli-reporting.ts`
- `scripts/lib/ado-cli-install.ts`
- `scripts/lib/ado-cli-types.ts`

## Relationship To Semantic Layer

- The `semantic-layer` repo still contains its own copy of this workflow system.
- Do not remove or break the `semantic-layer` copy as part of work in this repo.
- Treat this repo as the reusable extracted version.
- Short term: harden this repo so it can stand on its own cleanly.
- Longer term: this can become its own MCP/tooling project that other repos consume.

## Current State

As of March 9, 2026:

- the extracted repo builds successfully
- an extracted automated test suite now covers config compatibility, PR description rendering, and stubbed `init`/`doctor` flows
- the standalone CLI runs successfully against the current Azure DevOps target
- the public CLI surface is now centered on `ael`, with `ado:*` aliases kept only for compatibility
- `ael:validate-config` exists for local config schema validation
- `defaultBranch` is configurable instead of hardcoded in the main command paths
- agent identities are config-driven instead of fixed to `codex|claude`
- `ael:init`, `ael:doctor`, and `ael:smoke` now exist for bootstrap and preflight
- `install` bootstraps downstream repos with package scripts, `AGENTS.md` workflow instructions, project contract template, and `.gitignore` setup
- `ael:init` writes generated local config to `agent-execution.config.local.json`
- `ael:init` now auto-detects default area and iteration paths when Azure Boards returns them
- the CLI has extracted `config`, `ado-bootstrap`, and `pr-description` helper modules under `scripts/lib`
- the repo is package-ready with an `ael` bin entrypoint plus downstream adoption templates
- both read/bootstrap commands and core mutating commands now support `--json` for agent-safe parsing
- Azure DevOps PAT auth fallback is now supported via `AEL_ADO_PAT`
- configured assignee/reviewer identities are now resolved through Azure DevOps before write operations run
- `doctor` and `smoke` now inspect branch policy visibility and active PR merge readiness
- the CLI entrypoint is now thin, with command logic split across focused modules under `scripts/lib`
- Biome formatter/lint guardrails and GitHub Actions CI are now in place
- this repo is initialized as a local git repository on `main`, but still has no `origin` remote

Validated commands:

```bash
npm install
npm run build
npm test
npm run ael:init
npm run ael:doctor
npm run ael:smoke
npm run ael:validate-config
npm run ael:status
npm run ael:help
npm run ael:report -- --limit 5
npm run ael:audit -- --state open --limit 5
```

## What Is Not Finished Yet

This repo is separated, but it is not yet fully productized for arbitrary new projects.

Main remaining hardening gaps:

1. the first live validation pass against this repo's own guinea-pig Azure DevOps project has not happened yet
2. the local git repo still has no `origin` remote or detected remote default branch
3. some modules are still large enough to split further after the first live guinea-pig pass
4. long-term optional GitHub code-host support is not started
5. package metadata may need a final URL/visibility confirmation before public publish

## Near-Term Priority

If continuing work in this repo, the highest-value next steps are:

1. connect this repo to its own guinea-pig Azure DevOps remote and validate it end to end
2. run a full live lifecycle test from work item creation through PR and closeout
3. confirm the installed-package downstream path in a clean repo
4. keep tightening module boundaries if the first live pass exposes new pressure points
5. decide whether later GitHub support is repo-host-only or full tracker parity

Do not spend time adding semantic-layer-specific behavior here.

## Design Boundary

This repo should own:

- Azure DevOps workflow mechanics
- traceability rules
- audit and repair logic
- status/reporting logic
- config-driven workflow defaults

This repo should not own:

- semantic-layer business logic
- semantic model policies
- semantic database knowledge
- repo-specific domain tags unless they are configurable

## Operating Rules

- Prefer config-driven behavior over hardcoded project assumptions.
- Keep the CLI generic enough to be reused in non-semantic projects.
- Keep changes scoped and easy to extract or port.
- When changing docs, keep `AGENTS.md`, `README.md`, and `docs/ADO-WORKFLOW.md` aligned.
- If you add project-specific examples, label them clearly as examples.

## Config Notes

Primary config file:

- `agent-execution.config.local.json`
- `ael` package/bin entrypoint for downstream repos

Template:

- `agent-execution.config.example.json`
- `docs/ADOPTING-AEL.md`
- `templates/downstream/*`
- `docs/RELEASE-POLICY.md`
- `CHANGELOG.md`

Legacy fallback:

- `agent-execution.config.json`

Optional override:

```bash
AGENT_EXECUTION_CONFIG=/absolute/path/to/config.json npm run ael:status
```

## Recommended Start Sequence

When starting fresh in this repo:

```bash
npm install
npm run format:check
npm run lint
npm run build
npm test
npm run ael:init
npm run ael:doctor
npm run ael:validate-config
npm run ael:status
npm run ael:help
```

Then read:

1. `AGENTS.md`
2. `README.md`
3. `docs/PROJECT-CONTEXT.md`
4. `docs/ADO-WORKFLOW.md`
5. `docs/FIRST-PUSH-CHECKLIST.md`
6. `docs/RELEASE-POLICY.md`
