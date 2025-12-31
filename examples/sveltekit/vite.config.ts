import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    alias: {
      $convex: path.resolve("./src/convex"),
    },
    dedupe: ["yjs", "lib0", "y-protocols"],
  },
});
