#!/usr/bin/env node
/**
 * Contract coverage inventory — lists handler nodes vs exemplars vs fixtures.
 *
 * Usage:
 *   node scripts/contract-inventory.mjs
 *   node scripts/contract-inventory.mjs --family google
 *   node scripts/contract-inventory.mjs --family openai --json
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "backend/data/node_definitions.json");
const EXAMPLES = join(ROOT, "docs/contracts/examples");
const FIXTURES = join(ROOT, "contracts/fixtures/handlers");

const FAMILY_MAP = {
  google: (n) => n.apiProvider === "google",
  openai: (n) => n.apiProvider === "openai",
  fal: (n) => n.apiProvider === "fal",
};

function loadRegistry() {
  return Object.values(JSON.parse(readFileSync(REGISTRY, "utf8")));
}

function loadExemplarNodeIds() {
  const ids = new Set();
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(EXAMPLES, file), "utf8");
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const nodesBlock = fm[1].match(/^nodes:\n((?:\s+-\s+.+\n?)+)/m);
    if (nodesBlock) {
      for (const line of nodesBlock[1].split("\n")) {
        const m = line.match(/^\s+-\s+(.+)$/);
        if (m) ids.add(m[1].trim());
      }
    }
    // Single-node exemplars often use definitionId in title only — also map filename stem
    const stem = file.replace(/\.md$/, "").replace(/-fal$/, "");
    ids.add(stem);
  }
  return ids;
}

function fixtureIndex() {
  const byFamily = {};
  for (const family of readdirSync(FIXTURES)) {
    const dir = join(FIXTURES, family);
    if (!existsSync(dir)) continue;
    byFamily[family] = readdirSync(dir).sort();
  }
  return byFamily;
}

function nodeFixtures(node, fixtures) {
  const slug = node.id.replace(/-/g, "-");
  const hits = [];
  for (const [family, files] of Object.entries(fixtures)) {
    for (const f of files) {
      if (f.includes(slug) || f.includes(node.id.split("-").slice(0, 2).join("-"))) {
        if (f.includes(node.id) || node.id.includes(f.split("-request")[0].replace(".json", "").replace(".txt", ""))) {
          hits.push(`${family}/${f}`);
        }
      }
    }
  }
  // Broader match: any fixture filename containing node id prefix
  const broad = [];
  for (const [family, files] of Object.entries(fixtures)) {
    for (const f of files) {
      if (f.includes(node.id)) broad.push(`${family}/${f}`);
    }
  }
  return [...new Set(broad.length ? broad : hits)];
}

const args = process.argv.slice(2);
const familyArg = args.includes("--family") ? args[args.indexOf("--family") + 1] : null;
const asJson = args.includes("--json");

const nodes = loadRegistry();
const exemplarIds = loadExemplarNodeIds();
const fixtures = fixtureIndex();

const filtered = familyArg
  ? nodes.filter(FAMILY_MAP[familyArg] ?? (() => true))
  : nodes.filter((n) => ["google", "openai", "fal"].includes(n.apiProvider));

const rows = filtered
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((node) => {
    const hasExemplar = exemplarIds.has(node.id) || [...exemplarIds].some((e) => node.id.startsWith(e) && e.length > 4);
    const nodeFixtureList = nodeFixtures(node, fixtures);
    return {
      id: node.id,
      provider: node.apiProvider,
      pattern: node.executionPattern,
      exemplar: hasExemplar ? "yes" : "MISSING",
      fixtures: nodeFixtureList.length ? nodeFixtureList.join(", ") : "none",
      fixtureCount: nodeFixtureList.length,
    };
  });

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const missing = rows.filter((r) => r.exemplar === "MISSING");
const noFixtures = rows.filter((r) => r.fixtureCount === 0);

console.log(`Contract inventory (${familyArg ?? "google+openai+fal"})`);
console.log(`Nodes: ${rows.length} | Missing exemplar: ${missing.length} | No fixtures: ${noFixtures.length}\n`);

for (const r of rows) {
  const flag = r.exemplar === "MISSING" ? " !" : "";
  console.log(`${r.id.padEnd(28)} ${r.provider.padEnd(8)} ${r.pattern.padEnd(12)} exemplar:${r.exemplar}${flag}`);
  if (r.fixtures !== "none") console.log(`  fixtures: ${r.fixtures}`);
}

if (missing.length) {
  console.log("\n--- Missing exemplars ---");
  for (const r of missing) console.log(`  ${r.id}`);
}

if (noFixtures.length) {
  console.log("\n--- No golden fixtures (may be intentional) ---");
  for (const r of noFixtures) console.log(`  ${r.id}`);
}
