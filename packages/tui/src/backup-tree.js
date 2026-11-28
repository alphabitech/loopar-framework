/**
 * Backup lineage tree for the terminal — the same model and lane layout the
 * desk's Backups page draws (apps/loopar/modules/backup/pages/backups/client/
 * backups-page.jsx: buildLineage + layoutLanes; keep them in sync), rendered
 * with box-drawing characters instead of SVG.
 *
 * HEAD (engine.readHead) names the backup the tenant's current state descends
 * from; each backup's manifest `parent` hangs it under the one it came from.
 * "You are here" sits on top, joined to that backup; the way from the origin
 * to it is "lit".
 */
import { A } from "./term.js";

export const ROOT = "__root__";
export const HERE = "__here__";

const time = (d) => new Date(d).getTime();

export function buildLineage(rows, head) {
  const byFile = new Map(rows.map((r) => [r.file, r]));
  const asc = [...rows].sort((a, b) => time(a.date) - time(b.date));
  const parentOf = new Map();
  let previous = null;
  for (const r of asc) {
    // `parent` undefined: made before lineage was recorded (chained by date); null: a root.
    let parent = r.parent !== undefined ? r.parent : (r.kind === "uploaded" ? null : previous);
    if (parent && !byFile.has(parent)) parent = null;
    if (!parent && r.kind !== "uploaded") parent = ROOT;
    parentOf.set(r.file, parent);
    if (r.kind !== "uploaded") previous = r.file;
  }
  const current = head && byFile.has(head) ? head : asc.filter((r) => r.kind !== "uploaded").at(-1)?.file ?? null;
  parentOf.set(HERE, current || ROOT);
  const lit = new Set();
  for (let f = HERE; f; f = parentOf.get(f)) lit.add(f);
  return { byFile, parentOf, current, lit };
}

export function layoutLanes(rows, lineage) {
  const { parentOf } = lineage;
  const desc = [...rows].sort((a, b) => time(b.date) - time(a.date));
  const nodes = [{ id: HERE }, ...desc.map((r) => ({ id: r.file, row: r })), { id: ROOT }];
  const rowOf = new Map(nodes.map((n, i) => [n.id, i]));

  const children = new Map();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { id } = nodes[i];
    if (id === HERE) continue;
    const p = parentOf.get(id);
    if (!p) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(id);
  }
  const firstChild = (id) => children.get(id)?.[0];

  const starts = nodes.filter((n) => n.id !== HERE && (n.id === ROOT || !parentOf.get(n.id) || firstChild(parentOf.get(n.id)) !== n.id))
    .reverse();
  const laneOf = new Map();
  const taken = [];
  const free = (lane, top, bottom) => !taken.some((t) => t.lane === lane && !(t.bottom < top || bottom < t.top));
  for (const start of starts) {
    const chain = [start.id];
    for (let c = firstChild(start.id); c; c = firstChild(c)) chain.push(c);
    const parent = parentOf.get(start.id);
    const top = rowOf.get(chain.at(-1));
    const bottom = parent ? rowOf.get(parent) : rowOf.get(start.id);
    let lane = parent ? laneOf.get(parent) + 1 : 0;
    while (!free(lane, top, bottom)) lane++;
    for (const id of chain) laneOf.set(id, lane);
    taken.push({ lane, top, bottom });
  }

  const at = parentOf.get(HERE);
  const atLane = laneOf.get(at) ?? 0;
  let hereLane = !children.has(at) && free(atLane, 0, rowOf.get(at) - 1) ? atLane : atLane + 1;
  while (hereLane !== atLane && !free(hereLane, 0, rowOf.get(at))) hereLane++;
  laneOf.set(HERE, hereLane);

  const segments = nodes.map(() => []);
  for (const n of nodes) {
    const p = parentOf.get(n.id);
    if (!p) continue;
    const from = rowOf.get(n.id);
    const to = rowOf.get(p);
    const edge = { lane: laneOf.get(n.id), into: laneOf.get(p), lit: lineage.lit.has(n.id) };
    segments[from].push({ ...edge, part: "start" });
    for (let r = from + 1; r < to; r++) segments[r].push({ ...edge, part: "through" });
    segments[to].push({ ...edge, part: "end" });
  }
  const width = Math.max(...laneOf.values()) + 1;
  return { nodes: nodes.map((n, i) => ({ ...n, col: laneOf.get(n.id), segments: segments[i] })), width };
}

/**
 * The graph cells of one row: 2 terminal columns per lane (the lane, then
 * the connector to its right). Edges run down a child's lane and turn left
 * into the parent's lane on the parent's row: ●─╯.
 */
export function graphCells(node, width, lineage) {
  const cells = Array.from({ length: width * 2 }, () => ({ ch: " ", lit: false }));
  const put = (i, ch, lit) => {
    const c = cells[i];
    if (c.ch === "│" && ch === "─") c.ch = "┼";
    else if (c.ch === " " || ch !== "─") c.ch = ch;
    c.lit = c.lit || lit;
  };
  for (const s of node.segments) {
    if (s.part === "through") put(s.lane * 2, "│", s.lit);
    if (s.part === "end" && s.lane !== s.into) {
      for (let k = s.into * 2 + 1; k < s.lane * 2; k++) put(k, "─", s.lit);
      put(s.lane * 2, "╯", s.lit);
    }
  }
  const on = lineage.lit.has(node.id);
  const glyph = node.id === HERE ? "◆" : node.id === ROOT ? "○" : node.id === lineage.current ? "◉" : on ? "●" : "○";
  cells[node.col * 2] = { ch: glyph, lit: on, node: true };
  return cells.map((c) => {
    if (c.ch === " ") return " ";
    const color = c.node && node.id === HERE ? `${A.bold}${A.cyan}` : c.lit ? A.cyan : A.gray;
    return `${color}${c.ch}${A.reset}`;
  }).join("");
}
