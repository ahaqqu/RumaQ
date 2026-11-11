# Reasons, docs, comments

A comment and a doc make the same claim: this is why the code is this way. Judge the reason, not the wording, and never judge it by whether it agrees with another doc.

## Extract three things

- **Claim** — what the text asserts about behaviour or design.
- **Reason** — what forces it to be so.
- **Action** — what a reader should do with it.

A text with no reason cannot be tested. That absence is the finding.

## Test the reason

- **Is it still true?** Check the code at HEAD and the runtime it runs on. A stale reason is worse than none.
- **Is it the real reason?** Look for the constraint the text does not name: a provider limit, a protocol step, a schema, a clock, a migration.
- **Does it survive a better design?** If the audit can remove the constraint, the reason was a workaround, not a rule.
- **Does it contradict another doc?** One of them is wrong. Say which, and why.

## Test the action

An action a reader cannot carry out is a wish. Name the file, flag, command, or test. When the action is "be careful", the rule was never written.

## Verdicts

- **keep** — reason true, action clear.
- **rewrite** — reason true, text untestable.
- **move** — the reason belongs to a doc a reader meets before the code.
- **delete** — no reason survives, or the code already shows it.
- **disagree** — the reason is false or the action is worse than the audit's own. Name the doc and line, state the better reason and the replacement. A disagreement is a finding, never a silent edit.

## Comment classes

| Class             | Test                                         | Disposition                                        |
| ----------------- | -------------------------------------------- | -------------------------------------------------- |
| Restates the code | The next line already says it                | delete                                             |
| History           | What the code used to do, or when it changed | delete; the issue keeps the history                |
| Constraint        | Names something outside this file            | keep, or encode                                    |
| Workaround        | Compensates for a defect elsewhere           | delete with the workaround, or move the constraint |
| Warning           | A reader gets burned without it              | keep, one line                                     |

## Move a comment to a doc

1. Name the destination and heading.
2. Write the rule, the reason, and its trigger. Drop dates and the discovery story.
3. Delete the comment in the same change. Leave one pointer line only when the rule is a correctness one and the doc is far from the code.

## Write the text

- **One mode per page**: tutorial (learning by doing), how-to (a goal), reference (lookup), explanation (why). Mixing modes is how a page stops serving any of them.
- The heading carries the point, not the topic.
- One thought per sentence; the condition before the action; the real symbol, never a synonym.
- Counts and paths are true at HEAD, with the command that produced them beside them.
- A generated file is regenerated, never edited.
- Link the artifact; never paste it.

## One source per reason

When two places state the same rule, one will drift. Keep the reason where the reader meets it first and let the other place link to it.

## The doc is not the standard

A conventions page records what someone decided once. The audit re-derives the rule from the code and the constraints, and reports the difference in either direction: the doc may be stale, or the code may be. Treating the doc as correct produces agreement, not an audit.
