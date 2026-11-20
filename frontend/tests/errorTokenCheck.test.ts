// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findErrorTokenHits } from '../scripts/check-error-tokens.mjs';

/**
 * scripts/check-error-tokens.mjs runs in `npm run lint` (design: error is not danger, and
 * neither is the accent). Each `bad` fixture is a set of sheets that must produce at least
 * one hit; each `fine` fixture must produce none.
 */
const hits = (...sources: string[]) =>
  findErrorTokenHits(sources.map((source, i) => ({ file: `fixture${i}.css`, source })));

describe('check-error-tokens', () => {
  const bad: Record<string, string[]> = {
    'error token is the accent': ['body { --sr-error: var(--sr-accent); }'],
    'danger token is the accent': [':root { --sr-danger: var(--sr-accent-hover); }'],
    'danger alias reaches the accent through a chain': [
      ':root { --sr-danger-ink: var(--sr-danger); }',
      'body { --sr-danger: var(--sr-error); --sr-error: var(--sr-accent); }',
    ],
    'error token falls back to the accent': ['body { --sr-error-soft: var(--missing, var(--sr-accent-soft)); }'],
    'jev fail token is the accent': ['.r { --jev-fail: var(--sr-accent); }'],
    'error token is the orange literal': ['body { --sr-error: #FF5A1F; }'],
    'local override resolves to the accent': ['.panel { --sr-danger-edge: rgba(255, 90, 31, 0.34); }'],
    'error state reads danger': ['.settings-row__error { color: var(--sr-danger); }'],
    'failed dot reads danger ink': ['.run-history__dot--failed { background: var(--sr-danger-ink, #ef4444); }'],
    'invalid input paints the accent': ['.field[aria-invalid="true"], .field__invalid { border-color: var(--sr-accent-border); }'],
    'error state paints the orange literal': ['.chip--error { border-color: #ff5a1f; }'],
    'delete control reads error': ['.thing__delete:hover { color: var(--sr-error); }'],
    'clear control paints the accent': ['.toolbar__button--clear { background: var(--sr-accent-soft); }'],
    'trash trigger reads error': ['.home__trash__trigger { border-color: var(--sr-error-border); }'],
    'nested error rule is not read': ['.thing__error { & .x { color: var(--sr-danger); } }'],
  };
  for (const [name, sheets] of Object.entries(bad)) {
    it(`fails: ${name}`, () => expect(hits(...sheets).length).toBeGreaterThan(0));
  }

  const fine: Record<string, string[]> = {
    'error is the warning tone': [
      'body { --sr-error: var(--sr-warning); --sr-error-soft: var(--sr-warning-soft); --sr-error-border: var(--sr-warning-border); }',
    ],
    'danger is the red': [':root { --sr-danger: #ff887d; --sr-danger-ink: var(--sr-danger); --sr-danger-tint: rgba(255, 70, 60, 0.14); }'],
    'neutral override': ['[data-line-neutral] { --sr-error: var(--sr-ink-light); --sr-danger: var(--sr-ink-light); }'],
    'error text reads error': ['.settings-row__error { color: var(--sr-error); }'],
    'delete button reads danger': ['.thing__delete { color: var(--sr-danger-ink, #ff887d); background: var(--sr-danger-tint); }'],
    'a delete-chooser error line is an error': ['.kept-delete-chooser__error { color: var(--sr-error); }'],
    'the agent reads the accent': ['.chat-panel__thinking { background: var(--sr-accent-soft); color: var(--sr-accent); }'],
    'a primary action reads the accent': ['.button--primary { background: var(--sr-accent); }'],
    'a descendant of a delete rule parent is not the control': ['.delete-bar .button--primary { background: var(--sr-accent); }'],
    'comment mentioning the accent': ['/* .x__error { color: var(--sr-accent); } */ .y { color: red; }'],
  };
  for (const [name, sheets] of Object.entries(fine)) {
    it(`passes: ${name}`, () => expect(hits(...sheets)).toEqual([]));
  }
});
