# AEL Workflow

This repo uses the Agent Execution Layer (`ael`) as the workflow authority for Azure DevOps work.

## First Step

Before taking any action, run:

```bash
npx ael status
```

If config is missing, run:

```bash
npx ael init
npx ael doctor
```

## Execution Flow

Use this order unless the user explicitly directs otherwise:

1. `npx ael next -- --agent <agent-key>`
2. `npx ael start -- --id <id> --agent <agent-key>`
3. implement the change
4. run the project validation commands listed below
5. `npx ael commit -- --id <id> --all --message "<subject>"`
6. `npx ael pr -- --id <id> --ready`
7. `npx ael done -- --id <id> --summary "<outcome>" --impact "<value>"`

## Agent Key

Use this agent key by default:

- `codex`

## Required Validation Before PR

Run these before moving a PR out of draft:

- `<fill-in-build-command>`
- `<fill-in-test-command>`
- `<fill-in-any-domain-validation>`

Repo-specific policy lives in:

- `.ael/project-contract.md`

## Human Supervision

Escalate to a human instead of acting unilaterally when:

- `npx ael doctor` fails
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
