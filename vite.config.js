import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// GitHub Pages のサブパス（/<リポジトリ名>/）でも、そのまま動くように相対パスにする。
export default defineConfig({
  base: "./",
  plugins: [svelte()],
  server: {
    host: "0.0.0.0",
    port: 5190,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
