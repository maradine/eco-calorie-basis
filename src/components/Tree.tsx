import { useState } from "react";
import type { EcoData, TreeNode } from "../lib/types";

interface Props {
  tree: TreeNode;
  data: EcoData;
}

export function Tree({ tree, data }: Props) {
  const rootTotal = tree.totalCalories;
  const [copied, setCopied] = useState(false);
  // Default high enough to cover the deepest real tree. Depth uses the same
  // 0-indexing as the table: depth 0 is the target itself, depth 1 is its
  // direct ingredients, etc. So max-depth=1 for "Electronics Skill Book"
  // emits the book plus every research paper one row down.
  const [maxDepth, setMaxDepth] = useState<number>(99);

  async function copyForSheets() {
    const tsv = buildTsv(tree, data, maxDepth);
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Older browsers / insecure context — fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = tsv;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <div className="tree">
      <div className="tree__toolbar">
        <label className="tree__depth">
          <span>max depth</span>
          <input
            type="number"
            min={0}
            step={1}
            value={maxDepth}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 0) setMaxDepth(v);
            }}
          />
        </label>
        <button
          type="button"
          className="tree__copy"
          onClick={copyForSheets}
          aria-label="Copy table as tab-separated values"
        >
          {copied ? "✓ Copied" : "Copy for Sheets"}
        </button>
      </div>
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

/**
 * Walk the tree (ignoring UI collapse state) and emit TSV ready to paste
 * into Google Sheets / Excel. Columns: Depth, Item, Item ID, Kind, Recipe,
 * Qty, Labor, Calories, % of Root. Hierarchy is encoded both via the Depth
 * column (numeric, sortable) and a leading-space indent on the Item name.
 *
 * `maxDepth` caps how deep the recursion goes — a node at depth N is emitted,
 * but its children are skipped if N >= maxDepth. So maxDepth=0 emits only the
 * root; maxDepth=1 emits root + direct ingredients; etc.
 */
function buildTsv(tree: TreeNode, data: EcoData, maxDepth: number): string {
  const rootTotal = tree.totalCalories;
  const headers = [
    "Depth",
    "Item",
    "Item ID",
    "Kind",
    "Recipe",
    "Qty",
    "Labor",
    "Calories",
    "% of Root",
  ];
  const rows: string[][] = [headers];

  function walk(node: TreeNode, depth: number) {
    const indent = "  ".repeat(depth);
    const name = data.items[node.item] ?? node.item;
    const recipeCol =
      node.kind === "recipe" ? node.recipeId ?? "" :
      node.tagResolvedTo ?? "";
    const pct = rootTotal > 0 ? (node.totalCalories / rootTotal) * 100 : 0;
    rows.push([
      String(depth),
      indent + name,
      node.item,
      node.kind,
      recipeCol,
      fmt(node.qty),
      node.labor != null && node.labor > 0 ? fmt(node.labor) : "",
      fmt(node.totalCalories),
      pct.toFixed(2),
    ]);
    if (depth < maxDepth) {
      node.children?.forEach((ch) => walk(ch, depth + 1));
    }
  }

  walk(tree, 0);
  return rows
    .map((row) => row.map(escapeCell).join("\t"))
    .join("\n");
}

// TSV doesn't need CSV-style quoting; it just can't contain literal tabs or
// newlines inside a cell. Defensive collapse in case a label ever slips one in.
function escapeCell(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ");
}

// Plain numeric format for spreadsheets: no thousands separators, no scientific.
// Trim trailing zeros for fractional values so cells stay tidy.
function fmt(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  const s = n.toFixed(4);
  return s.replace(/\.?0+$/, "");
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
