# Contributing

This repo is the reusable Agent Execution Layer for Azure DevOps-backed workflows.

## Local Development

```bash
npm install
npm run build
npm test
npm run ael:help
```

Use `npm run ael:*` as the primary repo-local command surface. Legacy `npm run ado:*` aliases still exist, but they are compatibility aliases and should not be the default in new docs or examples.

## Contribution Rules

- Keep the workflow engine generic and config-driven.
- Keep Azure DevOps-specific behavior isolated to backend logic, not project-specific policy.
- Avoid semantic-layer-specific assumptions in commands, docs, or defaults.
- Prefer focused changes over broad refactors unless the refactor is the objective.
- Update [README.md](/Users/nwagner/repos/agent-execution-layer/README.md), [AGENTS.md](/Users/nwagner/repos/agent-execution-layer/AGENTS.md), and [docs/ADO-WORKFLOW.md](/Users/nwagner/repos/agent-execution-layer/docs/ADO-WORKFLOW.md) together when the user-facing workflow changes.

## Before Opening A PR

Run the relevant checks:

```bash
npm run build
npm test
```

If your change touches CLI behavior, also run the relevant command path directly, for example:

```bash
npm run ael:status -- --json
npm run ael:doctor -- --json
```
