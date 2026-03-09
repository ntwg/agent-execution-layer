# Security Policy

## Reporting

Do not open public issues for suspected security vulnerabilities.

If this repository is published on GitHub, use GitHub private vulnerability reporting or contact the maintainers through a private channel. If the repo is still private or pre-publication, report the issue directly to the maintainer through the existing secure communication path.

Include:

- affected command or file
- impact
- reproduction steps
- any suggested mitigation

## Scope

This project shells out to local tooling such as `git` and `az`, reads local config, and can modify Azure DevOps work items and pull requests. Treat command-invocation boundaries, config parsing, and generated content paths as the highest-risk areas.

Until a formal support policy exists, assume only the latest `0.x` version is supported for security fixes.
