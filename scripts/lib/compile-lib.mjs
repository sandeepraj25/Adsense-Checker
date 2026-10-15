// Compiles lib/ to CommonJS in a temporary directory and returns a require
// rooted there, the same way scripts/verify.mjs does, so tests exercise the
// real modules without a Next build.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const PACKAGES = ["libphonenumber-js", "sharp", "nodemailer", "next", "cheerio"];

export function compileLib(projectRoot, prefix = "aec-lib-") {
  const workDir = mkdtempSync(path.join(tmpdir(), prefix));
  const outDir = path.join(workDir, "build");
  const tsconfig = path.join(workDir, "tsconfig.json");
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: {
      target: "es2022", module: "commonjs", moduleResolution: "node", esModuleInterop: true, skipLibCheck: true, strict: true,
      outDir, rootDir: projectRoot, baseUrl: projectRoot, paths: { "@/*": ["./*"] }, types: ["node"],
      typeRoots: [path.join(projectRoot, "node_modules", "@types")],
    },
    include: [path.join(projectRoot, "lib/**/*.ts")],
  }));
  execFileSync(path.join(projectRoot, "node_modules", ".bin", "tsc"), ["-p", tsconfig], { stdio: "inherit" });
  const nodeModules = path.join(outDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(outDir, path.join(nodeModules, "@"), "dir");
  for (const pkg of PACKAGES) {
    try { symlinkSync(path.join(projectRoot, "node_modules", pkg), path.join(nodeModules, pkg), "dir"); } catch { /* optional */ }
  }
  return {
    workDir,
    require: createRequire(path.join(outDir, "lib", "x.js")),
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  };
}
