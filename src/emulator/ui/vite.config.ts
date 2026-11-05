import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const EMULATOR_ORIGIN = "http://127.0.0.1:4600";

/** Builds the emulator host UI into `dist/ui`, which the emulator serves at `/`. */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("../../../dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4601,
    strictPort: true,
    proxy: {
      "/__emulator": { target: EMULATOR_ORIGIN, changeOrigin: true },
      "/api": { target: EMULATOR_ORIGIN, changeOrigin: true },
    },
  },
});
