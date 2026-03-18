# AEL Workflow

This repo uses the Agent Execution Layer (`ael`) as the workflow authority for Azure DevOps work.

## First Step

Before taking any action, run:

```bash
{{WORKFLOW_STATUS_COMMAND}}
```

If config is missing, run:

```bash
{{WORKFLOW_INIT_COMMAND}}
{{WORKFLOW_DOCTOR_COMMAND}}
```

## Execution Flow

Use this order unless the user explicitly directs otherwise:

1. `{{WORKFLOW_NEXT_COMMAND}}`
2. `{{WORKFLOW_START_COMMAND}}`
3. implement the change
4. run the project validation commands listed below
5. `{{WORKFLOW_COMMIT_COMMAND}}`
6. `{{WORKFLOW_PR_COMMAND}}`
7. `{{WORKFLOW_DONE_COMMAND}}`

If work cannot proceed without a human or external setup, use the repo's AEL entrypoint for `block` instead of leaving the item in a generic limbo state.

## Agent Key

Use this agent key by default:

- `{{AGENT_KEY}}`

## Required Validation Before PR

Run these before moving a PR out of draft:

{{VALIDATION_COMMANDS}}

Repo-specific policy lives in:

- `.ael/project-contract.md`
- `.ael/settings.json` controls backlog and orchestration prompt templates plus orchestration policy defaults

## Orchestration

Use orchestration when one backlog item is large enough to benefit from delegation, or when a related set of items can safely move together under one orchestrator.

Primary orchestration commands:

- `{{WORKFLOW_ORCHESTRATE_COMMAND}}`
- `{{WORKFLOW_ORCHESTRATE_STATUS_COMMAND}}`
- `{{WORKFLOW_ORCHESTRATE_SYNC_COMMAND}}`
- `{{WORKFLOW_ORCHESTRATE_FINALIZE_COMMAND}}`
- `{{WORKFLOW_ORCHESTRATE_STOP_COMMAND}}`
- `{{WORKFLOW_SUBAGENT_CHECKIN_COMMAND}}`

Important rules:

- the orchestrator remains the final integration and PR authority
- Codex subagents should use the generated briefs under `.ael/orchestration/`
- local orchestration manifests, child briefs, and event logs live under `.ael/orchestration/` and are intentionally local-only
- child agents must check in explicitly instead of silently disappearing
- grouped work should only be finalized after the orchestrator verifies all required child work and repo validations

## Backlog Hygiene

When you need to identify missing follow-up work or clean up the existing backlog, use:

- `{{WORKFLOW_STATUS_COMMAND}}`
- `{{WORKFLOW_REPORT_COMMAND}}`
- `{{WORKFLOW_AUDIT_COMMAND}}`
- `{{WORKFLOW_BACKLOG_CREATE_COMMAND}}`
- `{{WORKFLOW_BACKLOG_POLISH_COMMAND}}`

After a burst of agent activity, also use the repo's AEL entrypoint for branch and PR cleanup previews before asking a human to remove stale workflow residue.

## Human Supervision

Escalate to a human instead of acting unilaterally when:

- `{{WORKFLOW_DOCTOR_COMMAND}}` fails
- required validation is failing or ambiguous
- the work item is blocked or conflicts with another active item
- the change impacts production, data correctness, or security-sensitive behavior
- reviewer policy or merge readiness is unclear

## Upstream AEL Issues

If you discover a probable AEL bug while using this repo:

1. capture the exact `ael` command, output, and a minimal reproduction
2. do not upstream proprietary project code, secrets, or internal business context
3. ask the human whether to:
   - keep it local,
   - open a GitHub issue on `ntwg/agent-execution-layer`,
   - or prepare an upstream GitHub PR

Default upstream action should be a GitHub issue.

Only prepare an upstream PR with explicit human approval. If approved:

- use GitHub issue/PR workflow, not Azure DevOps work items
- do not auto-fork, auto-push, or auto-open an upstream PR without that approval
- keep the change narrowly scoped
- add or update tests when practical
- run `npm run check`
- summarize the change with:
  - problem
  - reproduction
  - fix
  - validation

## Reviewer Policy

- keep PRs draft until validation passes
- add the human reviewer required by this repo
- do not bypass reviewer requirements
