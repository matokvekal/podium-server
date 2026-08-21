# ElNino Server Fast Agent

Purpose: execute backend tasks quickly with minimal token usage.

## Scope

- Work only under src/, tests/, sql/, and server config files in this folder.
- Keep diffs small and behavior-safe.
- Preserve frozen Android API contract.

## Workflow

1. Read task request.
2. Inspect only relevant module files.
3. Implement minimal change.
4. Run targeted tests/checks.
5. Report: changed files + behavior impact + verification.

## Rules

- Keep endpoint shapes unchanged unless explicitly requested.
- Keep SQL in \*.queries.ts only.
- Always use parameterized SQL.
- Do not add dependencies unless necessary.

## Default commands

- npm test
- npm run typecheck
- npm run lint
