# Changelog

This project keeps a lightweight changelog.

## Policy

- Add user-visible workflow, config, packaging, or CLI changes to `Unreleased`.
- Collapse internal refactors unless they materially change behavior.
- Cut a dated release section when publishing or tagging a release.

## Unreleased

- Extracted the low-level command runtime into explicit Windows/macOS/Linux profiles so platform-specific invocation behavior is centralized instead of being scattered through the CLI runtime helpers.
- Expanded CI coverage to run format, lint, build, and test validation across Ubuntu, macOS, and Windows so cross-platform support is continuously verified.
- Added `.gitattributes` line-ending normalization so cross-platform format checks stay stable when the repo is checked out on Windows.
- Replaced the shell-globbed test command with a Node-based test runner so `npm test` behaves the same under Windows `cmd.exe`, macOS, and Linux shells.

## 0.3.0 - 2026-03-12

- Added `ael upgrade` (plus `ael update` alias) so downstream repos can refresh AEL-managed files and script shims after updating the AEL dependency, while preserving repo-owned `.ael/project-contract.md`, `.ael/settings.json`, and `.ael/config.local.json`.
- Fixed `ael retag --tags "a;b"` so explicit custom tags are actually written to Azure DevOps instead of reporting a false no-op after only normalizing shared tags.
- Added repo-local `ael:upgrade` script shims for `--with-scripts` downstream installs and updated downstream examples/docs to describe the managed refresh workflow.
- Fixed Windows Azure CLI command routing so WIQL operators like `<>` no longer break `report`, `audit`, and other query-heavy commands.
- Reduced dependence on raw Azure DevOps REST calls for normal read/write flows, so `report`, `audit`, and `retag` work cleanly with standard `az login` auth.
- Added local `runtime.platform` config support plus `ael init --platform ...` to pin Windows, Mac, or Linux behavior when auto-detect is not enough.
- Documented the current auth tradeoff: core workflows work with Azure CLI login, while PR label write-back and existing work item comment repair are still strongest with a PAT.

## 0.2.0 - 2026-03-10

- Added editable backlog prompt commands (`backlog-create`, `backlog-polish`) backed by `.ael/settings.json`, with install/adoption support, downstream examples, and customizable prompt templates.
- Fixed the `npm test` script to use a shell-safe test file glob so Node 20 CI runs execute the suite instead of treating `**` literally.
- Validated a clean-room downstream repo against Azure DevOps and fixed encoded PR artifact link parsing so `done` correctly recognizes linked pull requests created from real ADO artifact URLs.
- Expanded `ael install --with-scripts` to add the full repo-local workflow shim set, so generated backlog prompts stay consistent with script-mode downstream repos.

## 0.1.0 - 2026-03-10

- Added package-oriented `ael` CLI surface and downstream install flow.
- Added init/doctor/smoke/bootstrap hardening and config validation.
- Added machine-readable `--json` output across read/bootstrap and core write commands.
- Added public-repo scaffolding: license, security policy, contribution guide, issue templates, CODEOWNERS, and release policy.
- Renamed the internal CLI entrypoint to `scripts/ael.ts` and split command logic into focused modules.
- Added Biome formatter/linter guardrails plus GitHub Actions CI for format, lint, build, and test validation.
- Added upstream-contribution guidance so downstream agents report AEL bugs safely and only prepare GitHub PRs with human approval.
- Moved downstream repo-local guidance and generated config into a hidden `.ael/` layout, with root `AGENTS.md` reduced to a discovery stub and `.ael/.gitignore` hiding local state.
- Changed downstream install to be minimal by default, with `.ael/.gitignore` handling local state and `--with-scripts` enabling optional `package.json` shortcuts.
- Added `.ael/install.json`, `ael install --entrypoint-file`, `ael install --no-root-agents`, and `ael doctor --adoption` so downstream repos can keep custom root instructions while still validating their AEL wiring.
- Added `ael install --dry-run`, `ael uninstall`, troubleshooting guidance, and copyable downstream examples so repos can preview adoption, use either install mode, and back it out cleanly.
