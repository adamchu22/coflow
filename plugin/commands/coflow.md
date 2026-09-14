---
name: coflow
description: Open a plan and flowchart in the browser for review, and wait for the human's verdict
argument-hint: [what the flow is about]
---

Open a CoFlow review session for: $1

1. Write the plan to a markdown file and the flowchart to a `.mmd` file, in the Mermaid
   subset CoFlow accepts. If there is already a `./coflow` project, run
   `coflow attach ./coflow` first and build on what is there rather than starting over.
2. Run `coflow <plan.md> --flow <flow.mmd> --json --gate --save-dir ./coflow` and **wait**.
   It blocks until the human decides — that is expected, do not background it.
3. Act on the decision JSON: `approved` means build it, `annotated` means every comment is
   an instruction to carry out, `dismissed` means stop and ask.

The `coflow` skill has the full contract — the Mermaid profile, the JSON shape, and the
rules about `humanOps` and human-owned layout.
