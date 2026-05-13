// Schema of eco-data.json, produced by parse_recipes.py + build_tags.py
// on Strange Loop Games' Eco autogen source.

export interface Ingredient {
  ref: string; // item id (kind="type") OR tag name (kind="tag")
  kind: "type" | "tag";
  qty: number;
}

export interface Output {
  item: string;
  qty: number;
}

export interface Recipe {
  id: string;
  name: string; // display name
  labor: number; // calories (base, level 0)
  ingredients: Ingredient[];
  outputs: Output[];
  skill: string | null;
  skillLevel: number;
  // Skill whose level controls labor-cost reduction. Usually matches `skill`,
  // but recipes can pin a different skill in their CreateLaborInCaloriesValue
  // call. Null when no skill reduces labor.
  laborSkill: string | null;
  table: string | null;
}

export interface SkillInfo {
  displayName: string;
  // Labor-cost multiplier indexed by level: multipliers[0] = 1 (no
  // reduction), and higher levels carry smaller fractions.
  multipliers: number[];
  maxLevel: number;
}

// User-selected per-skill level. Defaults to 0 (no reduction) when an entry
// is missing.
export type SkillLevels = Record<string, number>;

// Action kinds we model. Other Eco BonusActions (CraftTime, Power,
// Durability, etc.) are filtered out at parse time — they don't affect the
// calorie basis we're computing.
export type BonusAction =
  | "LaborCost"      // multiplies recipe.labor
  | "ResourceCost"   // multiplies recipe ingredient quantities
  | "HarvestYield"   // additive per-action yield boost (gathering)
  | "Yield";         // multiplicative output boost

export interface TalentEffect {
  action: BonusAction;
  // Multiplicative = flat one-shot; CappedMultiplicative scales per level
  // bounded by `cap`; Additive accumulates +value per level (used by yield
  // talents that say "+1 wheat per swing per level").
  kind: "Multiplicative" | "CappedMultiplicative" | "Additive" | string;
  value: number;
  cap: number | null;
  lowerIsBetter: boolean;
  // Cause filters — empty means "no restriction in this dimension". When
  // EVERY list is empty the effect is treated as filterless; the resolver
  // skips such effects rather than apply globally, since an unscoped Yield
  // would compound across every recipe in the tree.
  skills: string[];
  tags: string[];
  stations: string[];
  recipes: string[];  // recipe ids the effect is scoped to (Mineral Baking → Quicklime)
}

export interface TalentInfo {
  displayName: string;
  ownerSkill: string;
  // Player needs at least this many levels in `ownerSkill` to unlock the talent.
  skillLevelRequired: number;
  // True when the talent's effects scale with talent level. False = checkbox.
  hasLevels: boolean;
  maxLevel: number;
  effects: TalentEffect[];
}

// User-selected per-talent level. Talent disabled = 0; enabled = 1..maxLevel.
export type TalentLevels = Record<string, number>;

export interface ToolInfo {
  displayName: string;
  kind: string;       // "axe" | "pickaxe" | "sickle" | ...
  skill: string;      // gathering skill that governs this tool
  tier: number;       // 1 (Stone) .. 4 (Modern)
  damage: number;     // damage per swing
}

export interface RawHarvestInfo {
  // tree → felled trunk, log drops; ore → mined block, single drop; plants
  // are kept in defaultRawCosts since tool tier doesn't affect their cost.
  kind: "tree" | "ore";
  hp: number;         // block / tree HP to chop through
  yield: number;      // expected drops per fell/mine action
  skill: string;      // gathering skill (LoggingSkill, MiningSkill, ...)
}

// User-selected tool per gathering skill: toolTiers[skillId] = toolItemId.
// When unset, the resolver defaults to the lowest-tier tool that exists for
// that skill (Stone Axe / Stone Pickaxe / etc.).
export type ToolTiers = Record<string, string>;

export interface FoodInfo {
  // Energy granted to the player on consumption.
  calories: number | null;
  // Macronutrient values used in Eco's nutrition multiplier system. Each
  // is the integer the FoodItem class declares in its Nutrients() literal.
  carbs: number | null;
  fat: number | null;
  protein: number | null;
  vitamins: number | null;
}

export interface EcoData {
  recipes: Recipe[];
  producers: Record<string, string[]>; // itemId -> recipeIds producing it
  tagToItems: Record<string, string[]>; // tag -> qualifying itemIds
  items: Record<string, string>; // itemId -> human-readable display name
  // Tag membership per item — used to filter talent effects scoped via
  // ItemTags (e.g. Lumber, Housing, Fruit).
  itemToTags: Record<string, string[]>;
  food: Record<string, FoodInfo>;       // itemId -> nutrition (food items only)
  skills: Record<string, SkillInfo>;    // skillId -> labor-multiplier table
  talents: Record<string, TalentInfo>;  // talentId -> bonus definitions
  // Per-item default cal/unit, derived from in-game plant yield data
  // (20 cal/swing baseline / avg yield per harvest action). Items not in
  // this map fall back to the global 20 cal/unit floor — or to rawHarvest
  // for tree/ore items where the cost depends on chosen tool tier.
  defaultRawCosts: Record<string, number>;
  // Tree/ore harvest model — resolver computes per-unit cost at runtime
  // using the user's selected tool tier for the governing skill.
  rawHarvest: Record<string, RawHarvestInfo>;
  // Tools indexed by item id, used to populate per-skill tool pickers.
  tools: Record<string, ToolInfo>;
  // Diagnostic yield tables used to caption raw cards in the UI.
  plantYields: Record<string, YieldInfo>;
  treeYields: Record<string, YieldInfo>;
}

export interface YieldInfo {
  avgYield: number;  // average drop per harvest action (plant) or per tree (tree)
  sources: number;   // count of species contributing to this average
}

// Node kinds in the resolved breakdown tree.
export type NodeKind = "recipe" | "raw" | "cycle" | "missing";

export interface TreeNode {
  kind: NodeKind;
  item: string; // itemId this node represents (or "tag:<name>" when missing)
  qty: number; // how many of `item` this node accounts for
  totalCalories: number;
  // recipe kind extras
  recipeId?: string;
  labor?: number; // this node's own labor, scaled to qty
  outputQty?: number; // recipe output qty (unscaled)
  children?: TreeNode[];
  // tag resolution trace: "<tag> -> <chosen item>"
  tagResolvedTo?: string;
}

// User-provided overrides for ambiguity resolution.
//   keyed "tag:<tagname>" -> chosen itemId
//   keyed "item:<itemid>"  -> chosen recipeId
export type Choices = Record<string, string>;
