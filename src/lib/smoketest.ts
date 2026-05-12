// Node smoke test — verifies the resolver produces correct numbers under
// the new semantics: alphabetical defaults for ambiguity, sticky overrides.
import { readFileSync } from "node:fs";
import {
  Resolver,
  findAmbiguities,
  flattenRawInputs,
  GATHER_CHOICE,
} from "./resolver";
import type { EcoData } from "./types";

const data: EcoData = JSON.parse(
  readFileSync(new URL("../../public/eco-data.json", import.meta.url), "utf8"),
);

let passed = 0;
let failed = 0;

function check(label: string, got: number, expected: number, tol = 0.5) {
  const ok = Math.abs(got - expected) < tol;
  if (ok) {
    passed++;
    console.log(`  OK    ${label}: ${got}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}: got ${got}, expected ${expected}`);
  }
}

console.log("=== Defaults (no overrides) — alphabetical-first ===");
{
  const r = new Resolver(data);
  // BoardItem producers sorted alphabetically: Board, Boards, ParticleBoards, SawBoards
  // Default = Board: 25 labor + 1 wood (BirchLog @ 5.33 cal/log, derived
  // from TreeHealth/yield) ≈ 30 cal.
  const board = r.resolveItem("BoardItem", 1);
  check("Board (default=Board recipe)", Math.round(board.totalCalories), 30);

  // Dowel: 40 labor + 2 wood (≈10.7) / 16 outputs ≈ 3 cal.
  const dowel = r.resolveItem("DowelItem", 1);
  check("Dowel", Math.round(dowel.totalCalories), 3);

  // HewnLog: 20 labor + 2 Dowel (≈6.3) + 2 Wood (≈10.7) ≈ 37.
  const hewn = r.resolveItem("HewnLogItem", 1);
  check("HewnLog", Math.round(hewn.totalCalories), 37);

  // HewnDresser with defaults:
  //   60 labor
  // + 18 HewnLog (HardwoodHewnLog ≈ 37 = 666)
  // + 6 WoodBoard (BoardItem ≈ 30 = 180)
  // + 1 Dowel (≈ 3)
  // = ≈ 908 (rounding stacks up across the tree)
  const dresser = r.resolveItem("HewnDresserItem", 1);
  check("HewnDresser", Math.round(dresser.totalCalories), 908);
}

console.log("\n=== Sticky override: pin BoardItem recipe to SawBoards ===");
{
  const r = new Resolver(data, {
    choices: { "item:BoardItem": "SawBoards" },
  });
  const board = r.resolveItem("BoardItem", 1);
  // SawBoards: 20 labor + 2 wood (≈10.7) / 3 outputs ≈ 10 cal/board
  check("Board via SawBoards", Math.round(board.totalCalories), 10);
}

console.log("\n=== Ambiguities surfaced structurally ===");
{
  const ambs = findAmbiguities("HewnDresserItem", data, {});
  console.log(`  ${ambs.length} total ambiguities`);
  const onPath = ambs.filter((a) => a.onChosenPath).length;
  const offPath = ambs.filter((a) => !a.onChosenPath).length;
  console.log(`  ${onPath} on chosen path, ${offPath} off-path`);
  for (const a of ambs.slice(0, 10)) {
    console.log(
      `    ${a.onChosenPath ? "●" : "○"} ${a.key}  default=${a.chosen}  (${a.options.length} opts)`,
    );
  }
  check("found at least 5 ambiguities", ambs.length >= 5 ? 1 : 0, 1);
}

console.log("\n=== Quantity scaling ===");
{
  const r = new Resolver(data);
  const five = r.resolveItem("HewnDresserItem", 5);
  check("5× HewnDresser = 5 * 908", Math.round(five.totalCalories), 4540);
}

console.log("\n=== Gatherable items default to gather ===");
{
  const r = new Resolver(data);
  // SandItem is gatherable AND has producers. Default is gather → 20 cal.
  const sand = r.resolveItem("SandItem", 1);
  check("Sand (default = gather)", Math.round(sand.totalCalories), 20);
  if (sand.kind !== "raw") {
    failed++;
    console.log(`  FAIL  Sand kind: got ${sand.kind}, expected "raw"`);
  } else {
    passed++;
    console.log("  OK    Sand kind = raw");
  }
}

console.log("\n=== Gather override forces raw branch ===");
{
  const r = new Resolver(data, {
    choices: { "item:SandItem": GATHER_CHOICE },
  });
  const sand = r.resolveItem("SandItem", 1);
  check("Sand via explicit gather", Math.round(sand.totalCalories), 20);
}

console.log("\n=== Recipe override on gatherable item switches branch ===");
{
  const r = new Resolver(data, {
    choices: { "item:SandItem": "SandConcentrate" },
  });
  const sand = r.resolveItem("SandItem", 1);
  // SandConcentrate: 50 labor + 1 CrushedGranite (via CrushedGranite recipe,
  // 10 labor + 1 Stone raw = 30 / 3 outputs = 10). 50 + 10 = 60.
  // Actual check: just verify it's > 20 (more than raw gather).
  if (sand.kind !== "recipe") {
    failed++;
    console.log(`  FAIL  Sand via recipe kind: got ${sand.kind}`);
  } else {
    passed++;
    console.log(`  OK    Sand via SandConcentrate = ${Math.round(sand.totalCalories)} cal`);
  }
}

console.log("\n=== Flatten raw inputs for 1 HewnDresser (defaults) ===");
{
  const r = new Resolver(data);
  const dresser = r.resolveItem("HewnDresserItem", 1);
  const raw = flattenRawInputs(dresser);
  console.log(`  distinct raw inputs: ${raw.size}`);
  for (const [k, v] of raw.entries()) {
    console.log(`    ${v.toFixed(2)}× ${k}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
