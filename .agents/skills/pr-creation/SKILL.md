---
name: pr-creation
description: |
  Creating or opening a pull request. Invoke when the user says "create a PR",
  "open a PR", "pr-creation", or "submit PR". Do NOT invoke for simply fixing
  CI or pushing commits — only when a new PR needs to be opened or an existing
  PR needs its description updated.
---

# pr-creation

## Workflow

1. Check current state: `git status`, `git log --oneline -5`, and check if a PR already exists for the branch.
2. If not exist, create a new branch from `main`. If the branch already exists, ensure it is up to date with `main` and resolve any conflicts.
3. Analyze the security implications of the actual changes.
4. Analyze the performance implications of the actual changes.
5. Read `docs/` (`README.md` and all `.md` files), validate them against the code, and update whichever side is out of sync so they stay consistent.
6. Ensure all acceptance criteria in `docs/TEST_STRATEGY.md` are met and pass.
7. Run `./scripts/check.sh` before pushing: it regenerates the API docs and the typed client and fails on drift, printing the failing lines only. The commit hook owns formatting, and `./scripts/github/ci.sh` stays on GitHub — never run it by hand.
8. Push the changes and create the PR with below format.
9. Read the CI result on the PR (`gh pr checks --watch`). When a gate fails, run only that gate locally, fix it, and push again until the PR is green.
10. Once all CI gates pass, request a human review and wait for approval before merging.

## PR Title Format

```
<type>(<scope>): <short summary>     # max 72 chars
```

Types: `feat` · `fix` · `refactor` · `docs` · `chore`
Scope: the resource or route touched

## PR Description / Body Format

The PR description is the body shown in GitHub. Write it in Markdown with the following sections in order:

## Context

**As** <role>
**Given** <current situation>
**When** <change is applied>
**Then** <expected outcome>

## Summary

Clear and concise summary of the changes, not a list of files.

## Architecture

Architectural changes. Write `None` if none.

## Backend

Backend changes with automation test proof. Write `None` if none.

## Frontend

Frontend changes with automation test proof. Write `None` if none.

## Security Review

Security implications of the actual changes. Write `None` if none.

## Performance Review

Performance implications of the actual changes. Write `None` if none.

## Acceptance Criteria

Checklist of acceptance criteria met or not, based on `docs/TEST_STRATEGY.md`.

## Documentation

Checklist of documentation updated or added.

## Limitations & Warnings

Any limitations or warnings, or `None`.

All sections must be written. Write `None` if there are no relevant changes for that section.

## PR Rules (non-negotiable)

- PR title and PR body/description must follow the formats defined above.
- Never merge your own PR — submit for human review only.
- Never create a PR with a dirty working tree (must be committed). If unclear whether to commit or discard changes, ask for confirmation before committing.
- Always create a PR even for trivial changes — every change needs a review trail.
- If a human-review gate was triggered (destructive migration, new dependency, auth change), state it prominently in **Limitations & Warnings**.
