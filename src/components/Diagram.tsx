import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildDiagram } from "../lib/resolver";
import type { Choices, EcoData, TreeNode } from "../lib/types";

interface Props {
  tree: TreeNode;
  data: EcoData;
  choices: Choices;
  onChoicesChange: (choices: Choices) => void;
}

/**
 * A vertical assembly-line diagram. Raw harvests at the top, target at the
 * bottom. Each node is a card; edges are drawn as SVG splines behind the
 * cards. Ambiguity dropdowns sit inline on each card that has a decision.
 *
 * Layout strategy: one flex row per tier, cards flow horizontally. After
 * render, we measure each card's actual position and paint SVG connectors
 * in a single absolutely-positioned overlay sized to the full grid.
 */
export function Diagram({ tree, data, choices, onChoicesChange }: Props) {
  const layout = useMemo(() => buildDiagram(tree, data), [tree, data]);

  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });
  const [edgePaths, setEdgePaths] = useState<
    {
      d: string;
      qty: number;
      label?: string;
      midX: number;
      midY: number;
      id: string;
      fromId: string;
      toId: string;
    }[]
  >([]);
  // Click-highlight: when a card is selected, it and every edge touching it
  // render with 4× stroke weight so the user can trace its connections.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // Measure + compute SVG connector paths whenever layout changes.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const w = container.scrollWidth;
    const h = container.scrollHeight;
    setSvgSize({ w, h });

    // Map every node to its tier, then compute the deepest card bottom per
    // tier. All edges exiting a tier share that tier's lane-y, so the
    // horizontal traverse sits below every card in the tier — a short card
    // next to a tall sibling can't have its lane cut through the tall one.
    const tierOfNode = new Map<string, number>();
    for (const n of layout.nodes) tierOfNode.set(n.id, n.tier);

    const tierMaxBottom = new Map<number, number>();
    for (const [id, el] of cardRefs.current) {
      const tier = tierOfNode.get(id);
      if (tier == null) continue;
      const r = el.getBoundingClientRect();
      const bottom = r.bottom - containerRect.top + container.scrollTop;
      const cur = tierMaxBottom.get(tier) ?? -Infinity;
      if (bottom > cur) tierMaxBottom.set(tier, bottom);
    }

    // Measure every edge's endpoints up front so we can assign lanes in a
    // second pass. Grouped by source tier, since each tier's gutter owns its
    // own stack of horizontal lanes.
    type PreEdge = {
      edge: (typeof layout.edges)[number];
      x1: number; y1: number;
      x2: number; y2: number;
      fromTier: number;
    };
    const preEdges: PreEdge[] = [];
    for (const edge of layout.edges) {
      const from = cardRefs.current.get(edge.fromId);
      const to = cardRefs.current.get(edge.toId);
      if (!from || !to) continue;
      const fromTier = tierOfNode.get(edge.fromId);
      if (fromTier == null) continue;
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      // Provisional x = card center. Replaced below with per-edge exit/entry
      // offsets so multiple edges sharing a card don't pile on one x column.
      const x1 = fromRect.left + fromRect.width / 2 - containerRect.left + container.scrollLeft;
      const y1 = fromRect.bottom - containerRect.top + container.scrollTop;
      const x2 = toRect.left + toRect.width / 2 - containerRect.left + container.scrollLeft;
      const y2 = toRect.top - containerRect.top + container.scrollTop;
      preEdges.push({ edge, x1, y1, x2, y2, fromTier });
    }

    // Assign per-edge exit/entry x-offsets within each card. When a card has
    // multiple outgoing (or incoming) edges, we spread them horizontally
    // across the card's bottom (or top) edge so each wire has its own
    // vertical column instead of stacking on the center. Sorting by the
    // counterpart's x ensures lines fan out naturally — an edge going to
    // the far left exits from the left side of the source card, etc.
    const EXIT_SPACING = 12;   // preferred px between adjacent exits/entries
    const EXIT_MARGIN = 18;    // keep exits at least this far from card edges
    const outByFrom = new Map<string, PreEdge[]>();
    const inByTo = new Map<string, PreEdge[]>();
    for (const pe of preEdges) {
      (outByFrom.get(pe.edge.fromId) ?? outByFrom.set(pe.edge.fromId, []).get(pe.edge.fromId)!).push(pe);
      (inByTo.get(pe.edge.toId) ?? inByTo.set(pe.edge.toId, []).get(pe.edge.toId)!).push(pe);
    }
    const scrollLeft = container.scrollLeft;
    function spread(
      cardId: string,
      edges: PreEdge[],
      sortKey: (pe: PreEdge) => number,
      assign: (pe: PreEdge, x: number) => void,
    ) {
      const el = cardRefs.current.get(cardId);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cardLeft = r.left - containerRect.left + scrollLeft;
      const cardW = r.width;
      const center = cardLeft + cardW / 2;
      const n = edges.length;
      if (n === 1) { assign(edges[0], center); return; }
      const maxSpan = cardW - EXIT_MARGIN * 2;
      const spacing = Math.min(EXIT_SPACING, maxSpan / (n - 1));
      edges.sort((a, b) => sortKey(a) - sortKey(b));
      edges.forEach((pe, i) => {
        const offset = (i - (n - 1) / 2) * spacing;
        assign(pe, center + offset);
      });
    }
    for (const [id, outs] of outByFrom) {
      spread(id, outs, pe => pe.x2, (pe, x) => { pe.x1 = x; });
    }
    for (const [id, ins] of inByTo) {
      spread(id, ins, pe => pe.x1, (pe, x) => { pe.x2 = x; });
    }

    // Greedy interval-scheduling per tier: edges whose horizontal extents
    // overlap get assigned to different tracks so their lanes read distinctly.
    // Non-overlapping edges share a track, keeping the gutter compact.
    const trackOfEdge = new Map<string, number>();
    const byTier = new Map<number, PreEdge[]>();
    for (const pe of preEdges) {
      const list = byTier.get(pe.fromTier) ?? [];
      list.push(pe);
      byTier.set(pe.fromTier, list);
    }
    for (const tierEdges of byTier.values()) {
      tierEdges.sort(
        (a, b) => Math.min(a.x1, a.x2) - Math.min(b.x1, b.x2),
      );
      // tracks[i] = right-edge x of the latest edge assigned to track i.
      const tracks: number[] = [];
      for (const pe of tierEdges) {
        const left = Math.min(pe.x1, pe.x2);
        const right = Math.max(pe.x1, pe.x2);
        let track = -1;
        for (let i = 0; i < tracks.length; i++) {
          if (tracks[i] < left) { track = i; break; }
        }
        if (track === -1) { track = tracks.length; tracks.push(right); }
        else tracks[track] = right;
        trackOfEdge.set(`${pe.edge.fromId}-${pe.edge.toId}`, track);
      }
    }

    const LANE_BASE = 14;   // first lane sits this far below tier bottom
    const LANE_PITCH = 12;  // vertical distance between adjacent lanes
    const CORNER = 5;       // corner radius for rounded bends

    const newPaths: typeof edgePaths = [];
    for (const { edge, x1, y1, x2, y2, fromTier } of preEdges) {
      const track = trackOfEdge.get(`${edge.fromId}-${edge.toId}`) ?? 0;
      const tierBottom = tierMaxBottom.get(fromTier) ?? y1;
      const laneY = tierBottom + LANE_BASE + track * LANE_PITCH;
      const dx = x2 - x1;
      const hDir = Math.sign(dx);
      const r = Math.min(CORNER, Math.abs(dx) / 2);

      let d: string;
      if (hDir === 0 || r === 0) {
        // Straight vertical drop — source and target share an x.
        d = `M ${x1} ${y1} L ${x2} ${y2}`;
      } else {
        d =
          `M ${x1} ${y1} ` +
          `L ${x1} ${laneY - CORNER} ` +
          `Q ${x1} ${laneY} ${x1 + hDir * r} ${laneY} ` +
          `L ${x2 - hDir * r} ${laneY} ` +
          `Q ${x2} ${laneY} ${x2} ${laneY + CORNER} ` +
          `L ${x2} ${y2}`;
      }

      // Badge sits on the horizontal lane in empty gutter. For the straight-
      // vertical case (no lane), fall back to the geometric midpoint.
      const midX = hDir === 0 ? x1 : (x1 + x2) / 2;
      const midY = hDir === 0 ? (y1 + y2) / 2 : laneY;
      newPaths.push({
        d,
        qty: edge.qty,
        label: edge.label,
        midX,
        midY,
        id: `${edge.fromId}-${edge.toId}`,
        fromId: edge.fromId,
        toId: edge.toId,
      });
    }
    setEdgePaths(newPaths);
  }, [layout]);

  return (
    <div className="diagram" ref={containerRef}>
      <svg
        className="diagram__wires"
        width={svgSize.w}
        height={svgSize.h}
        style={{ pointerEvents: "none" }}
      >
        {/* Render non-highlighted first, then highlighted — SVG paints later
            siblings on top, so the selected card's wires and badges always
            sit above any overlapping neighbours. */}
        {[...edgePaths]
          .sort((a, b) => {
            const aH =
              highlightedId != null &&
              (a.fromId === highlightedId || a.toId === highlightedId);
            const bH =
              highlightedId != null &&
              (b.fromId === highlightedId || b.toId === highlightedId);
            return aH === bH ? 0 : aH ? 1 : -1;
          })
          .map((p) => {
            const touchesHighlight =
              highlightedId != null &&
              (p.fromId === highlightedId || p.toId === highlightedId);
            const label = `${formatQty(p.qty)}×`;
            // Size badge to label. Mono font at 10px is ~6.5px per char;
            // 10px horizontal padding keeps the text clear of the stroke.
            const badgeW = Math.max(32, Math.ceil(label.length * 6.5 + 10));
            return (
              <g key={p.id}>
                <path
                  d={p.d}
                  className={
                    "diagram__wire" +
                    (touchesHighlight ? " diagram__wire--highlighted" : "")
                  }
                />
                {p.qty !== 1 && (
                  <g transform={`translate(${p.midX}, ${p.midY})`}>
                    <rect
                      x={-badgeW / 2}
                      y={-8}
                      width={badgeW}
                      height={16}
                      className={
                        "diagram__wire-badge" +
                        (touchesHighlight ? " diagram__wire-badge--highlighted" : "")
                      }
                    />
                    <text
                      textAnchor="middle"
                      dy={4}
                      className={
                        "diagram__wire-label" +
                        (touchesHighlight ? " diagram__wire-label--highlighted" : "")
                      }
                    >
                      {label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
      </svg>

      {/* Tiers rendered top-to-bottom: tier 0 (raw) at top, maxTier (target) at bottom */}
      {layout.tiers.map((tierNodes, tierIdx) => (
        <div
          className={
            "diagram__tier " +
            (tierIdx === 0 ? "diagram__tier--raw " : "") +
            (tierIdx === layout.tiers.length - 1 ? "diagram__tier--target" : "")
          }
          key={tierIdx}
        >
          <div className="diagram__tier-label">
            {tierIdx === 0
              ? "Gather"
              : tierIdx === layout.tiers.length - 1
              ? "Assemble"
              : `Tier ${tierIdx}`}
          </div>
          <div className="diagram__tier-nodes">
            {tierNodes.map((dn) => (
              <Card
                key={dn.id}
                diagNode={dn}
                data={data}
                choices={choices}
                onChoicesChange={onChoicesChange}
                isHighlighted={highlightedId === dn.id}
                onToggleHighlight={() =>
                  setHighlightedId((prev) => (prev === dn.id ? null : dn.id))
                }
                registerRef={(el) => {
                  if (el) cardRefs.current.set(dn.id, el);
                  else cardRefs.current.delete(dn.id);
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Card({
  diagNode,
  data,
  choices,
  onChoicesChange,
  isHighlighted,
  onToggleHighlight,
  registerRef,
}: {
  diagNode: ReturnType<typeof buildDiagram>["nodes"][number];
  data: EcoData;
  choices: Choices;
  onChoicesChange: (c: Choices) => void;
  isHighlighted: boolean;
  onToggleHighlight: () => void;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  const node = diagNode.node;
  const name = data.items[node.item] ?? node.item;

  const producers = data.producers[node.item] ?? [];
  const isMultiProducer = node.kind === "recipe" && producers.length > 1;

  // Determine whether this recipe's ingredients include any ambiguous tags.
  const tagAmbiguities = useMemo(() => {
    if (node.kind !== "recipe" || !node.recipeId) return [];
    const recipe = data.recipes.find((r) => r.id === node.recipeId);
    if (!recipe) return [];
    return recipe.ingredients
      .filter((ing) => ing.kind === "tag")
      .map((ing) => ({
        tag: ing.ref,
        options: data.tagToItems[ing.ref] ?? [],
      }))
      .filter((x) => x.options.length > 1);
  }, [node, data]);

  function setChoice(key: string, value: string | null) {
    const next = { ...choices };
    if (value === null) delete next[key];
    else next[key] = value;
    onChoicesChange(next);
  }

  const kindClass =
    node.kind === "raw"
      ? "card--raw"
      : node.kind === "cycle" || node.kind === "missing"
      ? "card--" + node.kind
      : "card--recipe";

  return (
    <div
      ref={registerRef}
      className={
        "card " + kindClass + (isHighlighted ? " card--highlighted" : "")
      }
      onClick={(e) => {
        // Ignore clicks on embedded form controls so their own interactions
        // (opening a dropdown, focusing the select) aren't hijacked.
        const el = e.target as HTMLElement;
        if (el.closest("select, input, button, label")) return;
        onToggleHighlight();
      }}
    >
      <div className="card__head">
        <div className="card__qty">{formatQty(node.qty)}×</div>
        <div className="card__name">{name}</div>
      </div>

      {node.kind === "recipe" && (
        <div className="card__body">
          {isMultiProducer ? (
            <label className="card__field">
              <span className="card__field-label">recipe</span>
              <select
                value={node.recipeId}
                onChange={(e) => setChoice(`item:${node.item}`, e.target.value)}
              >
                {[...producers].sort().map((opt) => {
                  const recipe = data.recipes.find((r) => r.id === opt);
                  const tableLabel = recipe?.table ? humanizeTable(recipe.table) : null;
                  return (
                    <option key={opt} value={opt}>
                      {tableLabel ? `${tableLabel} · ${opt}` : opt}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : (
            <div className="card__recipe">via {node.recipeId}</div>
          )}

          {tagAmbiguities.map((amb) => (
            <label className="card__field" key={amb.tag}>
              <span className="card__field-label">{amb.tag}</span>
              <select
                value={choices[`tag:${amb.tag}`] ?? [...amb.options].sort()[0]}
                onChange={(e) => setChoice(`tag:${amb.tag}`, e.target.value)}
              >
                {[...amb.options].sort().map((opt) => (
                  <option key={opt} value={opt}>
                    {data.items[opt] ?? opt}
                  </option>
                ))}
              </select>
            </label>
          ))}

          {diagNode.table && (
            <div className="card__table">{humanizeTable(diagNode.table)}</div>
          )}
        </div>
      )}

      {node.kind === "raw" && (
        <div className="card__body">
          <div className="card__recipe card__recipe--raw">raw harvest</div>
          {node.tagResolvedTo && (
            <div className="card__tag-trace">{node.tagResolvedTo}</div>
          )}
        </div>
      )}

      <div className="card__foot">
        <span className="card__cal">{formatCal(node.totalCalories)}</span>
        <span className="card__cal-label">cal</span>
      </div>
    </div>
  );
}

function formatQty(q: number): string {
  if (q === Math.floor(q)) return q.toString();
  if (q < 0.01) return q.toExponential(1);
  return q.toFixed(q < 1 ? 3 : 2);
}

function formatCal(n: number): string {
  if (n === 0) return "0";
  if (n < 1) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

function humanizeTable(table: string): string {
  return table
    .replace(/Object$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
}
