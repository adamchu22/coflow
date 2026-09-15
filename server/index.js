// Localhost session server. Serves the editor, owns the store, blocks until the human decides.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, newId, describeTarget, isUnresolved, flowName } from "../lib/store.js";
import { toMermaid, mergePositions, lint, layout } from "../lib/graph.js";

const EDITOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "editor");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const body = (req) =>
  new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 4e6) { reject(new Error("payload too large")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });

// `flows` is { name: graph } — already parsed, so a bad chart died in the CLI before this.
export function startSession({ dir, title, docText = "", flows = {} }) {
  const store = new Store(dir);
  if (title && store.meta.title === "Untitled") store.meta.title = title;

  // Whatever the agent handed us seeds the project, once. Re-running against an existing
  // folder leaves the human's work alone unless the agent actually passed new content.
  if (docText.trim()) {
    const blocks = docText.trim().split(/\n{2,}/).map((text, i) => ({ id: `b${i}`, text: text.trim() }));
    store.save({ doc: { blocks }, by: "agent", note: "agent plan" });
  }
  if (Object.keys(flows).length) {
    const next = { ...store.flows };
    for (const [name, g] of Object.entries(flows)) next[flowName(name)] = layout(mergePositions(store.flows[flowName(name)], g));
    store.save({ flows: next, by: "agent", note: "agent flowchart" });
  }
  let decide;
  const decided = new Promise((r) => { decide = r; });

  // Nobody watching, nobody waiting: the tab pings every 10s and beacons on close. Two
  // minutes for the browser to show up at all, thirty seconds of silence after that, and
  // the session dismisses itself — a closed tab must not leave a server behind.
  let seen = Date.now(), opened = false;
  const dismiss = () => decide({ decision: "dismissed", feedback: "", version: store.meta.rev, dir: store.dir, comments: [], humanOps: [], doc: "", mermaid: toMermaid(store.graph), flows: flowsOut() });
  const idle = setInterval(() => { if (Date.now() - seen > (opened ? 30000 : 120000)) dismiss(); }, 5000);
  decided.then(() => clearInterval(idle));

  const lintAll = () => Object.fromEntries(Object.entries(store.flows).map(([n, g]) => [n, lint(g)]));
  const flowsOut = () => Object.fromEntries(Object.entries(store.flows).map(([n, g]) => [n, { mermaid: toMermaid(g), graph: g }]));

  const routes = {
    "POST /api/ping": () => { seen = Date.now(); opened = true; return { ok: true }; },
    "POST /api/bye": () => { seen = Date.now() - 25000; return { ok: true }; },

    "GET /api/project": () => ({
      ...store.state(),
      dir: store.dir,
      lint: lintAll(),
      versions: store.versions(),
    }),

    "POST /api/save": (b) => {
      store.save({ doc: b.doc, graph: b.graph, flows: b.flows, title: b.title, by: "human", note: b.note || "edit" });
      return { rev: store.meta.rev, lint: lintAll(), flows: store.flows, versions: store.versions() };
    },

    "POST /api/comment": (b) => {
      if (b.id) {
        const c = store.comments.find((c) => c.id === b.id);
        if (!c) throw new Error("no such comment");
        // Status is the human's verdict only. The AI writes to c.thread, never here.
        const next = (b.patch || {}).status;
        if (next && !["open", "resolved"].includes(next)) throw new Error("bad status: " + next);
        if (next) c.status = next;
        if (b.patch?.body) c.body = String(b.patch.body).trim();
      } else {
        if (!b.body?.trim()) throw new Error("empty comment");
        store.comments.push({
          id: newId("c_"), target: b.target || {}, body: b.body.trim(),
          status: "open", createdBy: "human", createdAt: new Date().toISOString(),
        });
      }
      store.save({ comments: store.comments, by: "human", note: "comment" });
      return { comments: store.comments, rev: store.meta.rev };
    },

    "POST /api/undo": (b) => {
      store.undo(b.rev);
      return { ...store.state(), lint: lintAll(), versions: store.versions() };
    },

    "POST /api/handoff": () => ({ ...store.handoff(), dir: store.dir }),

    "POST /api/saveas": (b) => {
      if (!b.dir?.trim()) throw new Error("no dir");
      return { dir: store.copyTo(b.dir.trim()) };
    },

    // Everything the human produced goes back to the agent in one payload — nothing
    // here needs an API key, because the agent that called us is the AI.
    "POST /api/decision": (b) => {
      const decision = {
        decision: b.decision, feedback: b.feedback || "",
        version: store.meta.rev, dir: store.dir,
        comments: store.comments.filter(isUnresolved).map((c) => ({ id: c.id, target: describeTarget(c, store), body: c.body })),
        resolvedComments: store.comments.filter((c) => !isUnresolved(c)).map((c) => ({ target: describeTarget(c, store), body: c.body })),
        humanOps: store.humanEdits({ limit: 60 }),
        doc: store.doc.blocks.map((x) => x.text).join("\n\n"),
        mermaid: toMermaid(store.graph),
        flows: flowsOut(),
      };
      store.record(b.decision);
      setTimeout(() => decide(decision), 100);
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const key = `${req.method} ${url.pathname}`;
    try {
      if (routes[key]) return json(res, 200, await routes[key](req.method === "POST" ? await body(req) : {}));

      if (key === "GET /api/export") {
        const fmt = url.searchParams.get("fmt") || "mermaid";
        const g = store.flows[url.searchParams.get("flow")] ?? store.graph;
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(fmt === "md" ? store.doc.blocks.map((b) => b.text).join("\n\n") : toMermaid(g));
      }

      const file = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
      const full = path.join(EDITOR, file);
      if (fs.existsSync(full) && full.startsWith(EDITOR)) {
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "text/plain" });
        return res.end(fs.readFileSync(full));
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 400, { error: String(e.message || e) });
    }
  });

  return new Promise((resolve) => {
    const port = Number(process.env.COFLOW_PORT) || 0;
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      resolve({
        url, store,
        wait: async () => {
          // Closing the tab without deciding = dismissed.
          const d = await decided;
          server.close();
          return d;
        },
        dismiss,
      });
    });
  });
}
