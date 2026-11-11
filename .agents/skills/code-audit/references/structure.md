# Structure

One question per module: **should these pieces change together?** A line names the shared change, not the smell.

## Lenses

**Hidden link** — pieces that must move together and the code does not say so.

- Copied logic or a copied value.
- A module reading state another module wrote.
- One feature split across folders by layer.
- A call order or convention every caller must remember.

**Needless link** — pieces tied together that change for different reasons.

- Callers reaching into internals.
- Stable code importing volatile code.
- A general function with a parameter only one caller understands.
- A shallow module whose interface moves with its internals.

**Surplus** — pieces with no reason of their own to change.

- A wrapper with one caller that adds no rule.
- An extension point or setting for something that never varies.
- Dead code.

**Special case** — code that exists for one situation instead of following from the design: an `if` for one value, a parameter for one caller, a swallowed error, a retry or a sleep, a disabled test. Each one is a requirement the design never accounted for; read them together to infer what the system needs to be.

## Derive the convention from usage

A documented rule is a claim; the call sites are evidence. Count both sides — the code that follows the rule and the code that does not. A rule most call sites break is either dead or wrong, and those are different findings. Say which, with the count.

The same holds for a rule the audit proposes: show the call sites it would unify.

## One fix behind several

Look for a change that removes two or more ledger lines at once; it is worth more than any line alone. Report it once and list the lines it clears.

## Completion

- A typical change lands in one place.
- No import points from stable code to volatile code.
- Every wrapper states its reason or is gone.
- Every kept special case names the requirement it serves.

## Output

A bounded change with a `file:line` set — the seam, never the rewrite.
