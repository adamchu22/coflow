# CoFlow Spec — V0 (localhost-first)

## 1. One-liner

Google Docs + Excalidraw + Plannotator review loop, where every doc paragraph and every flowchart node is AI-generatable AND human-annotatable AND human-editable directly.

Fix vs Plannotator: human never has to file a comment to fix a typo. Direct edit always works. Comments are only for delegating to AI.

## 2. Who / scope

Primary: builders planning anything (SOPs, user journeys, system design, agent workflows, essays with diagrams). General-purpose mechanics, builder-led validation.

V0 is single-player, localhost-first, file-backed. No SaaS, no auth, no DB, no payments.

## 3. Core loop

```
agent OR human invokes coflow (CLI or Chrome ext)
  -> localhost server (random port) opens editor
  -> AI drafts Doc + Flow OR human starts blank
  -> human EITHER:
       a) edits directly (type/drag/relabel) -> saved as human-op
       b) selects [text range | node(s) | edge(s)] + comments -> Send to AI -> AI patch
  -> visual diff (green add / red remove / ghost move)
  -> Approve / Annotate -> JSON returned to calling agent on stdout
```

Terminal states (copy Plannotator): `approved | annotated | dismissed`. Approval may carry notes.

## 4. Invocation (agent-callable like Plannotator)

### 4.1 CLI

```
coflow doc <file.md> [--save-dir ./coflow] [--json] [--gate]
coflow flow <file.mermaid | prompt...> [--save-dir ./coflow] [--json]
coflow both <file.md | prompt...> [--save-dir ./coflow] [--json]
coflow sessions [--open [N]] [--clean]
coflow --help
```

Behavior (mirror Plannotator session model):
- Starts local server on random localhost port (`COFLOW_PORT` overrides, `COFLOW_REMOTE=1` for SSH/devcontainer fixed port 19432 behavior).
- Opens browser to session. Blocks until human submits, approves, or closes tab.
- Plaintext default: empty on close, `The user approved.` on approve, else feedback text.
- `--json`: `{"decision":"approved|annotated|dismissed","feedback":"...","humanOps":{...},"version":N}`.
- `--gate --require-approval --result-file <path>`: exit 0 = approved only, 1 = annotated/dismissed (record still published), 2 = gate failed (bad flags, missing file, oversized file). Strict flags require `--gate --json`.
- Do not parse browser HTML. Stdout JSON is the contract.
- Never run bare `coflow` from an agent hook entrypoint pattern — `coflow --help` prints without launching.

### 4.2 Chrome extension (V0 thin launcher only)

- Button: `Open CoFlow` -> `POST http://localhost:<discovery>/start {saveDir}` or spawns `coflow both` via native messaging, then opens returned URL.
- No editing in extension. Extension only starts server + opens tab. All editing in localhost editor.
- Save dir picker defaults to `./coflow/` relative to current project, user-overridable.

## 5. Project folder schema (no DB)

```
./coflow/
  coflow.json          # { projectId, title, rev, updatedAt, editor: "v0" }
  doc.md               # source of truth for prose (also store prosemirror JSON in doc.json for ranges)
  doc.json             # prosemirror JSON, stable node ids for anchoring
  flow.mermaid         # source of truth for semantics
  flow.excalidraw.json # scene + top-level `coflow` field (see 7.3), positions source of truth
  comments.json        # [{id, target, body, status, createdBy, createdAt}]
  versions/            # N.json snapshots {rev, docHash, flowHash, diff, decision, at}
```

Caps: single files 2MB (same as Plannotator annotate). `.env` never loaded.

## 6. Editor (both panes directly editable)

- Left: Tiptap (ProseMirror). Typing = `human-op`, saved immediately, debounced to `doc.md + doc.json`.
- Right: Excalidraw canvas via `@excalidraw/excalidraw` + `@excalidraw/mermaid-to-excalidraw`. Drag/relabel/add/delete = `human-op`, saved to `flow.excalidraw.json` + re-serialized to `flow.mermaid` when semantically clean.
- Semantics vs positions split: `nodes[{id,type,label,docRefId}] + edges[{id,from,to,label}]` vs `positions{id:{x,y}}`. Human drag writes positions only. AI patch preserves positions of unchanged IDs.
- Node types V0: `process, decision, start-end`. Shapes: rect, rounded, diamond, ellipse/stadium, circle. Edges: `-->` and `-.->` with `|label|`. Directions: LR, RL, TD, BT. Anything else -> full-replacement path, never silent degrade.
- Human layout fully allowed. AI proposes layout via dagre/ELK on `render-mermaid`; never force-zoom on `patch-diagram`.

## 7. AI patch protocol (vendored from flowchartai, MIT)

Do not fork flowchartai's Next.js app. Vendor only the pattern + narrow modules.

### 7.1 Commands (in `src/lib/diagram/contracts.ts` equivalent)

- `render-mermaid { mermaid, target, reason }`: create or fully replace one explicit target. Used for initial gen + unsupported-syntax fallback + legacy upgrade.
- `patch-diagram { target, baseRev, ops[] }`: atomic semantic ops on one explicit target at base revision. Ops: `addNode, updateNode (full style object replace), removeNode, addEdge, removeEdge`. No `updateEdge` — change endpoints via remove+add. Edge ID canonical: `source__target`, one directed pair max once.

Executor (`canvas-command-executor.ts` equivalent):
- Preserve user-created elements + other AI diagrams. Preserve IDs/positions of unchanged semantic elements.
- Ambiguous target, stale `baseRev`, invalid refs, unsupported syntax -> fail before `updateScene`, zero canvas mutation.
- One successful command = one `updateScene` with `CaptureUpdateAction.IMMEDIATELY` so Undo restores pre-command canvas. Late hydration uses `NEVER` to set history baseline.
- Local patch must not force viewport zoom.

### 7.2 Stream protocol (agent -> browser)

SSE events: `text | tool-call | finish | error | aborted`.
- Browser buffers cross-chunk, never applies partial tool args. Commits only after valid tool result + terminal `finish`.
- Usage/billing hook (if any later): record once, only after canvas commit succeeds. Render failures / aborts = zero.

### 7.3 Persistence

- Store semantic doc + rev inside Excalidraw JSON top-level `coflow` field (same as flowchartai's `flowchartAi` field). No migration needed. Save/reload/export preserves it. Files without it remain loadable, upgraded via one targeted `render-mermaid` when safely targeted.
- V1 records not satisfying capability profile (7.4): migrate record-by-record to full-replacement Mermaid, preserve unrelated metadata.

### 7.4 Mermaid capability profile (enforce in prompt + parser + renderer + tests)

Families: `flowchart|graph` only. Directions: `LR,RL,TD,BT`. Node stables IDs required. Shapes: rect, rounded, diamond, ellipse/stadium, circle. Edges: `-->`, `-.->` with pipe labels. Explicit `fill,stroke,stroke-width` (style update = full replace). No HTML labels, subgraphs, classes, edge styling, parallel edges, advanced connectors in patch path — those force `render-mermaid`.

## 8. Selection + comments -> AI task queue

```json
{
  "id": "c_123",
  "target": { "docRange": {"from": 120, "to": 210} },
  "body": "make this parallel",
  "status": "open|applied|wont-do",
  "createdBy": "human|ai",
  "createdAt": "2026-09-14T00:00:00Z"
}
// OR
{
  "id": "c_124",
  "target": { "nodeIds": ["n1","n2"], "edgeIds": ["n1__n2"] },
  "body": "missing error path, add retry",
  "status": "open",
  "createdBy": "human",
  "createdAt": "..."
}
```

- Anchors are stable IDs (`doc nodeId` / `semantic node/edge id`), never x,y.
- Each comment = task. AI must set `applied|wont-do+reason`. UI shows status inline.
- `Send to AI` payload: `{ selection, commentBody, fullDocHash, fullGraphRev, mermaidProfile }`. AI returns one Command (7.1) + `resolves: [commentIds]`.
- Comments persist in `comments.json`, survive layout regen via ID re-anchor (fuzzy fallback by label match if ID missing, marked `re-anchored`).

## 9. Bi-directional generation (V0 must-have)

- `Prompt -> Both`: one intent returns `{ docPatch, flowCommand }`.
- `Doc -> Flow`: "turn this section into flowchart" (selection -> `render-mermaid` scoped target).
- `Flow -> Doc`: "explain this subgraph as SOP" (nodeIds -> doc insert).
- Doc<->node cross-links: `node.docRefId <-> doc node id`. Click node highlights paragraph and vice-versa.

## 10. Diff + versions + gates

- Every AI commit + every human-op batch = new `rev`. `versions/N.json` snapshot.
- Visual diff: added green, removed red, moved ghosted. Text diff: standard ProseMirror diff.
- `Request approval` = Plannotator gate. Blocks calling agent until human acts. Returns decision JSON (4.1).

## 11. What to take vs skip from https://github.com/tanchaowen84/flowchartai

Take:
- `src/lib/diagram/contracts.ts`, `canvas-command-executor.ts`, parser/serializer/renderer + shared capability profile, FlowchartAgent system prompt (Mermaid constraints), SSE buffer-then-commit, Undo + `flowchartAi`-in-JSON persistence pattern (rename to `coflow`).
- `@excalidraw/mermaid-to-excalidraw` integration + lazy-load + idle-preload pattern.

Skip:
- Next.js marketing/blog/pricing, Better Auth, Postgres/Drizzle, Creem, Resend, R2/S3, analytics, i18n, docs content-collections. Do not import SaaS envelope.

## 12. V0 build list (ship slice)

1. `coflow` Node binary + session server (random port, open browser, block, stdout JSON, `--gate` exits).
2. Static editor page: Tiptap left + Excalidraw right + prompt bar.
3. File store impl (Sec 5) + rev/version snapshots.
4. Contracts + executor + Mermaid profile + render/patch paths.
5. Selection + comments.json + Send-to-AI + status pills.
6. Diff view + Approve/Annotate gate.
7. Chrome ext launcher (start + open only).
8. Export Mermaid/MD/PNG/SVG.

Cut V0: realtime collab (Yjs later), permissions, templates library, runnable nodes, comment threads, mobile editing, SaaS deploy.

V1: Yjs presence, templates, cross-link polish, `guide export/share` equivalent for flows.
V2: runnable flows (node = agent step), subflow library, PR share links.

## 13. Win / risk

Win if: % AI drafts annotated-not-deleted high, iterations-to-approve <4, % projects with doc<->flow links.
Risks: anchor rot on rewrite (stable IDs + re-anchor flag), AI pretty-but-wrong graphs (typed nodes + linter: decision must have >=2 outs), two panes feel disconnected (force cross-links V0).

## 14. Open decisions for build start

1. Single-player iteration first (yes V0) — confirm no team gates V0?
2. Flows as pictures V0 (yes) — runnable later?
3. First entry: `prompt->both` vs `import doc->gen flow` — default to both, support import day 1?

---
Refs: Plannotator CLI session model; flowchartai MIT (Excalidraw + mermaid-to-excalidraw + Mastra FlowchartAgent via OpenRouter).
