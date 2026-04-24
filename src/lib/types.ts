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
  table: string | null;
}

export interface EcoData {
  recipes: Recipe[];
  producers: Record<string, string[]>; // itemId -> recipeIds producing it
  tagToItems: Record<string, string[]>; // tag -> qualifying itemIds
  items: Record<string, string>; // itemId -> human-readable display name
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
