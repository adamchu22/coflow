---
name: coflow
description: Write a document and its flowchart *with* the human — open both in a browser editor, block while they edit, and get their revisions and comments back. Use when the user asks for CoFlow, or asks to draft, review, draw, or edit a document, process, diagram or flow together. Not for ordinary planning: only open it when the human asks to work in it.
---

# CoFlow

A review loop, not a renderer. You write the plan and the chart, the human rewrites them
by hand, and you get their edits back. Nothing here talks to a model — you are the AI.

## Run it

```bash
coflow plan.md --flow flow.mmd --json --gate --save-dir ./coflow
```

More than one process? `--flow dispatch=dispatch.mmd` adds a flow called *dispatch*. Need
props on the boxes — actor, system, CRM property — or a proposed change drawn in green?
Seed that flow as JSON instead of Mermaid:

```bash
coflow plan.md --flow main.mmd --flow sync=sync.json --json --gate
```

```json
{ "dir": "LR",
  "nodes": [{ "id": "a", "label": "Extract fields", "props": { "system": "app" } },
            { "id": "b", "label": "Push to CRM", "props": { "system": "hubspot" }, "status": "proposed", "docRefId": "b2" }],
  "edges": [{ "from": "a", "to": "b", "status": "proposed" }] }
```

`status: "proposed"` is your suggestion until the human accepts it. `docRefId` ties a box to
a doc paragraph (`b2` is the third paragraph, counted from `b0`). Mapping tables — field →
CRM property → rule — go in the plan as markdown pipe tables; the human edits them as a grid.

**It blocks.** The browser opens and the command sits there — for minutes, maybe an hour —
until the human decides. That is the point. Do not background it, do not poll it, do not
set a short timeout, and do not start other work while it runs. Wait.

When it returns, stdout is the decision JSON and the exit code is `0` approved,
`1` changes requested or rejected, `2` bad invocation.

Other forms:

```bash
coflow - --flow flow.mmd            # plan on stdin
coflow "Vendor onboarding"          # empty project, human draws it
coflow attach ./coflow              # re-read a project from an earlier session
```

## Write the chart first

Seed the canvas so the human edits something instead of facing a blank page. CoFlow reads
a deliberately small Mermaid subset and **rejects anything outside it rather than guessing**:

- `flowchart` or `graph`, direction `TD` `BT` `LR` `RL`
- five shapes: `a[Step]` `b(Rounded)` `c([Start/End])` `d((Terminator))` `e{Decision?}`
- edges `-->` and `-.->`, labelled `-->|yes|`
- no subgraphs, no `classDef`, no `==>`, no HTML labels

```mermaid
flowchart TD
  a([Request received]) --> b[Check vendor docs]
  b --> q{Complete?}
  q -->|yes| d([Onboarded])
  q -.->|no| r[Ask for missing docs]
  r --> b
```

## Read the result

```json
{
  "decision": "annotated",
  "feedback": "close, but see the comment",
  "comments": [{ "id": "c_sxl5ks", "target": "flow Reject", "body": "drop this branch" }],
  "humanOps": ["relabelled edge q__c to \"after 30 days\"", "removed node \"Reject\" (c)"],
  "doc": "# Vendor onboarding…",
  "mermaid": "flowchart TD…",
  "flows": { "main": { "mermaid": "…", "graph": { "nodes": [{ "id": "a", "label": "…", "props": { "actor": "rep" } }], "edges": [] } } },
  "version": 7,
  "dir": "/abs/path/to/coflow"
}
```

Then:

- **`approved`** — this is the final document. Build against it and do not re-litigate the
  design. The folder records the sign-off, so later sessions can tell it apart from a draft.
- **`annotated`** — every comment is an instruction, not a suggestion. Carry them all out,
  then **run `coflow` again against the same `--save-dir`** so they can see the revision.
  That is the loop: annotate → revise → reopen, until they approve. Only the human closes a
  comment, so never mark one resolved yourself.
- **`dismissed`** — stop and ask what they want instead. This is also what you get when
  they close the tab: the server lives only while a tab is on it and shuts itself down
  about 30 seconds after the last one goes (two minutes if none ever opened). No hook or
  cleanup step is needed, and nothing is left listening.

**`humanOps` is the list of edits they made by hand.** Read it before you touch the chart
again: re-adding a node they just deleted is the fastest way to lose their trust. The same
goes for layout — their positions, box sizes, styling and arrow attachment points are theirs and
survive you sending a new chart, so send semantics and leave the geometry alone.
Their props survive too, and yours merge over them. `humanOps` also tells you when they
accepted a proposal, changed a prop, or linked a box to a paragraph; `flows[name].graph`
is where you read the current props and links back.

## The folder

`--save-dir` defaults to `./coflow` in the current directory, and it persists after the
session: `doc.md`, `flows/NAME.mermaid` + `.json`, `comments.json`, `handoff.md`, and a `versions/`
snapshot per edit. Commit it if the document belongs with the code; `versions/` is undo
history and can be ignored.

`coflow attach <dir>` prints the lot for a later session, and its first lines say where
things stand — `**draft**`, `**approved** by the human at rev N`, or `**approved** at
rev N, then edited 3 more time(s) — no longer final`. Check it before assuming anything
is settled.

## Install

`coflow` must be on PATH: `npm i -g coflow`, or run it as `npx coflow`. Node 20+, no
other dependencies.
