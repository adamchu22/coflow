// CoFlow editor. No build step, no framework: SVG canvas + contenteditable doc.
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElementNS(tag === "div" || tag === "input" ? "http://www.w3.org/1999/xhtml" : "http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) v !== undefined && n.setAttribute(k, v);
  for (const c of [].concat(kids)) n.append(c);
  return n;
};

const W = 168, H = 64;
// Boxes are that size until you drag one bigger. w/h are yours like x/y are: Mermaid cannot
// carry them, so they live in flow.json and survive the agent handing back a new chart.
const nw = (n) => n.w || W, nh = (n) => n.h || H;
let S = null;                                  // server state
let view = { x: 0, y: 0, k: 1 };
const sel = { nodes: new Set(), edges: new Set(), blockId: null, quote: null };
let flash = { nodes: [], edges: [] };          // last AI diff, highlighted green
// Boxes ⌘+arrow just laid down, still unnamed. They are real (a crash loses nothing) but
// they draw as placeholders so a half-built chain reads as half-built.
const drafts = new Set();
// The branch ⌘+arrow is drawing right now: press again and the same origin splits into
// another sibling rather than growing a chain. Naming, Escape or any other click ends it.
let fan = null;

const api = async (p, opts) => {
  const r = await fetch(p, { headers: { "content-type": "application/json" }, ...opts });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "request failed");
  return j;
};

/* ─────────────── boot ─────────────── */
(async function boot() {
  S = await api("/api/project");
  $("#title").value = S.meta.title;
  renderAll();
  fit();
  setTimeout(() => $("#hint").classList.add("fade"), 9000);
})();

// The hint strip doubles as a "what now?" line while a chain is being drawn.
let hintTimer;
function hint(text) {
  const h = $("#hint");
  h.textContent = text;
  h.classList.remove("fade");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.add("fade"), 5000);
}

function renderAll() { renderDoc(); renderCanvas(); renderComments(); renderVersions(); renderLint(); renderPending(); }

function renderPending() {
  const open = S.comments.filter((c) => c.status === "open").length;
  $("#pending").textContent = open ? `${open} comment${open > 1 ? "s" : ""} waiting for the agent` : "";
  $("#cmeta").textContent = open ? `${open} open` : "";
}

/* ─────────────── doc pane ─────────────── */
function blockClass(t) {
  if (t.startsWith("# ")) return "h1";
  if (t.startsWith("## ")) return "h2";
  if (t.startsWith("### ")) return "h3";
  if (t.startsWith("> ")) return "quote";
  if (t.startsWith("```") || t.startsWith("    ")) return "code";
  if (/^\s*([-*]|\d+\.)\s/.test(t)) return "li";
  return "";
}

/* Live markdown. Every marker stays in the DOM text, so textContent is still the exact
   source and caret offsets need no mapping — we only dress what is already there.
   ponytail: inline + block prefixes. Tables and images stay raw, which still reads fine. */
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const mk = (m) => `<span class="mk">${m}</span>`;
function md(text) {
  if (text.startsWith("```") || text.startsWith("    ")) return esc(text);   // code stays literal
  return esc(text)
    .replace(/^(#{1,3} |&gt; |[-*] |\d+\. )/, mk)
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_, m, t) => `<b>${mk(m)}${t}${mk(m)}</b>`)
    .replace(/`([^`]+)`/g, (_, t) => `<code>${mk("`")}${t}${mk("`")}</code>`)
    .replace(/(^|[^\w*_])([*_])(?=\S)([^*_]*?\S)\2(?![\w*_])/g, (_, pre, m, t) => `${pre}<i>${mk(m)}${t}${mk(m)}</i>`)
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, t) => `<s>${mk("~~")}${t}${mk("~~")}</s>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a>${mk("[")}${t}${mk("](" + u + ")")}</a>`);
}

// Caret as a plain character offset — safe because the rendered text equals the source.
function caretOffset(host) {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0).cloneRange();
  const end = { c: r.endContainer, o: r.endOffset };
  r.selectNodeContents(host);
  r.setEnd(end.c, end.o);
  return r.toString().length;
}
function setCaret(host, off) {
  if (off === null) return;
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let n, seen = 0;
  while ((n = w.nextNode())) {
    if (seen + n.length >= off) {
      const r = document.createRange();
      r.setStart(n, off - seen);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return;
    }
    seen += n.length;
  }
  host.focus();
}

function renderDoc() {
  const host = $("#doc");
  host.textContent = "";
  docMeta();
  for (const b of S.doc.blocks) {
    const n = S.comments.filter((c) => c.target.blockId === b.id && c.status === "open").length;
    const d = el("div", {
      class: ["block", blockClass(b.text), sel.blockId === b.id ? "sel" : "", n ? "commented" : ""].filter(Boolean).join(" "),
      contenteditable: "true", "data-id": b.id, spellcheck: "false",
    });
    d.innerHTML = md(b.text) || "<br>";
    // ponytail: mark the first literal occurrence. A quote broken across markup tags
    // simply doesn't highlight — the comment still names it.
    for (const q of S.comments.filter((c) => c.target.quote && c.target.blockId === b.id && c.status === "open")) {
      const e = esc(q.target.quote);
      if (d.innerHTML.includes(e)) d.innerHTML = d.innerHTML.replace(e, `<mark>${e}</mark>`);
    }
    if (n) d.dataset.pin = String(n);
    host.append(d);
  }
}

$("#doc").addEventListener("input", (e) => {
  const d = e.target.closest(".block");
  if (!d || e.isComposing) return;
  const b = S.doc.blocks.find((b) => b.id === d.dataset.id);
  b.text = d.textContent.replace(/​/g, "");
  const off = caretOffset(d);
  d.className = ["block", blockClass(b.text), "sel"].filter(Boolean).join(" ");
  d.innerHTML = md(b.text) || "<br>";
  setCaret(d, off);
  queueSave();
});

// Paste plain text only — otherwise a copied web page lands as HTML the doc cannot round-trip.
$("#doc").addEventListener("paste", (e) => {
  e.preventDefault();
  document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
});

$("#doc").addEventListener("focusin", (e) => {
  const d = e.target.closest(".block");
  if (!d) return;
  sel.blockId = d.dataset.id;
  sel.nodes.clear(); sel.edges.clear();
  document.querySelectorAll(".block.sel").forEach((x) => x.classList.remove("sel"));
  d.classList.add("sel");
  renderCanvas(); syncTarget();
});

// Enter splits into a new block; Backspace at the very start merges back.
// Each paragraph is its own contenteditable, so the browser's ⌘A stops at the one you are
// in. Select every block instead, and let the next keystroke clear the doc the way it would
// clear a selection anywhere else.
let allDoc = false;
const selectWholeDoc = (on) => {
  allDoc = on;
  document.querySelectorAll("#doc .block").forEach((d) => d.classList.toggle("all", on));
};
const replaceDoc = (text) => {
  const id = "b" + Math.random().toString(36).slice(2, 8);
  S.doc.blocks = [{ id, text }];
  sel.blockId = null;
  selectWholeDoc(false);
  renderDoc(); queueSave("cleared the doc");
  const d = document.querySelector(`[data-id="${id}"]`);
  if (d) { d.focus(); setCaret(d, text.length); }
};
addEventListener("pointerdown", () => selectWholeDoc(false), true);

$("#doc").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); return selectWholeDoc(true); }
  if (allDoc) {
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); return replaceDoc(""); }
    // Typing over a selection replaces it, here as anywhere else.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); return replaceDoc(e.key); }
    if (e.key !== "Escape") selectWholeDoc(false); else { e.preventDefault(); return selectWholeDoc(false); }
  }
  const d = e.target.closest(".block");
  if (!d) return;
  const i = S.doc.blocks.findIndex((b) => b.id === d.dataset.id);
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const id = "b" + Math.random().toString(36).slice(2, 8);
    S.doc.blocks.splice(i + 1, 0, { id, text: "" });
    renderDoc(); queueSave();
    document.querySelector(`[data-id="${id}"]`)?.focus();
  }
  if (e.key === "Backspace" && i > 0 && !d.textContent.length) {
    e.preventDefault();
    S.doc.blocks.splice(i, 1);
    renderDoc(); queueSave();
    const prev = document.querySelector(`[data-id="${S.doc.blocks[i - 1].id}"]`);
    prev?.focus();
  }
});

// One project = one doc. Show where it is on disk so "which file is this?" has an answer.
function docMeta() {
  const m = $("#docmeta");
  m.textContent = `${(S.dir || "").replace(/^\/Users\/[^/]+/, "~")}/doc.md · rev ${S.meta.rev}`;
  m.title = `${S.dir}/doc.md`;
}

/* ── Right-click is how you talk about a thing without leaving it: the menu opens on
      what is under the cursor, and the comment box opens there too. ── */
function menu(ev, items) {
  ev.preventDefault();
  const m = $("#ctxmenu");
  m.textContent = "";
  for (const [label, fn] of items) {
    if (!label) { m.append(Object.assign(document.createElement("span"), { className: "sep" })); continue; }
    const b = Object.assign(document.createElement("button"), { textContent: label });
    b.onclick = () => { m.hidden = true; fn(); syncInspector(); };
    m.append(b);
  }
  m.hidden = false;
  syncInspector();
  m.style.left = Math.min(ev.clientX, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = Math.min(ev.clientY, innerHeight - m.offsetHeight - 8) + "px";
}
addEventListener("pointerdown", (e) => { if (!e.target.closest("#ctxmenu")) { $("#ctxmenu").hidden = true; syncInspector(); } }, true);

// The comment box, where the thing is. Same payload as the rail, one less round trip.
function commentPopover(target, x, y) {
  const p = $("#cpop"), ta = p.querySelector("textarea");
  p.hidden = false;
  syncInspector();
  p.style.left = Math.min(x, innerWidth - p.offsetWidth - 8) + "px";
  p.style.top = Math.min(y, innerHeight - p.offsetHeight - 8) + "px";
  p.querySelector(".where").textContent = describe(target);
  ta.value = ""; ta.focus();
  p.onsubmitcomment = async () => {
    const body = ta.value.trim();
    if (!body) return;
    const r = await api("/api/comment", { method: "POST", body: JSON.stringify({ body, target }) });
    S.comments = r.comments; S.meta.rev = r.rev;
    closeComment();
    renderAll();
    toast("Comment added — the agent gets it when you send feedback");
  };
}
const closeComment = () => { $("#cpop").hidden = true; syncInspector(); };
$("#cpop").addEventListener("click", (e) => {
  if (e.target.closest("[data-post]")) $("#cpop").onsubmitcomment();
  if (e.target.closest("[data-close]")) closeComment();
});
$("#cpop").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") $("#cpop").onsubmitcomment();
  if (e.key === "Escape") closeComment();
});
addEventListener("pointerdown", (e) => { if (!e.target.closest("#cpop,#ctxmenu,#selbar,#inspector")) closeComment(); }, true);

// C, or the toolbar button: same box, anchored to whatever is selected.
const commentOn = () => {
  syncTarget();
  const b = ($("#inspector").hidden ? svg : $("#inspector")).getBoundingClientRect();
  commentPopover(targetOf(), $("#inspector").hidden ? b.left + 40 : b.left, $("#inspector").hidden ? b.top + 40 : b.bottom + 6);
};

$("#doc").addEventListener("contextmenu", (ev) => {
  const d = ev.target.closest(".block");
  if (!d) return;
  sel.nodes.clear(); sel.edges.clear();
  sel.blockId = d.dataset.id;
  document.querySelectorAll(".block.sel").forEach((x) => x.classList.remove("sel"));
  d.classList.add("sel");
  renderCanvas();
  const quote = hi && hi.id === d.dataset.id && hi.end > hi.start
    ? { blockId: hi.id, quote: S.doc.blocks.find((b) => b.id === hi.id).text.slice(hi.start, hi.end) } : null;
  menu(ev, [
    quote && [`Comment on “${quote.quote.slice(0, 24)}”…`, () => commentPopover(quote, ev.clientX, ev.clientY)],
    ["Comment on this paragraph…", () => commentPopover({ blockId: d.dataset.id }, ev.clientX, ev.clientY)],
    ["General note…", () => commentPopover({}, ev.clientX, ev.clientY)],
    [null],
    ["Expand the doc", () => $("#t-expand").click()],
  ].filter(Boolean));
});

/* ── Highlight some words and a small bar appears: markdown you don't have to type,
      and a comment pinned to exactly those words. ── */
function selOffsets(d) {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return null;
  const r = s.getRangeAt(0);
  if (!d.contains(r.commonAncestorContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(d);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  return { start, end: start + r.toString().length, rect: r.getBoundingClientRect() };
}

let hi = null;   // { block, start, end } — what is highlighted right now
document.addEventListener("selectionchange", () => {
  const d = getSelection().anchorNode?.parentElement?.closest?.("#doc .block");
  const o = d && selOffsets(d);
  const bar = $("#selbar");
  if (!o) { bar.hidden = true; hi = null; return; }
  hi = { id: d.dataset.id, ...o };
  const p = $("#docpane").getBoundingClientRect();
  bar.hidden = false;
  bar.style.left = Math.max(4, Math.min(o.rect.left - p.left, p.width - bar.offsetWidth - 4)) + "px";
  bar.style.top = Math.max(4, o.rect.top - p.top - 34) + "px";
});

function editBlock(fn) {
  if (!hi) return;
  const b = S.doc.blocks.find((x) => x.id === hi.id);
  const [text, caret] = fn(b.text, hi.start, hi.end);
  b.text = text;
  renderDoc();
  const d = document.querySelector(`[data-id="${b.id}"]`);
  d.focus(); setCaret(d, caret);
  queueSave("formatted");
}

$("#selbar").addEventListener("mousedown", (e) => e.preventDefault());   // keep the selection
$("#selbar").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || !hi) return;
  if (b.dataset.wrap) {
    const m = b.dataset.wrap;
    editBlock((t, s, x) => [t.slice(0, s) + m + t.slice(s, x) + m + t.slice(x), x + m.length * 2]);
  } else if (b.dataset.prefix) {
    // Prefixes belong to the whole block, and swapping one for another beats stacking them.
    const p = b.dataset.prefix;
    editBlock((t) => {
      const bare = t.replace(/^(#{1,3} |> |[-*] |\d+\. )/, "");
      return bare === t || !t.startsWith(p) ? [p + bare, p.length + bare.length] : [bare, bare.length];
    });
  } else if (b.id === "sel-link") {
    const u = prompt("Link to:");
    if (u) editBlock((t, s, x) => [`${t.slice(0, s)}[${t.slice(s, x)}](${u})${t.slice(x)}`, x + u.length + 4]);
  } else if (b.id === "sel-comment") {
    const blk = S.doc.blocks.find((x) => x.id === hi.id);
    sel.quote = { blockId: hi.id, quote: blk.text.slice(hi.start, hi.end) };
    sel.nodes.clear(); sel.edges.clear();
    syncTarget();
    $("#cbody").focus();
  }
});

// Anything else you select is a different target, so the pinned quote goes with it.
for (const ev of ["focusin", "pointerdown"]) addEventListener(ev, (e) => {
  if (!e.target.closest("#selbar,#cbody,#cadd,#cpop,#ctxmenu")) sel.quote = null;
}, true);

// The doc on its own when you want to write, the canvas back when you want to draw.
$("#t-expand").onclick = () => {
  const on = document.querySelector("main").classList.toggle("docfull");
  $("#t-expand").textContent = on ? "⤡" : "⤢";
  if (!on) fit();
};

/* ─────────────── canvas ─────────────── */
const svg = $("#canvas");
// Selecting on pointerdown re-renders the canvas, so the element the first click landed
// on is gone by the time dblclick fires — which means dblclick lands on the container and
// ev.target is useless. Hit-test the live DOM at the pointer instead.
svg.addEventListener("dblclick", (ev) => {
  const g = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".node,.edge");
  if (!g) return;
  ev.stopPropagation();
  const id = g.dataset.id;
  const n = nodeById(id);
  n ? rename(n) : labelEdge(S.graph.edges.find((e) => e.id === id));
});
// Port offsets from a node centre, clockwise from the top. An edge with fromPort/toPort
// set is pinned to that side; without one it takes the shortest line, as before.
const ports = (n) => [[0, -nh(n) / 2], [nw(n) / 2, 0], [0, nh(n) / 2], [-nw(n) / 2, 0]];
const anchor = (n, i) => { const [ox, oy] = ports(n)[i]; return { x: n.x + ox, y: n.y + oy }; };
const nearestPort = (n, p) => {
  let best, bd = 22;   // aim at a dot to pin that side; drop mid-box and the arrow stays auto
  ports(n).forEach((_, i) => {
    const a = anchor(n, i), d = Math.hypot(p.x - a.x, p.y - a.y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
};
svg.addEventListener("contextmenu", (ev) => {
  const g = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".node,.edge");
  const p = toWorld(ev);
  sel.blockId = null;
  document.querySelectorAll(".block.sel").forEach((x) => x.classList.remove("sel"));
  if (!g) {
    sel.nodes.clear(); sel.edges.clear();
    renderCanvas();
    return menu(ev, [
      ["Add a step here", () => { const n = { id: newNodeId(), type: "rectangle", label: "Step", x: p.x, y: p.y }; S.graph.nodes.push(n); sel.nodes = new Set([n.id]); renderCanvas(); queueSave("add node"); rename(n); }],
      ["General note…", () => commentPopover({}, ev.clientX, ev.clientY)],
    ]);
  }
  const id = g.dataset.id;
  // Right-clicking inside a marquee selection keeps it: the menu acts on all of it.
  if (!sel.nodes.has(id) && !sel.edges.has(id)) {
    sel.nodes.clear(); sel.edges.clear();
    nodeById(id) ? sel.nodes.add(id) : sel.edges.add(id);
  }
  renderCanvas(); syncTarget();
  const n = nodeById(id);
  menu(ev, [
    ["Add comment…", () => commentPopover(targetOf(), ev.clientX, ev.clientY)],
    [n ? "Rename" : "Label this arrow", () => (n ? rename(n) : labelEdge(S.graph.edges.find((e) => e.id === id)))],
    n && ["Add the next step →", () => { const to = addNext(n, 1); link(n, to, 1); rename(to); }],
    [null],
    ["Delete", del],
  ].filter(Boolean));
});
const nodeById = (id) => S.graph.nodes.find((n) => n.id === id);
const newNodeId = () => "n" + Math.random().toString(36).slice(2, 6);

const toWorld = (ev) => {
  const r = svg.getBoundingClientRect();
  return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
};

function applyView() {
  $("#world").setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
  document.getElementById("dots").setAttribute("patternTransform", `translate(${view.x} ${view.y}) scale(${view.k})`);
  $("#zoomlabel").textContent = Math.round(view.k * 100) + "%";
}

function wrap(label, max = 20, rows = 3) {
  const words = String(label).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) { lines.push(cur); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, rows);
}

// flowchartai's shape vocabulary: rectangle, rounded, stadium, circle, diamond.
function shapeEl(n) {
  const type = n.type, cls = "n-box " + type, w = nw(n), h = nh(n);
  // Inline style, not fill/stroke attributes: the stylesheet would win over an attribute.
  const style = [
    n.color && `fill:${n.color}`,
    n.stroke ? `stroke:${n.stroke}` : n.color && `stroke:color-mix(in srgb,${n.color} 60%,#111)`,
    n.sw && `stroke-width:${n.sw}`,
  ].filter(Boolean).join(";") || undefined;
  if (type === "diamond") return el("path", { class: cls, style, d: `M${w / 2} 0 L${w} ${h / 2} L${w / 2} ${h} L0 ${h / 2} Z` });
  if (type === "circle") return el("ellipse", { class: cls, style, cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 });
  const rx = type === "stadium" ? h / 2 : type === "rounded" ? 18 : 6;
  return el("rect", { class: cls, style, width: w, height: h, rx });
}

function renderCanvas() {
  const gN = $("#nodes"), gE = $("#edges");
  gN.textContent = ""; gE.textContent = "";

  for (const e of S.graph.edges) {
    const a = nodeById(e.from), b = nodeById(e.to);
    if (!a || !b) continue;
    const p = edgePath(a, b, e);
    const g = el("g", { class: ["edge", e.style === "dashed" ? "dashed" : "", sel.edges.has(e.id) ? "sel" : "", flash.edges.includes(e.id) ? "added" : ""].filter(Boolean).join(" "), "data-id": e.id });
    if (e.opacity !== undefined) g.setAttribute("opacity", e.opacity);
    const st = [e.color && `stroke:${e.color};marker-end:url(#arrow-ctx)`, e.sw && `stroke-width:${e.sw}`].filter(Boolean).join(";");
    g.append(el("path", { class: "hit", d: p.d }), el("path", { d: p.d, style: st || undefined }));
    if (e.label) g.append(el("text", { x: p.mx, y: p.my - 5 }, e.label));
    g.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); pick(ev, null, e.id); });
    gE.append(g);
  }

  for (const n of S.graph.nodes) {
    const open = S.comments.filter((c) => (c.target.nodeIds || []).includes(n.id) && c.status === "open");
    const g = el("g", {
      class: ["node", sel.nodes.has(n.id) ? "sel" : "", drafts.has(n.id) ? "tmp" : "", flash.nodes.includes(n.id) ? "added" : ""].filter(Boolean).join(" "),
      transform: `translate(${n.x - nw(n) / 2} ${n.y - nh(n) / 2})`, "data-id": n.id,
    });
    if (n.opacity !== undefined) g.setAttribute("opacity", n.opacity);
    g.append(shapeEl(n));

    // Wider box, more words per line; taller box, more lines — that is what resizing is for.
    const w = nw(n), h = nh(n), tight = n.type === "diamond" || n.type === "circle";
    const lines = wrap(n.label, Math.max(6, Math.round((w / (tight ? 12 : 8.4)))), Math.max(1, Math.floor(h / 20)));
    const t = el("text", { x: w / 2, y: h / 2 - (lines.length - 1) * 8 + 5 });
    lines.forEach((l, i) => t.append(el("tspan", { x: w / 2, dy: i ? 16 : 0 }, l)));
    g.append(t);

    // Any edge or corner of the selected box resizes it. Added before the ports so the blue
    // dots still win the middle of each side — drawing an arrow beats resizing there.
    if (sel.nodes.size === 1 && sel.nodes.has(n.id))
      for (const [sx, sy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
        const T = 10, cur = sx && sy ? (sx === sy ? "nwse" : "nesw") : sx ? "ew" : "ns";
        const grip = el("rect", {
          class: "grip", style: `cursor:${cur}-resize`,
          x: sx < 0 ? -T / 2 : sx > 0 ? w - T / 2 : T / 2, width: sx ? T : w - T,
          y: sy < 0 ? -T / 2 : sy > 0 ? h - T / 2 : T / 2, height: sy ? T : h - T,
        });
        grip.addEventListener("pointerdown", (ev) => startResize(ev, n, sx, sy));
        g.append(grip);
      }

    // Two circles per port: a fat invisible one you can actually hit, a small visible dot.
    [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]].forEach(([px, py], i) => {
      const hit = el("circle", { class: "porthit", cx: px, cy: py, r: 15 });
      hit.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); startLink(ev, n, i); });
      g.append(hit, el("circle", { class: "port", cx: px, cy: py, r: 5.5 }));
    });
    if (open.length) {
      const pin = el("g", { class: "cpin", transform: `translate(${w - 6} -6)` });
      pin.append(el("circle", { r: 9 }), el("text", { y: 3.5 }, String(open.length)));
      pin.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); document.querySelector(`[data-cid="${open[0].id}"]`)?.scrollIntoView({ block: "center" }); });
      g.append(pin);
    }
    g.addEventListener("pointerdown", (ev) => startDrag(ev, n));
    gN.append(g);
  }

  // Grab either end of a selected arrow to move it to another box (or another side).
  const gH = $("#handles");
  gH.textContent = "";
  for (const e of S.graph.edges) {
    const a = nodeById(e.from), b = nodeById(e.to);
    if (!sel.edges.has(e.id) || !a || !b) continue;
    const p = edgePath(a, b, e);
    for (const [end, pt] of [["from", p.p1], ["to", p.p2]]) {
      const h = el("circle", { class: "handle", cx: pt.x, cy: pt.y, r: 7 });
      h.addEventListener("pointerdown", (ev) => startReattach(ev, e, end));
      gH.append(h);
    }
  }
  syncInspector();
  applyView();
}

// Every arrow leaves and arrives square to a box side, so a branch that fans out is
// symmetric: the top and bottom siblings mirror each other instead of one bowing away.
// A genuine back edge — a retry climbing the chart — still bows aside to clear the chain.
const NORMAL = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const facing = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);

function edgePath(a, b, e = {}) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const fp = e.fromPort ?? facing(dx, dy);
  const tp = e.toPort ?? facing(-dx, -dy);
  // 4px clear of the outline, so the head points at the box rather than into it.
  const out = (n, i) => ({ x: anchor(n, i).x + NORMAL[i][0] * 4, y: anchor(n, i).y + NORMAL[i][1] * 4 });
  const p1 = out(a, fp), p2 = out(b, tp);
  // How far each end holds its own direction: half the room it actually has that way, so
  // the curve never overshoots the gap and kinks back on itself.
  const gx = p2.x - p1.x, gy = p2.y - p1.y;
  const reach = (i, x, y) => Math.max(30, Math.min(120, (x * NORMAL[i][0] + y * NORMAL[i][1]) * 0.5));
  const k1 = reach(fp, gx, gy), k2 = reach(tp, -gx, -gy);
  const back = e.fromPort === undefined && (dy < -1 || (Math.abs(dy) <= 1 && dx < 0));
  const off = back ? Math.min(220, 70 + L * 0.16) : 0;
  const bx = (-dy / L) * off, by = (dx / L) * off;
  const c1 = { x: p1.x + NORMAL[fp][0] * k1 + bx, y: p1.y + NORMAL[fp][1] * k1 + by };
  const c2 = { x: p2.x + NORMAL[tp][0] * k2 + bx, y: p2.y + NORMAL[tp][1] * k2 + by };
  return {
    p1, p2,
    d: `M${p1.x} ${p1.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`,
    mx: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
    my: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
  };
}

const selKey = () => [...sel.nodes].sort().join() + "|" + [...sel.edges].sort().join();

function pick(ev, nodeId, edgeId) {
  const key = selKey();
  if (!ev.shiftKey) { sel.nodes.clear(); sel.edges.clear(); }
  sel.blockId = null;
  if (nodeId) sel.nodes.has(nodeId) && ev.shiftKey ? sel.nodes.delete(nodeId) : sel.nodes.add(nodeId);
  if (edgeId) sel.edges.add(edgeId);
  document.querySelectorAll(".block.sel").forEach((x) => x.classList.remove("sel"));
  // Re-rendering detaches the element the pointer is on, and a dblclick whose two clicks
  // hit different elements is never dispatched. Redraw only when selection actually moved.
  if (key !== selKey()) renderCanvas();
  syncTarget();
}

function startDrag(ev, n) {
  ev.stopPropagation();
  svg.setPointerCapture(ev.pointerId);
  if (!sel.nodes.has(n.id)) pick(ev, n.id);
  const start = toWorld(ev);
  const origin = [...sel.nodes].map((id) => ({ n: nodeById(id), x: nodeById(id).x, y: nodeById(id).y }));
  const move = (e) => {
    const p = toWorld(e);
    for (const o of origin) { o.n.x = o.x + (p.x - start.x); o.n.y = o.y + (p.y - start.y); }
    renderCanvas();
  };
  const up = () => {
    svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up);
    queueSave("move");
  };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up);
}

// Drag an edge or a corner. sx/sy say which one, so the side you did not grab stays put.
function startResize(ev, n, sx, sy) {
  ev.stopPropagation();
  svg.setPointerCapture(ev.pointerId);
  const start = toWorld(ev), w0 = nw(n), h0 = nh(n), x0 = n.x, y0 = n.y;
  const move = (e) => {
    const p = toWorld(e);
    const w = Math.max(80, w0 + (p.x - start.x) * sx), h = Math.max(44, h0 + (p.y - start.y) * sy);
    n.w = Math.round(w); n.h = Math.round(h);
    // Centre moves half of whatever the size did, which holds the opposite edge still.
    if (sx) n.x = Math.round(x0 + (sx * (w - w0)) / 2);
    if (sy) n.y = Math.round(y0 + (sy * (h - h0)) / 2);
    renderCanvas();
  };
  const up = () => {
    svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up);
    queueSave("resize");
  };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up);
}

function startLink(ev, from, port) {
  svg.setPointerCapture(ev.pointerId);
  const rub = $("#rubber");
  let over = null;
  const under = (p) =>
    S.graph.nodes.find((n) => n.id !== from.id && Math.abs(p.x - n.x) < nw(n) / 2 + 10 && Math.abs(p.y - n.y) < nh(n) / 2 + 10);
  const highlight = (id) => {
    if (id === over) return;
    over = id;
    document.querySelectorAll(".node.drop").forEach((x) => x.classList.remove("drop"));
    if (over) document.querySelector(`.node[data-id="${over}"]`)?.classList.add("drop");
  };

  const move = (e) => {
    const p = toWorld(e);
    const hit = under(p);
    highlight(hit?.id || null);
    // Preview snaps to the box edge once you are over a node, so the arrow reads true.
    const s = anchor(from, port);
    rub.setAttribute("d", hit ? edgePath(from, hit, { fromPort: port }).d : `M${s.x} ${s.y} L${p.x} ${p.y}`);
  };

  const up = (e) => {
    svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up);
    rub.removeAttribute("d");
    highlight(null);
    const p = toWorld(e);
    let to = under(p);
    const fresh = !to;
    if (fresh) to = addNext(from, port, p.x - from.x, p.y - from.y);
    link(from, to, port);
    if (fresh) rename(to);
  };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up);
}

// The next box, a clear gap away in the direction you pointed. Shared by the blue dots
// and by ⌘+arrow, so chaining by keyboard lands exactly where dragging would.
function addNext(from, port, dx = 0, dy = 0) {
  const L = Math.hypot(dx, dy);
  const [ux, uy] = L < 50 ? NORMAL[port] : [dx / L, dy / L];
  const gap = Math.max(L, Math.abs(ux) > Math.abs(uy) ? W + 80 : H + 100);
  let x = from.x + ux * gap, y = from.y + uy * gap;
  while (S.graph.nodes.some((n) => Math.abs(n.x - x) < W * 0.9 && Math.abs(n.y - y) < H * 0.9)) { x += ux || 30; y += uy ? uy * H : H; }
  const to = { id: newNodeId(), type: "rectangle", label: "Step", x, y };
  S.graph.nodes.push(to);
  return to;
}

// One more sibling on the current branch, with every sibling re-spaced so they stay even.
function grow(from, port) {
  const to = { id: newNodeId(), type: "rectangle", label: "Step", x: from.x, y: from.y };
  S.graph.nodes.push(to);
  drafts.add(to.id);
  fan.ids.push(to.id);
  spread(from, port);
  link(from, to, port);
}

function spread(from, port) {
  fan.ids = fan.ids.filter(nodeById);           // undo or delete may have taken some back
  const horiz = port === 1 || port === 3;       // right / left
  const back = port === 0 || port === 3 ? -1 : 1;
  const dist = horiz ? W + 80 : H + 100;
  const step = horiz ? H + 40 : W + 40;
  fan.ids.forEach((id, i) => {
    const n = nodeById(id), off = (i - (fan.ids.length - 1) / 2) * step;
    n.x = horiz ? from.x + back * dist : from.x + off;
    n.y = horiz ? from.y + off : from.y + back * dist;
  });
}

function link(from, to, port) {
  const id = `${from.id}__${to.id}`;
  if (!S.graph.edges.some((x) => x.id === id)) S.graph.edges.push({ id, from: from.id, to: to.id, label: "", style: "solid", fromPort: port });
  sel.nodes = new Set([to.id]); sel.edges.clear();
  renderCanvas(); renderLint(); syncTarget(); queueSave("link");
}

// Drag an arrow's end onto another box to re-route it; onto a blue dot to pin the side.
function startReattach(ev, e, end) {
  ev.stopPropagation();
  svg.setPointerCapture(ev.pointerId);
  const rub = $("#rubber");
  const other = nodeById(end === "from" ? e.to : e.from);
  const move = (m) => { const p = toWorld(m); rub.setAttribute("d", `M${other.x} ${other.y} L${p.x} ${p.y}`); };
  const up = (m) => {
    svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up);
    rub.removeAttribute("d");
    const p = toWorld(m);
    const hit = S.graph.nodes.find((n) => Math.abs(p.x - n.x) < nw(n) / 2 + 10 && Math.abs(p.y - n.y) < nh(n) / 2 + 10);
    if (!hit) return;                                  // dropped on nothing: leave it alone
    if (hit.id === other.id) return toast("An arrow needs two different boxes", true);
    const next = { ...e, [end]: hit.id, [end + "Port"]: nearestPort(hit, p) };
    next.id = `${next.from}__${next.to}`;
    if (next.id !== e.id && S.graph.edges.some((x) => x.id === next.id)) return toast("That arrow already exists", true);
    S.graph.edges[S.graph.edges.indexOf(e)] = next;
    sel.edges = new Set([next.id]);
    renderCanvas(); renderLint(); syncTarget(); queueSave("reconnected an arrow");
  };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up);
}

// Space-hold is the pan modifier, like every canvas tool.
let space = false;
addEventListener("keydown", (e) => { if (e.code === "Space" && !e.target.matches("input,textarea,[contenteditable]")) space = true; });
addEventListener("keyup", (e) => { if (e.code === "Space") space = false; });
addEventListener("blur", () => { space = false; });

function startPan(ev) {
  svg.setPointerCapture(ev.pointerId);
  const sx = ev.clientX - view.x, sy = ev.clientY - view.y;
  svg.classList.add("panning");
  const move = (e) => { view.x = e.clientX - sx; view.y = e.clientY - sy; applyView(); };
  const up = () => { svg.classList.remove("panning"); svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up); };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up);
}

// Rubber-band select. Shift keeps what was already selected.
function startMarquee(ev) {
  svg.setPointerCapture(ev.pointerId);
  const a = toWorld(ev);
  const box = $("#marquee");
  const keepN = [...sel.nodes], keepE = [...sel.edges];
  const move = (m) => {
    const b = toWorld(m);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    for (const [k, v] of Object.entries({ x, y, width: w, height: h })) box.setAttribute(k, v);
    sel.nodes = new Set(keepN);
    for (const n of S.graph.nodes)
      if (n.x + nw(n) / 2 > x && n.x - nw(n) / 2 < x + w && n.y + nh(n) / 2 > y && n.y - nh(n) / 2 < y + h) sel.nodes.add(n.id);
    // An arrow comes along when both its boxes are in the band — delete does the same.
    sel.edges = new Set([...keepE, ...S.graph.edges.filter((e) => sel.nodes.has(e.from) && sel.nodes.has(e.to)).map((e) => e.id)]);
    renderCanvas();
  };
  const up = () => {
    svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up);
    box.setAttribute("width", 0); box.setAttribute("height", 0);
    syncTarget();
  };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up);
}

svg.addEventListener("pointerdown", (ev) => {
  if (ev.target.closest(".node,.edge,.handle")) return;
  if (ev.button === 1 || ev.altKey || space) return startPan(ev);
  if (!ev.shiftKey) { sel.nodes.clear(); sel.edges.clear(); }
  sel.blockId = null;
  document.querySelectorAll(".block.sel").forEach((x) => x.classList.remove("sel"));
  renderCanvas(); syncTarget();
  startMarquee(ev);
});

svg.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const r = svg.getBoundingClientRect();
  if (ev.ctrlKey || ev.metaKey) {
    const k = Math.min(2.5, Math.max(0.2, view.k * Math.exp(-ev.deltaY / 220)));
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    view.x = mx - (mx - view.x) * (k / view.k);
    view.y = my - (my - view.y) * (k / view.k);
    view.k = k;
  } else {
    view.x -= ev.shiftKey ? ev.deltaY : ev.deltaX;
    view.y -= ev.shiftKey ? 0 : ev.deltaY;
  }
  applyView();
}, { passive: false });

// One floating text box over the canvas, shared by node rename and edge labelling.
function inlineEdit({ x, y, w, value, placeholder = "", commit }) {
  const inp = document.createElement("input");
  inp.value = value;
  inp.placeholder = placeholder;
  Object.assign(inp.style, {
    position: "absolute", zIndex: 9, textAlign: "center",
    left: `${view.x + (x - w / 2) * view.k}px`,
    top: `${view.y + y * view.k - 15}px`,
    width: `${Math.max(90, w * view.k)}px`,
  });
  $("#canvaspane").append(inp);
  inp.focus(); inp.select();
  let cancelled = false;
  const done = () => { inp.remove(); if (!cancelled) commit(inp.value.trim()); renderCanvas(); };
  inp.addEventListener("blur", done);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") inp.blur();
    if (e.key === "Escape") { cancelled = true; inp.blur(); }
  });
}

const rename = (n) =>
  inlineEdit({ x: n.x, y: n.y, w: nw(n), value: n.label, commit: (v) => { n.label = v || n.id; drafts.delete(n.id); fan = null; queueSave("rename"); } });

// Arrow labels are how a decision branch says "yes" / "no".
function labelEdge(e) {
  if (!e) return;
  const a = nodeById(e.from), b = nodeById(e.to);
  if (!a || !b) return;
  const m = edgePath(a, b, e);
  inlineEdit({ x: m.mx, y: m.my, w: 130, value: e.label || "", placeholder: "yes / no / …", commit: (v) => { e.label = v; queueSave("edge label"); } });
}

function fit() {
  if (!S.graph.nodes.length) { view = { x: 0, y: 0, k: 1 }; return applyView(); }
  const xs = S.graph.nodes.map((n) => n.x), ys = S.graph.nodes.map((n) => n.y);
  const x0 = Math.min(...xs) - W, x1 = Math.max(...xs) + W, y0 = Math.min(...ys) - H * 1.8, y1 = Math.max(...ys) + H;
  const r = svg.getBoundingClientRect();
  view.k = Math.min(1.4, Math.max(0.25, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
  view.x = r.width / 2 - ((x0 + x1) / 2) * view.k;
  view.y = r.height / 2 - ((y0 + y1) / 2) * view.k;
  applyView();
}

/* ─────────────── toolbar ─────────────── */
document.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
  const type = b.dataset.add;
  const r = svg.getBoundingClientRect();
  const id = "n" + Math.random().toString(36).slice(2, 6);
  // Drop it in the middle, then step clear of anything already sitting there.
  let x = (r.width / 2 - view.x) / view.k, y = (r.height / 2 - view.y) / view.k;
  while (S.graph.nodes.some((n) => Math.abs(n.x - x) < W * 0.9 && Math.abs(n.y - y) < H * 0.9)) { x += 30; y += H; }
  S.graph.nodes.push({ id, type, label: { diamond: "Decision?", stadium: "Start", circle: "End" }[type] || "Step", x, y });
  sel.nodes.clear(); sel.nodes.add(id);
  renderCanvas(); renderLint(); queueSave("add node");
});

$("#t-del").onclick = del;
$("#t-label").onclick = () => {
  const e = S.graph.edges.find((x) => sel.edges.has(x.id));
  const n = nodeById([...sel.nodes][0]);
  if (e) return labelEdge(e);
  if (n) return rename(n);
  toast("Select a box (rename it) or an arrow (label it) — double-clicking does the same. The chart is Mermaid, so text is labels only: no fonts, no free-floating text.", true);
};
$("#t-fit").onclick = fit;
$("#t-layout").onclick = async () => {
  for (const n of S.graph.nodes) { n.x = null; n.y = null; }
  S = { ...S, ...(await api("/api/save", { method: "POST", body: JSON.stringify({ graph: S.graph, note: "auto-layout" }) })) };
  renderCanvas(); fit();
};
$("#t-comment").onclick = commentOn;

/* ── Select something and the panel comes to it: label, style, comment, delete.
      Styling is the human's, like position — Mermaid cannot carry it, so it lives in
      flow.json and survives the agent handing back a new chart. ── */
const selected = () => [...S.graph.nodes.filter((n) => sel.nodes.has(n.id)), ...S.graph.edges.filter((e) => sel.edges.has(e.id))];

function restyle(patch, note = "restyled") {
  for (const o of selected()) Object.assign(o, patch);
  renderCanvas(); queueSave(note);
}

function syncInspector() {
  const box = $("#inspector"), items = selected();
  // The right-click menu and the comment box are already about the selection — two panels
  // over the same box is clutter, so the style panel waits its turn.
  if (!items.length || !$("#ctxmenu").hidden || !$("#cpop").hidden) { box.hidden = true; return; }
  const r = svg.getBoundingClientRect();
  box.hidden = false;
  // Sit clear of what is actually drawn — an arrow is as wide as its curve, not as wide as
  // the box it starts from, and the panel must never cover the ends you drag to re-route it.
  const rects = items.map((o) => svg.querySelector(`[data-id="${o.id}"]`)?.getBoundingClientRect()).filter(Boolean);
  const s = rects.length
    ? { left: Math.min(...rects.map((v) => v.left)), right: Math.max(...rects.map((v) => v.right)),
        top: Math.min(...rects.map((v) => v.top)), bottom: Math.max(...rects.map((v) => v.bottom)) }
    : r;
  const w = box.offsetWidth, h = box.offsetHeight, GAP = 14;
  const fitX = (x) => Math.min(Math.max(r.left + 8, x), r.right - w - 8);
  const fitY = (y) => Math.min(Math.max(r.top + 8, y), r.bottom - h - 8);
  // Right of it, else left of it, else underneath — first spot that lands clear wins.
  let x = fitX(s.right + GAP), y = fitY(s.top);
  if (x < s.right + GAP) x = fitX(s.left - GAP - w);
  if (x + w > s.left && x < s.right) { x = fitX(s.left); y = fitY(s.bottom + GAP); }
  box.style.left = x + "px";
  box.style.top = y + "px";
  const first = items[0];
  box.querySelectorAll("[data-nodes-only]").forEach((r) => (r.hidden = !sel.nodes.size));
  box.querySelectorAll("[data-shape]").forEach((b) => b.classList.toggle("on", b.dataset.shape === first.type));
  $("#i-fill").value = first.color || "#ffffff";
  $("#i-stroke").value = first.stroke || (sel.nodes.size ? "#3f3f46" : "#4b5563");
  $("#i-sw").value = first.sw || (sel.nodes.size ? 1.5 : 2);
  $("#i-op").value = first.opacity ?? 1;
}

// Shape is the agent's to write and yours to correct — it is semantics, so Mermaid carries it.
$("#inspector").querySelectorAll("[data-shape]").forEach((b) => {
  b.onclick = () => {
    for (const n of S.graph.nodes) if (sel.nodes.has(n.id)) n.type = b.dataset.shape;
    renderCanvas(); queueSave("reshape");
  };
});

$("#i-fill").oninput = (e) => restyle({ color: e.target.value });
$("#i-stroke").oninput = (e) => restyle({ stroke: e.target.value });
$("#i-sw").oninput = (e) => restyle({ sw: Number(e.target.value) });
$("#i-op").oninput = (e) => restyle({ opacity: Number(e.target.value) });
$("#i-clear").onclick = () => restyle({ color: undefined, stroke: undefined, sw: undefined, opacity: undefined }, "cleared styling");
$("#i-label").onclick = () => $("#t-label").click();
$("#i-del").onclick = del;
$("#i-comment").onclick = () => { const b = $("#inspector").getBoundingClientRect(); commentPopover(targetOf(), b.left, b.bottom + 6); };

function del() {
  if (sel.blockId && !sel.nodes.size) return;
  S.graph.nodes = S.graph.nodes.filter((n) => !sel.nodes.has(n.id));
  S.graph.edges = S.graph.edges.filter((e) => !sel.edges.has(e.id) && !sel.nodes.has(e.from) && !sel.nodes.has(e.to));
  sel.nodes.clear(); sel.edges.clear();
  renderCanvas(); renderLint(); syncTarget(); queueSave("delete");
}

// ⌘C / ⌘V: the boxes, the arrows between them, and the styling — a copy, not a reference.
let clip = null;
const copySel = () => {
  if (!sel.nodes.size) return;
  clip = {
    nodes: S.graph.nodes.filter((n) => sel.nodes.has(n.id)).map((n) => ({ ...n })),
    edges: S.graph.edges.filter((e) => sel.nodes.has(e.from) && sel.nodes.has(e.to)).map((e) => ({ ...e })),
  };
  toast(`Copied ${clip.nodes.length} box${clip.nodes.length > 1 ? "es" : ""}`);
};
const pasteClip = () => {
  if (!clip?.nodes.length) return;
  const id = {};
  const copies = clip.nodes.map((n) => ({ ...n, id: (id[n.id] = newNodeId()), x: n.x + 40, y: n.y + 40 }));
  S.graph.nodes.push(...copies);
  for (const e of clip.edges)
    S.graph.edges.push({ ...e, id: `${id[e.from]}__${id[e.to]}`, from: id[e.from], to: id[e.to] });
  // Select the copies, so the next drag moves what you just pasted.
  sel.nodes = new Set(copies.map((n) => n.id)); sel.edges.clear();
  renderCanvas(); renderLint(); syncTarget(); queueSave("paste");
};

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input,textarea,[contenteditable]")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") { e.preventDefault(); return copySel(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") { e.preventDefault(); return pasteClip(); }
  if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); del(); }
  if (e.key === "Escape") { fan = null; drafts.clear(); sel.nodes.clear(); sel.edges.clear(); renderCanvas(); syncTarget(); }
  if (e.key === "c" && !e.metaKey && !e.ctrlKey) commentOn();
  // ⌘+arrow makes one box that way. Press it again and the branch splits: the same origin
  // fans into two equally spaced boxes, then three, then four. Enter names one and ends it.
  if ((e.metaKey || e.ctrlKey) && e.key.startsWith("Arrow") && sel.nodes.size === 1) {
    const id = [...sel.nodes][0];
    const port = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3 }[e.key];
    if (port !== undefined) {
      e.preventDefault();
      // Same direction off a box the fan just made: grow it. Anything else starts a new one.
      if (!(fan && fan.port === port && fan.ids.includes(id) && drafts.has(id))) fan = { fromId: id, port, ids: [] };
      const from = nodeById(fan.fromId);
      if (from) {
        grow(from, port);
        hint("⌘+arrow again to split this branch in two · Enter to name this box");
      }
    }
  }
  // Enter names whatever is selected, so a chain gets its labels after it is drawn.
  if (e.key === "Enter" && sel.nodes.size === 1) {
    const n = nodeById([...sel.nodes][0]);
    if (n) { e.preventDefault(); rename(n); }
  }
  // In the doc and in text fields the browser's own undo is the right one.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
});

/* ─────────────── saving ─────────────── */
let saveTimer, dirty = null;
function queueSave(note = "edit") {
  dirty = note;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
}
// Undo has to land on the edit you just made, not the one before it, so it flushes first.
async function flushSave() {
  clearTimeout(saveTimer);
  if (dirty === null) return;
  const note = dirty;
  dirty = null;
  try {
    const r = await api("/api/save", { method: "POST", body: JSON.stringify({ doc: S.doc, graph: S.graph, title: $("#title").value, note }) });
    S.meta.rev = r.rev; S.lint = r.lint; S.versions = r.versions;
    docMeta(); renderLint(); renderVersions();
  } catch (err) { toast(err.message, true); }
}

// Step back one revision. The server drops the snapshot rather than stacking another,
// so pressing it twice goes back two steps instead of ping-ponging.
async function undo(rev) {
  await flushSave();
  rev = rev ?? (S.versions || [])[0]?.rev;
  if (!rev) return toast("Nothing to undo yet", true);
  S = { ...S, ...(await api("/api/undo", { method: "POST", body: JSON.stringify({ rev }) })) };
  sel.nodes.clear(); sel.edges.clear();
  renderAll();
}
$("#title").oninput = () => queueSave("title");

/* ─────────────── comments ─────────────── */
function targetOf() {
  if (sel.quote) return sel.quote;
  if (sel.nodes.size || sel.edges.size) return { nodeIds: [...sel.nodes], edgeIds: [...sel.edges] };
  if (sel.blockId) return { blockId: sel.blockId };
  return {};   // nothing selected is still a comment: it is about the project as a whole
}

function describe(t) {
  if (!t || (!t.blockId && !t.nodeIds?.length && !t.edgeIds?.length)) return "General note";
  if (t.quote) return "“" + t.quote.slice(0, 40) + "”";
  if (t.blockId) return "¶ " + (S.doc.blocks.find((b) => b.id === t.blockId)?.text.slice(0, 40) || "(paragraph)");
  const names = (t.nodeIds || []).map((id) => nodeById(id)?.label || id);
  return "◆ " + [...names, ...(t.edgeIds || [])].join(", ");
}

function syncTarget() {
  const t = targetOf();
  const box = $("#target");
  box.textContent = describe(t);
  box.classList.toggle("on", Boolean(t.blockId || t.nodeIds?.length || t.edgeIds?.length));
}

$("#cadd").onclick = async () => {
  const body = $("#cbody").value.trim();
  const target = targetOf();
  if (!body) return toast("Write the comment first", true);
  const r = await api("/api/comment", { method: "POST", body: JSON.stringify({ body, target }) });
  S.comments = r.comments; S.meta.rev = r.rev;
  $("#cbody").value = "";
  sel.quote = null;
  renderAll();
};

$("#cbody").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); $("#cadd").click(); }
});

let showResolved = false;
function renderComments() {
  const host = $("#comments");
  host.textContent = "";
  const done = S.comments.filter((c) => c.status !== "open");
  if (!S.comments.length) {
    host.append(Object.assign(document.createElement("div"), { className: "empty", textContent: "No comments yet. Say what you want changed — select a box, an arrow, a paragraph or a few words first to pin it there, or just write with nothing selected for a general note. Everything here goes back to the agent when you send feedback." }));
    return;
  }
  for (const c of [...S.comments].reverse().filter((c) => showResolved || c.status === "open")) {
    const d = document.createElement("div");
    d.className = "c " + c.status;
    d.dataset.cid = c.id;
    d.innerHTML = `<div class="top"><span class="where"></span><span class="pill ${c.status}">${c.status === "open" ? "for the agent" : "resolved"}</span></div><div class="body"></div>`;
    d.querySelector(".where").textContent = describe(c.target);
    d.querySelector(".body").textContent = c.body;
    d.querySelector(".where").onclick = () => focusTarget(c.target);
    const acts = document.createElement("div");
    acts.className = "acts";
    const setStatus = (status) => async () => {
      S.comments = (await api("/api/comment", { method: "POST", body: JSON.stringify({ id: c.id, patch: { status } }) })).comments;
      renderAll();
    };
    const btn = (text, cls, fn) => {
      const b = Object.assign(document.createElement("button"), { className: "mini " + cls, textContent: text });
      b.onclick = fn;
      return b;
    };
    // "Resolved" means you fixed it yourself, so don't bother the agent with it.
    acts.append(c.status === "open" ? btn("I fixed it", "", setStatus("resolved")) : btn("Reopen", "", setStatus("open")));
    d.append(acts);
    host.append(d);
  }
  // Resolved ones are done. They stay reachable, they just stop costing you scroll.
  if (done.length) {
    const t = Object.assign(document.createElement("button"), {
      className: "mini", textContent: showResolved ? "Hide resolved" : `Show ${done.length} resolved`,
    });
    t.onclick = () => { showResolved = !showResolved; renderComments(); };
    host.append(t);
  }
}

function focusTarget(t) {
  if (t?.blockId) return document.querySelector(`[data-id="${t.blockId}"]`)?.focus();
  sel.nodes = new Set(t?.nodeIds || []);
  sel.edges = new Set(t?.edgeIds || []);
  renderCanvas(); syncTarget();
  const n = nodeById([...sel.nodes][0]);
  if (!n) return;
  const r = svg.getBoundingClientRect();
  view.x = r.width / 2 - n.x * view.k;
  view.y = r.height / 2 - n.y * view.k;
  applyView();
}

/* ─────────────── versions / toast / verdict ─────────────── */
function renderVersions() {
  const host = $("#versions");
  host.textContent = "";
  for (const v of (S.versions || []).slice(0, 25)) {
    const d = document.createElement("div");
    d.className = "vrow";
    d.innerHTML = `<b>r${v.rev}</b><span></span><span class="spacer"></span>`;
    d.querySelector("span").textContent = `${v.by} · ${(v.ops || []).join("; ") || v.note || ""}`.slice(0, 40);
    d.title = (v.ops || []).join("\n") || v.note || "";
    const u = Object.assign(document.createElement("button"), { className: "mini", textContent: "revert" });
    u.onclick = () => undo(v.rev);
    d.append(u);
    host.append(d);
  }
}

function renderLint() {
  const host = $("#lint");
  host.textContent = "";
  for (const w of (S.lint || []).slice(0, 3)) {
    host.append(Object.assign(document.createElement("div"), { textContent: "⚠ " + w }));
  }
}

let toastTimer;
function toast(msg, isErr, undoRev) {
  const t = $("#toast");
  t.textContent = "";
  t.className = "toast" + (isErr ? " err" : "");
  t.append(Object.assign(document.createElement("span"), { textContent: msg }));
  if (undoRev) {
    const b = Object.assign(document.createElement("button"), { textContent: "Undo" });
    b.onclick = () => { undo(undoRev); t.hidden = true; };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 9000);
}

// Three ways out, exactly like Plannotator: approve, send it back with feedback, or bail.
const decide = async (decision, feedback) => {
  await api("/api/decision", { method: "POST", body: JSON.stringify({ decision, feedback }) });
  const said = { approved: "Approved", annotated: "Sent back to the agent", dismissed: "Rejected" }[decision];
  document.body.innerHTML = `<div class="done"><h2>${said}</h2><p class="muted">The agent has your doc, your flowchart, your comments and your edits. You can close this tab.</p></div>`;
};

$("#approve").onclick = () => {
  const open = S.comments.filter((c) => c.status === "open").length;
  if (open && !confirm(`${open} comment(s) are still open. Approve anyway?`)) return;
  decide("approved", "");
};
$("#reject").onclick = () => confirm("Reject this and stop the agent?") && decide("dismissed", "");

const fb = $("#fb");
$("#annotate").onclick = () => {
  const open = S.comments.filter((c) => c.status === "open").length;
  const edits = (S.versions || []).filter((v) => v.by === "human").flatMap((v) => v.ops || []).length;
  $("#fbsum").textContent =
    `Going back with ${open} comment(s), ${edits} edit(s) you made by hand, the doc, and the flowchart.`;
  fb.showModal();
  $("#fbtext").focus();
};
$("#fbcancel").onclick = () => fb.close();
$("#fbsend").onclick = () => { fb.close(); decide("annotated", $("#fbtext").value.trim()); };

/* ─────────────── pane resizing ─────────────── */
document.querySelectorAll(".grip").forEach((g) => g.addEventListener("pointerdown", (ev) => {
  const which = g.dataset.grip;
  const move = (e) => {
    const w = which === "doc" ? e.clientX : window.innerWidth - e.clientX;
    document.documentElement.style.setProperty(which === "doc" ? "--doc-w" : "--side-w", `${Math.max(180, Math.min(680, w))}px`);
  };
  const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); renderCanvas(); };
  addEventListener("pointermove", move); addEventListener("pointerup", up);
}));
addEventListener("resize", applyView);
