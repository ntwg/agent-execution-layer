# First Push Checklist

Use this before the first public push or package publish.

## Required Before First Push

1. Add the real `origin` remote for this repo, or replace the local init with a clone of the final remote.
2. Create the guinea-pig Azure DevOps project/repository used for live validation.
3. Run the bootstrap and read-only checks:
   - `npm run ael:init`
   - `npm run ael:doctor`
   - `npm run ael:smoke`
4. Run one real lifecycle test end to end:
   - `npm run ael:create`
   - `npm run ael:start`
   - `npm run ael:commit`
   - `npm run ael:pr`
   - `npm run ael:done`
5. Confirm the default MIT `LICENSE` is acceptable for publication or replace it before release.

## Recommended Before Public Release

1. Decide whether to keep the npm package name `agent-execution-layer` or change it before publishing.
2. Add GitHub repository metadata to `package.json` once the final repo URL exists.
3. Remove `"private": true` only when the package is ready to publish.
4. Confirm the install flow in a clean downstream repo:
   - install package
   - run `ael install`
   - run `ael init`
   - run `ael doctor`
5. Update `CHANGELOG.md` before the first tagged release.

## Already Completed

- Public CLI surface is centered on `ael`
- Repo-local `npm run ael:*` scripts exist
- Legacy `npm run ado:*` aliases remain for compatibility
- Downstream adoption templates exist
- Read and core write commands support `--json`
- `CONTRIBUTING.md` and `SECURITY.md` exist for public-repo basics
- A default MIT `LICENSE` is present
