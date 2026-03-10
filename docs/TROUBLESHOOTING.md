# Troubleshooting

Use this when downstream adoption or first-run bootstrap does not work as expected.

## `ael` command not found

Typical cause:

- the package dependency is installed, but you are not invoking the local bin correctly for that repo

Recommended fix:

1. confirm the package exists in `package.json`
2. run `npx ael status`
3. if the repo chose script mode, run `npm run ael:status` instead

## `ael doctor --adoption` fails

Typical causes:

- `.ael/install.json` is missing
- `.ael/.gitignore` does not keep `agent-guide.md`, `project-contract.md`, and `install.json` tracked
- the root discovery file does not point at `.ael/agent-guide.md`
- script mode was selected but `ael:*` package scripts are missing

Recommended fix:

1. run `ael doctor --adoption --json`
2. inspect the failed check labels
3. re-run `ael install --force`
4. if the repo owns a custom root instructions file, re-run `ael install --entrypoint-file <path>` or `ael install --no-root-agents`

## `backlog-create` or `backlog-polish` output is not what you want

Typical cause:

- the repo is still using the default prompt templates
- `.ael/settings.json` was edited into invalid JSON

Recommended fix:

1. edit `.ael/settings.json`
2. adjust `promptTemplates.backlogCreate` and `promptTemplates.backlogPolish`
3. re-run `ael backlog-create` or `ael backlog-polish`
4. if the file is broken, restore it from the installed template or re-run `ael install --force`

## `ael init` cannot detect the Azure DevOps target

Typical causes:

- the repo has no git remote
- the remote is not an Azure DevOps remote
- Azure CLI auth is not active
- the Azure DevOps extension is missing

Recommended fix:

1. confirm `git remote -v` shows the target repo
2. run `az login`, or export `AEL_ADO_PAT`
3. install the Azure DevOps extension if needed:

```bash
az extension add --name azure-devops
```

4. re-run `ael init` with explicit flags if auto-detection is still ambiguous:

```bash
ael init --organization-url <url> --project <project> --repository <repo> --default-branch main
```

## `ael doctor` fails on Azure auth or repo access

Typical causes:

- expired Azure login
- PAT not exported in the current shell
- the signed-in identity cannot access the Azure DevOps org/project/repo

Recommended fix:

1. run `az account show`
2. if using PAT auth, confirm `AEL_ADO_PAT` is exported in the current shell
3. verify the account can open the target org/project/repo in Azure DevOps
4. re-run `ael doctor --json`

## `ael uninstall` leaves files or scripts behind

Typical causes:

- the repo is using `--no-root-agents`, so root instructions are external and AEL will not edit them
- a package script was customized and no longer matches the exact AEL default
- the root entry file no longer contains the managed AEL marker block

Recommended fix:

1. run `ael uninstall --dry-run --json`
2. review `warnings` and `scripts.preserved`
3. remove any remaining custom root references manually
4. remove preserved package scripts manually if the repo no longer wants them

## Reinstall After Cleanup

If you want to reset the downstream repo cleanly:

```bash
ael uninstall
ael install --force
ael doctor --adoption
```
