import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dir, "dist");
const entryPath = join(import.meta.dir, "src/main.tsx");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [entryPath],
  outdir: distDir,
  target: "browser",
  format: "iife",
  minify: false,
  sourcemap: "none"
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

function fingerprintFile(filename: string): string {
  const sourcePath = join(distDir, filename);
  const bytes = readFileSync(sourcePath);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const parts = filename.split(".");
  const ext = parts.pop();
  const base = parts.join(".");
  const hashedName = `${base}.${hash}.${ext}`;
  renameSync(sourcePath, join(distDir, hashedName));
  return hashedName;
}

const cssFile = fingerprintFile("main.css");
const jsFile = fingerprintFile("main.js");

writeFileSync(
  join(distDir, "index.html"),
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pet Events</title>
<link rel="stylesheet" href="/app/${cssFile}">
</head>
<body>
<div id="app"></div>
<script src="/app/${jsFile}"></script>
</body>
</html>`
);
