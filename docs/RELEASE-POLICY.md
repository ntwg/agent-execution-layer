# Release Policy

Use a lightweight release process until the first real downstream adoptions are stable.

## Versioning

- Stay on `0.x` while the command surface and config schema are still settling.
- Use patch bumps for fixes, docs, and non-breaking UX/output improvements.
- Use minor bumps for new commands, new config fields, or meaningful workflow capabilities.
- Treat breaking CLI or config changes as a minor bump while still on `0.x`, and document them clearly in `CHANGELOG.md`.

## Release Checklist

1. Run `npm run build`.
2. Run `npm test`.
3. Update `CHANGELOG.md`.
4. Verify the installed-package path still works in a clean downstream repo.
5. Tag only after the live ADO workflow pass is green.
