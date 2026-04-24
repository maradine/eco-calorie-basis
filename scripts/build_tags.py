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
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path("/home/claude/everything")
CATEGORIES = [
    "Block", "Item", "Food", "Tool", "Clothing", "Fertilizer", "Seed",
    "Animal", "Plant",
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

    for cat in CATEGORIES:
        cat_dir = ROOT / cat
        if not cat_dir.is_dir():
            continue
        for path in sorted(cat_dir.glob("*.cs")):
            text = path.read_text(encoding="utf-8-sig")
            for m in RE_CLASS_DECL.finditer(text):
                name = m.group(1)
                # Only care about Item classes (the things actually produced
                # by recipes / held in inventory). Skip Blocks and Recipes.
                if not name.endswith("Item"):
                    continue
                attrs = _attribute_block_before(text, m.start())
                tags = {tm.group(1) for tm in RE_TAG_STRING.finditer(attrs)}
                if name not in item_file:
                    item_file[name] = f"{cat}/{path.name}"
                item_to_tags[name].update(tags)
                for t in tags:
                    tag_to_items[t].add(name)

    # Convert sets to sorted lists for JSON
    out = {
        "tagToItems": {t: sorted(v) for t, v in sorted(tag_to_items.items())},
        "itemToTags": {i: sorted(v) for i, v in sorted(item_to_tags.items())},
        "itemFile": dict(sorted(item_file.items())),
    }
    Path("/home/claude/eco-calories/tags.json").write_text(json.dumps(out, indent=2))

    print(f"Items found: {len(item_file)}")
    print(f"Distinct tags: {len(tag_to_items)}")
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
