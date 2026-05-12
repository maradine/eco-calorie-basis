"""
Scan the Eco autogen tree to build:
  - item_to_tags: every `[Tag("x")]` attached to every `class XxxItem` declaration
  - tag_to_items: the inverse
  - item_file: where each Item class is defined

Approach: attribute blocks in these files are always immediately above the
class declaration, separated only by whitespace, comments, and other
attributes. We find each `public ... class XxxItem` declaration and walk
backwards over contiguous attribute/comment/whitespace lines to collect
every Tag("...") that sits in that stack.
"""
from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from pathlib import Path

# Override with ECO_AUTOGEN env var; default is the typical Windows Steam path.
DEFAULT_ROOT = Path(
    r"C:\Program Files (x86)\Steam\steamapps\common\Eco"
    r"\Eco_Data\Server\Mods\__core__\AutoGen"
)
ROOT = Path(os.environ.get("ECO_AUTOGEN", str(DEFAULT_ROOT)))
CATEGORIES = [
    "Block", "Item", "Food", "Tool", "Clothing", "Fertilizer", "Seed",
    "Animal", "Plant",
    # Tech holds skill books / scrolls (no Item suffix on the class — see
    # _walk_classes for the loosened acceptance rule).
    "Tech",
]

# Regex to pick out *any* class declaration ending in "Item" (also "Carcass",
# "Block", etc.; we'll filter by suffix).
RE_CLASS_DECL = re.compile(
    r'public\s+(?:partial\s+)?class\s+(\w+)\s*(?::\s*[^{\n]+)?'
)

# Find Tag attributes. We allow either a string literal or a qualified
# constant (e.g., BlockTags.PartialStack) — but we're only interested in
# string literals for user-facing tags.
RE_TAG_STRING = re.compile(r'\[Tag\("([^"]+)"\)\]')

# Food item nutritional fields (autogen Food/*.cs files):
#   public override float Calories                  => 210;
#   public override Nutrients Nutrition             => new Nutrients() { Carbs = 13, Fat = 0, Protein = 2, Vitamins = 0};
RE_FOOD_CALORIES = re.compile(
    r'public\s+override\s+float\s+Calories\s*=>\s*(\d+(?:\.\d+)?)f?\s*;'
)
RE_FOOD_NUTRITION = re.compile(
    r'new\s+Nutrients\s*\(\s*\)\s*\{\s*'
    r'Carbs\s*=\s*(\d+(?:\.\d+)?)f?\s*,\s*'
    r'Fat\s*=\s*(\d+(?:\.\d+)?)f?\s*,\s*'
    r'Protein\s*=\s*(\d+(?:\.\d+)?)f?\s*,\s*'
    r'Vitamins\s*=\s*(\d+(?:\.\d+)?)f?\s*\}'
)

# Skill class declarations in Tech/*.cs. The MultiplicativeStrategy array
# is indexed by level and holds the labor multiplier at that level (1.0 at
# level 0, lower at higher levels — e.g. Carpentry levels 1..7 give 0.8..0.5).
RE_SKILL_CLASS = re.compile(
    r'public\s+(?:partial\s+)?class\s+(\w+Skill)\s*:\s*Skill\b'
)
RE_MULTI_STRATEGY = re.compile(
    r'new\s+MultiplicativeStrategy\s*\(\s*new\s+float\[\]\s*\{\s*([^}]+?)\s*\}\s*\)',
    re.DOTALL,
)
RE_MAX_LEVEL_RETURN = re.compile(
    r'MaxLevel\s*\{[^}]*?return\s+(\d+)'
)
RE_LOC_DISPLAY_NAME = re.compile(r'\[LocDisplayName\("([^"]+)"\)\]')


def _eval_float_expr(s: str):
    """Evaluate a C# float-literal expression like '1 - 0.2f' as a Python
    float. Strips the 'f' suffix and refuses anything containing letters
    (defensive — autogen files are trusted but eval is eval).
    """
    s = s.replace("f", "").strip()
    if not s or not re.fullmatch(r'[\d\.\-\+\*\/\s\(\)]+', s):
        return None
    try:
        return float(eval(s, {"__builtins__": {}}, {}))
    except Exception:
        return None


# Species type — distinguishes plants (one-swing harvest, yield per kill)
# from trees (whole-tree felling, yield per tree).
RE_SPECIES_CLASS = re.compile(
    r'public\s+partial\s+class\s+(\w+Species)\s*:\s*(\w+Species)\b'
)
# Resource entries inside a `ResourceList = new List<SpeciesResource>() {...}`.
# Each is `new SpeciesResource(typeof(XxxItem), new Range(lo, hi), freq)` —
# freq defaults to 1 when it's the primary drop.
RE_SPECIES_RESOURCE = re.compile(
    r'new\s+SpeciesResource\s*\(\s*'
    r'typeof\((\w+)\)\s*,\s*'
    r'new\s+Range\s*\(\s*([\d\.\-]+)f?\s*,\s*([\d\.\-]+)f?\s*\)\s*'
    r'(?:,\s*([\d\.\-]+)f?\s*)?\)'
)
# Tree felling parameter — `this.TreeHealth = 15f;` in a SetDefaultProperties
# partial method (Organisms/Tree/*.cs). This is the trunk HP the player has
# to chop through to fell the tree.
RE_TREE_HEALTH = re.compile(r'this\.TreeHealth\s*=\s*([\d\.]+)f?')

# Assumed axe damage per swing for the tree-cost model. Iron Axe (Damage =
# 1.5f, tier 2) is the typical mid-tier tool a seller pricing in calorie
# basis is using — Stone Axe (1.0f) and Steel Axe (2.0f) are equally valid
# alternatives. 20 cal/swing is constant across every tier per the source.
# So cal_per_hp = 20 / axe_damage.
ASSUMED_AXE_DAMAGE = 1.5

# Tool damage values are declared two different ways in autogen Tool/*.cs:
#   - CreateDamageValue(1.5f, typeof(LoggingSkill), typeof(IronAxeItem))   -- axes/sickles/shovels
#   - damage = new ConstantValue(2);                                       -- pickaxes
# We try both. Skill type is included where present.
RE_TOOL_DAMAGE_CREATE = re.compile(
    r'CreateDamageValue\(\s*([\d\.]+)f?\s*,\s*typeof\((\w+Skill)\)'
)
RE_TOOL_DAMAGE_CONSTANT = re.compile(
    r'damage\s*=\s*new\s+ConstantValue\(\s*([\d\.]+)f?\s*\)'
)
# Pickaxes burn calories on MiningSkill but their damage is unkeyed; infer
# the skill from `CreateCalorieValue(..., typeof(MiningSkill), ...)`.
RE_TOOL_CAL_SKILL = re.compile(
    r'CreateCalorieValue\(\s*\d+(?:\.\d+)?f?\s*,\s*typeof\((\w+Skill)\)'
)
RE_TOOL_TIER = re.compile(r'\[Tier\((\d+)\)\]')
# Tool kind is derived from the base class — `: AxeItem`, `: PickaxeItem`, etc.
RE_TOOL_BASE_CLASS = re.compile(
    r'public\s+partial\s+class\s+\w+Item\s*:\s*(\w+Item)\b'
)
TOOL_BASE_TO_KIND = {
    "AxeItem": "axe",
    "PickaxeItem": "pickaxe",
    "SickleItem": "sickle",
    "ScytheItem": "scythe",
    "ShovelItem": "shovel",
    "HoeItem": "hoe",
    "MacheteItem": "machete",
    "HammerItem": "hammer",
    "BowItem": "bow",
    "RockDrillItem": "rock_drill",
}

# Block hardness for Minable blocks — `[..., Minable(2), ...]` on a
# `XxxOreBlock` class. Mining cost = hardness × 20 / pickaxe_damage for the
# chosen tier. The bracket-attribute can stack with others (`[Solid, Wall,
# Minable(2)]`), so we match the inner token only.
RE_MINABLE = re.compile(r'\bMinable\((\d+)\)')


def _attribute_block_before(text: str, class_start: int) -> str:
    """Walk backwards from `class_start` over the contiguous attribute stack."""
    # Scan line-by-line backward. Stop at the first line that isn't an
    # attribute, whitespace, or a comment.
    lines = text[:class_start].splitlines()
    collected = []
    for line in reversed(lines):
        stripped = line.strip()
        if not stripped:
            collected.append(line)
            continue
        if stripped.startswith("//"):
            collected.append(line)
            continue
        # Attributes look like [...] possibly with an inline // comment at end.
        # Several attributes can stack on one line: [A][B(1)]
        # This check is loose: must START with '[' and CONTAIN ']'.
        if stripped.startswith("[") and "]" in stripped:
            collected.append(line)
            continue
        # Something else — end of attribute stack.
        break
    return "\n".join(reversed(collected))


def main() -> None:
    item_to_tags: dict[str, set[str]] = defaultdict(set)
    tag_to_items: dict[str, set[str]] = defaultdict(set)
    item_file: dict[str, str] = {}
    # Per-item food data — populated only from Food/*.cs files where the Item
    # class declares Calories + a Nutrients() literal.
    food: dict[str, dict] = {}

    if not ROOT.is_dir():
        raise SystemExit(
            f"Eco autogen source not found at {ROOT}. "
            "Set ECO_AUTOGEN env var to the AutoGen folder path."
        )

    for cat in CATEGORIES:
        cat_dir = ROOT / cat
        if not cat_dir.is_dir():
            continue
        for path in sorted(cat_dir.glob("*.cs")):
            text = path.read_text(encoding="utf-8-sig")
            for m in RE_CLASS_DECL.finditer(text):
                name = m.group(1)
                # Items: things held in inventory / produced by recipes.
                # Standard items end in "Item"; skill books and scrolls end
                # in "SkillBook" or "SkillScroll" and are referenced bare in
                # recipes (e.g. CraftingElement<CarpentrySkillBook>).
                if not (
                    name.endswith("Item")
                    or name.endswith("SkillBook")
                    or name.endswith("SkillScroll")
                ):
                    continue
                attrs = _attribute_block_before(text, m.start())
                tags = {tm.group(1) for tm in RE_TAG_STRING.finditer(attrs)}
                if name not in item_file:
                    item_file[name] = f"{cat}/{path.name}"
                item_to_tags[name].update(tags)
                for t in tags:
                    tag_to_items[t].add(name)

            # Food data is class-level fields on the FoodItem subclass; each
            # Food/*.cs file has exactly one such Item class, so scanning the
            # file body once is sufficient.
            if cat == "Food":
                cal_m = RE_FOOD_CALORIES.search(text)
                nut_m = RE_FOOD_NUTRITION.search(text)
                if cal_m or nut_m:
                    # Pull the file's first *Item class as the owner.
                    owner = None
                    for cm in RE_CLASS_DECL.finditer(text):
                        if cm.group(1).endswith("Item"):
                            owner = cm.group(1)
                            break
                    if owner:
                        food[owner] = {
                            "calories": float(cal_m.group(1)) if cal_m else None,
                            "carbs": float(nut_m.group(1)) if nut_m else None,
                            "fat": float(nut_m.group(2)) if nut_m else None,
                            "protein": float(nut_m.group(3)) if nut_m else None,
                            "vitamins": float(nut_m.group(4)) if nut_m else None,
                        }

    # Plant + tree yields: scan AutoGen/Plant/*.cs for each species'
    # ResourceList. We accumulate (sum of avg yields, count) per produced
    # item across every species that drops it. Trees track an additional
    # `hpSum` so we can derive a felling cost per log (TreeHealth lives in
    # the hand-written Organisms/Tree/*.cs partial, not in autogen).
    plant_yields: dict[str, dict[str, float]] = {}   # itemId -> {sum, count}
    tree_yields: dict[str, dict[str, float]] = {}    # itemId -> {sum, count, hpSum}
    organisms_tree = ROOT.parent / "Organisms" / "Tree"
    plant_dir = ROOT / "Plant"
    if plant_dir.is_dir():
        for path in sorted(plant_dir.glob("*.cs")):
            text = path.read_text(encoding="utf-8-sig")
            species_kind = None
            for sm in RE_SPECIES_CLASS.finditer(text):
                base = sm.group(2)
                if base == "TreeSpecies":
                    species_kind = "tree"
                    break
                if base == "PlantSpecies":
                    species_kind = "plant"
                    break
            if species_kind is None:
                continue
            # For trees, pick up TreeHealth from the matching hand-written
            # file (same filename, in __core__/Organisms/Tree/). Most tree
            # species override the TreeSpecies default of 3.
            tree_health: float | None = None
            if species_kind == "tree":
                hand_path = organisms_tree / path.name
                if hand_path.exists():
                    hand_text = hand_path.read_text(encoding="utf-8-sig")
                    hm = RE_TREE_HEALTH.search(hand_text)
                    if hm:
                        tree_health = float(hm.group(1))
            bucket = tree_yields if species_kind == "tree" else plant_yields
            for rm in RE_SPECIES_RESOURCE.finditer(text):
                item = rm.group(1)
                lo = float(rm.group(2))
                hi = float(rm.group(3))
                freq = float(rm.group(4)) if rm.group(4) else 1.0
                avg = ((lo + hi) / 2.0) * freq
                entry = bucket.setdefault(
                    item, {"sum": 0.0, "count": 0.0, "hpSum": 0.0},
                )
                entry["sum"] += avg
                entry["count"] += 1
                if species_kind == "tree" and tree_health is not None:
                    entry["hpSum"] += tree_health

    # Tool extraction: each tool's tier + damage + governing skill so the
    # resolver can dynamically scale tree-/ore-harvest cost by chosen tier.
    tools: dict[str, dict] = {}
    tool_dir = ROOT / "Tool"
    if tool_dir.is_dir():
        for path in sorted(tool_dir.glob("*.cs")):
            text = path.read_text(encoding="utf-8-sig")
            base_m = RE_TOOL_BASE_CLASS.search(text)
            if not base_m:
                continue
            kind = TOOL_BASE_TO_KIND.get(base_m.group(1))
            if kind is None:
                continue
            # Damage + skill — try both declaration patterns.
            dmg_m = RE_TOOL_DAMAGE_CREATE.search(text)
            if dmg_m:
                damage = float(dmg_m.group(1))
                skill = dmg_m.group(2)
            else:
                dmg_m = RE_TOOL_DAMAGE_CONSTANT.search(text)
                if not dmg_m:
                    continue
                damage = float(dmg_m.group(1))
                # Skill not on damage line — pull from the calorie burn line.
                cal_skill_m = RE_TOOL_CAL_SKILL.search(text)
                skill = cal_skill_m.group(1) if cal_skill_m else None
            if not skill:
                continue
            tier_m = RE_TOOL_TIER.search(text)
            tier = int(tier_m.group(1)) if tier_m else 1
            display_m = re.search(r'\[LocDisplayName\("([^"]+)"\)\]', text)
            display = display_m.group(1) if display_m else path.stem
            # Tool id = the class name immediately after `class` in the item
            # class declaration. Path stem usually matches the class root.
            cls_m = re.search(
                r'public\s+partial\s+class\s+(\w+Item)\s*:\s*\w+Item\b', text,
            )
            tool_id = cls_m.group(1) if cls_m else f"{path.stem}Item"
            tools[tool_id] = {
                "displayName": display,
                "kind": kind,
                "skill": skill,
                "tier": tier,
                "damage": damage,
            }

    # Ore blocks: pick up `[Minable(N)]` from each block file. The Item class
    # in the same file is what the player ends up with; tag those items with
    # their hardness and the governing MiningSkill.
    ore_hardness: dict[str, int] = {}
    block_dir = ROOT / "Block"
    if block_dir.is_dir():
        for path in sorted(block_dir.glob("*.cs")):
            text = path.read_text(encoding="utf-8-sig")
            hm = RE_MINABLE.search(text)
            if not hm:
                continue
            hardness = int(hm.group(1))
            # Companion *Item class in the same file.
            for cm in re.finditer(r'public\s+partial\s+class\s+(\w+Item)\b', text):
                ore_hardness[cm.group(1)] = hardness
                break

    # Raw-harvest table — the resolver computes per-unit cost from this at
    # runtime using the seller's chosen tool tier.
    #   { kind: "tree", hp, yield, skill }       — trees, felling cost
    #   { kind: "ore",  hp, yield: 1, skill }    — mined blocks
    # Plant items don't end up here; their cost (20/yield) doesn't scale with
    # tool tier (one cut kills the plant regardless of sickle quality), so we
    # keep them in the baked `defaultRawCosts`.
    raw_harvest: dict[str, dict] = {}
    for item, agg in tree_yields.items():
        if agg["count"] == 0 or agg["sum"] == 0 or agg["hpSum"] == 0:
            continue
        raw_harvest[item] = {
            "kind": "tree",
            "hp": round(agg["hpSum"] / agg["count"], 3),
            "yield": round(agg["sum"] / agg["count"], 3),
            "skill": "LoggingSkill",
        }
    for item, hardness in ore_hardness.items():
        raw_harvest[item] = {
            "kind": "ore",
            "hp": hardness,
            "yield": 1,
            "skill": "MiningSkill",
        }

    # Plant defaults are static — yield divides into the per-swing 20 cal,
    # tool tier doesn't enter into it.
    default_raw_costs: dict[str, float] = {}
    for item, agg in plant_yields.items():
        if agg["count"] == 0:
            continue
        avg = agg["sum"] / agg["count"]
        if avg > 0:
            default_raw_costs[item] = round(20.0 / avg, 4)

    # Second pass: extract skill multiplier tables from Tech/*.cs. Each
    # specialty Skill class declares a MultiplicativeStrategy array of
    # labor-cost factors indexed by level — what we surface in the UI as a
    # per-skill slider.
    skills: dict[str, dict] = {}
    tech_dir = ROOT / "Tech"
    if tech_dir.is_dir():
        for path in sorted(tech_dir.glob("*.cs")):
            text = path.read_text(encoding="utf-8-sig")
            cls_m = RE_SKILL_CLASS.search(text)
            if not cls_m:
                continue
            skill_id = cls_m.group(1)
            attrs = _attribute_block_before(text, cls_m.start())
            name_m = RE_LOC_DISPLAY_NAME.search(attrs)
            display = name_m.group(1) if name_m else skill_id
            multi_m = RE_MULTI_STRATEGY.search(text, cls_m.end())
            if not multi_m:
                continue
            parts = [p.strip() for p in multi_m.group(1).split(",") if p.strip()]
            multipliers = [_eval_float_expr(p) for p in parts]
            if any(m is None for m in multipliers):
                # Couldn't parse one of the entries — skip this skill so we
                # don't ship partial data the UI can't trust.
                continue
            max_m = RE_MAX_LEVEL_RETURN.search(text, cls_m.end())
            max_level = int(max_m.group(1)) if max_m else len(multipliers) - 1
            skills[skill_id] = {
                "displayName": display,
                "multipliers": multipliers,
                "maxLevel": max_level,
            }

    # Convert sets to sorted lists for JSON
    out = {
        "tagToItems": {t: sorted(v) for t, v in sorted(tag_to_items.items())},
        "itemToTags": {i: sorted(v) for i, v in sorted(item_to_tags.items())},
        "itemFile": dict(sorted(item_file.items())),
        "food": dict(sorted(food.items())),
        "skills": dict(sorted(skills.items())),
        "tools": dict(sorted(tools.items())),
        "rawHarvest": dict(sorted(raw_harvest.items())),
        "defaultRawCosts": dict(sorted(default_raw_costs.items())),
        # Auxiliary info on how each yield was computed — useful for the
        # UI to surface "this default comes from N plant species averaging
        # X yield per harvest" without re-deriving the math client-side.
        "plantYields": {
            item: {
                "avgYield": round(agg["sum"] / agg["count"], 3),
                "sources": int(agg["count"]),
            }
            for item, agg in sorted(plant_yields.items())
            if agg["count"] > 0
        },
        "treeYields": {
            item: {
                "avgYield": round(agg["sum"] / agg["count"], 3),
                "sources": int(agg["count"]),
            }
            for item, agg in sorted(tree_yields.items())
            if agg["count"] > 0
        },
    }
    here = Path(__file__).parent
    (here / "tags.json").write_text(json.dumps(out, indent=2))

    print(f"Items found: {len(item_file)}")
    print(f"Distinct tags: {len(tag_to_items)}")
    print(f"Food items with nutrition: {len(food)}")
    print(f"Skills with multiplier tables: {len(skills)}")
    plant_count = len([i for i in plant_yields if i in default_raw_costs])
    tree_count = len([i for i in raw_harvest.values() if i["kind"] == "tree"])
    ore_count = len([i for i in raw_harvest.values() if i["kind"] == "ore"])
    print(f"Plant yields baked: {plant_count} items (1 cut / yield)")
    print(f"Tree harvest entries: {tree_count} items (TreeHealth + yield, tier-scaled)")
    print(f"Ore harvest entries: {ore_count} items (Minable hardness, tier-scaled)")
    print(f"Tool tiers indexed: {len(tools)} items")
    print()

    # Report coverage of the recipe-ingredient tags we care about.
    recipe_tags = [
        'CrushedRock', 'Fat', 'Fruit', 'Hardwood', 'HewnLog', 'LargeFish',
        'MediumCarcass', 'MediumFish', 'MediumLeatherCarcass',
        'MediumWoolyCarcass', 'MortaredStone', 'NaturalFiber', 'Oil',
        'Petals', 'Silica', 'SmallCarcass', 'SmallFish', 'Softwood',
        'TinyCarcass', 'TinyFurCarcass', 'TinyLeatherCarcass', 'Tool',
        'Wood', 'WoodBoard',
    ]
    print("Recipe ingredient tags -> items:")
    for t in recipe_tags:
        items = sorted(tag_to_items.get(t, []))
        shown = items[:6]
        ell = "..." if len(items) > 6 else ""
        print(f"  {t:24s} ({len(items):2d}) : {shown}{ell}")


if __name__ == "__main__":
    main()
