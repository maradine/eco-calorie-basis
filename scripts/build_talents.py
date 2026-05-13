"""
Parse Eco talent definitions into the bundle.

Talent effects live in plain (non-autogen) .cs source in the dedicated server
install at Mods/__core__/Benefits/*.cs. Each `XxxTalent` class adds Bonus
entries in its constructor; we lift those into a JSON shape the calorie-basis
resolver can apply to recipes and raw harvest costs.

What we capture (anything else is intentionally skipped — calorie basis only
cares about whether a recipe costs more or less labor / fewer ingredients,
or a raw item drops more units per swing):

  - LaborCost: scales recipe.labor
  - ResourceCost: scales recipe.ingredients[*].qty
  - HarvestYield / Yield: scales effective output (inverse — cheaper per unit)

Each Bonus collapses to:
  { action, kind, value, cap?, lowerIsBetter, skills[], tags[], stations[] }

Talent unlock metadata (which skill owns it, at what level) is pulled from
the *autogen* TalentGroup classes in AutoGen/Benefit/*.cs.

Run with ECO_AUTOGEN set to the Eco server's __core__/AutoGen folder, OR
accept the default Windows-Steam dedicated-server path.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

DEFAULT_AUTOGEN = Path(
    r"C:\Program Files (x86)\Steam\steamapps\common\Eco Server"
    r"\Mods\__core__\AutoGen"
)
AUTOGEN_ROOT = Path(os.environ.get("ECO_AUTOGEN", str(DEFAULT_AUTOGEN)))
BENEFITS_ROOT = AUTOGEN_ROOT.parent / "Benefits"

# Class headers we care about. Every talent in Eco has a base + a specialized
# subclass: the base lives in Benefits/*.cs (carries the constructor that
# adds Bonuses), the subclass lives in AutoGen/Benefit/*.cs (empty, just
# links a TalentGroup to the base). The group references the SUBCLASS, so
# we need to walk inheritance back up to the base to find effects.
RE_TALENT_CLASS_ANY = re.compile(
    r'public\s+partial\s+class\s+(\w+Talent)\s*:\s*(\w+)\b'
)
RE_TALENT_GROUP_CLASS = re.compile(
    r'public\s+partial\s+class\s+(\w+TalentGroup)\s*:\s*TalentGroup\b'
)

# Inside a TalentGroup constructor we want OwningSkill, Level, and the
# Talents array members.
RE_OWNING_SKILL = re.compile(r'OwningSkill\s*=\s*typeof\((\w+)\)')
RE_GROUP_LEVEL = re.compile(r'this\.Level\s*=\s*(\d+)')
RE_TALENTS_ARRAY = re.compile(
    r'Talents\s*=\s*new\s+Type\[\]\s*\{\s*([^}]*?)\s*\}', re.DOTALL,
)

# Inside a Bonus literal (regexes operate on a single Bonus's substring).
RE_ACTION = re.compile(r'Action\s*=\s*BonusAction\.(\w+)')
RE_TYPE_SET = re.compile(
    r'(SkillTypes|CraftStationTypes)\s*=\s*new\s+HashSet<Type>\s*\{\s*([^}]*?)\s*\}',
    re.DOTALL,
)
# Some causes scope to specific recipes via `Recipes = new HashSet<...>`.
# The set element is `typeof(XxxRecipe)`; we strip the `Recipe` suffix to
# match how the resolver keys recipes in eco-data.json.
RE_RECIPE_SET = re.compile(
    r'Recipes\s*=\s*new\s+HashSet<(?:System\.)?Type>\s*\{\s*([^}]*?)\s*\}',
    re.DOTALL,
)
RE_TAG_SET = re.compile(
    r'ItemTags\s*=\s*new\s+HashSet<string>\s*\{\s*([^}]*?)\s*\}', re.DOTALL,
)
RE_BONUS_EFFECT = re.compile(
    r'new\s+BonusEffect(\w+)\s*\{([^}]*)\}', re.DOTALL,
)
RE_FIELD_FLOAT = re.compile(r'(Value|Cap)\s*=\s*([\d\.\-]+)f?')
RE_FIELD_BOOL = re.compile(r'LowerIsBetter\s*=\s*(true|false)')
RE_NAME = re.compile(r'Name\s*=\s*Localizer\.DoStr\("([^"]+)"\)')

# Actions we surface to the resolver. Everything else (Power, CraftTime,
# Durability, Pollution, Unlock, etc.) is dropped — they don't affect the
# per-unit calorie basis we're computing.
RELEVANT_ACTIONS = {"LaborCost", "ResourceCost", "HarvestYield", "Yield"}


def _strip_typeof_set(body: str) -> list[str]:
    """Pull `typeof(X)` names out of a HashSet body."""
    return re.findall(r'typeof\((\w+)\)', body)


def _strip_string_set(body: str) -> list[str]:
    return re.findall(r'"([^"]+)"', body)


def _find_balanced_close(text: str, open_idx: int) -> int:
    """Given the index of an opening `{`, return the index of its matching
    closing `}`. Naive: doesn't handle braces inside strings/comments, but
    Eco's auto- and hand-written code keeps everything well-formed."""
    depth = 0
    i = open_idx
    while i < len(text):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def parse_bonus(body: str) -> dict | None:
    """Extract one Bonus literal's structural fields. Returns None when the
    Bonus doesn't have an action we care about."""
    action_m = RE_ACTION.search(body)
    if not action_m:
        return None
    action = action_m.group(1)
    if action not in RELEVANT_ACTIONS:
        return None

    eff_m = RE_BONUS_EFFECT.search(body)
    if not eff_m:
        return None
    eff_kind = eff_m.group(1)  # Multiplicative / CappedMultiplicative / Additive / ...
    eff_body = eff_m.group(2)

    value, cap = None, None
    for fm in RE_FIELD_FLOAT.finditer(eff_body):
        key = fm.group(1)
        val = float(fm.group(2))
        if key == "Value":
            value = val
        elif key == "Cap":
            cap = val
    if value is None:
        return None
    lib_m = RE_FIELD_BOOL.search(eff_body)
    lower_is_better = lib_m.group(1) == "true" if lib_m else True

    skills, stations = [], []
    for tm in RE_TYPE_SET.finditer(body):
        names = _strip_typeof_set(tm.group(2))
        if tm.group(1) == "SkillTypes":
            skills.extend(names)
        else:
            stations.extend(names)

    tags: list[str] = []
    tm = RE_TAG_SET.search(body)
    if tm:
        tags.extend(_strip_string_set(tm.group(1)))

    recipes: list[str] = []
    rm = RE_RECIPE_SET.search(body)
    if rm:
        # Recipes are referenced as `typeof(XxxRecipe)` here; the bundle keys
        # recipes by their `name:` argument, which is the class name minus
        # the trailing "Recipe". This matches what build_bundle.py emits.
        for cls in _strip_typeof_set(rm.group(1)):
            recipes.append(cls[:-len("Recipe")] if cls.endswith("Recipe") else cls)

    return {
        "action": action,
        "kind": eff_kind,
        "value": value,
        "cap": cap,
        "lowerIsBetter": lower_is_better,
        "skills": skills,
        "tags": tags,
        "stations": stations,
        "recipes": recipes,
    }


def parse_talent_file(text: str) -> dict[str, dict[str, Any]]:
    """Extract every `XxxTalent` class in this file: its parent class and
    any Bonus effects it adds in its constructor. A talent may have no
    effects (autogen subclasses) or non-relevant effects (CraftTime, etc.) —
    both are recorded so we can walk inheritance later.
    """
    talents: dict[str, dict[str, Any]] = {}
    class_matches = list(RE_TALENT_CLASS_ANY.finditer(text))
    for i, m in enumerate(class_matches):
        talent_id = m.group(1)
        parent = m.group(2)
        start = m.start()
        end = class_matches[i + 1].start() if i + 1 < len(class_matches) else len(text)
        block = text[start:end]

        name_m = RE_NAME.search(block)
        display = name_m.group(1) if name_m else None

        # Walk every `Bonuses.Add(new Bonus { ... });` literal.
        effects: list[dict] = []
        cursor = 0
        while True:
            add_idx = block.find("Bonuses.Add(new Bonus", cursor)
            if add_idx < 0:
                break
            brace_open = block.find("{", add_idx)
            if brace_open < 0:
                break
            brace_close = _find_balanced_close(block, brace_open)
            if brace_close < 0:
                break
            bonus_body = block[brace_open : brace_close + 1]
            parsed = parse_bonus(bonus_body)
            if parsed:
                effects.append(parsed)
            cursor = brace_close + 1
        talents[talent_id] = {
            "parent": parent,
            "displayName": display,
            "effects": effects,
        }
    return talents


def resolve_effects(
    talent_id: str, talents: dict[str, dict[str, Any]]
) -> tuple[list[dict], str | None]:
    """Walk the inheritance chain from `talent_id` up to find the first
    ancestor that contributes Bonus effects. Returns (effects, displayName).
    """
    cur = talent_id
    display: str | None = None
    while cur and cur in talents:
        info = talents[cur]
        if not display and info.get("displayName"):
            display = info["displayName"]
        if info["effects"]:
            return info["effects"], display
        parent = info.get("parent")
        if not parent or parent == "Talent":
            break
        cur = parent
    return [], display


def parse_group_file(text: str) -> dict[str, dict[str, Any]]:
    """Walk every TalentGroup class in this autogen file and capture which
    Talents it owns plus its unlock level + owning skill."""
    groups: dict[str, dict[str, Any]] = {}
    class_matches = list(RE_TALENT_GROUP_CLASS.finditer(text))
    for i, m in enumerate(class_matches):
        group_id = m.group(1)
        start = m.start()
        end = class_matches[i + 1].start() if i + 1 < len(class_matches) else len(text)
        block = text[start:end]
        owning_m = RE_OWNING_SKILL.search(block)
        level_m = RE_GROUP_LEVEL.search(block)
        talents_m = RE_TALENTS_ARRAY.search(block)
        if not (owning_m and level_m and talents_m):
            continue
        owned = _strip_typeof_set(talents_m.group(1))
        groups[group_id] = {
            "owningSkill": owning_m.group(1),
            "level": int(level_m.group(1)),
            "talents": owned,
        }
    return groups


def main() -> None:
    if not BENEFITS_ROOT.is_dir():
        raise SystemExit(
            f"Benefits source not found at {BENEFITS_ROOT}. "
            "Set ECO_AUTOGEN to the dedicated server's AutoGen folder; "
            "this script reads talents from its sibling Benefits/ dir."
        )
    if not AUTOGEN_ROOT.is_dir():
        raise SystemExit(f"Autogen source not found at {AUTOGEN_ROOT}.")

    # Pass 1: every talent class (base + specialized), captured from both
    # the hand-written Benefits/ source and the AutoGen/Benefit/ source.
    # Eco uses C# partial classes so the same talent can appear declared in
    # multiple files — autogen typically holds a metadata-only partial and
    # Benefits/ holds the constructor with the Bonuses. We merge effects
    # rather than overwriting.
    talents: dict[str, dict[str, Any]] = {}

    def _ingest(text: str) -> None:
        for tid, info in parse_talent_file(text).items():
            existing = talents.setdefault(
                tid, {"parent": info["parent"], "displayName": None, "effects": []}
            )
            existing["effects"].extend(info["effects"])
            if info["displayName"]:
                existing["displayName"] = info["displayName"]
            # Prefer a non-`Talent` parent if we see one — that's the
            # specialization edge we need for inheritance walking.
            if existing["parent"] == "Talent" and info["parent"] != "Talent":
                existing["parent"] = info["parent"]

    for path in sorted(BENEFITS_ROOT.glob("*.cs")):
        _ingest(path.read_text(encoding="utf-8-sig"))
    autogen_benefit = AUTOGEN_ROOT / "Benefit"
    if autogen_benefit.is_dir():
        for path in sorted(autogen_benefit.glob("*.cs")):
            _ingest(path.read_text(encoding="utf-8-sig"))

    # Pass 2: every TalentGroup's unlock info (always in autogen).
    groups: dict[str, dict[str, Any]] = {}
    if autogen_benefit.is_dir():
        for path in sorted(autogen_benefit.glob("*.cs")):
            text = path.read_text(encoding="utf-8-sig")
            groups.update(parse_group_file(text))

    # Build the final talent set: keyed by the specialized talent class that
    # a TalentGroup references, with effects pulled from the inheritance
    # chain (so we land on the base class that actually carries Bonuses).
    final: dict[str, dict[str, Any]] = {}
    for gid, g in groups.items():
        for tid in g["talents"]:
            effects, display = resolve_effects(tid, talents)
            if not effects:
                # Talents with no labor/resource/yield bonuses are real but
                # outside our model (pollution, craft time, etc.). Skip
                # silently — surfacing them would imply we model them.
                continue
            has_levels = any(e["kind"] != "Multiplicative" for e in effects)
            final[tid] = {
                "displayName": display or tid,
                "ownerSkill": g["owningSkill"],
                "skillLevelRequired": g["level"],
                "hasLevels": has_levels,
                # Eco's talent investment caps at 5 levels in the standard
                # talent tier system; we don't introspect this further.
                "maxLevel": 5 if has_levels else 1,
                "effects": effects,
            }

    out = dict(sorted(final.items()))
    here = Path(__file__).parent
    (here / "talents.json").write_text(json.dumps(out, indent=2))

    print(f"Parsed {len(out)} talents with cost-affecting bonuses")
    actions = {}
    for info in out.values():
        for e in info["effects"]:
            actions[e["action"]] = actions.get(e["action"], 0) + 1
    for a, n in sorted(actions.items()):
        print(f"  {a:14s} : {n}")


if __name__ == "__main__":
    main()
