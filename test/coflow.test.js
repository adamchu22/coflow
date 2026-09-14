import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMermaid, toMermaid, mergePositions, layout, diffGraphs, lint, addEdge } from "../lib/graph.js";
import { Store, summarize } from "../lib/store.js";

const SRC = `flowchart TD
  n0([Start])
  n0 --> q{Valid?}
  q -->|yes| n1[Ship it]
  q -.->|no| n2[Fix it]
  n2 --> q`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coflow-"));

test("mermaid round-trips through the graph", () => {
  const g = parseMermaid(SRC);
  assert.equal(g.nodes.length, 4);
  assert.equal(g.edges.length, 4);
  assert.equal(g.nodes.find((n) => n.id === "q").type, "diamond");
  assert.equal(g.edges.find((e) => e.id === "q__n2").style, "dashed");
  assert.deepEqual(parseMermaid(toMermaid(g)).edges.map((e) => e.id), g.edges.map((e) => e.id));
});

test("every shape in the profile round-trips, legacy names normalise", () => {
  const src = "flowchart LR\n  a[A]\n  b(B)\n  c([C])\n  d((D))\n  e{E}";
  const types = parseMermaid(src).nodes.map((n) => n.type);
  assert.deepEqual(types, ["rectangle", "rounded", "stadium", "circle", "diamond"]);
  assert.equal(toMermaid(parseMermaid(src)).split("\n").slice(1).join("\n").trim(), 'a["A"]\n  b("B")\n  c(["C"])\n  d(("D"))\n  e{"E"}');
  // Old CoFlow shape names still load rather than blowing up an existing project.
  const legacy = { dir: "TD", nodes: [{ id: "x", type: "decision", label: "X" }, { id: "y", type: "start-end", label: "Y" }], edges: [] };
  assert.match(toMermaid(legacy), /x\{"X"\}/);
  assert.match(toMermaid(legacy), /y\(\["Y"\]\)/);
});

test("profile violations are rejected, not silently degraded", () => {
  assert.throws(() => parseMermaid("flowchart TD\n  subgraph one\n  end"), /unsupported/);
  assert.throws(() => parseMermaid("flowchart TD\n  a[A] ==> b[B]"), /unsupported/);
  assert.throws(() => parseMermaid("sequenceDiagram\n  a->>b: hi"), /unsupported/);
});

test("an updated flowchart from the agent keeps the positions the human dragged", () => {
  const placed = layout(parseMermaid(SRC));
  const hand = placed.nodes.find((n) => n.id === "q");
  hand.x = 999; hand.y = 42;
  placed.edges.find((e) => e.id === "n0__q").fromPort = 2;   // arrow pinned to the bottom side
  hand.color = "#ff8800"; hand.sw = 3; hand.opacity = 0.5;   // and styled by hand
  hand.w = 260; hand.h = 96;                                 // and stretched to fit its label

  // Agent sends back the same chart plus one new node.
  const next = parseMermaid(SRC + "\n  n1 --> done([Done])");
  const merged = layout(mergePositions(placed, next));

  assert.equal(merged.nodes.find((n) => n.id === "q").x, 999);
  assert.equal(merged.nodes.find((n) => n.id === "q").y, 42);
  assert.equal(merged.edges.find((e) => e.id === "n0__q").fromPort, 2, "port binding survives too");
  assert.equal(merged.nodes.find((n) => n.id === "q").color, "#ff8800", "so does the colour");
  assert.equal(merged.nodes.find((n) => n.id === "q").sw, 3, "and the stroke width");
  assert.equal(merged.nodes.find((n) => n.id === "q").opacity, 0.5, "and the opacity");
  assert.equal(merged.nodes.find((n) => n.id === "q").w, 260, "and the size you dragged it to");
  assert.equal(merged.nodes.find((n) => n.id === "q").h, 96);
  const fresh = merged.nodes.find((n) => n.id === "done");
  assert.ok(Number.isFinite(fresh.x) && Number.isFinite(fresh.y), "new node got laid out");
});

test("layout only fills unplaced nodes, and new ones land clear of placed ones", () => {
  const g = layout(parseMermaid(SRC));
  const before = g.nodes.map((n) => ({ ...n }));
  assert.deepEqual(layout(g).nodes, before, "layout is idempotent");

  addEdge(g, { from: "q", to: "extra" });
  g.nodes.push({ id: "extra", type: "rectangle", label: "Extra", x: null, y: null });
  const placed = layout(g).nodes.find((n) => n.id === "extra");
  const clash = layout(g).nodes.some((n) => n.id !== "extra" && Math.abs(n.x - placed.x) < 100 && Math.abs(n.y - placed.y) < 40);
  assert.ok(!clash, "new node does not land on top of an existing one");
});

test("diff and lint report what changed and what is wrong", () => {
  const a = parseMermaid(SRC);
  const b = parseMermaid(SRC + "\n  n1 --> r[Retry]");
  const d = diffGraphs(a, b);
  assert.deepEqual(d.addedNodes, ["r"]);
  assert.deepEqual(d.addedEdges, ["n1__r"]);
  assert.deepEqual(diffGraphs(b, a).removedNodes, ["r"]);

  const oneWay = parseMermaid("flowchart TD\n  a[A] --> q{Only one out?}");
  assert.ok(lint(oneWay).some((w) => /Only one out\?/.test(w)), "a decision with one exit is flagged");
});

test("summarize says in plain words what the human did", () => {
  const a = parseMermaid(SRC);
  const b = parseMermaid("flowchart TD\n  n0([Start])\n  n0 --> n1[Ship it]");
  const ops = summarize({ graph: a, doc: { blocks: [] } }, { graph: b, doc: { blocks: [] } });
  assert.ok(ops.some((o) => /removed node "Valid\?"/.test(o)), ops.join(" | "));
  assert.ok(ops.some((o) => /Fix it/.test(o)), ops.join(" | "));

  // Retitling a branch is a decision change, not cosmetic.
  const relabelled = parseMermaid("flowchart TD\n  n0([Start])\n  n0 -->|later| n1[Ship it]");
  const one = summarize({ graph: parseMermaid("flowchart TD\n  n0([Start])\n  n0 --> n1[Ship it]"), doc: { blocks: [] } }, { graph: relabelled, doc: { blocks: [] } });
  assert.deepEqual(one, ['relabelled edge n0__n1 to "later"']);
});

test("every save snapshots the prior state and records the change", () => {
  const dir = tmp();
  const s = new Store(dir);
  s.save({ graph: parseMermaid(SRC), doc: { blocks: [{ id: "b0", text: "# One" }] } });
  const r1 = s.meta.rev;
  s.save({ doc: { blocks: [{ id: "b0", text: "# Two" }] } });

  assert.match(fs.readFileSync(path.join(dir, "doc.md"), "utf8"), /# Two/);
  assert.match(fs.readFileSync(path.join(dir, "flow.mermaid"), "utf8"), /flowchart TD/);
  // Reverting is a step back, not an edit: rev goes down and the snapshot is dropped, so
  // pressing it twice goes two steps back instead of bouncing between the last two states.
  s.undo(s.meta.rev);
  assert.equal(s.doc.blocks[0].text, "# One");
  assert.match(fs.readFileSync(path.join(dir, "doc.md"), "utf8"), /# One/);
  assert.equal(s.meta.rev, r1);
  assert.equal(s.versions().length, r1);
  s.undo(r1);
  assert.equal(s.meta.rev, 0);
  assert.equal(s.versions().length, 0);
  fs.rmSync(dir, { recursive: true });
});

test("humanEdits is what the agent has not seen, handoff carries the lot", () => {
  const dir = tmp();
  const s = new Store(dir);
  s.save({ graph: parseMermaid(SRC), doc: { blocks: [{ id: "b0", text: "# Plan" }] }, by: "agent" });
  s.save({ graph: parseMermaid("flowchart TD\n  n0([Start])"), by: "human" });

  const mine = s.humanEdits();
  assert.ok(mine.some((o) => /removed node/.test(o)), mine.join(" | "));
  assert.deepEqual(s.humanEdits({ sinceAgent: true }), mine, "nothing from the agent counts as a human edit");

  // A comment with nothing selected is a general note, and one on a few words quotes them.
  s.comments.push({ id: "c1", target: {}, body: "cut this branch", status: "open" });
  s.comments.push({ id: "c2", target: { blockId: "b0", quote: "Plan" }, body: "too vague", status: "open" });
  s.save({ comments: s.comments, by: "human" });
  const { md } = s.handoff();
  assert.match(md, /general note: cut this branch/);
  assert.match(md, /doc "Plan": too vague/);
  assert.match(md, /```mermaid/);
  assert.match(md, /What the human changed by hand/);
  fs.rmSync(dir, { recursive: true });
});

test("the folder remembers the verdict, and stops claiming final once edited again", () => {
  const dir = tmp();
  const s = new Store(dir);
  s.save({ graph: parseMermaid(SRC), doc: { blocks: [{ id: "b0", text: "# Plan" }] } });
  assert.match(s.handoff().md, /\*\*draft\*\* — nobody has signed this off/);

  s.record("approved");
  assert.match(s.handoff().md, /\*\*approved\*\* by the human at rev 1/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "handoff.json"), "utf8")).decision.what, "approved");
  // A new Store sees it too, so a later session can tell finished from abandoned.
  assert.equal(new Store(dir).meta.decision.what, "approved");

  s.save({ doc: { blocks: [{ id: "b0", text: "# Plan, actually no" }] } });
  assert.match(s.handoff().md, /edited 1 more time\(s\) — no longer final/);
  fs.rmSync(dir, { recursive: true });
});
