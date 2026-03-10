# Project Context

Use this file when starting work in this repo without prior conversation context.

## Purpose

This repo exists to provide a reusable Azure DevOps execution workflow that can be adopted across projects.

The goal is to keep workflow mechanics generic, reusable, and easy to install in downstream repos.

## What It Covers

The engine currently covers:

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

## Product Direction

- Treat this repo as the reusable workflow engine.
- Short term: keep hardening install, config, and downstream adoption.
- Longer term: this can become its own MCP/tooling project that other repos consume.

## Current State

As of March 10, 2026:

- the repo builds successfully
- the automated test suite now covers config compatibility, PR description rendering, and stubbed `init`/`doctor` flows
- the standalone CLI runs successfully against the current Azure DevOps target
- the public CLI surface is now centered on `ael`, with `ado:*` aliases kept only for compatibility
- `ael:validate-config` exists for local config schema validation
- `defaultBranch` is configurable instead of hardcoded in the main command paths
- agent identities are config-driven instead of fixed to `codex|claude`
- `ael:init`, `ael:doctor`, and `ael:smoke` now exist for bootstrap and preflight
- `install` now defaults to a minimal downstream footprint: a root discovery stub plus `.ael/.gitignore`, `.ael/install.json`, `.ael/agent-guide.md`, and `.ael/project-contract.md`; `--with-scripts`, `--entrypoint-file`, and `--no-root-agents` tune that footprint
- `ael:init` writes generated local config to `.ael/config.local.json`
- `ael:init` now auto-detects default area and iteration paths when Azure Boards returns them
- the CLI has extracted `config`, `ado-bootstrap`, and `pr-description` helper modules under `scripts/lib`
- the repo is package-ready with an `ael` bin entrypoint plus downstream adoption templates
- a clean-room downstream tarball install/adoption/uninstall pass now succeeds outside this workspace
- both read/bootstrap commands and core mutating commands now support `--json` for agent-safe parsing
- Azure DevOps PAT auth fallback is now supported via `AEL_ADO_PAT`
- configured assignee/reviewer identities are now resolved through Azure DevOps before write operations run
- `doctor` and `smoke` now inspect branch policy visibility and active PR merge readiness
- the CLI entrypoint is now thin, with command logic split across focused modules under `scripts/lib`
- Biome formatter/lint guardrails and GitHub Actions CI are now in place
- the repo is connected to both Azure DevOps and GitHub remotes
- a full live Azure DevOps lifecycle pass has already exercised `init`, `doctor`, `smoke`, `create`, `claim`, `retag`, `start`, `branch`, `commit`, `pr`, `done`, `audit`, and `report`
- the first live pass exposed and fixed real board-path defaulting and Azure query-shape issues

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
npm run ael:create -- --title "<task>" --human-summary "<goal>" --agent-context "<context>"
npm run ael:start -- --id <id> --agent codex
npm run ael:commit -- --id <id> --all --message "<subject>"
npm run ael:pr -- --id <id> --ready
npm run ael:done -- --id <id> --summary "<outcome>" --impact "<value>"
```

## What Is Not Finished Yet

This repo is separated and now validated against a real Azure DevOps repo, but it is not yet feature-complete for every downstream environment.

Main remaining hardening gaps:

1. decide when to remove `private` from `package.json` and publish formally
2. keep public troubleshooting/adoption docs tight as real users exercise the install flow
3. long-term optional GitHub code-host support is not started
4. continue tightening module boundaries only when real downstream usage exposes pressure points

## Near-Term Priority

If continuing work in this repo, the highest-value next steps are:

1. decide final publish posture and package visibility
2. keep the `.ael/` downstream layout stable so zero-context agents have one consistent discovery path
3. keep tightening module boundaries only if downstream adoption exposes real weak spots
4. decide whether later GitHub support is repo-host-only or full tracker parity
5. keep troubleshooting and example coverage aligned with the real install modes

Do not spend time adding project-specific behavior here.

## Design Boundary

This repo should own:

- Azure DevOps workflow mechanics
- traceability rules
- audit and repair logic
- status/reporting logic
- config-driven workflow defaults

This repo should not own:

- project-specific business logic
- domain-specific policies
- project-specific data-model knowledge
- repo-specific domain tags unless they are configurable

## Operating Rules

- Prefer config-driven behavior over hardcoded project assumptions.
- Keep the CLI generic enough to be reused in different projects without repo-specific assumptions.
- Keep changes scoped and easy to extract or port.
- When changing docs, keep `AGENTS.md`, `README.md`, and `docs/ADO-WORKFLOW.md` aligned.
- If you add project-specific examples, label them clearly as examples.

## Config Notes

Primary config file:

- `.ael/config.local.json`
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
