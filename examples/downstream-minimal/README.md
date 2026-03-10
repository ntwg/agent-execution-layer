# Downstream Minimal Example

This folder shows the smallest tracked footprint AEL needs in a downstream repo after:

```bash
npx ael install
```

Assumptions for this example:

- the downstream repo has a `package.json`
- the repo uses the default root `AGENTS.md` discovery stub
- the repo did not opt into `package.json` `ael:*` scripts

Tracked files:

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
