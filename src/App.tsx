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
  // Skill level per specialty: skillLevels[skillId] = 0..maxLevel. Defaults
  // to 0 (no labor reduction). Kept across target changes since it reflects
  // the player, not the recipe.
  const [skillLevels, setSkillLevels] = useState<Record<string, number>>({});
  // Talent investment per talent id. 0 = not learned; 1..maxLevel = invested.
  // For flat talents only 0/1 is meaningful. Auto-clears below required skill.
  const [talentLevels, setTalentLevels] = useState<Record<string, number>>({});
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
    return new Resolver(data, { choices, rawCosts, skillLevels, talentLevels });
  }, [data, choices, rawCosts, skillLevels, talentLevels]);

  const tree: TreeNode | null = useMemo(() => {
    if (!resolver || !selectedItem) return null;
    return resolver.resolveItem(selectedItem, qty);
  }, [resolver, selectedItem, qty]);

  const rawInputs = useMemo(() => {
    if (!tree) return new Map<string, number>();
    return flattenRawInputs(tree);
  }, [tree]);

  // Walk the resolved tree to find every laborSkill referenced by an
  // in-use recipe — these are the skills we surface as sliders. Skill IDs
  // present in data.skills (i.e. we have a multiplier table for them).
  const skillsInTree = useMemo(() => {
    const set = new Set<string>();
    if (!tree || !data) return set;
    const d = data; // narrowed local for closure
    function visit(n: TreeNode) {
      if (n.kind === "recipe" && n.recipeId) {
        const r = d.recipes.find((x) => x.id === n.recipeId);
        if (r?.laborSkill && d.skills[r.laborSkill]) {
          set.add(r.laborSkill);
        }
      }
      n.children?.forEach(visit);
    }
    visit(tree);
    return set;
  }, [tree, data]);

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

          {tree && skillsInTree.size > 0 && (
            <>
              <div className="section-label">
                <span className="section-label__num">02</span>
                Skills
              </div>
              <div className="skills">
                {[...skillsInTree]
                  .sort((a, b) =>
                    (data.skills[a]?.displayName ?? a).localeCompare(
                      data.skills[b]?.displayName ?? b,
                    ),
                  )
                  .map((skillId) => {
                    const info = data.skills[skillId];
                    const level = skillLevels[skillId] ?? 0;
                    const mult = info.multipliers[level] ?? 1;
                    const talents = Object.entries(data.talents ?? {})
                      .filter(([, t]) => t.ownerSkill === skillId)
                      .sort(([, a], [, b]) =>
                        a.skillLevelRequired - b.skillLevelRequired ||
                        a.displayName.localeCompare(b.displayName),
                      );
                    return (
                      <div key={skillId} className="skills__block">
                        <div className="skills__row">
                          <div className="skills__name">{info.displayName}</div>
                          <input
                            type="range"
                            min={0}
                            max={info.maxLevel}
                            value={level}
                            className="skills__slider"
                            onChange={(e) =>
                              setSkillLevels({
                                ...skillLevels,
                                [skillId]: Number(e.target.value),
                              })
                            }
                          />
                          <div className="skills__level">Lvl {level}</div>
                          <div className="skills__mult">×{mult.toFixed(2)}</div>
                        </div>
                        {talents.length > 0 && (
                          <div className="skills__talents">
                            {talents.map(([tid, t]) => {
                              const locked = level < t.skillLevelRequired;
                              const tlevel = locked ? 0 : talentLevels[tid] ?? 0;
                              return (
                                <div
                                  key={tid}
                                  className={
                                    "skills__talent" +
                                    (locked ? " skills__talent--locked" : "")
                                  }
                                >
                                  <span className="skills__talent-req">
                                    L{t.skillLevelRequired}
                                  </span>
                                  <span className="skills__talent-name">
                                    {t.displayName}
                                  </span>
                                  {t.hasLevels ? (
                                    <input
                                      type="range"
                                      min={0}
                                      max={t.maxLevel}
                                      value={tlevel}
                                      disabled={locked}
                                      className="skills__talent-slider"
                                      onChange={(e) =>
                                        setTalentLevels({
                                          ...talentLevels,
                                          [tid]: Number(e.target.value),
                                        })
                                      }
                                    />
                                  ) : (
                                    <input
                                      type="checkbox"
                                      checked={tlevel > 0}
                                      disabled={locked}
                                      className="skills__talent-check"
                                      onChange={(e) =>
                                        setTalentLevels({
                                          ...talentLevels,
                                          [tid]: e.target.checked ? 1 : 0,
                                        })
                                      }
                                    />
                                  )}
                                  <span className="skills__talent-level">
                                    {locked
                                      ? "locked"
                                      : t.hasLevels
                                        ? tlevel > 0
                                          ? `lv ${tlevel}`
                                          : "off"
                                        : tlevel > 0
                                          ? "on"
                                          : "off"}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </>
          )}

          {tree && (
            <>
              <div className="section-label">
                <span className="section-label__num">
                  {skillsInTree.size > 0 ? "03" : "02"}
                </span>
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
                    <span className="section-label__num">
                      {skillsInTree.size > 0 ? "04" : "03"}
                    </span>
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
              {/* If the target is a food, surface in-game nutrition values
                  the player gains by eating it. */}
              {data.food[selectedItem] && (
                <>
                  <div className="sticky-target__divider" />
                  {data.food[selectedItem].calories != null && (
                    <div className="sticky-target__stat">
                      <div className="sticky-target__label">food cal</div>
                      <div className="sticky-target__value">
                        {Math.round(data.food[selectedItem].calories!)}
                      </div>
                    </div>
                  )}
                  <div className="sticky-target__stat">
                    <div className="sticky-target__label">carbs</div>
                    <div className="sticky-target__value">
                      {data.food[selectedItem].carbs ?? 0}
                    </div>
                  </div>
                  <div className="sticky-target__stat">
                    <div className="sticky-target__label">fat</div>
                    <div className="sticky-target__value">
                      {data.food[selectedItem].fat ?? 0}
                    </div>
                  </div>
                  <div className="sticky-target__stat">
                    <div className="sticky-target__label">protein</div>
                    <div className="sticky-target__value">
                      {data.food[selectedItem].protein ?? 0}
                    </div>
                  </div>
                  <div className="sticky-target__stat">
                    <div className="sticky-target__label">vitamins</div>
                    <div className="sticky-target__value">
                      {data.food[selectedItem].vitamins ?? 0}
                    </div>
                  </div>
                </>
              )}
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
