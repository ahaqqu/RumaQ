# Verification gap

One question at the end of every audit: **what proof does this repo still lack?** Default both answers to `no`; missing tooling is not a gap on its own.

## Scripted verification — `verify-skill`

Answer `yes` only when two or more hold:

- The audited surface has no scripted way to be driven at all.
- A workflow demands evidence per change, and the evidence is gathered by hand.
- Changes ship with no artifact a reviewer can open.
- The existing harness cannot reach the surface — a CLI, a worker, a desktop wrapper, an external service.

## Formal verification — `formal`

Answer `yes` only when two or more hold, and name the code:

- A protocol with interleavings: claim, reap, lease, retry, cancel.
- A property that must hold in every order — at most one live run, never two audit rows, never a purged object still referenced.
- Tests sample the orderings instead of covering them.
- The failure class is costly: duplicate write, lost run, stuck queue, double credit.

## Name the proof

    V1 | formal | file:line | one live run under any interleaving
       | broken variant: the reaper flips running → failed while the worker stays alive
       | cost: model checker + runtime install, one spec, rerun per change

Four verdicts only: `verify-skill`, `formal`, `both`, `neither`. `neither` is the common answer; give the reasoning in one line, not an essay.

## Principle

A gap exists when the missing proof would catch a real failure. Ask what the last three incidents would have looked like with that proof in place; if the answer is "the same", there is no gap.
