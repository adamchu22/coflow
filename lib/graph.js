// Semantic flow graph: parse/serialize Mermaid, validate, apply AI ops, lay out, diff.
// Graph = { dir, nodes:[{id,type,label,x,y,props?,status?,docRefId?}], edges:[{id,from,to,label,style,props?,status?}]
//   props     free key/value pairs — actor, system, SLA, CRM property, whatever the agent's
//             vocabulary needs. Mermaid cannot carry them; they live in flows/<name>.json.
//   status    "proposed": the agent suggests it, the human accepts by clearing it.
//   docRefId  the doc block this step is described in.

// Shape vocabulary follows flowchartai (MIT), the open-source implementation of this
// same patch protocol, rather than spec 7.4s shorter list. Order matters: the longer
// wrappers must be tested before their prefixes.
export const TYPES = ["rectangle", "rounded", "stadium", "circle", "diamond"];
const WRAP = {
  stadium: ["([", "])"],
  circle: ["((", "))"],
  rounded: ["(", ")"],
  rectangle: ["[", "]"],
  diamond: ["{", "}"],
};
// mermaid renders ellipse and stadium identically; older CoFlow projects used semantic names.
const ALIAS = { ellipse: "stadium", "start-end": "stadium", process: "rectangle", decision: "diamond" };
export const normType = (t) => ALIAS[t] || (TYPES.includes(t) ? t : "rectangle");
export const NODE_W = 168, NODE_H = 64;

const unwrap = (s) => {
  for (const [type, [o, c]] of Object.entries(WRAP)) {
    if (s.startsWith(o) && s.endsWith(c) && s.length > o.length + c.length - 1)
      return { type, label: s.slice(o.length, -c.length).replace(/^"|"$/g, "") };
  }
  return null;
};

// `n1[Do thing]` or bare `n1`
function parseRef(tok) {
  const m = tok.trim().match(/^([A-Za-z0-9_-]+)\s*(.*)$/s);
  if (!m) return null;
  const [, id, rest] = m;
  if (!rest) return { id };
  const shape = unwrap(rest);
  if (!shape) throw new Error(`unsupported node shape: ${rest}`);
  return { id, ...shape };
}

export function parseMermaid(src) {
  const g = { dir: "TD", nodes: [], edges: [] };
  const byId = new Map();
  const put = (ref) => {
    if (!ref) return;
    let n = byId.get(ref.id);
    if (!n) { n = { id: ref.id, type: normType(ref.type), label: ref.label ?? ref.id, x: null, y: null }; byId.set(n.id, n); g.nodes.push(n); }
    else if (ref.label !== undefined) { n.label = ref.label; n.type = normType(ref.type); }
  };
  for (let raw of src.split("\n")) {
    const line = raw.replace(/%%.*$/, "").trim();
    if (!line) continue;
    const head = line.match(/^(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/i);
    if (head) { g.dir = head[1].toUpperCase() === "TB" ? "TD" : head[1].toUpperCase(); continue; }
    const edge = line.match(/^(.+?)\s*(-->|-\.->)\s*(?:\|([^|]*)\|\s*)?(.+)$/);
    if (edge) {
      const [, l, arrow, label, r] = edge;
      const a = parseRef(l), b = parseRef(r);
      put(a); put(b);
      addEdge(g, { from: a.id, to: b.id, label: label?.trim() || "", style: arrow === "-.->" ? "dashed" : "solid" });
      continue;
    }
    // Anything else arrow-shaped (==>, --o, <--, ~~~) is off-profile. Fail loudly rather
    // than swallow it into a node label.
    if (/[-=~.]{2,}[>ox]|<[-=~]/.test(line)) throw new Error("unsupported mermaid line: " + line);
    if (/^[A-Za-z0-9_-]+\s*[[({]/.test(line)) { put(parseRef(line)); continue; }
    throw new Error(`unsupported mermaid line: ${line}`);
  }
  return g;
}

// The human owns x/y. When the agent hands over a new flowchart, every node it kept
// stays exactly where the human dragged it; only genuinely new nodes get laid out.
// Everything the human owns and Mermaid cannot say: where it sits, how it looks, and
// which side of a box each arrow attaches to. The agent sends semantics; this puts the
// human's layer back on top of it.
// A Mermaid seed never sets these, so the old value always survives. A JSON seed may set
// them, and then the agent's value wins for the keys it sent — props merge key by key, so
// the actor the human typed in stays unless the agent names a new one.
const HUMAN = ["color", "stroke", "sw", "opacity", "fromPort", "toPort", "w", "h", "dash", "status", "docRefId"];

export function mergePositions(prev, next) {
  const keep = (list) => new Map((list || []).map((o) => [o.id, o]));
  const carry = (o, old) => {
    if (!old) return;
    for (const k of HUMAN) if (old[k] !== undefined && o[k] === undefined) o[k] = old[k];
    if (old.props || o.props) o.props = { ...old.props, ...o.props };
  };
  const at = keep(prev?.nodes);
  for (const n of next.nodes) {
    const old = at.get(n.id);
    if (old && old.x !== null && old.x !== undefined) { n.x = old.x; n.y = old.y; }
    carry(n, old);
  }
  const kept = keep(prev?.edges);
  for (const e of next.edges) carry(e, kept.get(e.id));
  return next;
}

// A graph the agent wrote as JSON instead of Mermaid — the only way to seed props, status
// and doc links. Same rule as the Mermaid path: a bad reference fails before anything is written.
export function fromJSON(obj) {
  const g = { dir: /^(LR|RL|TD|BT)$/.test(obj.dir) ? obj.dir : "TD", nodes: [], edges: [] };
  for (const n of obj.nodes || []) {
    if (!/^[A-Za-z0-9_-]+$/.test(n.id || "")) throw new Error(`bad node id: ${JSON.stringify(n.id)}`);
    g.nodes.push({ ...n, type: normType(n.type), label: n.label ?? n.id, x: n.x ?? null, y: n.y ?? null });
  }
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of obj.edges || []) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`edge ${e.from} -> ${e.to} names a node that does not exist`);
    const made = addEdge(g, e);
    for (const k of Object.keys(e)) if (made[k] === undefined) made[k] = e[k];
  }
  return g;
}

export const edgeId = (from, to) => `${from}__${to}`;

export function addEdge(g, { from, to, label = "", style = "solid" }) {
  const id = edgeId(from, to);
  const existing = g.edges.find((e) => e.id === id);
  if (existing) { if (label) existing.label = label; return existing; }
  const e = { id, from, to, label, style };
  g.edges.push(e);
  return e;
}

export function toMermaid(g) {
  const out = [`flowchart ${g.dir || "TD"}`];
  for (const n of g.nodes) {
    const [o, c] = WRAP[normType(n.type)];
    out.push(`  ${n.id}${o}"${String(n.label).replace(/"/g, "'")}"${c}`);
  }
  for (const e of g.edges) {
    const arrow = e.style === "dashed" ? "-.->" : "-->";
    out.push(`  ${e.from} ${arrow}${e.label ? ` |${e.label}|` : ""} ${e.to}`);
  }
  return out.join("\n");
}

// --- Layered layout. Only fills nodes with null x/y unless force. ---
export function layout(g, force = false) {
  const incoming = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
  const depth = new Map();
  let frontier = g.nodes.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  if (!frontier.length && g.nodes.length) frontier = [g.nodes[0].id];
  let d = 0;
  const seen = new Set();
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      depth.set(id, d);
      for (const e of g.edges) if (e.from === id && !seen.has(e.to)) next.push(e.to);
    }
    frontier = next;
    d++;
  }
  for (const n of g.nodes) if (!depth.has(n.id)) depth.set(n.id, d);

  const rows = new Map();
  for (const n of g.nodes) {
    const k = depth.get(n.id);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(n);
  }
  const horizontal = g.dir === "LR" || g.dir === "RL";
  const GAP_MAIN = 95, GAP_CROSS = 60;
  for (const [k, row] of rows) {
    const main = k * (horizontal ? NODE_W + GAP_MAIN : NODE_H + GAP_MAIN);
    const step = horizontal ? NODE_H + GAP_CROSS : NODE_W + GAP_CROSS;
    const held = force ? [] : row.filter((n) => n.x !== null && n.x !== undefined);
    const free = row.filter((n) => !held.includes(n));
    const crossOf = (n) => (horizontal ? n.y - 120 : n.x - 420);
    // New nodes land beside whatever the human already placed in this layer,
    // never on top of it.
    let cross = held.length
      ? Math.max(...held.map(crossOf)) + step
      : (-(free.length - 1) / 2) * step;
    for (const n of free) {
      n.x = 420 + (horizontal ? main : cross);
      n.y = 120 + (horizontal ? cross : main);
      cross += step;
    }
  }
  return g;
}

export function diffGraphs(a, b) {
  const an = new Map((a.nodes || []).map((n) => [n.id, n]));
  const bn = new Map((b.nodes || []).map((n) => [n.id, n]));
  const ae = new Set((a.edges || []).map((e) => e.id));
  const be = new Set((b.edges || []).map((e) => e.id));
  return {
    addedNodes: [...bn.keys()].filter((id) => !an.has(id)),
    removedNodes: [...an.keys()].filter((id) => !bn.has(id)),
    changedNodes: [...bn.keys()].filter((id) => an.has(id) && (an.get(id).label !== bn.get(id).label || an.get(id).type !== bn.get(id).type)),
    addedEdges: [...be].filter((id) => !ae.has(id)),
    removedEdges: [...ae].filter((id) => !be.has(id)),
  };
}

// Decision nodes need >= 2 outgoing edges (spec §13 linter).
export function lint(g) {
  const warn = [];
  for (const n of g.nodes) {
    const outs = g.edges.filter((e) => e.from === n.id).length;
    const type = normType(n.type);
    if (type === "diamond" && outs < 2) warn.push(`${n.label || n.id}: decision with ${outs} outgoing branch(es)`);
    if (type !== "stadium" && type !== "circle" && !outs && !g.edges.some((e) => e.to === n.id))
      warn.push(`${n.label || n.id}: orphan node`);
  }
  return warn;
}
