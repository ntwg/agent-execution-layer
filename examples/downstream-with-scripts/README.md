# Downstream With-Scripts Example

This folder shows the tracked footprint a downstream repo gets after:

```bash
npx ael install --with-scripts
```

Assumptions for this example:

- the downstream repo has a `package.json`
- the repo wants `npm run ael:*` shortcuts
- the repo uses the default root `AGENTS.md` discovery stub

Tracked files:

- `package.json`
- `AGENTS.md`
- `.ael/.gitignore`
- `.ael/install.json`
- `.ael/agent-guide.md`
- `.ael/project-contract.md`
- `.ael/settings.json`

Generated local state:

- `.ael/config.local.json`

That local config file is intentionally ignored by `.ael/.gitignore`.

Editable prompt settings:

- `.ael/settings.json`
