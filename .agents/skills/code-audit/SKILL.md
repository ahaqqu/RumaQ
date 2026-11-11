---
name: code-audit
description: Read-only audit of a codebase, directory, or module — implicit state machines, coupling, docs, and comments, judged on reasons rather than on convention.
disable-model-invocation: true
argument-hint: '<path|module> [states|structure|docs|comments]'
---

# Code Audit

Reads, judges, reports. One run, one scope. It changes nothing: findings leave as issues and proposed PRs.

## Stance

- **The code is evidence; the docs are claims.** Neither is the answer key.
- **You decide what is correct.** A documented convention that is wrong is a finding — the docs cannot veto it.
- **Every finding carries a reason and a replacement.** What breaks, why, and what to do instead.
- **Disagree out loud.** Name the doc, the line, and the better reason. Silence is agreement.
- **Only the invisible binds you** — runtime, protocol, law. Confirm it at the source before citing it.

## Board

One screen per machine: ASCII before and after, ≤40 words of prose, one decision per ID (`S1 adopt, T2 defer`). The owner answers with IDs.

## Phases

### 1. Scope

`<scope>` is one path — a module, a directory, a package. A whole-repo audit is one run per path, never one pass over the tree.

Lens: `all` (default), or `states`, `structure`, `docs`, `comments`; a named lens narrows phases 3–5. Phase 6 always runs.

Done when the scope is one path and the lens is fixed.

### 2. Inventory

    bash <skill>/scripts/scan.sh <scope>

Read the top 12 files and what they import. The ranking replaces a directory walk.

Done when every file with ≥3 state hits or ≥2 transitions has a `file:line` entry.

### 3. Evidence — 2 subagents, parallel

**A** takes states and comments; **B** takes structure and docs. Both read-only, briefed with the scope, the inventory, the line format, a 60-line cap, and "cite `file:line`, no file dumps".

    S1 | file:line | finding | why it matters | what instead
    T1 | file:line | 51 repeated guard lines | one omission ships the route unguarded | derive the guard from the route table

Reconcile both ledgers yourself. Trust a summary until a specific line contradicts it.

Done when every line carries a reason and a replacement the owner can accept or reject.

### 4. Machines — depth on ≤3

Run this pass yourself; spawn nothing. Follow [`references/state-machines.md`](references/state-machines.md).

A machine passes the gate only if it does one now: removes a bug class, collapses a change into one place, or unlocks a UX decision. Everything else is dropped.

Under the `structure` lens, depth goes to the top 3 structural findings instead.

Done when each kept machine has a before diagram, an after diagram, a transition table, a migration map, the proof that behaviour is unchanged, and the UX/DX/AX verdicts.

### 5. Reasons, docs, comments

Follow [`references/comments-and-docs.md`](references/comments-and-docs.md). Judge every doc claim and comment on its reason and its action, not on its conformity to the project's own conventions.

Done when every claim has a verdict — keep, rewrite, move, delete, or disagree — with the reason for the verdict.

### 6. Verification gap

Follow [`references/verification-gap.md`](references/verification-gap.md).

Done when the verdict is `verify-skill`, `formal`, `both`, or `neither`, with a target and the proof it would add.

### 7. Board and report

Post the board in chat first. Then write `<docs>/audit-<YYYY-MM-DD>-<scope>.md` — following the project's reports convention where one exists — and open it as a PR.

    # Audit — <scope> — <date>
    ## Verdict        one sentence per axis: UX, DX, AX
    ## Ledger         ID | file:line | finding | why | what instead
    ## Machines       one board per machine
    ## Docs           claim | reason, tested | verdict | replacement
    ## Verification   verdict + target + proof
    ## Issues         ID | title | entry phase

Done when each finding has an ID, an issue title, and a route (`implement`, `defer`, or `drop`).

## Budgets

- 2 subagents, once, in parallel; 1 depth pass by the parent.
- Parent reads ≤12 files; each subagent ≤25.
- ≤3 machines; a fourth is an issue, not a finding.
- Report ≤150 lines. Link artifacts; never paste code.

## Hard rules

- Audit mode is read-only: the report is the only file it creates.
- A finding without a reason and a replacement is an opinion — mark it `sketch` and keep it out of the ledger.
- Behaviour claims are checked at HEAD and cite the line.
- A doc that contradicts the code is evidence about the doc, never an excuse for the code.
- `apply` runs only when the owner asks: accepted IDs go through the project's implementation flow, one PR per group.
