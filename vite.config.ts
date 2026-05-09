import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Stamp the build with a short git SHA + ISO date. Falls back to "dev" when
// git isn't available (shouldn't happen in CI but keeps local odd setups
// from breaking the build).
function resolveBuildId(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    const date = new Date().toISOString().slice(0, 10);
    return `${sha} · ${date}`;
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [react()],
  // Relative base so the app works both at / and under a project subpath
  // (e.g., GitHub Pages at /eco-calorie-basis/).
  base: "./",
  define: {
    __BUILD_ID__: JSON.stringify(resolveBuildId()),
  },
});
