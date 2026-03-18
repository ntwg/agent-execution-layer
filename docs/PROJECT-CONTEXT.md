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
- explicit human-blocked workflow reasons
- overlap-aware reporting from configured area tags
- rollout-aware target branch aliases and cleanup helpers
- closeout validation before marking work done
- Azure DevOps audit and safe repair commands
- Azure DevOps human-readable status reporting
- stale branch and stale PR cleanup commands
- Codex-app-native orchestration with durable ADO child work items, local run state, and grouped or isolated PR finalization

Current entrypoint:

- `scripts/ael.ts`

Core internal modules:

- `scripts/lib/ado-cli-runtime.ts`
- `scripts/lib/ado-cli-bootstrap.ts`
- `scripts/lib/ado-cli-workflow.ts`
- `scripts/lib/ado-cli-cleanup.ts`
- `scripts/lib/ado-cli-reporting.ts`
- `scripts/lib/ado-cli-install.ts`
- `scripts/lib/ado-cli-types.ts`
- `scripts/lib/orchestration/*`

## Product Direction

- Treat this repo as the reusable workflow engine.
- Short term: keep hardening install, config, and downstream adoption.
- Longer term: this can become its own MCP/tooling project that other repos consume.

## Current State

As of March 18, 2026:

- the repo builds successfully
- the automated test suite now covers config compatibility, PR description rendering, and stubbed `init`/`doctor` flows
- the standalone CLI runs successfully against the current Azure DevOps target
- the public CLI surface is now centered on `ael`, with `ado:*` aliases kept only for compatibility
- `ael:validate-config` exists for local config schema validation
- `defaultBranch` is configurable instead of hardcoded in the main command paths
- agent identities are config-driven instead of fixed to `codex|claude`
- `ael:init`, `ael:doctor`, and `ael:smoke` now exist for bootstrap and preflight
- `install` now defaults to a minimal downstream footprint: a root discovery stub plus `.ael/.gitignore`, `.ael/install.json`, `.ael/agent-guide.md`, `.ael/project-contract.md`, and `.ael/settings.json`; `--with-scripts`, `--entrypoint-file`, and `--no-root-agents` tune that footprint
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
- the runtime command layer is now validated in CI across Windows, macOS, and Linux
- config discovery now prefers the git repo root so nested-folder command runs find `.ael/config.local.json` more reliably
- work can now be explicitly blocked/unblocked with human-gate reasons instead of relying on generic blocked state alone
- reporting now surfaces configured area-tag overlap risk, human-blocked items, active PR target branches, and open work by hierarchy type
- branch and PR cleanup now exist as first-class commands with safe-by-default dry-run behavior
- `create` now supports config-backed hierarchy kinds like `initiative`, `feature`, `backlog`, and `task`
- downstream install/upgrade/uninstall now expose managed vs user-owned vs local-only file ownership with `--explain`
- AEL now includes an orchestration subsystem for Codex app orchestrator threads, including `orchestrate`, `orchestrate-status`, `orchestrate-sync`, `orchestrate-finalize`, `orchestrate-stop`, and `subagent-checkin`
- orchestration runs persist under `.ael/orchestration/` as local-only state while child work remains visible in Azure DevOps child tasks
- grouped PR and done flows can now operate across multiple related work items through `--ids`
- downstream `.ael/settings.json` now carries orchestration prompts, defaults, tag prefixes, approval rules, and check-in policy
- `doctor --orchestration` validates orchestration readiness in addition to the existing adoption/bootstrap checks
- `report` now surfaces orchestration run counts, blocked children, and items awaiting orchestrator review

Validated commands:

```bash
npm install
npm run build
npm test
npm run ael:init
npm run ael:doctor
npm run ael:smoke
npm run ael:validate-config
npm run ael:backlog-create
npm run ael:backlog-polish
npm run ael:orchestrate -- --ids "<id;id;id>"
npm run ael:orchestrate-status -- --run <run-id>
npm run ael:orchestrate-sync -- --run <run-id>
npm run ael:orchestrate-finalize -- --run <run-id>
npm run ael:subagent-checkin -- --run <run-id> --child <child-id> --status done --summary "<summary>"
npm run ael:status
npm run ael:help
npm run ael:block -- --id <id> --reason human-approval-needed
npm run ael:unblock -- --id <id>
npm run ael:report -- --limit 5
npm run ael:audit -- --state open --limit 5
npm run ael:cleanup-branches -- --dry-run
npm run ael:cleanup-prs -- --dry-run
npm run ael:create -- --title "<task>" --human-summary "<goal>" --agent-context "<context>"
npm run ael:start -- --id <id> --agent codex
npm run ael:commit -- --id <id> --all --message "<subject>"
npm run ael:pr -- --id <id> --ready
npm run ael:done -- --id <id> --summary "<outcome>" --impact "<value>"
```

## What Is Not Finished Yet

This repo is separated and now validated against a real Azure DevOps repo, but it is not yet feature-complete for every downstream environment.

Main remaining hardening gaps:

1. validate orchestration end to end in more downstream repos and keep the grouped-vs-isolated heuristics stable
2. decide when to remove `private` from `package.json` and publish formally
3. keep public troubleshooting/adoption docs tight as real users exercise the install flow
4. long-term optional GitHub code-host support is not started
5. keep cross-platform coverage, orchestration state handling, and cleanup flows stable as real downstream repos exercise them

## Near-Term Priority

If continuing work in this repo, the highest-value next steps are:

1. decide final publish posture and package visibility
2. keep the `.ael/` downstream layout and orchestration prompt protocol stable so zero-context agents have one consistent discovery path
3. keep cleanup, human-block, orchestration, overlap-reporting, and rollout-branch behavior stable across Windows and macOS at the same time
4. decide whether later GitHub support is repo-host-only or full tracker parity
5. keep troubleshooting and example coverage aligned with the real install and orchestration modes

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
- `.ael/settings.json`
- `.ael/orchestration/*`
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
