import type {
  BonusAction,
  Choices,
  EcoData,
  Recipe,
  SkillLevels,
  TalentEffect,
  TalentLevels,
  TreeNode,
} from "./types";

// Default raw-harvest calorie floor. At level 0 every harvesting tool burns
// ~20 calories per swing, and one swing = one block for appropriately-tiered
// tools. Overridable per-item via the second arg to Resolver.
export const DEFAULT_RAW_COST = 20;

// Items that are gatherable from the world AND have producing recipes in the
// data — Eco's autogen only captures the recipes, so without this list sand
// (SandConcentrate, rocker box) would always resolve as a crafted chain even
// when the seller just digs a sand block. Gather is the default when in this
// set; pinning a specific recipe via choices["item:X"] switches behaviour.
// If a new dual-mode item shows up, add it here.
export const GATHERABLE_ITEMS: ReadonlySet<string> = new Set([
  "SandItem",
  "DirtItem",
]);
// Sentinel choice value: choices["item:SandItem"] = "__gather__" forces
// the raw-harvest branch for a gatherable item.
export const GATHER_CHOICE = "__gather__";

export interface ResolveOptions {
  choices?: Choices;
  rawCosts?: Record<string, number>;
  skillLevels?: SkillLevels;
  talentLevels?: TalentLevels;
}

export class Resolver {
  private recipesById: Map<string, Recipe>;
  private memo: Map<string, TreeNode> = new Map();
  private stack: Set<string> = new Set();
  private choices: Choices;
  private rawCosts: Record<string, number>;
  private skillLevels: SkillLevels;
  private talentLevels: TalentLevels;

  constructor(private data: EcoData, opts: ResolveOptions = {}) {
    this.recipesById = new Map(data.recipes.map((r) => [r.id, r]));
    this.choices = opts.choices ?? {};
    this.rawCosts = opts.rawCosts ?? {};
    this.skillLevels = opts.skillLevels ?? {};
    this.talentLevels = opts.talentLevels ?? {};
  }

  /**
   * Update the resolver with new ambiguity choices and clear the cache.
   * Cheaper than constructing a new Resolver because data indexes are kept.
   */
  setChoices(choices: Choices) {
    this.choices = choices;
    this.memo.clear();
  }

  setSkillLevels(levels: SkillLevels) {
    this.skillLevels = levels;
    this.memo.clear();
  }

  setTalentLevels(levels: TalentLevels) {
    this.talentLevels = levels;
    this.memo.clear();
  }

  /** Labor-cost multiplier for a recipe given its labor-governing skill. */
  private skillMultiplier(skillId: string | null | undefined): number {
    if (!skillId) return 1;
    const level = this.skillLevels[skillId] ?? 0;
    const info = this.data.skills?.[skillId];
    if (!info) return 1;
    const m = info.multipliers[level];
    return typeof m === "number" ? m : 1;
  }

  /** Compose every enabled talent's effect on a single (recipe, action)
   *  combination into one cost factor. Returns 1 (no change) when nothing
   *  applies. Iterating per-edge keeps the math local and side-effect-free. */
  private talentMultiplier(
    recipe: Recipe | null,
    item: string | null,
    action: BonusAction,
  ): number {
    let factor = 1;
    const talents = this.data.talents ?? {};
    for (const tid in this.talentLevels) {
      const level = this.talentLevels[tid] ?? 0;
      if (level <= 0) continue;
      const t = talents[tid];
      if (!t) continue;
      for (const eff of t.effects) {
        if (eff.action !== action) continue;
        if (!this.effectMatches(eff, recipe, item)) continue;
        factor *= this.effectFactor(eff, level);
      }
    }
    return factor;
  }

  /** Cause-filter check: a talent effect only applies when all of its
   *  filters (skill, item tag, crafting station) are satisfied. Empty
   *  filter lists mean "no restriction in this dimension". */
  private effectMatches(
    eff: TalentEffect,
    recipe: Recipe | null,
    item: string | null,
  ): boolean {
    if (eff.skills.length > 0) {
      if (!recipe?.laborSkill || !eff.skills.includes(recipe.laborSkill)) {
        return false;
      }
    }
    if (eff.stations.length > 0) {
      if (!recipe?.table || !eff.stations.includes(recipe.table)) {
        return false;
      }
    }
    if (eff.tags.length > 0) {
      // Tags filter against the produced/affected item's tag set. For
      // recipes that's the primary output item; for raw harvest it's the
      // item itself.
      const probe = item ?? recipe?.outputs[0]?.item;
      if (!probe) return false;
      const tags = this.data.itemToTags?.[probe] ?? [];
      if (!eff.tags.some((t) => tags.includes(t))) return false;
    }
    return true;
  }

  /** Translate one talent effect at a given player-invested level into a
   *  cost-side multiplier. Yield effects flip to 1/yield since we're
   *  shrinking the per-unit cost (more output per swing = cheaper per unit). */
  private effectFactor(eff: TalentEffect, level: number): number {
    const isYield = eff.action === "HarvestYield" || eff.action === "Yield";
    if (eff.kind === "Multiplicative") {
      // One-shot effect — `level >= 1` enables it.
      return isYield && eff.value !== 0 ? 1 / eff.value : eff.value;
    }
    if (eff.kind === "CappedMultiplicative") {
      const exp = Math.pow(eff.value, level);
      const clamped = eff.lowerIsBetter
        ? Math.max(eff.cap ?? 0, exp)
        : Math.min(eff.cap ?? Infinity, exp);
      return isYield && clamped !== 0 ? 1 / clamped : clamped;
    }
    if (eff.kind === "Additive") {
      // Yield-side additive: +value per level → divides per-unit cost by
      // (1 + value*level). Labor/resource additive: subtracts value*level.
      if (isYield) return 1 / (1 + eff.value * level);
      return Math.max(0, 1 - eff.value * level);
    }
    return 1;
  }

  /** Public entry point. Returns a scaled tree for `qty` of `item`. */
  resolveItem(item: string, qty = 1): TreeNode {
    const unit = this.resolveUnit(item);
    return this.scale(unit, qty);
  }

  /** Per-unit resolution, memoized. */
  private resolveUnit(item: string): TreeNode {
    const cached = this.memo.get(item);
    if (cached) return cached;

    if (this.stack.has(item)) {
      return { kind: "cycle", item, qty: 1, totalCalories: 0 };
    }

    this.stack.add(item);
    try {
      const producers = this.data.producers[item] ?? [];
      let node: TreeNode;

      if (producers.length === 0) {
        // Raw harvest leaf — apply yield talents that target this item's tags.
        const baseCost = this.rawCosts[item] ?? DEFAULT_RAW_COST;
        const yieldFactor =
          this.talentMultiplier(null, item, "HarvestYield") *
          this.talentMultiplier(null, item, "Yield");
        node = { kind: "raw", item, qty: 1, totalCalories: baseCost * yieldFactor };
      } else {
        const overrideKey = `item:${item}`;
        const chosen = this.choices[overrideKey];
        const gatherable = GATHERABLE_ITEMS.has(item);
        // Gatherable-and-craftable items default to gather — sellers almost
        // always dig sand/dirt out of the world rather than spin up a rocker
        // box. Pinning a specific recipe via the override switches back.
        if (gatherable && (!chosen || chosen === GATHER_CHOICE)) {
          const baseCost = this.rawCosts[item] ?? DEFAULT_RAW_COST;
          const yieldFactor =
            this.talentMultiplier(null, item, "HarvestYield") *
            this.talentMultiplier(null, item, "Yield");
          node = { kind: "raw", item, qty: 1, totalCalories: baseCost * yieldFactor };
        } else {
          // Sticky overrides: respect the user's choice even if it would
          // produce a non-optimal path. If they haven't chosen, pick the
          // alphabetically-first recipe ID — stable, obvious, user-overridable.
          const recipeId =
            chosen && producers.includes(chosen)
              ? chosen
              : [...producers].sort()[0];
          node = this.resolveRecipe(recipeId, item);
        }
      }

      this.memo.set(item, node);
      return node;
    } finally {
      this.stack.delete(item);
    }
  }

  private resolveRecipe(recipeId: string, producedItem: string): TreeNode {
    const recipe = this.recipesById.get(recipeId);
    if (!recipe) {
      return { kind: "missing", item: producedItem, qty: 1, totalCalories: 0 };
    }
    const outQty =
      recipe.outputs.find((o) => o.item === producedItem)?.qty ?? 1;
    // Apply the labor-skill multiplier plus any LaborCost talents whose
    // cause filters match this recipe. Yield-side talents also boost the
    // effective output (more units per craft), shrinking per-unit cost.
    const labor =
      (recipe.labor ?? 0) *
      this.skillMultiplier(recipe.laborSkill) *
      this.talentMultiplier(recipe, producedItem, "LaborCost");
    const ingFactor = this.talentMultiplier(recipe, producedItem, "ResourceCost");
    const yieldFactor =
      this.talentMultiplier(recipe, producedItem, "Yield") *
      this.talentMultiplier(recipe, producedItem, "HarvestYield");

    // Children are built at PER-UNIT-OUTPUT demand. If the recipe is
    // "2 wood -> 16 dowels", the Dowel unit node's child is "0.125 wood
    // per 1 dowel". This way every node's qty/totalCalories at every
    // depth means the same thing: requirements for ONE of the parent.
    const children: TreeNode[] = [];
    let ingredientTotal = 0;

    for (const ing of recipe.ingredients) {
      // ResourceCost talents shrink the actual ingredient demand at craft
      // time; we propagate that to per-unit-output qty for child resolution.
      const perUnitQty = (ing.qty * ingFactor) / outQty;
      const child =
        ing.kind === "type"
          ? this.resolveItem(ing.ref, perUnitQty)
          : this.resolveTag(ing.ref, perUnitQty);
      children.push(child);
      ingredientTotal += child.totalCalories;
    }

    const perUnitLabor = outQty > 0 ? labor / outQty : labor;
    // Yield talents scale the effective output beyond `outQty`; per-unit
    // labor + ingredient cost both shrink proportionally.
    const perUnitTotal = (perUnitLabor + ingredientTotal) * yieldFactor;

    return {
      kind: "recipe",
      item: producedItem,
      qty: 1,
      totalCalories: perUnitTotal,
      recipeId,
      labor: perUnitLabor, // labor attributable to ONE output unit
      outputQty: outQty,
      children,
    };
  }

  private resolveTag(tag: string, qty: number): TreeNode {
    const candidates = this.data.tagToItems[tag] ?? [];
    if (candidates.length === 0) {
      return {
        kind: "missing",
        item: `tag:${tag}`,
        qty,
        totalCalories: 0,
      };
    }

    const overrideKey = `tag:${tag}`;
    const override = this.choices[overrideKey];
    // Sticky overrides: if the user picked a specific item for this tag,
    // use it. Otherwise default to the alphabetically-first candidate.
    // No cheapest-evasion — once pinned, stays pinned.
    const chosen =
      override && candidates.includes(override)
        ? override
        : [...candidates].sort()[0];

    const child = this.resolveItem(chosen, qty);
    return { ...child, tagResolvedTo: `${tag} → ${chosen}` };
  }

  private scale(unit: TreeNode, qty: number): TreeNode {
    if (qty === 1) return unit;
    return scaleTree(unit, qty);
  }
}

/**
 * Scale a unit tree to represent `qty` items.
 *
 * Because `resolveRecipe` stores children already normalized to per-unit-
 * output demand, every field in the subtree scales uniformly by the same
 * factor. This keeps the tree semantics simple: at every depth, `qty` and
 * `totalCalories` mean "what this node represents", nothing more.
 */
function scaleTree(node: TreeNode, qty: number): TreeNode {
  const ratio = qty / (node.qty || 1);
  return {
    ...node,
    qty,
    totalCalories: node.totalCalories * ratio,
    labor: node.labor != null ? node.labor * ratio : node.labor,
    children: node.children?.map((ch) => scaleTree(ch, ch.qty * ratio)),
  };
}

/**
 * Find every ambiguity in the target's dependency graph — structurally,
 * not just on the currently-resolved path. This lets a seller see every
 * decision they could pin down before committing to a calorie basis.
 *
 * Two kinds of ambiguity:
 *   - multi-producer: an item is produced by multiple recipes
 *   - tag: a tag ingredient has multiple qualifying items
 *
 * Walks the graph breadth-first from the target, following BOTH the chosen
 * path (so the user sees what's being used) AND every alternate branch
 * (so the user sees what could be chosen). Cycle-safe via a seen set.
 */
export interface AmbiguityPoint {
  key: string; // "tag:<tag>" or "item:<item>"
  kind: "tag" | "multi-producer";
  tag?: string;
  item?: string;
  chosen: string; // currently-resolved itemId or recipeId (default or override)
  options: string[];
  onChosenPath: boolean; // is this decision actually affecting the current total?
}

export function findAmbiguities(
  target: string,
  data: EcoData,
  choices: Choices,
): AmbiguityPoint[] {
  const out: AmbiguityPoint[] = [];
  const seenKeys = new Set<string>();
  const seenItems = new Set<string>();

  // Determine the currently-chosen-path items so we can mark which
  // ambiguities are in-use vs structurally-present-but-off-path.
  const onPathItems = new Set<string>();
  const onPathRecipes = new Set<string>();
  walkChosenPath(target, data, choices, onPathItems, onPathRecipes);

  function pushItem(item: string) {
    if (seenItems.has(item)) return;
    seenItems.add(item);

    const producers = data.producers[item] ?? [];
    if (producers.length === 0) return; // raw harvest, no decision here

    const gatherable = GATHERABLE_ITEMS.has(item);
    // A gatherable item is a decision point even with one producer — the
    // user is choosing gather vs. that one recipe. A multi-producer item
    // is always a decision. Gather is listed first in the options.
    if (producers.length > 1 || gatherable) {
      const key = `item:${item}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        const options = gatherable
          ? [GATHER_CHOICE, ...[...producers].sort()]
          : [...producers].sort();
        const override = choices[key];
        const chosen =
          override && options.includes(override)
            ? override
            : gatherable
              ? GATHER_CHOICE
              : options[0];
        out.push({
          key,
          kind: "multi-producer",
          item,
          chosen,
          options,
          onChosenPath: onPathItems.has(item),
        });
      }
    }

    // Follow every recipe that produces this item (to surface off-path
    // ambiguities as well), then walk into each recipe's ingredients.
    for (const recipeId of producers) {
      const recipe = data.recipes.find((r) => r.id === recipeId);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        if (ing.kind === "type") {
          pushItem(ing.ref);
        } else {
          pushTag(ing.ref);
        }
      }
    }
  }

  function pushTag(tag: string) {
    const candidates = data.tagToItems[tag] ?? [];
    if (candidates.length <= 1) {
      // Unambiguous tag: just recurse into the one (or zero) candidates.
      candidates.forEach(pushItem);
      return;
    }

    const key = `tag:${tag}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      const chosen =
        (choices[key] && candidates.includes(choices[key]))
          ? choices[key]
          : [...candidates].sort()[0];
      out.push({
        key,
        kind: "tag",
        tag,
        chosen,
        options: [...candidates].sort(),
        onChosenPath: onPathItems.has(chosen),
      });
    }

    // Walk into every candidate so their sub-ambiguities surface too.
    for (const c of candidates) {
      pushItem(c);
    }
  }

  pushItem(target);

  // Sort: on-path decisions first, then off-path. Within each group, tags
  // before multi-producers (usually what a seller pins first), then alpha.
  out.sort((a, b) => {
    if (a.onChosenPath !== b.onChosenPath) return a.onChosenPath ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "tag" ? -1 : 1;
    return a.key.localeCompare(b.key);
  });

  return out;
}

/** Walk the currently-chosen path from `target`, collecting the set of items
 *  and recipes actually used so we can mark ambiguities as on- vs off-path. */
function walkChosenPath(
  target: string,
  data: EcoData,
  choices: Choices,
  outItems: Set<string>,
  outRecipes: Set<string>,
  seen = new Set<string>(),
): void {
  if (seen.has(target)) return;
  seen.add(target);
  outItems.add(target);

  const producers = data.producers[target] ?? [];
  if (producers.length === 0) return;

  const key = `item:${target}`;
  const override = choices[key];
  // Gatherable items default to gather; walking a gather branch stops here
  // (no ingredients to follow).
  if (GATHERABLE_ITEMS.has(target) && (!override || override === GATHER_CHOICE)) {
    return;
  }
  const chosenRecipe =
    (override && producers.includes(override))
      ? override
      : [...producers].sort()[0];
  outRecipes.add(chosenRecipe);

  const recipe = data.recipes.find((r) => r.id === chosenRecipe);
  if (!recipe) return;

  for (const ing of recipe.ingredients) {
    if (ing.kind === "type") {
      walkChosenPath(ing.ref, data, choices, outItems, outRecipes, seen);
    } else {
      const tagKey = `tag:${ing.ref}`;
      const candidates = data.tagToItems[ing.ref] ?? [];
      if (candidates.length === 0) continue;
      const chosen =
        (choices[tagKey] && candidates.includes(choices[tagKey]))
          ? choices[tagKey]
          : [...candidates].sort()[0];
      walkChosenPath(chosen, data, choices, outItems, outRecipes, seen);
    }
  }
}

/**
 * Flatten a breakdown tree into a flat list of raw-harvest requirements.
 * Useful for the "just tell me what to go get" view.
 */
export function flattenRawInputs(node: TreeNode): Map<string, number> {
  const totals = new Map<string, number>();
  function visit(n: TreeNode) {
    if (n.kind === "raw") {
      totals.set(n.item, (totals.get(n.item) ?? 0) + n.qty);
    }
    n.children?.forEach(visit);
  }
  visit(node);
  return totals;
}

/**
 * Compute layout tiers for the diagram view: raw-harvest leaves at tier 0,
 * target at the highest tier. Each node's tier = 1 + max(tier of its
 * children). Ensures that no edge points "backward" in the vertical flow.
 *
 * Returns a map of node path → tier, and tiers → nodes at that depth.
 */
export interface DiagramLayout {
  nodes: DiagramNode[];
  tiers: DiagramNode[][]; // tiers[0] = raw leaves, tiers[N] = target
  edges: DiagramEdge[];
  maxTier: number;
}

export interface DiagramNode {
  id: string; // stable per-path id
  node: TreeNode;
  tier: number;
  // For visual grouping: which crafting table (recipe.table) if any
  table?: string | null;
}

export interface DiagramEdge {
  fromId: string; // child (earlier in production, higher tier number confusingly)
  toId: string; // parent (later in production — the thing being built from the child)
  qty: number;
  // The ingredient label: either tag name or type name as it appears in the recipe
  label?: string;
}

export function buildDiagram(
  root: TreeNode,
  data: EcoData,
): DiagramLayout {
  // First pass: walk the tree and collect raw (node, parent) pairs without
  // worrying about tier or deduplication. We keep a "path" for each instance
  // so we can trace back who needs what.
  interface RawEntry {
    node: TreeNode;
    parentPath: string | null;
    path: string;
  }
  const raw: RawEntry[] = [];
  function collect(n: TreeNode, parentPath: string | null, path: string) {
    raw.push({ node: n, parentPath, path });
    n.children?.forEach((ch, i) => collect(ch, path, `${path}/${i}`));
  }
  collect(root, null, "0");

  // Second pass: compute tier for each node via its subtree depth, then
  // deduplicate by (item, tier). Each unique (item, tier) becomes one
  // DiagramNode whose qty is the sum of qtys at that position.
  function subtreeDepth(n: TreeNode): number {
    if (!n.children || n.children.length === 0) return 0;
    return 1 + Math.max(...n.children.map(subtreeDepth));
  }
  const tierOfPath = new Map<string, number>();
  for (const { node, path } of raw) {
    tierOfPath.set(path, subtreeDepth(node));
  }

  function recipeTableFor(recipeId?: string): string | null | undefined {
    if (!recipeId) return undefined;
    const r = data.recipes.find((x) => x.id === recipeId);
    return r?.table ?? null;
  }

  // Dedup key = `tier|item` so identical items at the same depth collapse.
  // We track the representative TreeNode (first-seen) + accumulate qty/cal.
  const byKey = new Map<string, { rep: TreeNode; qty: number; cal: number; id: string }>();
  const pathToId = new Map<string, string>();
  let idCounter = 0;

  for (const { node, path } of raw) {
    const tier = tierOfPath.get(path)!;
    const key = `${tier}|${node.item}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.qty += node.qty;
      existing.cal += node.totalCalories;
      pathToId.set(path, existing.id);
    } else {
      const id = `n${idCounter++}`;
      byKey.set(key, { rep: node, qty: node.qty, cal: node.totalCalories, id });
      pathToId.set(path, id);
    }
  }

  const nodes: DiagramNode[] = [];
  for (const [key, v] of byKey.entries()) {
    const tier = Number(key.split("|")[0]);
    // Build a "synthetic" node reflecting the collapsed qty/cal while
    // preserving the representative's structural info (kind, recipeId,
    // children, tagResolvedTo). Children aren't used for the diagram UI,
    // so carrying them doesn't hurt — but we do want qty/totalCalories
    // to reflect the sum.
    const synth: TreeNode = {
      ...v.rep,
      qty: v.qty,
      totalCalories: v.cal,
    };
    nodes.push({
      id: v.id,
      node: synth,
      tier,
      table: recipeTableFor(synth.recipeId),
    });
  }

  // Edges: dedup by (fromId, toId) summing qty.
  const edgeMap = new Map<string, DiagramEdge>();
  for (const { parentPath, path, node } of raw) {
    if (parentPath == null) continue;
    const fromId = pathToId.get(path)!;
    const toId = pathToId.get(parentPath)!;
    const key = `${fromId}->${toId}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.qty += node.qty;
    } else {
      edgeMap.set(key, { fromId, toId, qty: node.qty });
    }
  }

  const edges = [...edgeMap.values()];
  const maxTier = Math.max(...nodes.map((n) => n.tier));
  const tiers: DiagramNode[][] = Array.from({ length: maxTier + 1 }, () => []);
  for (const n of nodes) tiers[n.tier].push(n);

  return { nodes, tiers, edges, maxTier };
}
