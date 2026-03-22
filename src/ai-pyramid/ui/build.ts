import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dir, "dist");
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "src/main.tsx")],
  outdir: distDir,
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none"
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

writeFileSync(
  join(distDir, "index.html"),
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pet Events</title>
<link rel="stylesheet" href="/app/main.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/app/main.js"></script>
</body>
</html>`
);
