import { useState } from "react";
import type { EcoData, TreeNode } from "../lib/types";

interface Props {
  tree: TreeNode;
  data: EcoData;
}

export function Tree({ tree, data }: Props) {
  const rootTotal = tree.totalCalories;
  return (
    <div className="tree">
      <div className="tree__head">
        <div>Item · Recipe</div>
        <div>Labor</div>
        <div>Calories</div>
        <div>%</div>
      </div>
      <Row node={tree} data={data} depth={0} rootTotal={rootTotal} defaultOpen />
    </div>
  );
}

function Row({
  node,
  data,
  depth,
  rootTotal,
  defaultOpen = false,
}: {
  node: TreeNode;
  data: EcoData;
  depth: number;
  rootTotal: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || depth < 1);
  const hasChildren = !!(node.children && node.children.length > 0);
  const pct = rootTotal > 0 ? (node.totalCalories / rootTotal) * 100 : 0;
  const label = data.items[node.item] ?? node.item;

  const kindClass =
    node.kind === "raw"
      ? "tree__row--raw"
      : node.kind === "cycle" || node.kind === "missing"
      ? "tree__row--" + node.kind
      : "";

  return (
    <>
      <div
        className={"tree__row " + kindClass}
        style={{ ["--depth" as any]: depth }}
        onClick={() => hasChildren && setOpen((o) => !o)}
      >
        <div className="tree__label">
          <span
            className={"tree__caret" + (hasChildren ? "" : " tree__caret--leaf")}
          >
            {hasChildren ? (open ? "▼" : "▶") : "·"}
          </span>
          {node.kind === "raw" && (
            <span className="kind-badge kind-badge--raw">raw</span>
          )}
          {node.kind === "cycle" && (
            <span className="kind-badge kind-badge--cycle">cycle</span>
          )}
          {node.kind === "missing" && (
            <span className="kind-badge kind-badge--missing">missing</span>
          )}
          <span className="tree__qty">{formatQty(node.qty)}×</span>
          <span className="tree__name">
            {label}
            {node.kind === "recipe" && node.recipeId && label !== node.recipeId && (
              <span style={{ color: "var(--ink-3)", marginLeft: 6 }}>
                · {node.recipeId}
              </span>
            )}
          </span>
          {node.tagResolvedTo && (
            <span className="tree__tag">[{node.tagResolvedTo}]</span>
          )}
        </div>
        <div className="tree__labor">
          {node.labor != null && node.labor > 0 ? format(node.labor) : "—"}
        </div>
        <div className="tree__cal">{format(node.totalCalories)}</div>
        <div className="tree__pct">{pct >= 1 ? pct.toFixed(0) : pct.toFixed(1)}</div>
      </div>
      {open &&
        hasChildren &&
        node.children!.map((ch, i) => (
          <Row
            key={i}
            node={ch}
            data={data}
            depth={depth + 1}
            rootTotal={rootTotal}
          />
        ))}
    </>
  );
}

function formatQty(q: number): string {
  if (q === Math.floor(q)) return q.toString();
  if (q < 0.01) return q.toExponential(1);
  return q.toFixed(q < 1 ? 3 : 2);
}

function format(n: number): string {
  if (n === 0) return "0";
  if (n < 0.1) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  return Math.round(n).toLocaleString();
}
