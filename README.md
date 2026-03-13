# Agent Execution Layer

A standalone Azure DevOps workflow engine for multi-agent software delivery.

This repo provides a reusable Azure DevOps execution layer for agent-driven delivery across projects. It manages work-item intake, agent claiming, linked branches, `AB#<id>` commit discipline, linked PR creation, closeout summaries, drift audits, and human-readable status reporting.

If you are starting work here without prior conversation context, read [docs/PROJECT-CONTEXT.md](docs/PROJECT-CONTEXT.md) after this file.

## Quickstart

Until npm publishing is enabled, install AEL from GitHub:

```bash
npm install -D github:ntwg/agent-execution-layer
npx ael install
npx ael doctor --adoption
npx ael init
npx ael status
```

If you want to preview the downstream file changes first, run `npx ael install --dry-run`.

## What It Does

- Creates and updates Azure DevOps work items with a standard two-audience structure
- Claims work for specific agents while keeping the responsible human in `Assigned To`
- Marks work as explicitly human-blocked with first-class reasons like `waiting-on-human`, `human-approval-needed`, and `external-setup-needed`
- Creates linked branches and enforces `AB#<id>` commit discipline
- Opens linked PRs with optional human reviewers, synced PR tags, and rollout-aware target branch aliases
- Adds structured completion summaries before closing work items
- Supports config-driven extra Azure DevOps field defaults on create and done
- Supports hierarchy-aware work creation with config-backed `initiative`, `feature`, `backlog`, and `task` kinds
- Validates the active config shape before operational commands run
- Bootstraps config from Azure login or PAT-backed Azure DevOps access plus repo/project detection with `ael init`
- Runs preflight and read-only smoke checks with `ael doctor` and `ael smoke`, including branch policy and PR readiness checks
- Audits Azure DevOps drift and can repair safe issues like formatting, inferred missing PR links, PR tag sync, and overlap reporting
- Produces a quick human-readable status report for active work, blocked items, overlap risks, PR targets, hierarchy counts, and recent completions
- Identifies stale branches and PRs with first-class cleanup commands
- Renders editable backlog-analysis prompts with `ael backlog-create` and `ael backlog-polish`

## Current Backend

- Azure DevOps only
- Configured by generated local config in `.ael/config.local.json`

This repo no longer ships a checked-in active target config. Run `npm run ael:init` to generate `.ael/config.local.json` from Azure login and repo context. The older root filename `agent-execution.config.local.json` and the legacy filename `agent-execution.config.json` are still accepted for compatibility.

The long-term adoption model is package-based: install AEL in the downstream repo and call the `ael` bin entrypoint from that repo. See [docs/ADOPTING-AEL.md](docs/ADOPTING-AEL.md).

The downstream bootstrap command is `ael install`. By default it keeps repo impact minimal: a small root `AGENTS.md` discovery stub, `.ael/.gitignore`, `.ael/install.json`, `.ael/agent-guide.md`, `.ael/project-contract.md`, and `.ael/settings.json`. Pass `--with-scripts` if the downstream repo also wants the full `package.json` `ael:*` workflow shortcut set, `--entrypoint-file <path>` if the root discovery stub should live somewhere other than `AGENTS.md`, `--no-root-agents` if the repo already has its own root instruction file and you want AEL to stay entirely under `.ael/`, `--dry-run` if you want a preview before writing anything, or `--explain` if you want a managed-vs-user-owned ownership summary. Use `ael refresh` when you want one command that updates the installed AEL dependency and then refreshes AEL-managed files. Keep `ael upgrade` for the narrower case where the dependency was already updated and you only want to sync the managed repo files without overwriting `.ael/project-contract.md`, `.ael/settings.json`, or `.ael/config.local.json`.

If you want a copyable reference layout, start with [examples/downstream-minimal](examples/downstream-minimal).
If you want the script-driven variant, use [examples/downstream-with-scripts](examples/downstream-with-scripts).

## Troubleshooting

Common adoption failures are documented in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

The most common first fixes are:

- run `npx ael doctor --adoption` after `ael install`
- run `npx ael refresh --dry-run` before applying a one-command downstream update
- run `npx ael upgrade --dry-run` before applying managed-file refreshes when the dependency is already updated
- confirm `az login` or `AEL_ADO_PAT` is set before `ael init`
- install the Azure DevOps Azure CLI extension if `doctor` reports missing `az devops`
- use `ael install --entrypoint-file <path>` or `--no-root-agents` when the repo already owns its root instructions
- edit `.ael/settings.json` if you want to customize the backlog-analysis prompts
- use `ael block` / `ael unblock` when work is waiting on a human gate instead of leaving the reason implicit
- use `ael cleanup-branches --dry-run` and `ael cleanup-prs --dry-run` after a burst of agent work
- use `ael uninstall --dry-run` before cleanup if you want to see exactly what AEL would remove

This repo also exposes `npm run ael:*` scripts for local development. The older `npm run ado:*` aliases remain only for compatibility.

You can also point at a different config file with:

```bash
AGENT_EXECUTION_CONFIG=/absolute/path/to/config.json npm run ael:status
```

If a machine needs an explicit platform override, run `ael init --platform windows`, `ael init --platform mac`, or `ael init --platform linux`. That value is stored in the local `.ael/config.local.json` file because it is machine-specific.

## Setup

```bash
npm install
npm run format:check
npm run lint
npm run build
npm test
npm run ael:init
npm run ael:doctor
npm run ael:validate-config
npm run ael:backlog-create
npm run ael:backlog-polish
npm run ael:status
npm run ael:help
```

Prerequisites:

- Azure CLI installed
- Azure DevOps extension available in Azure CLI
- either `az login` completed for the target tenant/org or `AEL_ADO_PAT` exported for PAT-backed Azure DevOps auth

Auth note:

- normal status, report, doctor, branch, commit, and PR flows work with either `az login` or `AEL_ADO_PAT`
- PR label write-back and existing work-item comment repair are still strongest with `AEL_ADO_PAT`

Repo guardrails:

- Biome is the configured formatter and linter
- GitHub Actions CI runs format, lint, build, and test on pushes to `main` and pull requests across Ubuntu, macOS, and Windows

## Core Commands

```bash
npm run ael:init
npm run ael:doctor
npm run ael:smoke
npm run ael:validate-config
npm run ael:status
npm run ael:backlog-create
npm run ael:backlog-polish
npm run ael:enable
npm run ael:disable
npm run ael:block -- --id <id> --reason human-approval-needed
npm run ael:unblock -- --id <id>
npm run ael:create -- --title "<task>" --human-summary "<goal>" --agent-context "<technical context>"
npm run ael:start -- --id <id> --agent codex --assigned-to "<human>"
npm run ael:commit -- --id <id> --all --message "<subject>"
npm run ael:pr -- --id <id> --ready
npm run ael:done -- --id <id> --summary "<outcome>" --impact "<business value>"
npm run ael:cleanup-branches -- --dry-run
npm run ael:cleanup-prs -- --dry-run
npm run ael:audit -- --state open --limit 100
npm run ael:report
```

## Reviewer / PR Tag Behavior

- Reviewer assignment is optional
- `--reviewer "<email-or-ado-id>"` adds a specific human reviewer
- `--reviewer assigned` uses the work item assignee
- `--no-reviewer` forces no reviewer even if config defaults change later
- `--target prod` or `--rollout` lets PRs use configured rollout branches instead of always targeting the default branch
- PR tag sync is on by default and mirrors linked work item tags onto the PR
- assignee and reviewer identities are resolved through Azure DevOps before write operations run

## Config Validation

- `npm run ael:validate-config` checks the current config file for required fields, enum values, and obvious placeholder values
- `npm run ael:status` reports whether the current config is valid before printing normalized defaults

## Bootstrap And Health Checks

- `npm run ael:init` bootstraps a config from Azure DevOps and git remote context, auto-detects repo ID plus default area/iteration paths, and can run fully non-interactively with flags
- `npm run ael:doctor` checks git context, Azure CLI or PAT auth, config validity, project access, repository access, configured identities, branch policies, and default branch reachability
- `npm run ael:doctor -- --adoption` checks that a downstream repo's `.ael` install contract is wired correctly
- `npm run ael:block` and `npm run ael:unblock` provide first-class human-gate workflow states
- `npm run ael:backlog-create` renders the editable prompt for finding gaps and creating new backlog items
- `npm run ael:backlog-polish` renders the editable prompt for refining existing backlog items
- `npx ael install --dry-run` previews downstream adoption changes without mutating the repo
- `npx ael refresh` updates the installed AEL dependency in a downstream repo and then runs the managed-file refresh automatically
- `npx ael upgrade` refreshes AEL-managed downstream files after dependency updates while preserving repo-owned `.ael/project-contract.md`, `.ael/settings.json`, and `.ael/config.local.json`
- `npx ael install --explain`, `npx ael upgrade --explain`, and `npx ael uninstall --explain` print the managed/user-owned/local-only file contract
- `npx ael uninstall` removes AEL-managed downstream files and exact-match `ael:*` script shims
- `npx ael cleanup-branches` and `npx ael cleanup-prs` identify stale workflow residue before it turns into repo noise
- `npm run ael:smoke` runs the doctor flow plus read-only work item queries, PR list queries, and active PR merge-readiness inspection
- `status`, `validate-config`, `backlog-create`, `backlog-polish`, `init`, `doctor`, `smoke`, `upgrade`, `list`, `next`, `create`, `claim`, `branch`, `start`, `commit`, `pr`, `done`, `retag`, `audit`, `report`, `enable`, `disable`, `block`, `unblock`, `cleanup-branches`, and `cleanup-prs` all support `--json` for agent-safe parsing

## Config Shape

- `configVersion` version-stamps the generated config
- `defaultBranch` is used by `start`, `branch`, and `pr` unless overridden
- `agents` is an explicit list of agent definitions with `key`, `tag`, `branchPrefix`, and `defaultAssignee`
- `defaultAgent` is the fallback for commands that can infer an agent
- `workItemFieldDefaults.create` and `workItemFieldDefaults.done` can stamp extra Azure DevOps field values during item creation and closeout
- `cleanupDefaults` controls stale-branch and stale-PR cleanup thresholds
- `coordination.areaTags` and `coordination.humanBlockReasons` drive overlap-aware reporting and explicit human-block tags
- `branching` config defines development branches, rollout branches, and branch aliases like `prod`
- `hierarchyDefaults` maps AEL work kinds like `feature` or `backlog` to your Azure DevOps work item types
- `runtime.platform` lets a local config pin command behavior to `auto`, `windows`, `mac`, or `linux`

## Files

- `scripts/ael.ts`: thin CLI entrypoint and command dispatcher
- `scripts/lib/command-runtime.ts`: low-level platform command profiles and command invocation routing for Windows, macOS, and Linux
- `scripts/lib/ado-cli-runtime.ts`: shared CLI/runtime helpers
- `scripts/lib/ado-cli-bootstrap.ts`: status, init, doctor, and help flows
- `scripts/lib/ado-cli-workflow.ts`: work-item, branch, commit, PR, and done flows
- `scripts/lib/ado-cli-cleanup.ts`: stale branch and PR cleanup flows
- `scripts/lib/ado-cli-reporting.ts`: retag, list, next, audit, and report flows
- `scripts/lib/ado-cli-install.ts`: downstream install/bootstrap flow
- `scripts/lib/ado-cli-types.ts`: internal workflow types
- `bin/ael.js`: package entrypoint for downstream install/use
- `.ael/.gitignore`: hides local AEL state while keeping committed guidance visible
- `.ael/install.json`: install manifest used by `doctor --adoption`
- `.ael/config.local.json`: generated local config written by `ael:init`
- `.ael/agent-guide.md`: downstream agent workflow instructions
- `.ael/project-contract.md`: downstream repo-specific validation and escalation policy
- `.ael/settings.json`: editable downstream prompt settings for backlog-create/backlog-polish
- `agent-execution.config.example.json`: reusable template
- `docs/ADOPTING-AEL.md`: downstream adoption guide
- `docs/FIRST-PUSH-CHECKLIST.md`: release and publish-readiness checklist
- `docs/RELEASE-POLICY.md`: lightweight release/versioning policy
- `docs/UPSTREAM-CONTRIBUTIONS.md`: policy for downstream agents reporting or contributing upstream fixes
- `docs/TROUBLESHOOTING.md`: common install, init, and cleanup failure cases
- `CHANGELOG.md`: rolling user-visible change log
- `examples/downstream-minimal`: copyable low-noise downstream repo layout
- `examples/downstream-with-scripts`: copyable downstream layout with `package.json` script shims
- `templates/downstream/*`: downstream package/agent/project-contract templates
- `.github/*`: public GitHub issue, PR, and ownership templates
- `docs/PROJECT-CONTEXT.md`: current project context and next hardening priorities
- `docs/ADO-WORKFLOW.md`: operational Azure DevOps workflow reference
- `AGENTS.md`: agent instructions for this repo
