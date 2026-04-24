# Eco · Calorie Basis — Claude onboarding

A single-page React/Vite/TypeScript app that computes the total labor-calorie
cost of any craftable item in Eco (Strange Loop Games). Built for **sellers**
who want to know what their goods cost them so they can price accordingly.

This is NOT a build optimizer. The user already knows their build path —
they're asking "given my choices, what did this cost me in labor?"

## Core design principles (don't drift from these)

1. **Sticky overrides.** Once the user pins a recipe or tag choice, the
   resolver uses it. No silent path-switching to find a cheaper route.
2. **Alphabetical-first defaults.** When ambiguity exists and the user
   hasn't chosen, pick the alphabetically-first recipe ID or tag member.
   Stable, obvious, user-overridable. Not "cheapest."
3. **All decision points visible, not just on-path ones.** The Diagram
   view surfaces inline dropdowns wherever a decision could be made;
   alternate branches that a choice would activate are dimmed but still
   present. A seller should see the full topology of decisions before
   committing to a calorie number.
4. **Field-report aesthetic.** Warm paper background, forest-green accent,
   JetBrains Mono for data, Fraunces for display. Not "designed by AI"
   glossy — this is an engineer's calculator.

## What's built

### Data pipeline
- `scripts/parse_recipes.py` scans Eco's autogen C# tree (Recipe/, Item/,
  Block/, Food/, Tool/, Clothing/, Vehicle/, WorldObject/, Fertilizer/,
  Seed/) and extracts 1,370 recipes via regex. Handles: `RecipeFamily`
  vs tag-product-variant `Recipe` inheritance; 4-arg IngredientElement
  with Talent; `0.1f` float literals; `[RequiresSkill]` attributes;
  `CraftingComponent.AddTagProduct` for labor inheritance.
- `scripts/build_tags.py` walks `*Item` class decls across the same
  folders, collects `[Tag("x")]` attributes, produces tag → items map.
- `scripts/build_bundle.py` combines both into `public/eco-data.json`
  (~570 KB: recipes, producers index, tagToItems, humanized item names).

### Resolver (`src/lib/resolver.ts`)
- Pure functions. Memoized DFS with cycle detection.
- `Resolver.resolveItem(item, qty)` — returns a `TreeNode` tree where
  every node's `qty` and `totalCalories` represent "this many of this
  item, costing this much." Children are normalized to per-unit-output
  demand, so the tree scales cleanly with `qty`.
- `findAmbiguities(target, data, choices)` — walks the FULL dependency
  graph structurally (not just the chosen path), returns on-path and
  off-path decision points.
- `buildDiagram(tree, data)` — assigns tiers via subtree depth;
  deduplicates identical items within a tier (summing qty and calories)
  so wide trees like Truck (was 215 nodes, now 49) stay legible.
- `flattenRawInputs(tree)` — Map<item, qty> of raw-harvest leaves.

### UI (`src/App.tsx` + `src/components/`)
- `Picker.tsx` — fuzzy-searchable item selector with qty input.
- `Diagram.tsx` — **primary view**. Vertical tree, raw at top, target
  at bottom. SVG cubic-bezier wires between cards. Inline dropdowns on
  cards for ambiguity. Card per unique (item, tier) pair.
- `Tree.tsx` — **secondary view** (tab). The original tabular indented
  tree with labor/cal/% columns. Still useful for verifying math.
- `FlatInputs.tsx` — raw-harvest requirements as a flat list.
- Sticky target banner at the bottom of the viewport: per-unit cal,
  order total, raw input count. Always visible while scrolling wide
  trees.

## Assumptions baked in

- **Level 0, no upgrades.** Every recipe uses its base `LaborInCalories`
  value. Skills, talents, upgrade modules not modeled. Noted in README.
- **Raw harvest = 20 cal/unit** (`DEFAULT_RAW_COST` in resolver.ts).
  Matches the in-game model of 20 cal/swing with a tier-appropriate
  tool. Per-item overrides supported via `rawCosts` option on Resolver
  constructor — no UI for this yet.
- **Multi-output recipes divide labor across outputs.** ButcherBison
  (70 labor, 10 meat + 2 hide + 3 wool) allocates ~4.67 cal/unit of
  meat, not the full 70. Simple and defensible; user can override in
  `resolveRecipe` if they want a different allocation strategy.

## Known limitations (likely "next asks")

- **No persistence.** Refresh wipes overrides. localStorage for
  current-target overrides is easy; Firebase-backed presets would
  earn their keep if the seller makes the same builds repeatedly.
- **Diagram wire routing is naive.** Plain cubic-beziers. Wires can
  cross at deep/wide trees. A Sugiyama-style layered graph layout
  would be the principled fix but is a meaningful lift.
- **No subtree collapse.** Truck is functional but dense. "Click a
  node to collapse everything upstream of it" would help focus.
- **Raw harvest cost is one global value.** For a seller who buys some
  inputs from market and harvests others, a per-item cost editor would
  let them input "Iron Ore costs me 5 currency/unit, not 20 cal."
- **No currency math.** The user said they'd do pricing themselves.
  If that changes, adding a "calorie → currency" labor rate plus
  margin controls is straightforward.
- **Parse script paths are hardcoded** to wherever the Eco autogen
  tree was extracted when the scripts ran. Adjust `CATEGORIES` / `root`
  at the top of each script if regenerating.

## Testing

```sh
tsx src/lib/smoketest.ts       # regression tests — expected outputs
                               # for HewnDresser (1590 cal), Dowel (5),
                               # HewnLog (70), etc.
npm run build                  # tsc -b && vite build — catches type
                               # errors before they reach the browser
npm run dev                    # vite dev server at :5173
```

## Handy test items for the resolver

- **HewnDresserItem** — classic middleweight, 1590 cal at defaults.
  4-tier diagram. Good for smoke-testing ambiguity flow (HewnLog tag,
  WoodBoard tag, Wood tag, Hardwood tag all resolve).
- **TruckItem** — stress test. 49 nodes post-dedup, 10 tiers, ~147k
  cal. If wire routing or performance breaks anywhere, it's here.
- **BoardItem** — 4 producing recipes (Board, Boards, SawBoards,
  ParticleBoards). Good for testing the multi-producer dropdown.
- **DowelItem** — single-producer but feeds HewnLog. Clean 5 cal/unit.

## Conventions

- TypeScript strict mode. `noUnusedLocals`, `noUnusedParameters` on.
- Components use named exports (`export function Foo`), App default exports.
- CSS uses `--var` custom properties; design tokens at top of styles.css.
- No test framework yet — smoketest.ts is a plain node script via `tsx`.
  If adding tests, Vitest is the path of least resistance.
- No Firebase integration yet. Matches BaT Challenge Generator's stack
  but this app doesn't require persistence.
