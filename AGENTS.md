# AGENTS.md - Agent Execution Layer

Use this repo as the standalone Azure DevOps execution engine.

## Goal

Provide a reusable Azure DevOps workflow layer that can be plugged into other projects without rewriting the agent-workflow logic each time.

## Start Here

Read these first when beginning work without prior thread context:

1. `README.md`
2. `docs/PROJECT-CONTEXT.md`
3. `docs/ADO-WORKFLOW.md`
4. `docs/FIRST-PUSH-CHECKLIST.md`
5. `docs/RELEASE-POLICY.md`
6. `docs/UPSTREAM-CONTRIBUTIONS.md`

## Working Rules

- Keep this repo generic; do not hardcode project-specific business logic into the core workflow engine.
- Backend-specific behavior should stay Azure DevOps-focused for now.
- Prefer config-driven defaults over repo-specific assumptions.
- Keep commits scoped to one objective or tightly related file group.
- Before edits, check repo status and sync if a remote exists.
- Default assumption: this repo should remain the generic reusable workflow engine, while domain-specific logic stays elsewhere.

## Core Config

- Active config: `.ael/config.local.json`
- Root compatibility fallback: `agent-execution.config.local.json`
- Legacy fallback: `agent-execution.config.json`
- Reusable template: `agent-execution.config.example.json`

## Core Commands

```bash
npm install
npm run build
npm test
npm run ael:init
npm run ael:doctor
npm run ael:validate-config
npm run ael:status
npm run ael:help
npm run ael:create -- --title "<task>" --human-summary "<goal>" --agent-context "<technical context>"
npm run ael:start -- --id <id> --agent codex --assigned-to "<human>"
npm run ael:commit -- --id <id> --all --message "<subject>"
npm run ael:pr -- --id <id> --ready
npm run ael:done -- --id <id> --summary "<outcome>" --impact "<business value>"
npm run ael:audit -- --state open --limit 100
npm run ael:report
```

Use `npm run ael:*` as the primary repo-local command surface. `npm run ado:*` aliases remain only for compatibility.
Use `--json` on AEL commands when an agent needs machine-readable results.

## Design Direction

This repo is intended to become the reusable execution/control layer that other project-specific repos can adopt.

Keep these boundaries clear:

- this repo owns Azure DevOps workflow mechanics, traceability, audits, and status reporting
- downstream repos own project-specific tags, validations, content, and domain rules

Adoption target:

- downstream repos should install this repo as a package and call the `ael` bin entrypoint
- downstream repos should bootstrap themselves with `ael install`
- downstream repos should keep their repo-local workflow guidance under `.ael/`
- downstream repos should keep only a small root discovery stub in `AGENTS.md`

## Upstream Bugs And Fixes

If an agent finds a probable AEL bug while using AEL in a downstream repo:

1. Capture the exact `ael` command, output, and minimal reproduction.
2. Keep proprietary downstream code, secrets, and business context out of any upstream report.
3. Ask the human whether to:
   - keep the issue local,
   - open a GitHub issue on `ntwg/agent-execution-layer`,
   - or prepare an upstream GitHub PR.
4. Default to issue-first reporting.
5. Prepare an upstream PR only with explicit human approval.

When preparing an upstream PR:

- use GitHub issue/PR workflow, not Azure DevOps work items
- do not auto-fork, auto-push, or auto-open upstream PRs without that approval
- keep the fix narrowly scoped
- add or update tests when possible
- run `npm run check`
- summarize the change with:
  - problem
  - reproduction
  - fix
  - validation

## Current Priority

Until this repo is more fully productized, prioritize:

1. confirming the downstream installed-package path in a clean repo
2. deciding final publish posture and package visibility
3. expanding automated CLI coverage where downstream adoption exposes real gaps
4. keeping the `.ael/` downstream layout stable and easy for zero-context agents to discover
5. keeping any future GitHub support scoped behind Azure DevOps-first design

## References

- `README.md`
- `docs/PROJECT-CONTEXT.md`
- `docs/ADO-WORKFLOW.md`
- `docs/ADOPTING-AEL.md`
- `docs/FIRST-PUSH-CHECKLIST.md`
- `docs/RELEASE-POLICY.md`
- `docs/UPSTREAM-CONTRIBUTIONS.md`
- `CHANGELOG.md`
- `scripts/ael.ts`
- `scripts/lib/ado-cli-*.ts`
