# Adopting AEL

Use this guide when adding the Agent Execution Layer to another repository.

## Goal

The target state is:

- install AEL as a package dependency
- expose a small set of repo-local scripts
- generate repo-local config with `ael init`
- give agents one obvious entrypoint in the downstream repo's `AGENTS.md`

This keeps the workflow engine reusable while leaving project-specific validation and escalation rules in the downstream repo.

## Recommended Consumption Model

Use AEL as a CLI package, not as copied source files.

That means the downstream repo should:

1. install the package
2. run `ael install`
3. generate `agent-execution.config.local.json`
4. let the agent read the installed AEL workflow section in `AGENTS.md`

This repo is now package-ready with an `ael` bin entrypoint, but it is still marked `private` until the first real guinea-pig validation pass is complete.

Short term:
- consume it via local path, workspace dependency, or Git URL

Future steady state:
- publish it and install with normal package-manager workflow

## Downstream Setup

Use the templates in:

- `templates/downstream/package-scripts.json`
- `templates/downstream/AGENTS.md`
- `templates/downstream/AEL-PROJECT-CONTRACT.md`

Minimum downstream setup:

1. install the package dependency
2. run `ael install`
3. review the generated `AGENTS.md` AEL block
4. fill out `docs/AEL-PROJECT-CONTRACT.md` with repo-specific validation and escalation rules
5. run `npm run ael:init`
6. run `npm run ael:doctor`
7. run `npm run ael:status`

## What AEL Owns

AEL should own:

- ADO work item lifecycle
- branch and commit traceability
- PR creation and linkage
- closeout formatting
- ADO audits and reporting

The downstream repo should own:

- build/test/validation commands
- required reviewer policy when it differs by repo
- domain-specific tags
- escalation triggers
- deployment/release rules

## Zero-Context Agent Contract

If a zero-context agent lands in a downstream repo, it should be able to do this:

1. run `npm run ael:status`
2. if config is missing, run `npm run ael:init`
3. run `npm run ael:doctor`
4. run `npm run ael:next -- --agent <agent-key>`
5. start and execute work through AEL commands

For that to work, the downstream repo must clearly define:

- the agent key it expects
- the required validation commands before PR
- when a human must review or approve
- when the agent must escalate instead of acting

`ael install` now bootstraps most of that by:

- adding repo-local `ael:*` package scripts
- adding or appending an AEL block to `AGENTS.md`
- creating `docs/AEL-PROJECT-CONTRACT.md`
- ensuring `agent-execution.config.local.json` is ignored

## Recommended Human Supervision Policy

Default recommendation for downstream repos:

- keep PRs draft until validations pass
- require a human reviewer for merge
- require human escalation for production-impacting changes
- require human escalation when `doctor` fails or repo state is inconsistent
- do not let the agent invent validation requirements; define them in the downstream project contract

## Near-Term Gaps

Before calling AEL fully drop-in for arbitrary repos, we still want:

- further command/module extraction from the main CLI file
- one real live validation pass on the guinea-pig repo

That said, the package/install shape is now the right long-term model.
