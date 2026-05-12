"""Combine recipes.json + tags.json into the compact eco-data.json the app loads."""
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
APP_ROOT = HERE.parent

def humanize(item_id: str) -> str:
    s = item_id
    if s.endswith("Item"):
        s = s[:-4]
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    return s

def main():
    recipes_json = HERE / "recipes.json"
    tags_json = HERE / "tags.json"
    if not recipes_json.exists() or not tags_json.exists():
        raise SystemExit(
            "Run parse_recipes.py and build_tags.py first to produce "
            "recipes.json and tags.json in the scripts/ folder."
        )

    d = json.loads(recipes_json.read_text())
    t = json.loads(tags_json.read_text())

    compact_recipes = [
        {
            "id": r["id"],
            "name": r["displayName"],
            "labor": r["laborCalories"],
            "ingredients": r["ingredients"],
            "outputs": r["outputs"],
            "skill": r["skill"],
            "skillLevel": r["skillLevel"],
            # The skill that governs labor-cost reduction for this recipe.
            # Usually matches `skill` but not always — recipes set this via
            # CreateLaborInCaloriesValue(N, typeof(XSkill)). May be None if
            # no skill modifies labor.
            "laborSkill": r.get("laborSkill"),
            "table": r["table"],
        }
        for r in d["recipes"]
    ]

    all_items = set()
    for r in d["recipes"]:
        for o in r["outputs"]:
            all_items.add(o["item"])
        for i in r["ingredients"]:
            if i["kind"] == "type":
                all_items.add(i["ref"])
    for members in t["tagToItems"].values():
        all_items.update(members)

    items = {i: humanize(i) for i in sorted(all_items)}

    # Talents (optional) — parse_talents.py emits a sibling talents.json.
    talents_json = HERE / "talents.json"
    talents = (
        json.loads(talents_json.read_text()) if talents_json.exists() else {}
    )

    bundle = {
        "recipes": compact_recipes,
        "producers": d["producers"],
        "tagToItems": t["tagToItems"],
        "itemToTags": t.get("itemToTags", {}),
        "items": items,
        "food": t.get("food", {}),
        "skills": t.get("skills", {}),
        "talents": talents,
        # Per-item default cal/unit derived from plant ResourceList yields:
        # baseline 20 cal/swing divided by avg yield per harvest action.
        # Trees and ores are NOT in this map — their cost is computed by the
        # resolver at runtime from rawHarvest + toolTiers (since tool tier
        # changes the swing count).
        "defaultRawCosts": t.get("defaultRawCosts", {}),
        # Per-item harvest model: { kind: "tree"|"ore", hp, yield, skill }.
        # Resolver scales 20 cal/swing × ceil(hp/damage) × yield by the
        # tool currently selected for the governing skill.
        "rawHarvest": t.get("rawHarvest", {}),
        # Available tools per gathering skill — what fills the tool-tier
        # dropdown next to the skill slider.
        "tools": t.get("tools", {}),
        # Diagnostic — used by the UI to caption raw cards.
        "plantYields": t.get("plantYields", {}),
        "treeYields": t.get("treeYields", {}),
    }
    out = APP_ROOT / "public" / "eco-data.json"
    out.write_text(json.dumps(bundle))
    print(f"Wrote {out} ({out.stat().st_size:,} bytes)")
    print(f"  {len(compact_recipes)} recipes, {len(items)} items, "
          f"{len(t['tagToItems'])} tags")


if __name__ == "__main__":
    main()
