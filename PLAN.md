# CoFlow V0 — built plan

Spec source: `COFLOW_SPEC.md`. This file records what was actually built and where it
deviates from the spec.

## Approach

One Node process. The agent runs `coflow plan.md --flow flow.mmd`, a random-port server
opens the editor in a browser and blocks on a promise; `POST /api/decision` resolves it
and the process prints the human's work to stdout. Plannotator's contract, applied to a
doc + a flowchart instead of a plan file.

The folder is the database. The agent supplies semantics (`nodes`/`edges`); the human
owns `x`/`y`. When the agent re-seeds an existing project, `mergePositions` keeps every
coordinate the human placed and only lays out genuinely new nodes.

There is no in-app AI. The agent that launched the session *is* the AI.

| file | lines | what |
|---|---|---|
| `lib/graph.js` | 180 | Mermaid profile parse/serialize, layered layout, diff, lint, `mergePositions` |
| `lib/store.js` | 182 | folder I/O, versioning, plain-English change log, handoff |
| `server/index.js` | 146 | route table, static serve, the blocking decision promise |
| `bin/coflow.js` | 88 | CLI: seed in, decision out, exit codes |
| `editor/` | 801 | canvas + doc + comments + verdicts |
| `test/coflow.test.js` | 128 | 9 tests |

## Steps

- [x] `lib/graph.js`: Mermaid profile parse/serialize, layered BFS layout, diff, lint
- [x] `lib/store.js`: every write bumps `rev` and snapshots the *prior* state to `versions/N.json` with an `ops` list in plain English
- [x] `server/index.js`: routes, static serve, `POST /api/decision` resolves the blocking promise
- [x] `editor/`: SVG canvas — pan/zoom/marquee/drag/link/rename/delete, dot grid, quadratic edges clipped to node boxes, back-edges bowed aside
- [x] Doc pane: contenteditable block-per-paragraph with stable ids for comment anchoring
- [x] Comments: target = selected nodes/edges or a doc block id; canvas + gutter pins
- [x] Approve / Send feedback / Reject, with a feedback dialog; `--json --gate` stdout and exit-code contract
- [x] Decision payload carries comments, `humanOps`, the doc and the Mermaid
- [x] Five-shape vocabulary (rectangle/rounded/stadium/circle/diamond), legacy names aliased
- [x] Arrows: visible arrowheads, four grab dots per box, snapped drag preview, drop-target highlight, drop-on-empty creates and renames the next step, double-click to label
- [x] `mergePositions` so an agent re-seed never moves a box the human placed
- [x] `README.md`
- [ ] PNG/SVG export — **cut**, Mermaid + Markdown only

## Deviations from the spec

1. **No Excalidraw, no Tiptap, no React, no bundler.** The spec names all three. They
   cost a build step and hide the semantics↔positions mapping the whole contract depends
   on. Vanilla SVG + contenteditable owns that mapping directly. `flow.excalidraw.json`
   is therefore `flow.json`, and `doc.json` is `{blocks:[{id,text}]}`.
2. **Comment anchors are block ids, not character ranges.** Spec §8 shows
   `docRange {from,to}` while the same section insists anchors are stable. Ids win;
   character offsets rot on the first edit above them.
3. **Shapes follow flowchartai, not §6 or §7.4.** The spec contradicts itself (three
   types in §6, five in §7.4). Took the five the open-source implementation uses. Old
   CoFlow names (`process`, `start-end`, `decision`, `ellipse`) normalise in.
4. **The AI never closes a comment.** A comment is the human's instruction, not something
   the model rules on. Status is `open` until a human clicks *I fixed it*;
   `/api/comment` rejects any other value.
5. **Deleted things leave the canvas, but not the record.** Spec §10 wanted removed
   elements ghosted. They aren't; undo covers that. Every save instead stores what
   changed in words, and the agent is handed every human edit.
6. **No in-app AI, no op protocol, no API key.** Earlier drafts had `lib/ai.js`, an
   `/api/ai` route and `render-mermaid` / `patch-diagram` ops. All deleted: the agent on
   the other end of stdout already is the model, so a second one inside the app is a
   second bill and a second opinion nobody asked for.
7. **No Chrome extension, no daemon, no launchd agent.** MV3 cannot spawn a process, so
   a "click to open" button needed a background daemon listening at all times. Cut
   entirely. Sessions start from an agent.
8. **No `coflow://` deep link, no SSE, no `coflow sessions`.** Copy-paste, one atomic
   write, and the folder listing cover all three.

## Verification

- `npm test` — 9 passing.
- CLI end-to-end: seed a plan + flowchart → comment via API → hand-edit the graph →
  Send feedback → stdout JSON carries `comments`, `humanOps`, `doc`, `mermaid`, and
  `--gate` exits 1; approve exits 0.
- Browser (Playwright, real Chromium): arrowheads render on every edge including the
  bowed back-edge; dragging a port onto another box creates an edge; dropping on empty
  canvas creates the next node and opens its rename box; double-click labels an arrow
  and renames a box; comment pins and the header badge track open comments; **Send
  feedback** summarises the payload and ends the session.

Three bugs found and fixed in that browser pass: the empty toast div was painted over
the canvas (`display:flex` beat `[hidden]`), `S.versions` was never refreshed after a
save so the change count read 0, and selecting an edge re-rendered the canvas on
pointerdown — which detaches the element mid-gesture, so the browser never dispatched
the `dblclick` that labels it.
