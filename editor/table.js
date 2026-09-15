// A markdown pipe table as rows of cells, and back. The doc block stays markdown — the
// agent reads it as text — but the human edits cells, never pipes.
// ponytail: no alignment colons, no column widths; a "|" typed in a cell is stored as "\|".
export const isTable = (t) => t.startsWith("|") && t.split("\n").every((l) => l.trim().startsWith("|"));
const SEP = /^\|?\s*:?-{2,}/;

export function parseTable(t) {
  return t.split("\n")
    .filter((l) => l.trim() && !SEP.test(l.trim()))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
}

export function toTable(rows) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const line = (r) => "| " + Array.from({ length: cols }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|") || " ").join(" | ") + " |";
  const [head = [], ...rest] = rows;
  return [line(head), line(Array(cols).fill("---")), ...rest.map(line)].join("\n");
}
