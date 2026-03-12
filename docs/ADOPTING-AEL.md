# Adopting AEL

Use this guide when adding the Agent Execution Layer to another repository.

## Goal

The target state is:

- install AEL as a package dependency
- expose a small set of repo-local scripts or direct `ael` commands
- generate repo-local config with `ael init`
- keep AEL metadata in a hidden `.ael/` directory
- give agents one obvious root-level entrypoint in the downstream repo's `AGENTS.md`
- let teams customize backlog-analysis prompts through `.ael/settings.json`

This keeps the workflow engine reusable while leaving project-specific validation and escalation rules in the downstream repo.

## Quickstart

Until npm publishing is enabled, the simplest downstream path is:

```bash
npm install -D github:ntwg/agent-execution-layer
npx ael install
npx ael doctor --adoption
npx ael init
npx ael status
```

If you want to preview the generated repo changes first, run `npx ael install --dry-run`.

## Recommended Consumption Model

Use AEL as a CLI package, not as copied source files.

That means the downstream repo should:

1. install the package
2. run `ael install`
3. generate `.ael/config.local.json`
4. let the agent read the root `AGENTS.md` discovery stub, then `.ael/agent-guide.md`

Default install mode is intentionally minimal:

- no `package.json` mutation
- no root `.gitignore` mutation
- tracked `.ael/.gitignore` handles local AEL state
- repo-local instructions and policy stay under `.ael/`
- backlog prompt templates stay editable in `.ael/settings.json`

If a downstream repo wants repo-local script shortcuts, run `ael install --with-scripts`.
If a downstream repo wants the root discovery stub somewhere other than `AGENTS.md`, run `ael install --entrypoint-file <path>`.
If a downstream repo already has its own root instruction file, run `ael install --no-root-agents` to keep AEL entirely under `.ael/`.
If a downstream repo wants to see the exact changes before writing anything, run `ael install --dry-run`.

This repo is now package-ready with an `ael` bin entrypoint. It is still marked `private` until publish timing and package visibility are finalized.

Short term:
- consume it via local path, workspace dependency, or Git URL

Future steady state:
- publish it and install with normal package-manager workflow

## Downstream Setup

Use the templates in:

- `templates/downstream/package-scripts.json`
- `templates/downstream/AGENTS.md`
- `templates/downstream/agent-guide.md`
- `templates/downstream/AEL-PROJECT-CONTRACT.md`
- `templates/downstream/settings.json`

Minimum downstream setup:

1. install the package dependency
2. run `ael install`
3. review the generated root `AGENTS.md` discovery stub
4. fill out `.ael/project-contract.md` with repo-specific validation and escalation rules
5. edit `.ael/settings.json` if you want custom backlog-create/backlog-polish prompts
6. run `npx ael init` or your package-manager equivalent
7. if the machine needs it, re-run `npx ael init --platform windows|mac|linux`
8. run `npx ael doctor` or your package-manager equivalent
9. run `npx ael status` or your package-manager equivalent

If the repo prefers `npm run ael:*` scripts, use `ael install --with-scripts` instead.
If the repo already manages its own root `AGENTS.md`, use `ael install --no-root-agents` and point that existing file at `.ael/agent-guide.md`.
If you want to remove AEL later, use `ael uninstall` or preview the cleanup with `ael uninstall --dry-run`.

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
- whether and how agents may report or contribute upstream AEL fixes

## Zero-Context Agent Contract

If a zero-context agent lands in a downstream repo, it should be able to do this:

1. run `npx ael status` or the repo's chosen `ael` entrypoint
2. if config is missing, run `npx ael init`
3. run `npx ael doctor`
4. run `npx ael next -- --agent <agent-key>`
5. start and execute work through AEL commands

For that to work, the downstream repo must clearly define:

- the agent key it expects
- the required validation commands before PR
- when a human must review or approve
- when the agent must escalate instead of acting

`ael install` now bootstraps most of that by:

- adding or appending a small AEL discovery block to `AGENTS.md`
- creating `.ael/.gitignore`
- creating `.ael/install.json`
- creating `.ael/agent-guide.md`
- creating `.ael/project-contract.md`
- creating `.ael/settings.json`
- keeping `.ael/config.local.json` ignored through `.ael/.gitignore` while the committed guide and contract remain visible

Platform note:

- `.ael/config.local.json` now carries a machine-local `runtime.platform` value
- leave it as `auto` in most repos
- set it to `windows`, `mac`, or `linux` only when a machine needs an explicit override

See [examples/downstream-minimal](../examples/downstream-minimal) for a copyable minimal layout after install.
See [examples/downstream-with-scripts](../examples/downstream-with-scripts) for the script-shim variant.

Optional standard mode:

- `ael install --with-scripts` also adds repo-local `ael:*` package scripts
- `ael install --dry-run` previews the exact files and scripts AEL would touch
- script mode exposes the full repo-local `ael:*` workflow shortcut set, including `ael:backlog-create`, `ael:backlog-polish`, `ael:claim`, `ael:prioritize`, `ael:link`, `ael:branch`, and `ael:retag`

Optional custom entrypoint mode:

- `ael install --entrypoint-file docs/WORKFLOW.md` writes the root discovery stub to a custom repo-local file

Optional no-root mode:

- `ael install --no-root-agents` skips creating or editing `AGENTS.md`
- use this only when the downstream repo already has its own root discovery instructions

Cleanup mode:

- `ael uninstall` removes AEL-managed downstream files and exact-match package-script shims
- `ael uninstall --dry-run` previews that cleanup before changing the repo

## Adoption Verification

Use `ael doctor --adoption` to verify that the downstream repo is wired correctly.

It checks:

- `.ael/install.json`
- `.ael/.gitignore`
- `.ael/agent-guide.md`
- `.ael/project-contract.md`
- `.ael/settings.json`
- the expected root discovery entrypoint file
- required `ael:*` scripts when install mode is `--with-scripts`

## Troubleshooting

Use [docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for the common failure cases:

- `ael` command not found in the downstream repo
- `ael doctor --adoption` failing after install
- `ael init` not detecting the Azure DevOps target
- Azure auth or repo-access failures during `doctor`
- Windows or Mac command-routing issues
- `ael uninstall` preserving customized files or scripts

## Recommended Human Supervision Policy

Default recommendation for downstream repos:

- keep PRs draft until validations pass
- require a human reviewer for merge
- require human escalation for production-impacting changes
- require human escalation when `doctor` fails or repo state is inconsistent
- do not let the agent invent validation requirements; define them in the downstream project contract

## Upstream Feedback Loop

Downstream repos should define how agents handle probable AEL bugs found during normal use.

Recommended default:

1. capture the exact `ael` command, output, and minimal reproduction
2. keep proprietary repo code and secrets out of any upstream report
3. ask the human whether to:
   - keep it local,
   - open a GitHub issue on `ntwg/agent-execution-layer`,
   - or prepare an upstream GitHub PR

Recommended policy:

- default to GitHub issue reporting first
- allow upstream PR preparation only with explicit human approval
- use GitHub-native contribution flow for upstream AEL fixes
- keep the quality bar the same as internal AEL changes:
  - scoped fix
  - reproduction
  - validation
  - tests when practical

See [docs/UPSTREAM-CONTRIBUTIONS.md](./UPSTREAM-CONTRIBUTIONS.md).

## Near-Term Gaps

Before calling AEL fully drop-in for arbitrary repos, we still want:

- a final publish decision for package visibility and install mode defaults

That said, the package/install shape is now the right long-term model.
