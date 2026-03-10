# Upstream Contributions

Use this guide when an agent or downstream repo discovers a probable AEL bug while using the product.

## Goal

Create a safe feedback loop from downstream usage back into the public AEL repo without leaking private code or letting agents make upstream changes unilaterally.

## Default Modes

Use one of these modes:

1. `observe`
2. `report`
3. `contribute`

Default mode should be `report`, not `contribute`.

## Observe

Use `observe` when:

- the issue is minor or uncertain
- the current downstream task should continue
- the human has not asked for upstream action

In this mode, capture:

- the exact `ael` command
- the output or failure
- the repo context needed to understand the issue
- the smallest reproduction you can describe safely

## Report

Use `report` when the human wants the issue tracked upstream but does not want a code change prepared yet.

Default upstream action:

- open or update a GitHub issue on `ntwg/agent-execution-layer`

Issue content should include:

- problem summary
- exact command
- observed output or error
- expected behavior
- minimal reproduction
- whether the issue blocks downstream work

Do not include:

- proprietary downstream source code
- secrets, tokens, or credentials
- internal business context that is not needed to reproduce the issue

## Contribute

Use `contribute` only with explicit human approval.

Allowed upstream path:

- fork/branch on GitHub
- create a GitHub PR against `ntwg/agent-execution-layer`
- never auto-fork, auto-push, or auto-open an upstream PR without explicit human approval

Do not use the private Azure DevOps workflow as the upstream contribution path for external/downstream users.

## PR Quality Bar

An upstream AEL PR should follow the same quality bar as internal workflow changes, even though the transport is GitHub-native instead of Azure DevOps-native.

Expected standard:

- narrowly scoped fix
- clear root cause
- minimal reproduction
- tests added or updated when practical
- `npm run check` passing

Recommended PR summary sections:

- problem
- reproduction
- fix
- validation

## Approval Rule

Agents should not automatically fork and open upstream PRs just because they noticed an issue.

The safe default is:

1. capture the issue
2. ask the human whether to keep it local, report it, or contribute a fix
3. proceed only with the approved level of upstream action

## Downstream Policy

Downstream repos adopting AEL should include a short version of this policy in their root `AGENTS.md` discovery stub plus `.ael/project-contract.md`.

Recommended downstream default:

- issue-first reporting is allowed
- upstream PR preparation requires explicit human approval
- no proprietary code may be copied into upstream issues or PRs
