import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [vue(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3210" },
  },
  build: { outDir: "../../../dist/dashboard/web", emptyOutDir: true },
});
