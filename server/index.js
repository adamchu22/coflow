// Localhost session server. Serves the editor, owns the store, blocks until the human decides.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, newId, describeTarget, isUnresolved } from "../lib/store.js";
import { toMermaid, parseMermaid, mergePositions, lint, layout } from "../lib/graph.js";

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

export function startSession({ dir, title, docText = "", mermaid = "" }) {
  const store = new Store(dir);
  if (title && store.meta.title === "Untitled") store.meta.title = title;

  // Whatever the agent handed us seeds the project, once. Re-running against an existing
  // folder leaves the human's work alone unless the agent actually passed new content.
  if (docText.trim()) {
    const blocks = docText.trim().split(/\n{2,}/).map((text, i) => ({ id: `b${i}`, text: text.trim() }));
    store.save({ doc: { blocks }, by: "agent", note: "agent plan" });
  }
  if (mermaid.trim()) {
    store.save({ graph: layout(mergePositions(store.graph, parseMermaid(mermaid))), by: "agent", note: "agent flowchart" });
  }
  let decide;
  const decided = new Promise((r) => { decide = r; });

  const routes = {
    "GET /api/project": () => ({
      ...store.state(),
      dir: store.dir,
      mermaid: toMermaid(store.graph),
      lint: lint(store.graph),
      versions: store.versions(),
    }),

    "POST /api/save": (b) => {
      store.save({ doc: b.doc, graph: b.graph, title: b.title, by: "human", note: b.note || "edit" });
      return { rev: store.meta.rev, lint: lint(store.graph), graph: store.graph, versions: store.versions() };
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
      return { ...store.state(), mermaid: toMermaid(store.graph), versions: store.versions() };
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
      };
      store.handoff();
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
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(fmt === "md" ? store.doc.blocks.map((b) => b.text).join("\n\n") : toMermaid(store.graph));
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
        dismiss: () => decide({ decision: "dismissed", feedback: "", version: store.meta.rev, dir: store.dir, comments: [], humanOps: [], doc: "", mermaid: toMermaid(store.graph) }),
      });
    });
  });
}
