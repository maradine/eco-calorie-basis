import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative base so the app works both at / and under a project subpath
  // (e.g., GitHub Pages at /eco-calorie-basis/).
  base: "./",
});
