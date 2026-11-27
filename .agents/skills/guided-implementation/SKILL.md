---
name: guided-implementation
description: |
  Guided implementation of plans from markdown files. Invoke when the user says "implement plan", "follow plan", or "execute implementation". Do NOT invoke for simply fixing CI or pushing commits — only when a new implementation needs to be started or an existing implementation needs to be updated.
---

# guided-implementation

## Workflow

1. **Read the inputs.**
   - Read the plan file specified by the user (e.g., `docs/plan/*.md`).
   - Read `docs/ARCHITECTURE.md` as the architecture guideline.
   - Read `docs/TEST_STRATEGY.md` as the test strategy.

2. **Analyze the plan.**
   - Treat the plan and architecture as intents and directions, not strict instructions.
   - Be critical: identify unclear steps, verify feasibility, and propose better alternatives when they exist.
   - Consider security, performance, and functional impacts.

3. **Propose the implementation steps.**
   - List the step-by-step implementation plan in order.
   - Highlight any deviations from the written plan and any changes that touch architecture.
   - Do not start implementation until the user confirms the approach.

4. **Implement after confirmation.**
   - Begin implementation only after the user confirms the finalized steps.
   - Pause and ask for explicit approval before deviating from the plan or making architecture changes.

5. **Verify.**
   - Follow the test strategy from `docs/TEST_STRATEGY.md`.
   - Ensure acceptance criteria pass before finishing.

## Rules

- Never implement architecture changes without explicit user approval.
- Never treat the plan as immutable; challenge unclear or suboptimal parts.
- Always prioritize security and performance alongside functional correctness.
- Always finalize and confirm the step-by-step plan with the user before writing code.
