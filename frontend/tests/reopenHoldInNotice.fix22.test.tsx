/**
 * PR #199 round 22 (GM r33).
 * - 6: the held reopen's Marble forms are the World Labs notice's own second
 *   line, inside its box, in its one alert region (announced once); with
 *   nothing else to say (a `params` hold) the box holds only the line.
 * - 3: the button reads "I’ve checked Marble" (curly), and every line that
 *   names it quotes the one label constant.
 * - 2: the failure headings this PR adds say who: "Nebula couldn’t …".
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRecoveryStatus } from '../src/components/ProviderRecoveryStatus';
import { useGraphStore } from '../src/store/graphStore';
import { UNLOCK_LABEL, UNLOCK_RUN_ARIA, unlockAriaLabel } from '../src/lib/worldLabsWaiting';
import { reopenHoldLine } from '../src/lib/reopenHold';
import { failureMessage } from '../src/lib/errorCopy';
import * as projects from '../src/lib/projects';

const AMBIGUITY = { runId: 'run-1', nodeId: 'n1', kind: 'worldlabs-environment', message: 'Staged.', durable: true };
const ITS = reopenHoldLine('Delta', 'delta', { state: 'ambiguity', nodeId: 'n1', nodeName: 'World', projectId: 'delta',
  projectName: 'Delta', count: 1, fields: [] }, false);
const PARAMS = reopenHoldLine('Delta', 'delta', { state: 'params', nodeId: 'n1', nodeName: 'World', projectId: 'delta',
  projectName: 'Delta', count: 1, fields: ['Resume Operation ID'] }, false);

beforeEach(() => {
  useGraphStore.setState({ providerRecoveryWarning: null, uncertainWorldLabsRunId: null, providerRecoveries: [],
    providerStartAmbiguities: [] });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('GM r33, 6: the reopen line is the World Labs notice’s second line', () => {
  it('renders inside the notice’s box, after its text and button, and quotes the button as it shows', () => {
    useGraphStore.setState({ providerStartAmbiguities: [AMBIGUITY] });
    const { container } = render(<ProviderRecoveryStatus reopenLine={{ line: ITS, onDismiss: () => {} }} />);
    const box = container.querySelector('.provider-recovery-status');
    expect(box).not.toBeNull();
    // One box at the top: no second box stacked under it.
    expect(container.children).toHaveLength(1);
    const line = box!.querySelector('[data-reopen-hold-line]');
    expect(line?.textContent).toBe(ITS);
    expect(line?.parentElement).toBe(box);
    // The second line: after the notice's own text and its button.
    const ack = box!.querySelector('.provider-recovery-status__ack')!;
    expect(ack.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ITS).toContain(`press “${ack.textContent}”.`);
  });

  it('keeps one announcement: the notice’s alert region holds the line, with no live region of its own', () => {
    useGraphStore.setState({ providerStartAmbiguities: [AMBIGUITY] });
    const { container } = render(<ProviderRecoveryStatus reopenLine={{ line: ITS, onDismiss: () => {} }} />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(screen.getByRole('alert')).toContainElement(container.querySelector('[data-reopen-hold-line]') as HTMLElement);
  });

  it('with nothing else to say (a params hold), the box holds only the line', () => {
    const { container } = render(<ProviderRecoveryStatus reopenLine={{ line: PARAMS, onDismiss: () => {} }} />);
    const box = container.querySelector('.provider-recovery-status');
    expect(box?.textContent).toBe(PARAMS);
    expect(box?.getAttribute('role')).toBe('alert');
    expect(box?.querySelector('.provider-recovery-status__ack')).toBeNull();
  });

  it('no line, no box change: the notice alone is as before, and nothing shows with nothing held', () => {
    const { container, rerender } = render(<ProviderRecoveryStatus reopenLine={null} />);
    expect(container.innerHTML).toBe('');
    useGraphStore.setState({ providerStartAmbiguities: [AMBIGUITY] });
    rerender(<ProviderRecoveryStatus reopenLine={null} />);
    expect(container.querySelector('[data-reopen-hold-line]')).toBeNull();
  });

  it('its Dismiss closes the line only', () => {
    useGraphStore.setState({ providerStartAmbiguities: [AMBIGUITY] });
    const onDismiss = vi.fn();
    render(<ProviderRecoveryStatus reopenLine={{ line: ITS, onDismiss }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('the stylesheet puts the line on its own full-width row in the box (no stack of its own)', () => {
    const css = readFileSync(resolve(__dirname, '../src/App.css'), 'utf8');
    expect(css).not.toContain('.world-labs-stack');
    expect(css).toMatch(/\.provider-recovery-status:has\(\.provider-recovery-status__reopen\) \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.provider-recovery-status \.provider-recovery-status__reopen \{[^}]*flex: 1 0 100%;/);
  });
});

describe('GM r33, 3: “I’ve checked Marble”, curly, and quoted from the one label', () => {
  it('the button, its accessible names and the reopen line all read the curly label', () => {
    expect(UNLOCK_LABEL).toBe('I’ve checked Marble');
    expect(unlockAriaLabel('“World”')).toBe('I’ve checked Marble. Unlock “World”.');
    expect(UNLOCK_RUN_ARIA).toBe('I’ve checked Marble. Unlock this World Labs run.');
    expect(ITS).toBe('You can reopen “Delta” after you check its World Labs run in Marble and press “I’ve checked Marble”.');
    expect(ITS).not.toMatch(/['"]/);
  });

  it('nothing in the app or the agent docs still spells it with a straight apostrophe', () => {
    for (const file of ['../src/lib/worldLabsWaiting.ts', '../src/lib/reopenHold.ts', '../src/components/ProviderRecoveryStatus.tsx',
      '../../backend/handlers/worldlabs.py', '../../backend/main.py', '../../docs/MCP-SETUP.md', '../../skills/nebula/SKILL.md']) {
      expect(readFileSync(resolve(__dirname, file), 'utf8'), file).not.toMatch(/I(?:\\?'|\\u0027)ve checked Marble/);
    }
    // The backend's two copies of the button's name are the same text.
    expect(readFileSync(resolve(__dirname, '../../backend/handlers/worldlabs.py'), 'utf8')).toContain('UNLOCK_BUTTON = "“I’ve checked Marble”"');
    expect(readFileSync(resolve(__dirname, '../../backend/main.py'), 'utf8')).toContain('UNLOCK_BUTTON = "\\u201cI\\u2019ve checked Marble\\u201d"');
  });
});

describe('GM r33, 2: the failure headings this PR adds say who, with the curly apostrophe', () => {
  it('closing a restore notice that fails reads “Nebula couldn’t close the notice.”', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: 'boom' }), { status: 500,
      headers: { 'Content-Type': 'application/json' } }));
    for (const call of [() => projects.dismissCatalogRestore('r1'), () => projects.dismissCanvasHeldUnreadable('2026-10-31')]) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect(failureMessage(error, 'fallback').startsWith('Nebula couldn’t close the notice.')).toBe(true);
    }
  });

  it('the kept edits’, the follow’s and the reopen’s headings', () => {
    const store = readFileSync(resolve(__dirname, '../src/store/projectStore.ts'), 'utf8');
    for (const heading of ['Nebula couldn’t open the project.', 'Nebula couldn’t discard the kept edits.',
      'Nebula couldn’t save your edits.', 'Nebula couldn’t reopen the project.']) expect(store).toContain(heading);
    for (const old of ['"Couldn\'t discard the kept edits."', 'openFollowed: "Couldn\'t open the project."',
      'failureMessage(error, "Couldn\'t save your edits.")', "'Couldn’t reopen the project.'"]) expect(store).not.toContain(old);
  });
});
