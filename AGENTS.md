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

## Working Rules

- Keep this repo generic; do not hardcode semantic-layer-specific business logic into the core workflow engine.
- Backend-specific behavior should stay Azure DevOps-focused for now.
- Prefer config-driven defaults over repo-specific assumptions.
- Keep commits scoped to one objective or tightly related file group.
- Before edits, check repo status and sync if a remote exists.
- The semantic-layer copy stays in place; extraction work here should not assume the source repo will remove its local implementation.
- Default assumption: this repo should become the generic reusable workflow engine, while semantic/business logic stays elsewhere.

## Core Config

- Active config: `agent-execution.config.local.json`
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
- downstream repos should keep their own project contract and validation rules in local docs/AGENTS

## Current Priority

Until this repo is more fully productized, prioritize:

1. validating against a fresh guinea-pig Azure DevOps project
2. running a full live lifecycle test
3. breaking the workflow CLI into focused modules
4. expanding automated CLI coverage after the first live pass
5. keeping any future GitHub support scoped behind Azure DevOps-first design

## References

- `README.md`
- `docs/PROJECT-CONTEXT.md`
- `docs/ADO-WORKFLOW.md`
- `docs/ADOPTING-AEL.md`
- `docs/FIRST-PUSH-CHECKLIST.md`
- `docs/RELEASE-POLICY.md`
- `CHANGELOG.md`
- `scripts/ado-workflow.ts`
