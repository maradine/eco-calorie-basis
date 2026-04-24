// Node smoke test — verifies the resolver produces correct numbers under
// the new semantics: alphabetical defaults for ambiguity, sticky overrides.
import { readFileSync } from "node:fs";
import { Resolver, findAmbiguities, flattenRawInputs } from "./resolver";
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
  // Default = Board: 25 labor + 1 wood (20 raw) = 45 cal.
  const board = r.resolveItem("BoardItem", 1);
  check("Board (default=Board recipe)", Math.round(board.totalCalories), 45);

  // Dowel: one producer; 40 labor + 2 wood / 16 outputs = 5.
  const dowel = r.resolveItem("DowelItem", 1);
  check("Dowel", Math.round(dowel.totalCalories), 5);

  // HewnLog: 20 + 2*5 + 2*20 = 70.
  const hewn = r.resolveItem("HewnLogItem", 1);
  check("HewnLog", Math.round(hewn.totalCalories), 70);

  // HewnDresser with defaults:
  //   60 labor
  // + 18 HewnLog (tag=HewnLog; alpha = HardwoodHewnLogItem, same cost 70 = 1260)
  // + 6 WoodBoard (tag=WoodBoard; alpha = BoardItem = 45 = 270)
  // = 60 + 1260 + 270 = 1590
  const dresser = r.resolveItem("HewnDresserItem", 1);
  check("HewnDresser", Math.round(dresser.totalCalories), 1590);
}

console.log("\n=== Sticky override: pin BoardItem recipe to SawBoards ===");
{
  const r = new Resolver(data, {
    choices: { "item:BoardItem": "SawBoards" },
  });
  const board = r.resolveItem("BoardItem", 1);
  // SawBoards: 20 labor + 2 wood (40) = 60 / 3 outputs = 20 cal/board
  check("Board via SawBoards", Math.round(board.totalCalories), 20);
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
  check("5× HewnDresser = 5 * 1590", Math.round(five.totalCalories), 7950);
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
