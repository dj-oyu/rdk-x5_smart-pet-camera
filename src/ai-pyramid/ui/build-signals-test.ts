import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dir, "dist-signals-test");
const entryPath = join(import.meta.dir, "src/signals-test.tsx");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [entryPath],
  outdir: distDir,
  target: "browser",
  format: "iife",
  minify: false,
  sourcemap: "inline",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Built: ${result.outputs.map(o => o.path).join(", ")}`);
