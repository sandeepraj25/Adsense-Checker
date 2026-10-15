// Finds a Chromium for the tests that print real PDFs (scripts/report-test.mjs).
//
// playwright-core is a dev dependency (it ships no browser). In order:
//   1. CHROMIUM_PATH, if set — any Chromium or Chrome binary;
//   2. the Chromium that `npx playwright install chromium` downloaded for
//      this playwright-core version;
//   3. Google Chrome or Chromium installed in the usual place on macOS,
//      Linux or Windows.
// Returns { chromium, executablePath } or { problem } saying what is missing.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SYSTEM_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

export function findChromium() {
  let chromium = null;
  for (const dir of [PROJECT_ROOT, process.env.PLAYWRIGHT_CORE_DIR].filter(Boolean)) {
    try {
      ({ chromium } = createRequire(path.join(dir, "x.js"))("playwright-core"));
      break;
    } catch { /* next place */ }
  }
  if (!chromium) return { problem: "playwright-core is not installed (run npm install)" };

  const candidates = [process.env.CHROMIUM_PATH];
  try {
    candidates.push(chromium.executablePath());
  } catch { /* no managed browser for this version */ }
  candidates.push(...SYSTEM_BROWSERS);
  const executablePath = candidates.find((file) => file && existsSync(file));
  if (!executablePath) {
    return { problem: "no Chromium found (run `npx playwright install chromium`, install Google Chrome, or set CHROMIUM_PATH)" };
  }
  return { chromium, executablePath };
}
