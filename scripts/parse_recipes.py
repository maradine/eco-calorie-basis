"""
Eco recipe parser.

Reads Strange Loop Games' auto-generated RecipeFamily .cs files and emits a
normalized JSON representation suitable for calorie-basis graph resolution.

Output schema:
{
  "recipes": [
    {
      "id": "Boards",                  # name: field from Recipe.Init
      "displayName": "Boards",
      "file": "Boards.cs",
      "skill": "Skill" | "LoggingSkill" | ... ,   # null if no skill
      "skillLevel": 0,                 # from [RequiresSkill(...)] attribute, 0 if none
      "laborCalories": 40,
      "table": "WorkbenchObject",      # table type this recipe is registered on
      "ingredients": [
        {"ref": "Wood", "kind": "tag", "qty": 2},
        {"ref": "WoodPulpItem", "kind": "type", "qty": 5}
      ],
      "outputs": [
        {"item": "BoardItem", "qty": 1}
      ]
    },
    ...
  ],
  "unresolvedTags": ["Wood", "Hardwood", ...]   # tags used as ingredients in this dataset
}
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

# --- Regex toolkit -----------------------------------------------------------

# We work file-by-file. Each file defines exactly one RecipeFamily with exactly
# one Recipe (verified across the 177-file sample). The grammar is rigid
# because these files are auto-generated from RecipeTemplate.tt.

RE_NAME = re.compile(r'name:\s*"([^"]+)"')
RE_DISPLAY = re.compile(r'displayName:\s*Localizer\.DoStr\("([^"]+)"\)')
RE_REQUIRES_SKILL = re.compile(
    r'\[RequiresSkill\(typeof\((\w+)\)\s*,\s*(\d+)\)\]'
)
RE_LABOR = re.compile(
    r'CreateLaborInCaloriesValue\(\s*(\d+)(?:\s*,\s*typeof\((\w+)\))?\s*\)'
)
RE_TABLE = re.compile(r'tableType:\s*typeof\((\w+)\)')

# Ingredient forms observed in the sample:
#   new IngredientElement("Wood", 2, typeof(LoggingSkill))
#   new IngredientElement("Wood", 2, typeof(Skill))
#   new IngredientElement("Tool", 1, true)             <- static ingredient flag
#   new IngredientElement(typeof(WoodPulpItem), 5, typeof(MasonrySkill))
#   new IngredientElement(typeof(BisonCarcassItem), 1, true)
# Quantities in this sample are all integers; we accept decimals defensively.
RE_INGREDIENT = re.compile(
    r'new\s+IngredientElement\(\s*'
    r'(?:"(?P<tag>[^"]+)"|typeof\((?P<type>\w+)\))\s*,\s*'
    r'(?P<qty>\d+(?:\.\d+)?f?)\s*,\s*'
    # Third arg: skill typeof, a bool, or (rare) a skill followed by a 4th
    # talent argument. We don't care about the talent for calorie-basis work.
    r'(?:typeof\(\w+\)(?:\s*,\s*typeof\(\w+\))?|true|false)\s*\)'
)

# Outputs:
#   new CraftingElement<BoardItem>(1)
#   new CraftingElement<BoardItem>(0.1f)       <- fractional byproducts
#   new CraftingElement<BoardItem>()           <- defaults to 1
RE_OUTPUT = re.compile(
    r'new\s+CraftingElement<(?P<item>\w+)>\(\s*(?P<qty>\d+(?:\.\d+)?f?)?\s*\)'
)

# Tag product variant: inherits from a parent recipe, shares its labor cost.
#   CraftingComponent.AddTagProduct(tableType, typeof(ParentRecipe), this);
RE_TAG_PRODUCT = re.compile(
    r'CraftingComponent\.AddTagProduct\(\s*'
    r'(?:tableType:\s*)?typeof\(\w+\)\s*,\s*'
    r'typeof\((?P<parent>\w+)\)\s*,\s*this'
)


# Class declaration to distinguish standalone recipes (: RecipeFamily)
# from tag-product variants (: Recipe). Only the former have their own labor.
RE_CLASS = re.compile(
    r'public\s+partial\s+class\s+(?P<cls>\w+Recipe)\s*:\s*(?P<base>Recipe(?:Family)?)\b'
)


def _num(s: str | None) -> int | float | None:
    """Parse an Eco numeric literal, handling the trailing 'f'."""
    if s is None:
        return None
    s = s.rstrip("f")
    return float(s) if "." in s else int(s)


def parse_file(path: Path) -> dict[str, Any] | None:
    text = path.read_text(encoding="utf-8-sig")  # strip BOM

    name_m = RE_NAME.search(text)
    if not name_m:
        return None
    display_m = RE_DISPLAY.search(text)
    labor_m = RE_LABOR.search(text)
    table_m = RE_TABLE.search(text)
    skill_m = RE_REQUIRES_SKILL.search(text)
    class_m = RE_CLASS.search(text)
    tag_product_m = RE_TAG_PRODUCT.search(text)

    ingredients = [
        {
            "ref": m.group("type") or m.group("tag"),
            "kind": "type" if m.group("type") else "tag",
            "qty": _num(m.group("qty")),
        }
        for m in RE_INGREDIENT.finditer(text)
    ]

    outputs = [
        {"item": m.group("item"), "qty": _num(m.group("qty")) or 1}
        for m in RE_OUTPUT.finditer(text)
    ]

    return {
        "id": name_m.group(1),
        "displayName": display_m.group(1) if display_m else name_m.group(1),
        "file": path.name,
        "baseClass": class_m.group("base") if class_m else None,
        "className": class_m.group("cls") if class_m else None,
        # Tag-product variants share labor with a parent; we'll resolve in a
        # second pass.
        "tagProductParent": tag_product_m.group("parent") if tag_product_m else None,
        "skill": skill_m.group(1) if skill_m else None,
        "skillLevel": int(skill_m.group(2)) if skill_m else 0,
        "laborCalories": int(labor_m.group(1)) if labor_m else None,
        "laborSkill": labor_m.group(2) if labor_m and labor_m.group(2) else None,
        "table": table_m.group(1) if table_m else None,
        "ingredients": ingredients,
        "outputs": outputs,
    }


CATEGORIES = [
    "Recipe", "Item", "Block", "Food", "Tool", "Clothing", "Vehicle",
    "WorldObject", "Fertilizer", "Seed",
    # Tech holds each profession's skill book + scroll + book-recipe.
    "Tech",
]

# Eco autogen source root. Override with ECO_AUTOGEN env var; default points
# at the typical Steam install on Windows.
import os
DEFAULT_ROOT = Path(
    r"C:\Program Files (x86)\Steam\steamapps\common\Eco"
    r"\Eco_Data\Server\Mods\__core__\AutoGen"
)


def main() -> None:
    root = Path(os.environ.get("ECO_AUTOGEN", str(DEFAULT_ROOT)))
    if not root.is_dir():
        raise SystemExit(
            f"Eco autogen source not found at {root}. "
            "Set ECO_AUTOGEN env var to the AutoGen folder path."
        )
    recipes: list[dict[str, Any]] = []
    problems: list[str] = []

    for cat in CATEGORIES:
        cat_dir = root / cat
        if not cat_dir.is_dir():
            continue
        for path in sorted(cat_dir.glob("*.cs")):
            parsed = parse_file(path)
            if parsed is None:
                # Most files don't define recipes (Item-only, Block-only, etc.) —
                # that's fine, don't log them as problems.
                continue
            # Track the category this recipe was found in.
            parsed["category"] = cat
            recipes.append(parsed)

    # Second pass: tag-product variants inherit labor from their parent recipe
    # family. We match by className.
    by_class = {r["className"]: r for r in recipes if r["className"]}
    for r in recipes:
        parent_class = r.get("tagProductParent")
        if parent_class and r["laborCalories"] is None:
            parent = by_class.get(parent_class)
            if parent and parent["laborCalories"] is not None:
                r["laborCalories"] = parent["laborCalories"]
                r["laborInheritedFrom"] = parent["id"]
            else:
                problems.append(
                    f"{r['file']}: tag-product parent {parent_class} "
                    "not found or lacks labor"
                )

    # Now flag real anomalies (after inheritance resolution).
    for r in recipes:
        if r["laborCalories"] is None:
            problems.append(f"{r['file']}: no LaborInCalories and no parent labor")
        if not r["outputs"]:
            problems.append(f"{r['file']}: no CraftingElement outputs found")
        if not r["ingredients"]:
            problems.append(f"{r['file']}: no ingredients found (harvest-like?)")

    tags = sorted({
        ing["ref"] for r in recipes for ing in r["ingredients"] if ing["kind"] == "tag"
    })

    # Build an item -> producing-recipes index, so the web app can answer
    # "what recipes produce BoardItem?" without re-scanning.
    producers: dict[str, list[str]] = {}
    for r in recipes:
        for out in r["outputs"]:
            producers.setdefault(out["item"], []).append(r["id"])

    out = {
        "recipes": recipes,
        "unresolvedTags": tags,
        "producers": producers,
    }

    here = Path(__file__).parent
    (here / "recipes.json").write_text(json.dumps(out, indent=2))

    print(f"Parsed {len(recipes)} recipes")
    print(f"Unique tags used as ingredients: {len(tags)}")
    print(f"Unique output items: {len(producers)}")
    print(f"Problems: {len(problems)}")
    for p in problems[:20]:
        print(f"  - {p}")


if __name__ == "__main__":
    main()
