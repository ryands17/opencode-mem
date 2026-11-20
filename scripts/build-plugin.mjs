#!/usr/bin/env bun
// WARNING: dist must mirror the src tree -- the package exports map, tests, and import.meta-based path resolution all depend on it; --dts is a silent no-op on Bun versions without declaration emit.
import { rmSync } from "node:fs";
import { Glob } from "bun";

const files = [...new Glob("**/*.ts").scanSync({ cwd: "src" })].filter(
  (file) => !file.endsWith(".d.ts")
);
if (files.length === 0) {
  console.error("No TypeScript sources found under src/");
  process.exit(1);
}

rmSync("dist", { recursive: true, force: true });

const result = Bun.spawnSync({
  cmd: [
    process.execPath,
    "build",
    "--no-bundle",
    "--target=bun",
    "--dts",
    "--outdir",
    "../dist",
    ...files,
  ],
  cwd: "src",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(result.exitCode ?? 1);
