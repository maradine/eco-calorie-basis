import { useEffect, useMemo, useState } from "react";
import { Resolver, flattenRawInputs } from "./lib/resolver";
import type { Choices, EcoData, TreeNode } from "./lib/types";
import { Picker } from "./components/Picker";
import { Tree } from "./components/Tree";
import { FlatInputs } from "./components/FlatInputs";
import { Diagram } from "./components/Diagram";

type ViewMode = "diagram" | "breakdown";

export default function App() {
  const [data, setData] = useState<EcoData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [qty, setQty] = useState<number>(1);
  const [choices, setChoices] = useState<Choices>({});
  const [rawCosts, setRawCosts] = useState<Record<string, number>>({});
  const [view, setView] = useState<ViewMode>("diagram");

  useEffect(() => {
    const url = new URL("eco-data.json", document.baseURI).toString();
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  const resolver = useMemo(() => {
    if (!data) return null;
    return new Resolver(data, { choices, rawCosts });
  }, [data, choices, rawCosts]);

  const tree: TreeNode | null = useMemo(() => {
    if (!resolver || !selectedItem) return null;
    return resolver.resolveItem(selectedItem, qty);
  }, [resolver, selectedItem, qty]);

  const rawInputs = useMemo(() => {
    if (!tree) return new Map<string, number>();
    return flattenRawInputs(tree);
  }, [tree]);

  const perUnit = tree ? tree.totalCalories / (tree.qty || 1) : 0;

  return (
    <div className="app">
      <header className="masthead">
        <h1 className="masthead__title">
          Calorie <em>Basis</em>
        </h1>
        <div className="masthead__meta">
          Field Tool · Eco<br />
          {__BUILD_ID__} · Level 0 · Base Costs
        </div>
      </header>
      <div className="masthead__rule" />

      {error && (
        <div className="empty">
          <div className="empty__title">Data failed to load</div>
          <div>{error}</div>
        </div>
      )}
      {!data && !error && (
        <div className="empty">
          <div className="empty__title">Loading recipe index…</div>
        </div>
      )}

      {data && (
        <>
          <div className="section-label">
            <span className="section-label__num">01</span>
            Specimen
          </div>
          <Picker
            data={data}
            selected={selectedItem}
            onSelect={(item) => {
              setSelectedItem(item);
              setChoices({}); // reset overrides on new target
            }}
            qty={qty}
            onQtyChange={setQty}
          />

          {tree && (
            <>
              <div className="section-label">
                <span className="section-label__num">02</span>
                Production
              </div>

              <div className="tabs">
                <button
                  className={"tab " + (view === "diagram" ? "tab--active" : "")}
                  onClick={() => setView("diagram")}
                >
                  Diagram
                </button>
                <button
                  className={"tab " + (view === "breakdown" ? "tab--active" : "")}
                  onClick={() => setView("breakdown")}
                >
                  Breakdown
                </button>
              </div>

              {view === "diagram" ? (
                <Diagram
                  tree={tree}
                  data={data}
                  choices={choices}
                  onChoicesChange={setChoices}
                  rawCosts={rawCosts}
                  onRawCostsChange={setRawCosts}
                />
              ) : (
                <Tree tree={tree} data={data} />
              )}

              {rawInputs.size > 0 && (
                <>
                  <div className="section-label">
                    <span className="section-label__num">03</span>
                    Raw Harvest Requirements
                  </div>
                  <FlatInputs inputs={rawInputs} data={data} />
                </>
              )}
            </>
          )}

          {!selectedItem && (
            <div className="empty">
              <div className="empty__title">No specimen selected</div>
              <div>Search for any craftable item to compute its calorie basis.</div>
            </div>
          )}

          {/* Sticky target banner — always visible while scrolling the tree */}
          {tree && selectedItem && (
            <div className="sticky-target">
              <div className="sticky-target__name">
                {data.items[selectedItem] ?? selectedItem}
              </div>
              <div className="sticky-target__stat">
                <div className="sticky-target__label">per unit</div>
                <div className="sticky-target__value">{formatCal(perUnit)}</div>
              </div>
              <div className="sticky-target__stat">
                <div className="sticky-target__label">
                  order × {formatQty(qty)}
                </div>
                <div className="sticky-target__value">
                  {formatCal(tree.totalCalories)}
                </div>
              </div>
              <div className="sticky-target__stat">
                <div className="sticky-target__label">raw inputs</div>
                <div className="sticky-target__value">{rawInputs.size}</div>
              </div>
            </div>
          )}
        </>
      )}

      <footer className="footer">
        <span>Eco · Calorie Basis</span>
        <span>{data ? `${data.recipes.length} recipes indexed` : "—"}</span>
      </footer>
    </div>
  );
}

function formatCal(n: number): string {
  if (n === 0) return "0";
  if (n < 1) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

function formatQty(q: number): string {
  if (q === Math.floor(q)) return q.toString();
  return q.toFixed(q < 1 ? 2 : 1);
}
