// The environment for a production server started by a test.
//
// `next start` reads the project's .env files (.env.local, .env.production,
// .env) for every variable the process does not already have. On a
// developer's machine those hold real settings — an SMTP account, the live
// site URL, the admin login — which would silently replace what a test set
// up (or deliberately left out) and send the test's mail to a real server.
//
// So every variable named in those files is passed explicitly: the test's
// own value when it sets one, otherwise an empty string, which the app
// reads as "not set" and which stops Next from filling it in. Nothing is
// read from the files but the variable names.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const ENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];

/** Names of the variables defined in the project's .env files (values are never read out). */
export function dotenvNames(projectRoot = PROJECT_ROOT) {
  const names = new Set();
  for (const file of ENV_FILES) {
    const full = path.join(projectRoot, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

/**
 * `base` is the environment the test built (usually process.env plus its
 * settings). Variables the test did not set and that a .env file would
 * supply are blanked; NODE_ENV and PATH-like process variables are kept.
 */
export function isolatedServerEnv(base) {
  const env = { ...base };
  for (const name of dotenvNames()) {
    if (env[name] === undefined) env[name] = "";
  }
  return env;
}
