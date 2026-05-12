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

    # Convert sets to sorted lists for JSON
    out = {
        "tagToItems": {t: sorted(v) for t, v in sorted(tag_to_items.items())},
        "itemToTags": {i: sorted(v) for i, v in sorted(item_to_tags.items())},
        "itemFile": dict(sorted(item_file.items())),
        "food": dict(sorted(food.items())),
    }
    here = Path(__file__).parent
    (here / "tags.json").write_text(json.dumps(out, indent=2))

    print(f"Items found: {len(item_file)}")
    print(f"Distinct tags: {len(tag_to_items)}")
    print(f"Food items with nutrition: {len(food)}")
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
