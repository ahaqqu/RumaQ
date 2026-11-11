# Implicit state machines

A machine is **implicit** when the states live in the data and the legal transitions live only in guards, comments, and statement order. Making it explicit is a design decision — the audit owns that decision and argues for it.

## Signals

| Signal                                | Shape                                |
| ------------------------------------- | ------------------------------------ |
| Status column or string union         | free-text values in one field        |
| Booleans meaningful only together     | `needs_x` + `x_by`                   |
| Transition inside a conditional write | `where status = 'pending'`           |
| Clock transition                      | reaper, TTL, expiry, grace period    |
| Retry or attempt counter              | `attempt`, `backoff`                 |
| Lease, claim, lock, reservation       | a row that says "someone is working" |
| Optimistic guard                      | version, ETag, anchor value          |
| Multi-step flow                       | `step`, `stage`, wizard              |
| Enablement or capability table        | which combination is legal           |
| Freshness cache                       | data valid until a time              |

## Why implicit hurts

1. Illegal states are representable.
2. The same guard is rewritten at every call site, so one drifts.
3. A new state touches N files; its transition is known only to its author.
4. The rule lives in a comment, so code and comment can disagree.
5. An agent cannot answer "what happens if X" without reading every handler — the AX cost.

## Gate

Keep a machine only if it does one **now**, with evidence:

- **Removes a bug class.** Name the reachable bad state or interleaving, at `file:line`.
- **Collapses a change.** Name the change and the N places it touches today.
- **Unlocks a UX decision.** Name the screen and the state it cannot currently show.

No evidence, no machine. A fourth candidate is an issue, not a finding.

## Your machine, not theirs

The existing diagram or doc is a claim. Design the machine you would ship, then compare:

- A machine the docs describe and the code does not implement.
- A machine the code implements and the docs never mention.
- A machine both have, with no stated reason for its current shape.

When the audit departs from the documented design, show both and argue the departure. A doc that says "four states" is not evidence that four is right.

## Before and after

```
BEFORE  (implicit)                      AFTER  (explicit)
status: 'pending'|'running'             type State =
  |'success'|'failed'                     'pending'|'running'|'success'
+ picked_up_at + finished_at              |'failed'|'reaped'
                                        + reaped_at, reason
pending ─claim→ running ─finish→        pending ─claim→ running ─finish→ done
   │reap          │reap                    │reap          │reap
   ▼              ▼                        ▼              ▼
 failed         failed                  reaped         reaped  (terminal, reason)
```

Three artifacts per machine:

**Transition table** — one row per legal edge:

    from     | event  | guard                    | to      | effect
    pending  | claim  | status = 'pending'       | running | set picked_up_at
    running  | finish | status = 'running'       | success | set exit_code, finished_at
    running  | reap   | picked_up_at < now - ttl  | reaped  | set reason

**Migration map** — existing value → state, plus the default for an unknown value. A value that cannot be mapped is a finding, not a silent drop.

**Proof of no change** — the test that stays green after the extraction, named by file. A deliberate behaviour change is a separate line, never bundled into the refactor.

## UX / DX / AX

| Axis | Check — all three must hold                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| UX   | Every state the user can meet has a surface; no illegal state is paintable; waiting, empty, error, and offline are named states, not gaps |
| DX   | One transition function; an exhaustive switch the compiler enforces; guards in one place; a new state edits one file                      |
| AX   | State nouns are greppable; one artifact answers "what if X"; the machine reads as data without reading handlers                           |

A machine that improves one axis and regresses another is a `defer` with the regression named — never an `adopt`.

## Board

```
M1  <machine name>                                     <file:line>
    before                      after
    pending ─▶ running ─▶ ok    pending ─▶ running ─▶ success
      │reap     │reap              │reap      │reap      │
      ▼         ▼                  ▼          ▼          ▼
    failed    failed            reaped     reaped     reaped
    delta: <what the new state removes, in one sentence>
    cost: <migration, call sites>      UX <−|+>  DX <−|+>  AX <−|+>
    decision: S1 adopt / S2 defer / S3 reject
```
