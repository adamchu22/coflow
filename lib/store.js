// Folder-as-database. One project dir holds meta, doc, flows, comments, version snapshots.
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
const EMPTY = () => ({ dir: "TD", nodes: [], edges: [] });
// A flow's name is its filename, so it has to be one.
export const flowName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "flow";

// A comment is unresolved until a *human* closes it. The AI only ever replies.
export const isUnresolved = (c) => c.status === "open";

// Plain-English record of what changed, so the AI can see edits it did not make
// (spec 10: removed elements do not linger on the canvas, but they do show up here).
const flowsOf = (s) => s.flows ?? { main: s.graph };
export function summarize(prev, next) {
  const out = [];
  const pf = flowsOf(prev), nf = flowsOf(next);
  const names = [...new Set([...Object.keys(pf), ...Object.keys(nf)])];
  for (const name of names) {
    const tag = names.length > 1 ? `[${name}] ` : "";
    if (!pf[name]) { out.push(`added flow "${name}"`); continue; }
    if (!nf[name]) { out.push(`removed flow "${name}"`); continue; }
    for (const op of graphOps(pf[name], nf[name])) out.push(tag + op);
  }
  const pb = new Map(prev.doc.blocks.map((b) => [b.id, b.text]));
  const nb = new Map(next.doc.blocks.map((b) => [b.id, b.text]));
  for (const [id, text] of nb) {
    if (!pb.has(id)) out.push(`added paragraph "${text.slice(0, 40)}"`);
    else if (pb.get(id) !== text) out.push(`edited paragraph "${text.slice(0, 40)}"`);
  }
  for (const [id, text] of pb) if (!nb.has(id)) out.push(`deleted paragraph "${text.slice(0, 40)}"`);
  return out;
}

function graphOps(a, b) {
  const out = [];
  const label = (g, id) => g.nodes.find((n) => n.id === id)?.label || id;
  const d = diffGraphs(a, b);
  for (const id of d.removedNodes) out.push(`removed node "${label(a, id)}" (${id})`);
  for (const id of d.addedNodes) out.push(`added node "${label(b, id)}" (${id})`);
  for (const id of d.changedNodes) out.push(`relabelled ${id} to "${label(b, id)}"`);
  for (const id of d.removedEdges) out.push(`removed edge ${id}`);
  for (const id of d.addedEdges) out.push(`added edge ${id}`);
  // An edge label is how a branch says "yes" / "no" — a relabel is a real decision change.
  for (const e of b.edges) {
    const o = a.edges.find((x) => x.id === e.id);
    if (o && (o.label || "") !== (e.label || "")) out.push(`relabelled edge ${e.id} to "${e.label}"`);
  }
  // Props, proposals and doc links are semantics too: the agent needs to hear about them.
  const both = (list, prevList) => list.map((o) => [o, prevList.find((x) => x.id === o.id)]).filter(([, p]) => p);
  for (const [n, o] of [...both(b.nodes, a.nodes), ...both(b.edges, a.edges)]) {
    const name = n.label || n.id;
    if (o.status === "proposed" && n.status !== "proposed") out.push(`accepted proposed "${name}" (${n.id})`);
    if (o.status !== "proposed" && n.status === "proposed") out.push(`marked "${name}" (${n.id}) as proposed`);
    if (JSON.stringify(o.props || {}) !== JSON.stringify(n.props || {}))
      out.push(Object.keys(n.props || {}).length ? `set props of "${name}" (${n.id}) to ${JSON.stringify(n.props)}` : `cleared props of "${name}" (${n.id})`);
    if ((o.docRefId || null) !== (n.docRefId || null))
      out.push(n.docRefId ? `linked "${name}" (${n.id}) to paragraph ${n.docRefId}` : `unlinked "${name}" (${n.id}) from its paragraph`);
  }
  const moved = b.nodes.filter((n) => {
    const o = a.nodes.find((x) => x.id === n.id);
    return o && o.x !== null && (o.x !== n.x || o.y !== n.y);
  });
  if (moved.length) out.push(`moved ${moved.length} node(s)`);
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
    this.flows = {};
    const fdir = this.f("flows");
    if (fs.existsSync(fdir))
      for (const f of fs.readdirSync(fdir).sort())
        if (f.endsWith(".json")) this.flows[path.basename(f, ".json")] = readJSON(path.join(fdir, f), EMPTY());
    // Projects from before flows/ kept one chart at the top level. It becomes `main`.
    if (!Object.keys(this.flows).length) this.flows.main = readJSON(this.f("flow.json"), EMPTY());
    this.comments = readJSON(this.f("comments.json"), []);
    return this;
  }

  // The main chart — what `mermaid` in the decision payload has always meant.
  get graph() { return this.flows.main ?? Object.values(this.flows)[0] ?? EMPTY(); }

  state() {
    return { meta: this.meta, doc: this.doc, flows: this.flows, comments: this.comments };
  }

  // Every write bumps rev and snapshots. `by` is "human" | "ai". `graph` is shorthand for `main`.
  save({ doc, graph, flows, comments, title, by = "human", note = "" } = {}) {
    const prev = { flows: this.flows, doc: this.doc };
    if (doc) this.doc = doc;
    if (graph) flows = { ...this.flows, main: graph };
    if (flows) this.flows = Object.fromEntries(Object.entries(flows).map(([k, g]) => [flowName(k), layout(g)]));
    if (comments) this.comments = comments;
    if (title) this.meta.title = title;
    this.meta.rev += 1;
    this.meta.updatedAt = new Date().toISOString();
    this.writeAll();
    const ops = summarize(prev, { doc: this.doc, flows: this.flows });
    fs.writeFileSync(
      this.f(`versions/${this.meta.rev}.json`),
      JSON.stringify({ rev: this.meta.rev, at: this.meta.updatedAt, by, note, ops, doc: prev.doc, flows: prev.flows }, null, 2)
    );
    return this.meta.rev;
  }

  writeAll() {
    fs.writeFileSync(this.f("coflow.json"), JSON.stringify(this.meta, null, 2));
    fs.writeFileSync(this.f("doc.json"), JSON.stringify(this.doc, null, 2));
    fs.writeFileSync(this.f("doc.md"), this.doc.blocks.map((b) => b.text).join("\n\n") + "\n");
    const fdir = this.f("flows");
    fs.mkdirSync(fdir, { recursive: true });
    for (const [name, g] of Object.entries(this.flows)) {
      fs.writeFileSync(path.join(fdir, `${name}.json`), JSON.stringify(g, null, 2));
      fs.writeFileSync(path.join(fdir, `${name}.mermaid`), toMermaid(g) + "\n");
    }
    // A deleted flow leaves the folder too, and the pre-flows/ files go once they are migrated.
    for (const f of fs.readdirSync(fdir))
      if (!this.flows[f.replace(/\.(json|mermaid)$/, "")]) fs.unlinkSync(path.join(fdir, f));
    for (const f of ["flow.json", "flow.mermaid"]) fs.rmSync(this.f(f), { force: true });
    fs.writeFileSync(this.f("comments.json"), JSON.stringify(this.comments, null, 2));
  }

  // Step back to how things were before `rev`. History shrinks: undoing is not an edit,
  // so it must not leave a new revision for the next undo to land on.
  undo(rev) {
    const snap = readJSON(this.f(`versions/${rev}.json`), null);
    if (!snap) throw new Error(`no snapshot for rev ${rev}`);
    this.doc = snap.doc;
    this.flows = snap.flows ?? { main: snap.graph };
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

  // The folder remembers the verdict, so a later session can tell a finished document
  // from an abandoned draft — and tell whether it has been edited since it was signed off.
  record(what) {
    this.meta.decision = { what, atRev: this.meta.rev, at: new Date().toISOString() };
    this.writeAll();
    return this.handoff();
  }

  status() {
    const d = this.meta.decision;
    if (!d) return "**draft** — nobody has signed this off yet.";
    const since = this.meta.rev - d.atRev;
    return since
      ? `**${d.what}** at rev ${d.atRev}, then edited ${since} more time(s) — no longer final.`
      : `**${d.what}** by the human at rev ${d.atRev} (${d.at}).`;
  }

  handoff() {
    const open = this.comments.filter(isUnresolved);
    const sessionEdits = this.humanEdits();
    const flows = Object.entries(this.flows);
    const counts = flows.map(([, g]) => g.nodes.length).reduce((a, b) => a + b, 0);
    const md = [
      `# ${this.meta.title} — CoFlow handoff`,
      ``,
      `rev ${this.meta.rev} · ${this.meta.updatedAt} · ${flows.length} flow(s) / ${counts} nodes`,
      ``,
      this.status(),
      ``,
      `## Doc`,
      ``,
      this.doc.blocks.map((b) => b.text).join("\n\n"),
      ``,
      ...flows.flatMap(([name, g]) => [
        flows.length === 1 && name === "main" ? `## Flow` : `## Flow: ${name}`,
        ``,
        "```mermaid",
        toMermaid(g),
        "```",
        ...propLines(g),
        ``,
      ]),
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
      dir: this.dir, rev: this.meta.rev, title: this.meta.title, decision: this.meta.decision ?? null,
      openComments: open.map((c) => c.id), humanEdits: sessionEdits, mermaid: toMermaid(this.graph),
      flows: Object.fromEntries(flows.map(([n, g]) => [n, { mermaid: toMermaid(g), graph: g }])),
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

// What Mermaid leaves out, listed under the chart so the handoff reads whole.
function propLines(g) {
  const rows = [...g.nodes, ...g.edges].filter((o) => o.status || o.docRefId || Object.keys(o.props || {}).length);
  if (!rows.length) return [];
  return ["", ...rows.map((o) => {
    const bits = [];
    if (o.status) bits.push(o.status);
    if (o.docRefId) bits.push(`doc ${o.docRefId}`);
    for (const [k, v] of Object.entries(o.props || {})) bits.push(`${k}: ${v}`);
    return `- ${o.id}: ${bits.join(" · ")}`;
  })];
}

export function describeTarget(c, store) {
  if (c.target?.quote) return `doc "${c.target.quote.slice(0, 60)}"`;
  if (c.target?.blockId) {
    const b = store.doc.blocks.find((b) => b.id === c.target.blockId);
    return `doc "${(b?.text || "?").slice(0, 48)}"`;
  }
  const flow = c.target?.flow || "main";
  const g = store.flows[flow] ?? store.graph;
  const labels = (c.target?.nodeIds || []).map((id) => g.nodes.find((n) => n.id === id)?.label || id);
  const edges = c.target?.edgeIds || [];
  if (!labels.length && !edges.length) return "general note";
  const where = Object.keys(store.flows).length > 1 ? `flow ${flow}` : "flow";
  return `${where} ${[...labels, ...edges].join(", ")}`;
}
