# Changelog

This project keeps a lightweight changelog.

## Policy

- Add user-visible workflow, config, packaging, or CLI changes to `Unreleased`.
- Collapse internal refactors unless they materially change behavior.
- Cut a dated release section when publishing or tagging a release.

## Unreleased

- No unreleased changes yet.

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
