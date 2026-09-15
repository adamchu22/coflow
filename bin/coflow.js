#!/usr/bin/env node
// An agent calls this, it opens the editor, blocks until the human decides, prints JSON.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startSession } from "../server/index.js";
import { Store } from "../lib/store.js";
import { parseMermaid, fromJSON } from "../lib/graph.js";

const HELP = `coflow — hand a plan + flowchart to a human, get their edits back

  coflow <plan.md>                    open the editor on a markdown plan
  coflow - --flow flow.mmd            read the plan from stdin
  coflow "Vendor onboarding"          open an empty project with that title
  coflow attach <DIR>                 print the handoff for a project you saved earlier
  coflow skill                        print the agent instructions for driving coflow

Options
  --flow FILE         seed the main flow: FILE.mmd is Mermaid, FILE.json is a graph
                      with props / status / docRefId. Repeat with NAME=FILE for more flows.
  --save-dir DIR      project folder (default ./coflow)
  --json              print the decision as JSON instead of prose
  --gate              exit codes: 0 approved, 1 changes requested/dismissed, 2 bad invocation
  --result-file PATH  also write the decision JSON to PATH
  --no-open           don't launch a browser

The decision JSON carries everything the human produced: their comments, the notes they
typed, a plain-English list of every edit they made, and the final doc + Mermaid.

Env
  COFLOW_PORT         fixed port (default: random)
`;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

const die = (msg) => { console.error(msg); process.exit(2); };
const read = (f) => {
  if (!fs.existsSync(f)) die(`no such file: ${f}`);
  if (fs.statSync(f).size > 2 * 1024 * 1024) die(`${f} exceeds the 2MB cap`);
  return fs.readFileSync(f, "utf8");
};

if (!argv.length || flag("help") || argv[0] === "-h") { console.log(HELP); process.exit(0); }

// The zero-install entry point: an agent in any repo runs this and follows what it prints.
if (positional[0] === "skill") {
  console.log(fs.readFileSync(new URL("../plugin/skills/coflow/SKILL.md", import.meta.url), "utf8"));
  process.exit(0);
}

if (positional[0] === "attach") {
  const dir = positional[1] || die("coflow attach <dir>");
  if (!fs.existsSync(path.join(dir, "coflow.json"))) die(`not a coflow project: ${dir}`);
  console.log(new Store(dir).handoff().md);
  process.exit(0);
}

const arg = positional.join(" ");
const isFile = arg && arg !== "-" && fs.existsSync(arg) && fs.statSync(arg).isFile();
const docText = arg === "-" ? fs.readFileSync(0, "utf8") : isFile ? read(arg) : "";
// `--flow quote.mmd` is the main flow; `--flow dispatch=dispatch.json` is another one.
// Parsed here so an off-profile chart is a usage error, not a half-written project.
const flows = {};
for (const spec of argv.flatMap((a, i) => (a === "--flow" ? [argv[i + 1]] : []))) {
  const m = spec?.match(/^([^=]+)=(.+)$/);
  const [name, file] = m ? [m[1], m[2]] : ["main", spec || ""];
  const text = read(file);
  try { flows[name] = file.endsWith(".json") ? fromJSON(JSON.parse(text)) : parseMermaid(text); }
  catch (e) { die(`${file}: ${e.message}`); }
}
// Title: the plan's first heading, else the filename, else whatever was typed.
const title = (docText.match(/^#\s+(.+)/m)?.[1] || (isFile ? path.basename(arg, ".md") : arg) || "Untitled").slice(0, 80);

const session = await startSession({ dir: opt("save-dir", "./coflow"), title, docText, flows });

console.error(`CoFlow → ${session.url}  (project: ${session.store.dir})`);
if (!flag("no-open")) execFile("open", [session.url], () => {});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => session.dismiss());

const decision = await session.wait();

if (opt("result-file")) fs.writeFileSync(opt("result-file"), JSON.stringify(decision, null, 2));

if (flag("json")) {
  console.log(JSON.stringify(decision));
} else if (decision.decision === "approved") {
  console.log(decision.feedback ? `The user approved with notes: ${decision.feedback}` : "The user approved.");
} else if (decision.decision === "dismissed") {
  console.log("The user closed the review without deciding. Stop and ask them what they want.");
} else {
  console.log(
    [
      decision.feedback && `The user wrote: ${decision.feedback}`,
      decision.comments.length && "Their comments:",
      ...decision.comments.map((c) => `- ${c.target}: ${c.body}`),
      decision.humanOps.length && `They also edited it themselves: ${decision.humanOps.join("; ")}`,
      ...Object.entries(decision.flows).map(([n, f]) => `\nCurrent flowchart${n === "main" ? "" : ` "${n}"`}:\n\n\`\`\`mermaid\n${f.mermaid}\n\`\`\``),
    ].filter(Boolean).join("\n")
  );
}

if (flag("gate")) process.exit(decision.decision === "approved" ? 0 : 1);
