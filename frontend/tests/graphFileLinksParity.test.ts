/**
 * Q123 a (Justin, 2026-10-24): "Yes: `nebula load` and an MCP tool open a
 * bundle, restoring its files, as Load graph does. A big one opens as a new
 * project."
 *
 * Agents open a .nebula.zip through the backend (services/graph_file_links.py),
 * which rewrites the restored files' links as Load graph does here. One shared
 * fixture (backend/tests/fixtures/graph_file_links_cases.json) runs the
 * canvas's own functions and the backend's port (tests/test_graph_file_links.py),
 * so the two can't drift: link spellings, path canonicalization, the restore
 * mapping, one graph's rewrite with its warnings, and the name a file over the
 * save limit opens as.
 *
 * The fixture is read with JSON.parse, not imported: its nodes carry a
 * `__proto__` key, which an object literal would turn into a prototype.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { graphFileLinksForTests } from '../src/lib/graphFile';
import { projectNameForFile } from '../src/lib/projectSize';
import { isSafeWorldUrl } from '../src/lib/worldValue';
import type { NebulaNode } from '../src/lib/graphFileShared';

interface Shared {
  links: Array<{ value: string; expected: { kind: string; relativePath?: string } }>;
  paths: Array<{ raw: string; expected: string | null }>;
  mappings: Array<{ mapping: unknown; expected: Record<string, string> | null; error: string | null }>;
  rewrite: { nodes: NebulaNode[]; mapping: Record<string, string>; expectedNodes: unknown; expectedWarnings: string[] };
  worldUrls: Array<{ value: string; expected: boolean }>;
  projectNames: Array<{ fileName: string | null; expected: string }>;
  spatial: Array<{
    name: string;
    nodes: NebulaNode[];
    canvas: { kept: Record<string, string[]>; warnings: string[] };
    backend: { kept: Record<string, string[]>; warnings: string[] };
  }>;
}

const shared = JSON.parse(readFileSync(
  join(__dirname, '../../backend/tests/fixtures/graph_file_links_cases.json'), 'utf-8',
)) as Shared;

const {
  canonicalPortableOutputRelativePath,
  parseLocalOutputReference,
  rewriteAssetUrls,
  sanitizeImportedSpatialOutputs,
  validatedRestoreMapping,
} = graphFileLinksForTests;

describe('graph file links: the canvas and the backend read them alike (shared cases)', () => {
  it.each(shared.links.map((entry) => [JSON.stringify(entry.value).slice(0, 80), entry] as const))(
    'link %s', (_name, entry) => {
      const parsed = parseLocalOutputReference(entry.value);
      const got = parsed.kind === 'valid'
        ? { kind: 'valid', relativePath: parsed.relativePath }
        : { kind: parsed.kind };
      expect(got).toEqual(entry.expected);
    },
  );

  it.each(shared.paths.map((entry) => [JSON.stringify(entry.raw).slice(0, 80), entry] as const))(
    'path %s', (_name, entry) => {
      expect(canonicalPortableOutputRelativePath(entry.raw)).toBe(entry.expected);
    },
  );

  it.each(shared.mappings.map((entry, index) => [index, entry] as const))('mapping %s', (_index, entry) => {
    if (entry.error) {
      // The canvas shows its damaged-file line; the check's own words are `detail`.
      let detail: unknown = null;
      try { validatedRestoreMapping(entry.mapping); } catch (error) { detail = (error as { detail?: unknown }).detail; }
      expect(detail).toBe(entry.error);
      return;
    }
    expect(Object.fromEntries(validatedRestoreMapping(entry.mapping))).toEqual(entry.expected);
  });

  it('rewrites a graph to the restored files, with the same warnings', () => {
    const nodes = structuredClone(shared.rewrite.nodes);
    const mapping = validatedRestoreMapping(shared.rewrite.mapping);
    const warnings = rewriteAssetUrls(nodes, mapping);
    expect(warnings).toEqual(shared.rewrite.expectedWarnings);
    expect(JSON.parse(JSON.stringify(nodes))).toEqual(shared.rewrite.expectedNodes);
  });

  it.each(shared.worldUrls.map((entry) => [JSON.stringify(entry.value).slice(0, 80), entry] as const))(
    'World asset link %s', (_name, entry) => {
      expect(isSafeWorldUrl(entry.value)).toBe(entry.expected);
    },
  );

  it.each(shared.projectNames.map((entry) => [JSON.stringify(entry.fileName), entry] as const))(
    'a file over the limit named %s opens as the same project name', (_name, entry) => {
      expect(projectNameForFile(entry.fileName ?? undefined)).toBe(entry.expected);
    },
  );

  // The backend's World/spatial check is a stricter subset (it never ports the
  // full parsers): each case names what the canvas keeps and what the backend
  // keeps, and test_graph_file_links.py checks the backend never keeps more.
  it.each(shared.spatial.map((entry) => [entry.name, entry] as const))('World/spatial: %s', (_name, entry) => {
    const nodes = structuredClone(entry.nodes);
    const warnings = sanitizeImportedSpatialOutputs(nodes);
    expect(warnings).toEqual(entry.canvas.warnings);
    expect(Object.fromEntries(nodes.map((node) => [node.id, Object.keys(node.data.outputs ?? {})])))
      .toEqual(entry.canvas.kept);
  });
});
