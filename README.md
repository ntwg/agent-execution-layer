# Agent Execution Layer

A standalone Azure DevOps workflow engine for multi-agent software delivery.

This repo extracts the Azure DevOps execution system that was originally built inside `semantic-layer` and makes it reusable across projects. It manages work-item intake, agent claiming, linked branches, `AB#<id>` commit discipline, linked PR creation, closeout summaries, drift audits, and human-readable status reporting.

The source implementation remains in `semantic-layer`. This repo is an extracted copy for reuse, not a cutover.

If you are starting work here without prior conversation context, read [docs/PROJECT-CONTEXT.md](/Users/nwagner/repos/agent-execution-layer/docs/PROJECT-CONTEXT.md) after this file.

## What It Does

- Creates and updates Azure DevOps work items with a standard two-audience structure
- Claims work for specific agents while keeping the responsible human in `Assigned To`
- Creates linked branches and enforces `AB#<id>` commit discipline
- Opens linked PRs with optional human reviewers and synced PR tags
- Adds structured completion summaries before closing work items
- Validates the active config shape before operational commands run
- Bootstraps config from Azure login plus repo/project detection with `ael init`
- Runs preflight and read-only smoke checks with `ael doctor` and `ael smoke`
- Audits Azure DevOps drift and can repair safe issues like formatting, inferred missing PR links, and PR tag sync
- Produces a quick human-readable status report for active work, blocked items, PRs, and recent completions

## Current Backend

- Azure DevOps only
- Configured by generated local config in `agent-execution.config.local.json`

This repo no longer ships a checked-in active target config. Run `npm run ael:init` to generate `agent-execution.config.local.json` from Azure login and repo context. The legacy filename `agent-execution.config.json` is still accepted for older consumers.

The long-term adoption model is package-based: install AEL in the downstream repo and call the `ael` bin entrypoint from that repo's scripts. See [docs/ADOPTING-AEL.md](/Users/nwagner/repos/agent-execution-layer/docs/ADOPTING-AEL.md).

The downstream bootstrap command is `ael install`, which writes the recommended package scripts, `AGENTS.md` workflow block, project contract template, and `.gitignore` entry.

This repo also exposes `npm run ael:*` scripts for local development. The older `npm run ado:*` aliases remain only for compatibility.

You can also point at a different config file with:

```bash
AGENT_EXECUTION_CONFIG=/absolute/path/to/config.json npm run ael:status
```

## Setup

```bash
npm install
npm run build
npm test
npm run ael:init
npm run ael:doctor
npm run ael:validate-config
npm run ael:status
npm run ael:help
```

Prerequisites:

- Azure CLI installed
- Azure DevOps extension available in Azure CLI
- `az login` completed for the target tenant/org

## Core Commands

```bash
npm run ael:init
npm run ael:doctor
npm run ael:smoke
npm run ael:validate-config
npm run ael:status
npm run ael:enable
npm run ael:disable
npm run ael:create -- --title "<task>" --human-summary "<goal>" --agent-context "<technical context>"
npm run ael:start -- --id <id> --agent codex --assigned-to "<human>"
npm run ael:commit -- --id <id> --all --message "<subject>"
npm run ael:pr -- --id <id> --ready
npm run ael:done -- --id <id> --summary "<outcome>" --impact "<business value>"
npm run ael:audit -- --state open --limit 100
npm run ael:report
```

## Reviewer / PR Tag Behavior

- Reviewer assignment is optional
- `--reviewer "<name>"` adds a specific human reviewer
- `--reviewer assigned` uses the work item assignee
- `--no-reviewer` forces no reviewer even if config defaults change later
- PR tag sync is on by default and mirrors linked work item tags onto the PR

## Config Validation

- `npm run ael:validate-config` checks the current config file for required fields, enum values, and obvious placeholder values
- `npm run ael:status` reports whether the current config is valid before printing normalized defaults

## Bootstrap And Health Checks

- `npm run ael:init` bootstraps a config from Azure DevOps and git remote context, and can run fully non-interactively with flags
- `npm run ael:doctor` checks git context, Azure CLI/auth, config validity, project access, repository access, and default branch reachability
- `npm run ael:smoke` runs the doctor flow plus read-only work item and PR list queries
- `status`, `validate-config`, `init`, `doctor`, `smoke`, `list`, `next`, `create`, `claim`, `branch`, `start`, `commit`, `pr`, `done`, `retag`, `audit`, `report`, `enable`, and `disable` all support `--json` for agent-safe parsing

## Config Shape

- `configVersion` version-stamps the generated config
- `defaultBranch` is used by `start`, `branch`, and `pr` unless overridden
- `agents` is an explicit list of agent definitions with `key`, `tag`, `branchPrefix`, and `defaultAssignee`
- `defaultAgent` is the fallback for commands that can infer an agent

## Files

- `scripts/ado-workflow.ts`: extracted Azure DevOps workflow engine
- `scripts/lib/*.ts`: extracted config/bootstrap/PR-description helpers
- `bin/ael.js`: package entrypoint for downstream install/use
- `agent-execution.config.local.json`: generated local config written by `ael:init`
- `agent-execution.config.example.json`: reusable template
- `docs/ADOPTING-AEL.md`: downstream adoption guide
- `docs/FIRST-PUSH-CHECKLIST.md`: release and publish-readiness checklist
- `docs/RELEASE-POLICY.md`: lightweight release/versioning policy
- `CHANGELOG.md`: rolling user-visible change log
- `templates/downstream/*`: downstream package/agent/project-contract templates
- `.github/*`: public GitHub issue, PR, and ownership templates
- `docs/PROJECT-CONTEXT.md`: current project context and next hardening priorities
- `docs/ADO-WORKFLOW.md`: operational Azure DevOps workflow reference
- `AGENTS.md`: agent instructions for this repo
