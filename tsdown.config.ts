import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: "esm",
  dts: false,
  clean: true,
  target: "node24",
  platform: "node",
  fixedExtension: false,
});
