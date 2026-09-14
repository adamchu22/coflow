# Credits

CoFlow ships no third-party code. It has zero runtime dependencies — the canvas is
hand-written SVG, the doc is a `contenteditable`, the server is `node:http`. There is
nothing here to attribute a copyright to but Rugby Waldorf LLC.

What it *does* owe is ideas. These projects were read and learned from; none of their
source was copied into this repository.

### [Plannotator](https://github.com/backnotprop/plannotator) — Apache-2.0 OR MIT, © 2025-2026 backnotprop

The whole review loop. The agent starts a localhost session, the browser opens, the
process blocks, and the human's verdict comes back on stdout as JSON — no API key, no
daemon, no extension. `approved | annotated | dismissed` and the `--gate` exit codes are
Plannotator's shape, applied to a flowchart instead of a plan.

### [flowchartai](https://github.com/tanchaowen84/flowchartai) — MIT, © 2025 FlowChart AI

The canvas interaction model: four connection dots per box, click-or-drag to create the
next step, `⌘`+arrow to branch, the inline style panel, right-click menus. CoFlow's are
rebuilt from scratch in vanilla SVG — flowchartai is React + [Excalidraw](https://github.com/excalidraw/excalidraw),
CoFlow is 0 dependencies and no build step — so this is a debt of design, not of code.

### [Mermaid](https://github.com/mermaid-js/mermaid) — MIT

The graph interchange format. CoFlow reads and writes a deliberately small subset of
`flowchart` syntax (see *Mermaid profile* in the README) with its own parser and printer;
the Mermaid library itself is not used or bundled.
