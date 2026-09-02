#!/usr/bin/env node
/**
 * Generate every agent's rule file from AGENTS.md, the single source of truth.
 *
 *   node scripts/sync-rules.mjs           write the copies
 *   node scripts/sync-rules.mjs --check   fail if any copy is stale (used in CI)
 *
 * Different agents read different paths but want the same content. Hand-editing
 * seven copies guarantees they drift, so they are generated and CI enforces it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const source = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");

const BANNER =
  "<!-- Generated from AGENTS.md by scripts/sync-rules.mjs. Do not edit directly. -->\n\n";

/** Plain markdown copies. */
const PLAIN = [
  ".agents/rules/mspace.md",
  ".windsurf/rules/mspace.md",
  ".clinerules/mspace.md",
  ".kiro/steering/mspace.md",
  ".qoder/rules/mspace.md",
];

/** Cursor needs .mdc frontmatter. */
const CURSOR = {
  path: ".cursor/rules/mspace.mdc",
  frontmatter: [
    "---",
    "description: mSpace integration (SMS, USSD, Subscription, OTP, CaaS, LBS) — Mobitel, Sri Lanka",
    "globs:",
    "alwaysApply: false",
    "---",
    "",
  ].join("\n"),
};

/** Copilot gets the same content under its own filename. */
const COPILOT = ".github/copilot-instructions.md";

const targets = [
  ...PLAIN.map((p) => ({ path: p, content: BANNER + source })),
  { path: CURSOR.path, content: CURSOR.frontmatter + BANNER + source },
  { path: COPILOT, content: BANNER + source },
];

let stale = 0;
let written = 0;

for (const { path, content } of targets) {
  const full = join(repoRoot, path);
  const current = existsSync(full) ? readFileSync(full, "utf8") : null;

  if (current === content) continue;

  if (check) {
    console.error(`stale: ${path}`);
    stale++;
  } else {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    console.log(`wrote  ${path}`);
    written++;
  }
}

if (check) {
  if (stale) {
    console.error(
      `\n${stale} rule copy/copies are out of date. Run \`node scripts/sync-rules.mjs\` and commit the result.`
    );
    process.exit(1);
  }
  console.log(`All ${targets.length} rule copies are in sync with AGENTS.md.`);
} else {
  console.log(
    written ? `\n${written} file(s) updated from AGENTS.md.` : "Already in sync with AGENTS.md."
  );
}
