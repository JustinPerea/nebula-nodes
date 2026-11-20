// Design: a badge reads in sentence case; the reference-set role badge draws its word from the
// role definitions, never a stored value, and its stylesheet does not capitalise it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { REFERENCE_ROLES } from '../src/lib/referenceRoles';

it('every reference role label starts with a capital and has no capital after the first word', () => {
  for (const [id, role] of Object.entries(REFERENCE_ROLES)) {
    expect(role.label, id).toMatch(/^[A-Z][a-z]+$/);
  }
});

it('the reference role badge stylesheet does not capitalise the label', () => {
  const css = readFileSync(join(process.cwd(), 'src/styles/reference-set-node.css'), 'utf8');
  const rule = css.match(/\.reference-set-node__role-badge\s*\{[^}]*\}/)?.[0] ?? '';
  expect(rule).not.toBe('');
  expect(rule).not.toMatch(/text-transform:\s*uppercase/);
});

it('the reference set hint is a sentence in normal text, with a full stop', () => {
  const css = readFileSync(join(process.cwd(), 'src/styles/reference-set-node.css'), 'utf8');
  const rule = css.match(/\.reference-set-node__preview-empty\s*\{[^}]*\}/)?.[0] ?? '';
  expect(rule).not.toBe('');
  expect(rule).not.toMatch(/text-transform/);
  const tsx = readFileSync(join(process.cwd(), 'src/components/nodes/ReferenceSetNode.tsx'), 'utf8');
  expect(tsx).toContain('>Connect references with priority above 0.</div>');
});
