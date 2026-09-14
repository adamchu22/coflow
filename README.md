# CoFlow

A flowchart canvas + doc editor with a Plannotator-style review loop.

Your coding agent hands you a plan and a flowchart, opens localhost in your browser,
and **blocks**. You drag boxes, draw arrows, rewrite the doc, and leave comments. Then
you hit **Approve**, **Send feedback**, or **Reject** — and everything you produced goes
back to the agent on stdout.

No API key. No database. No background daemon. The agent that launched it is the AI.

## Use it

```bash
npx coflow plan.md --flow flow.mmd --json --gate
```

That prints a decision JSON to stdout and exits `0` on approve, `1` otherwise. Without
`--json` it prints prose an agent can read directly.

```
coflow <plan.md>                    open the editor on a markdown plan
coflow - --flow flow.mmd            read the plan from stdin
coflow "Vendor onboarding"          open an empty project with that title
coflow attach <DIR>                 print the handoff for a project you saved earlier

  --flow FILE.mmd      seed the canvas from a Mermaid flowchart
  --save-dir DIR       project folder (default ./coflow)
  --json               print the decision as JSON instead of prose
  --gate               exit codes: 0 approved, 1 changes requested / rejected, 2 usage error
  --result-file PATH   also write the decision JSON to PATH
  --no-open            don't launch a browser
```

Re-running against an existing `--save-dir` leaves your work alone unless the agent
passes new content. When it does, **every box you moved stays where you put it** — the
agent supplies semantics, you own the coordinates.

## What you get back

```json
{
  "decision": "annotated",
  "feedback": "close, but see the comment",
  "comments":  [{ "id": "c_sxl5ks", "target": "flow Reject", "body": "drop this branch" }],
  "humanOps":  ["relabelled edge q__c to \"after 30 days\"", "removed node \"Reject\" (c)"],
  "doc":       "# Vendor onboarding\n\nFirst we check the vendor…",
  "mermaid":   "flowchart TD\n  a([\"Start\"])\n  a --> q{\"Valid?\"}…",
  "version": 7,
  "dir": "/abs/path/to/coflow"
}
```

`decision` is `approved`, `annotated`, or `dismissed`. `humanOps` is the plain-English
log of what you changed by hand, so the agent doesn't re-add what you just deleted.
Comments you marked *I fixed it* move to `resolvedComments`.

## The canvas

- **Arrows.** Every box shows four blue dots. Drag one to another box to connect them.
  Click one, or drop it on empty canvas, and you get the next step a clear box-width away.
  Every arrow leaves and arrives square to a box side, so a branch fans out symmetrically
  instead of one leg bowing off on its own.
- **Re-route.** Click an arrow and drag either end onto another box; drop it on a blue dot
  to pin which side it attaches to.
- **Labels.** Double-click an arrow to write `yes` / `no` / whatever the branch means.
  Double-click a box to rename it.
- **Shapes.** rectangle `[]`, rounded `()`, stadium `([])`, circle `(())`, diamond `{}` —
  the same five flowchartai uses, so everything maps onto real Mermaid.
- **Branch by keyboard.** With a box selected, `⌘`+arrow makes one box that way and draws
  the arrow. Press it again and the branch *splits*: the same box now fans into two equally
  spaced siblings, then three, then four. Unnamed boxes show dashed; `Enter` names the
  selected one and ends the branch, `Escape` just ends it, `⌘Z` takes one back.
- **Select.** Drag the empty canvas to rubber-band; space / alt / middle-drag pans instead.
  `Del` deletes the selection, `⌘Z` steps back a revision.
- **Style.** Selecting anything opens a panel beside it: fill, stroke, stroke width,
  opacity, label, comment, delete.
- **Right-click** any box, arrow, paragraph or empty canvas for a menu — including a
  comment box that opens where you clicked, so you never leave what you're talking about.

Position, styling, and which side an arrow attaches to are yours: Mermaid cannot express
them, so they live in `flow.json` and survive the agent handing back a new chart.

## The doc

Markdown, live: `**bold**`, `*italic*`, ``code``, `~~strike~~`, links, `#`/`##`/`###`,
`>` quotes, lists and fences render as you type, with the markers left in place so what
you see is what the agent gets.

Don't write markdown? Highlight some words and a bar appears: bold, italic, code, strike,
headings, bullets, quote, link. `⤢` in the doc header gives the doc the whole window.

## Comments

Select a box, an arrow, or a paragraph — or highlight a few words and hit 💬 in that bar to
pin the comment to exactly those words — then write what you want changed and hit
**Add comment**. With nothing selected you get a general note about the project.
Pins show on the canvas; the header counts what's waiting. Resolved ones leave the rail
(`Show N resolved` brings them back). A comment is an instruction,
not a proposal — nothing closes it but you clicking *I fixed it*.

## The folder is the database

```
coflow.json      rev, title, updatedAt
doc.json         { blocks: [{ id, text }] }
doc.md           same doc, flat markdown
flow.json        { dir, nodes: [{id,type,label,x,y,color,stroke,sw,opacity}], edges: […] }
flow.mermaid     same graph, Mermaid source
comments.json    [{ id, target, body, status }]
versions/N.json  state as it was *before* rev N, plus `ops`: what that write did
handoff.md/json  written when you decide — including the verdict, so the folder
                 itself knows whether it holds a final document or a draft
```

Every write bumps `rev` and snapshots the previous state, so history is revertible from
the sidebar. `coflow attach <dir>` prints that history for an agent later.

## Mermaid profile

`flowchart`/`graph`, directions `TD|BT|LR|RL`, the five shapes above, edges `-->` and
`-.->` with `|label|`. No subgraphs, classes, HTML labels, or edge styling. Edge ids are
canonical `from__to`, one per ordered pair. Anything off-profile is rejected before
anything is written — a chart with `==>` fails loudly rather than becoming a node label.

## Tests

```bash
npm test
```

9 tests: Mermaid round-trip across all five shapes (plus legacy shape names), profile
rejection, position preservation across an agent re-seed, layout idempotence and
non-overlap, diff + lint, the plain-English change log, and store snapshot / undo /
handoff.

## Licence

MIT — © 2026 Rugby Waldorf LLC. See [LICENSE](LICENSE).

No third-party code ships in this repo (there are no dependencies at all), but the ideas
came from somewhere: [CREDITS.md](CREDITS.md) names them.

## Plugins

The same skill drives all three hosts — `plugin/skills/coflow/SKILL.md` is the only real
artifact; each manifest just points at it.

```
plugin/
├── skills/coflow/SKILL.md   when to run it, the Mermaid profile, how to read the result
├── commands/coflow.md       the /coflow slash command
├── .claude-plugin/plugin.json   Claude Code manifest
└── plugin.json                  Codex / agent-plugins.org manifest
.claude-plugin/marketplace.json  Claude Code marketplace
.agents/plugins/marketplace.json Codex marketplace
package.json → "pi": {…}         Pi package manifest
```

```bash
# Claude Code
/plugin marketplace add RugbyWaldorf/coflow
/plugin install coflow@coflow

# Codex
codex plugin marketplace add RugbyWaldorf/coflow

# Pi
pi install RugbyWaldorf/coflow
```

All three expect `coflow` on PATH — `npm i -g coflow`, or `npm link` from a clone until
it is published.
