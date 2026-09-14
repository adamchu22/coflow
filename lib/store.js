// Folder-as-database. One project dir holds meta, doc, graph, comments, version snapshots.
import fs from "node:fs";
import path from "node:path";
import { toMermaid, layout, diffGraphs } from "./graph.js";

const MAX_FILE = 2 * 1024 * 1024; // spec §5 cap

const readJSON = (p, fallback) => {
  try {
    const raw = fs.readFileSync(p, "utf8");
    if (raw.length > MAX_FILE) throw new Error(`${p} exceeds 2MB cap`);
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    if (e instanceof SyntaxError) return fallback;
    throw e;
  }
};

export const newId = (p = "n") => `${p}${Math.random().toString(36).slice(2, 8)}`;

// A comment is unresolved until a *human* closes it. The AI only ever replies.
export const isUnresolved = (c) => c.status === "open";

// Plain-English record of what changed, so the AI can see edits it did not make
// (spec 10: removed elements do not linger on the canvas, but they do show up here).
export function summarize(prev, next) {
  const out = [];
  const label = (g, id) => g.nodes.find((n) => n.id === id)?.label || id;
  const d = diffGraphs(prev.graph, next.graph);
  for (const id of d.removedNodes) out.push(`removed node "${label(prev.graph, id)}" (${id})`);
  for (const id of d.addedNodes) out.push(`added node "${label(next.graph, id)}" (${id})`);
  for (const id of d.changedNodes) out.push(`relabelled ${id} to "${label(next.graph, id)}"`);
  for (const id of d.removedEdges) out.push(`removed edge ${id}`);
  for (const id of d.addedEdges) out.push(`added edge ${id}`);
  // An edge label is how a branch says "yes" / "no" — a relabel is a real decision change.
  for (const e of next.graph.edges) {
    const o = prev.graph.edges.find((x) => x.id === e.id);
    if (o && (o.label || "") !== (e.label || "")) out.push(`relabelled edge ${e.id} to "${e.label}"`);
  }
  const moved = next.graph.nodes.filter((n) => {
    const o = prev.graph.nodes.find((x) => x.id === n.id);
    return o && o.x !== null && (o.x !== n.x || o.y !== n.y);
  });
  if (moved.length) out.push(`moved ${moved.length} node(s)`);
  const pb = new Map(prev.doc.blocks.map((b) => [b.id, b.text]));
  const nb = new Map(next.doc.blocks.map((b) => [b.id, b.text]));
  for (const [id, text] of nb) {
    if (!pb.has(id)) out.push(`added paragraph "${text.slice(0, 40)}"`);
    else if (pb.get(id) !== text) out.push(`edited paragraph "${text.slice(0, 40)}"`);
  }
  for (const [id, text] of pb) if (!nb.has(id)) out.push(`deleted paragraph "${text.slice(0, 40)}"`);
  return out;
}

export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(path.join(this.dir, "versions"), { recursive: true });
    this.load();
  }

  f(name) { return path.join(this.dir, name); }

  load() {
    this.meta = readJSON(this.f("coflow.json"), { projectId: newId("p"), title: "Untitled", rev: 0, editor: "v0" });
    this.doc = readJSON(this.f("doc.json"), { blocks: [{ id: newId("b"), text: "# Untitled" }] });
    this.graph = readJSON(this.f("flow.json"), { dir: "TD", nodes: [], edges: [] });
    this.comments = readJSON(this.f("comments.json"), []);
    return this;
  }

  state() {
    return { meta: this.meta, doc: this.doc, graph: this.graph, comments: this.comments };
  }

  // Every write bumps rev and snapshots. `by` is "human" | "ai".
  save({ doc, graph, comments, title, by = "human", note = "" } = {}) {
    const prev = { graph: this.graph, doc: this.doc };
    if (doc) this.doc = doc;
    if (graph) this.graph = layout(graph);
    if (comments) this.comments = comments;
    if (title) this.meta.title = title;
    this.meta.rev += 1;
    this.meta.updatedAt = new Date().toISOString();
    this.writeAll();
    const ops = summarize(prev, { doc: this.doc, graph: this.graph });
    fs.writeFileSync(
      this.f(`versions/${this.meta.rev}.json`),
      JSON.stringify({ rev: this.meta.rev, at: this.meta.updatedAt, by, note, ops, doc: prev.doc, graph: prev.graph }, null, 2)
    );
    return this.meta.rev;
  }

  writeAll() {
    fs.writeFileSync(this.f("coflow.json"), JSON.stringify(this.meta, null, 2));
    fs.writeFileSync(this.f("doc.json"), JSON.stringify(this.doc, null, 2));
    fs.writeFileSync(this.f("doc.md"), this.doc.blocks.map((b) => b.text).join("\n\n") + "\n");
    fs.writeFileSync(this.f("flow.json"), JSON.stringify(this.graph, null, 2));
    fs.writeFileSync(this.f("flow.mermaid"), toMermaid(this.graph) + "\n");
    fs.writeFileSync(this.f("comments.json"), JSON.stringify(this.comments, null, 2));
  }

  // Step back to how things were before `rev`. History shrinks: undoing is not an edit,
  // so it must not leave a new revision for the next undo to land on.
  undo(rev) {
    const snap = readJSON(this.f(`versions/${rev}.json`), null);
    if (!snap) throw new Error(`no snapshot for rev ${rev}`);
    this.doc = snap.doc;
    this.graph = snap.graph;
    for (const f of fs.readdirSync(this.f("versions"))) {
      if (Number(path.basename(f, ".json")) >= rev) fs.unlinkSync(this.f(`versions/${f}`));
    }
    this.meta.rev = rev - 1;
    this.meta.updatedAt = new Date().toISOString();
    this.writeAll();
    return this.meta.rev;
  }

  versions() {
    return fs.readdirSync(this.f("versions"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJSON(this.f(`versions/${f}`), null))
      .filter(Boolean)
      .sort((a, b) => b.rev - a.rev)
      .map(({ rev, at, by, note, ops }) => ({ rev, at, by, note, ops: ops || [] }));
  }

  // Everything the human changed by hand. sinceAgent:true narrows it to edits made
  // after the agent's last write, which is what the agent has not seen yet.
  humanEdits({ sinceAgent = false, limit = 40 } = {}) {
    const all = this.versions();
    const floor = sinceAgent ? (all.find((v) => v.by === "agent")?.rev ?? 0) : 0;
    return all.filter((v) => v.by === "human" && v.rev > floor).flatMap((v) => v.ops).slice(0, limit);
  }

  handoff() {
    const open = this.comments.filter(isUnresolved);
    const sessionEdits = this.humanEdits();
    const md = [
      `# ${this.meta.title} — CoFlow handoff`,
      ``,
      `rev ${this.meta.rev} · ${this.meta.updatedAt} · ${this.graph.nodes.length} nodes / ${this.graph.edges.length} edges`,
      ``,
      `## Doc`,
      ``,
      this.doc.blocks.map((b) => b.text).join("\n\n"),
      ``,
      `## Flow`,
      ``,
      "```mermaid",
      toMermaid(this.graph),
      "```",
      ``,
      `## Open comments (${open.length})`,
      ``,
      ...(open.length
        ? open.flatMap((c) => [
            `- [${c.id}] ${describeTarget(c, this)}: ${c.body}`,
          ])
        : ["_none_"]),
      ``,
      `## What the human changed by hand`,
      ``,
      ...(sessionEdits.length ? sessionEdits.map((o) => `- ${o}`) : ["_none_"]),
      ``,
    ].join("\n");
    fs.writeFileSync(this.f("handoff.md"), md);
    fs.writeFileSync(this.f("handoff.json"), JSON.stringify({
      dir: this.dir, rev: this.meta.rev, title: this.meta.title,
      openComments: open.map((c) => c.id), humanEdits: sessionEdits, mermaid: toMermaid(this.graph),
    }, null, 2));
    return { cmd: `npx coflow attach ${this.dir}`, md };
  }

  copyTo(destDir) {
    const dest = path.resolve(destDir);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(this.dir, dest, { recursive: true });
    this.dir = dest;
    fs.mkdirSync(path.join(this.dir, "versions"), { recursive: true });
    return dest;
  }
}

export function describeTarget(c, store) {
  if (c.target?.quote) return `doc "${c.target.quote.slice(0, 60)}"`;
  if (c.target?.blockId) {
    const b = store.doc.blocks.find((b) => b.id === c.target.blockId);
    return `doc "${(b?.text || "?").slice(0, 48)}"`;
  }
  const labels = (c.target?.nodeIds || []).map((id) => store.graph.nodes.find((n) => n.id === id)?.label || id);
  const edges = c.target?.edgeIds || [];
  if (!labels.length && !edges.length) return "general note";
  return `flow ${[...labels, ...edges].join(", ")}`;
}
