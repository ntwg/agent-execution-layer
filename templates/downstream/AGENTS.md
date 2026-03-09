# AEL Workflow

This repo uses the Agent Execution Layer (`ael`) as the workflow authority for Azure DevOps work.

## First Step

Before taking any action, run:

```bash
npm run ael:status
```

If config is missing, run:

```bash
npm run ael:init
npm run ael:doctor
```

## Execution Flow

Use this order unless the user explicitly directs otherwise:

1. `npm run ael:next -- --agent <agent-key>`
2. `npm run ael:start -- --id <id> --agent <agent-key>`
3. implement the change
4. run the project validation commands listed below
5. `npm run ael:commit -- --id <id> --all --message "<subject>"`
6. `npm run ael:pr -- --id <id> --ready`
7. `npm run ael:done -- --id <id> --summary "<outcome>" --impact "<value>"`

## Agent Key

Use this agent key by default:

- `{{AGENT_KEY}}`

## Required Validation Before PR

Run these before moving a PR out of draft:

{{VALIDATION_COMMANDS}}

Repo-specific policy lives in:

- `docs/AEL-PROJECT-CONTRACT.md`

## Human Supervision

Escalate to a human instead of acting unilaterally when:

- `npm run ael:doctor` fails
- required validation is failing or ambiguous
- the work item is blocked or conflicts with another active item
- the change impacts production, data correctness, or security-sensitive behavior
- reviewer policy or merge readiness is unclear

## Reviewer Policy

- keep PRs draft until validation passes
- add the human reviewer required by this repo
- do not bypass reviewer requirements
