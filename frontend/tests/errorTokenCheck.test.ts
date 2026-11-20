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
    'refused state paints the accent': ['.provider__refused { color: var(--sr-accent); }'],
    'warn state reads danger': ['.panel__warn { color: var(--sr-danger); }'],
    'blocked state reads danger': ['.chip--blocked { border-color: var(--sr-danger-border); }'],
    'denied state paints the accent': ['.row--denied { color: var(--sr-accent); }'],
    'rejected state reads danger': ['.row--rejected { color: var(--sr-danger-ink); }'],
    'error state uses the accent literal with alpha': ['.chip--error { background: #ff5a1f33; }'],
    'error state uses the accent rgba': ['.chip--error { background: rgba(255, 90, 31, 0.2); }'],
    'error state uses a danger red literal': ['.chip--error { color: #ff887d; }'],
    'error state uses the danger tint literal': ['.chip--error { background: rgba(255, 70, 60, 0.14); }'],
    'delete control uses the warning literal': ['.thing__delete { color: #F5C518; }'],
    'delete control uses the accent literal': ['.thing__delete { color: #ff5a1f; }'],
    'error state reaches the accent through a local property': ['.panel { --tone: var(--sr-accent); } .panel__error { color: var(--tone); }'],
    'error state reaches danger through a local property': ['.panel { --tone: var(--sr-danger); } .panel__error { color: var(--tone); }'],
    'delete control reaches the error tone through a local property': ['.panel { --tone: var(--sr-error); } .panel__delete { color: var(--tone); }'],
    'delete control reaches a literal through a local property': ['.panel { --tone: #ff5a1f; } .panel__delete { color: var(--tone); }'],
    'pass state sets a custom property to the warning tone': ['.row--pass { --x: var(--sr-warning); }'],
    'running state reads the warning tone': ['.run__dot--running { background: var(--sr-warning); }'],
    'passed state reads the error tone': ['.chip--passed { color: var(--sr-error); }'],
    'ready state paints the warning literal': ['.row__ready { color: #f5c518; }'],
    'ok state reads the warning soft tint': ['.row--ok { background: var(--sr-warning-soft); }'],
    'done state reaches warning through a local property': ['.row { --tone: var(--sr-warning); } .row--done { color: var(--tone); }'],
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
    'a Retry accent button inside an error container is not an error state': ['.chat__tool--error .chat__retry { background: var(--sr-accent); }'],
    'a delete control inside an error container may read danger': ['.chat__tool--error .chat__delete { color: var(--sr-danger); }'],
    'a button in a warning dialog is not an error state': ['.personal-warning__accept { border-color: var(--sr-accent-border); }'],
    'a not-ready mark may read the warning tone': ['.proposal-bar__not-ready-mark { color: var(--sr-warning); }'],
    'a failed state reads the error tone': ['.run__dot--failed { background: var(--sr-error); }'],
    'a running state is neutral': ['.run__dot--running { background: var(--sr-ink-light); }'],
    'a done state reads success': ['.run__dot--done { background: var(--sr-success); }'],
    'a local property that is neutral passes': ['.panel { --tone: var(--sr-ink-light); } .panel__error { color: var(--tone); }'],
    'a local property declared in another file is not followed': ['.panel { --tone: var(--sr-accent); }', '.panel__error { color: var(--tone); }'],
    'comment mentioning the accent': ['/* .x__error { color: var(--sr-accent); } */ .y { color: red; }'],
  };
  for (const [name, sheets] of Object.entries(fine)) {
    it(`passes: ${name}`, () => expect(hits(...sheets)).toEqual([]));
  }
});
