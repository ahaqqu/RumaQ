# Audit — scripts — 2026-11-16

Scope: `scripts/` at `origin/main` 251a724, clean worktree — 47 files (Bash entrypoints, CI-only
gates under `scripts/github/`, offline guard suites under `scripts/test/`, one TS/MJS generator
family). Lens: all. Read-only: this file is the only change. Parent-only pass: the run's
two-subagent budget went to the `frontend/` scope (owner cap, 2026-11-16).

## Verdict

- **UX (operator)** — the tooling answers with exit codes and one printed word: four gates mean
  "skip" by exiting 1, one prints `true`/`false`, and a gate that crashes reads as a skip.
- **DX** — the entrypoints are right (`test.sh`, `check.sh`, `deploy.sh`, `quiet.sh`), but the same
  skippable-path policy is spelled three ways across five scripts, and two of the five policy
  guards never run in CI.
- **AX** — every gate carries its policy in a header comment, yet "what runs for this change set"
  needs five scripts; two operator tools (`clean-worktrees.sh`, `generate-brand-icons.sh`) have no
  caller and no doc pointer.

## Ledger

ID | file:line | finding | why it matters | what instead
S1 | scripts/github/unit-test-scope.sh:87 | "skip" is exit 1, and a usage error (:34) or any crash is also non-zero; ci.sh:59,68 consume it as `if bash …; then run; else skip` | a syntax error or typo'd suite name skips 1,593 tests and CI stays green | reserve 0 = run, 1 = skip, everything else = error; callers `case $?` and fail on the default
S2 | scripts/github/ci.sh:57 | the comment cites `scripts/test/unit-test-scope.sh` as the rule's guard, but CI never executes it (`test.sh all` only) | the policy that decides whether the suites run can change without its guard firing | add `"$ROOT_DIR/scripts/test.sh" unit-test-scope` beside the smoke guard at ci.sh:92
S3 | .github/workflows/ci.yml:48 | the same for the Lighthouse scope guard: `scripts/test/lighthouse-scope.sh` is named in a comment, never run | a broken Lighthouse rule silently skips the perf budget | run the guard in ci.sh before the gate
S4 | scripts/github/ci.sh:100 | Worker config validation is skipped when `CLOUDFLARE_API_TOKEN` is absent | a secret-less PR merges a broken `cloudflare.config.ts`; the failure surfaces at deploy | make the dry-run need no token, or require the job on config changes
S5 | scripts/github/unit-test-scope.sh:37 | the skippable set exists three times: `case` here and lighthouse-scope.sh:26, a regex in worker-smoke-scope.sh:20 and e2e-smoke-scope.sh:21 | one new path class lands in two of the four gates and drifts in the others | one `skippable <target> <path>` table both shapes read (M1)
S6 | scripts/cleanup-preview-workers.sh:4 | the manual sweep deletes every `rumaq-api-*` Worker, including previews for open PRs | one stray run kills live previews the PR workflow still expects | require `--all`, or refuse while open PRs exist
S7 | scripts/github/cleanup-branch.sh:1 | tracked `100644` while `.gitattributes:4` declares `mode=755` | a caller that executes it directly gets EACCES; cleanup-branch.yml:24 only works because it prefixes `bash` | `git update-index --chmod=+x` so the index matches the attribute
S8 | scripts/clean-worktrees.sh:1 | `clean-worktrees.sh` and `generate-brand-icons.sh` have no caller and no doc pointer | the destructive one is discoverable only by `ls scripts/` | list operator entrypoints in AGENTS.md or a `scripts/README.md`
S9 | scripts/lib/quiet.sh:19 | the failure summary greps a fixed pattern list; output that matches none prints only `FAIL <label>` | an agent must open the log to learn why, against the file's own reason | fall back to the last 20 lines when no pattern matches

## Machines

### M1 — the change-set verdict — `scripts/github/unit-test-scope.sh:87`

```
BEFORE (four gates, three encodings)          AFTER (one verdict contract)
exit 0  run       (all four)                  stdout:  run  <why>     exit 0
exit 1  skip      (all four)                  stdout:  skip <why>     exit 0
exit 2  usage     (unit-test-scope.sh:34)     stderr:  <error>        exit != 0
crash   -> if-false -> SKIP (invisible)       caller: case "$verdict" in run|skip) ;; *) fail
```

```
state   | event                  | guard                             | verdict | effect
unknown | no path list           | empty after trim                  | run     | fail safe, reason printed
skip    | paths all in the set   | per-target skippable table        | skip    | suite skipped, reason printed
run     | any path outside       | per-target skippable table        | run     | suite runs
error   | gate cannot decide     | exception / bad usage / bad list  | —       | caller fails the job
```

Migration map: four gates (`unit-test-scope`, `lighthouse-scope`, `worker-smoke-scope`,
`e2e-smoke-scope`) and their call sites — ci.sh:59, :68, :93, ci.yml:56, pr-e2e-smoke.yml:49 —
plus the five guard suites, whose `expect()` helper asserts the exit code today
(worker-smoke-scope.sh:26) and must assert the word instead.
Proof: every existing guard case stays green because its expected `run|skip` word maps 1:1 from
the exit code it asserts now; the new case is the one the protocol exists for — a gate that errors
must fail the caller, not skip.
UX + (the reason is on stdout), DX + (one contract, one skippable table), AX + (one artifact
answers "what runs"). **decision: M1 adopt.**

## Docs

ID | file:line | claim | tested | verdict | replacement
D1 | AGENTS.md:26 | new shell scripts need `mode=755` "otherwise CI will fail with `Permission denied`" | false — cleanup-branch.sh is 644 in the index and CI passes, because its one caller prefixes `bash` (cleanup-branch.yml:24) | rewrite, then fix the bit | "add `mode=755` so the script can be run directly; CI invokes with `bash`, so a missing bit fails only a local `./` run"
D2 | AGENTS.md:14 | `test.sh` is "the single entrypoint for all tests (unit, automation-local, automation-live)" | mixed — the usage names ten suites, six of them offline guards (scripts/test.sh:79) | rewrite | name the guard suites, or drop the parenthetical
D3 | docs/TEST_STRATEGY.md:361 | the Lighthouse scope rule is offline-tested via `./scripts/test.sh lighthouse-scope` | true as a command, but that suite never runs in CI (S3) | keep the claim, add the invocation | no text change; run the guard in ci.sh

## Comments

ID | file:line | claim | tested | verdict | replacement
C1 | scripts/github/changed-paths.sh:13 | "prints nothing when no change set is available; callers treat that as unknown and fail safe" | true — each gate's empty branch prints and exits 0 (worker-smoke-scope.sh:22) | keep | —
C2 | scripts/github/pull-test-images.sh:10 | "strictly fail-open … never exits nonzero" | true — the loop has no exit, and the script ends `exit 0` | keep | —
C3 | scripts/backup/export-d1.sh:28 | "verified with the restore-drill canaries BEFORE upload" | true — verification at :170 precedes upload at :177 | keep | —
C4 | scripts/github/ci.sh:57 | "the rule is offline-tested in scripts/test/unit-test-scope.sh and it fails safe" | the suite exists, but CI never runs it (S2) | disagree | add the invocation; then the sentence is true
C5 | scripts/github/worker-smoke-scope.sh:15 | `cd "$root" || exit 0` under a header promising the caller reads a decision | the silent exit prints nothing, so "cannot find the root" reads as a run with no reason | rewrite | print the reason on that path too (M1)

## Verification

`neither`. The control plane already has the cheapest proof the skill asks for: six offline guard
suites drive the real scripts through `--from-stdin` (no git, no network), which is stronger than a
model checker over pure functions. What is missing is wiring, not tooling — two of those suites are
never invoked by CI (S2, S3), and the protocol makes an error indistinguishable from a skip (S1).
Fix those and the existing suites close the gap.

## Issues

ID | title | recommendation next step
M1 | One change-set verdict contract across the five gates | adopt
S1 | Gate errors read as skips | implement
S2 | The unit-test scope guard never runs in CI | implement
S3 | The Lighthouse scope guard never runs in CI | implement
S4 | Worker config validation is token-gated | defer
S5 | The skippable-path policy exists in three spellings | implement (rides M1)
S6 | The preview sweep can delete an open PR's Worker | implement
S7 | `cleanup-branch.sh` is 644 though the attribute says 755 | implement
S8 | Two operator tools have no caller and no pointer | implement
S9 | The quiet runner shows nothing for unmatched failures | implement
D1 | AGENTS.md mode=755 rule states the wrong consequence | implement
D2 | AGENTS.md test entrypoint undercounts the suites | implement
D3 | TEST_STRATEGY claims a guard command CI never runs | implement (S3)
C1 | changed-paths "fail safe" comment | drop
C2 | pull-test-images "strictly fail-open" comment | drop
C3 | export-d1 "verified before upload" comment | drop
C4 | ci.sh comment claims a guard that never runs | implement (S2)
C5 | worker-smoke-scope silent-root comment | implement (M1)
