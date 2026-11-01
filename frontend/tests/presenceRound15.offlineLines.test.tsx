/**
 * PR #204 round 15 (review 12 LOW-1; GM r23 3, offline comes first): a because line is hidden
 * while Nebula is offline wherever it is drawn, one rule in <LineText>, not per screen. That covers
 * the action-refusal lines no screen filtered (the Updates list's dismiss, Settings writes,
 * Connected apps, Trash, Pins, the proposal decide lines, the questions form and the rest). Back
 * online the line shows again. Other failure lines, and lines that aren't because lines, stay.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { PERSON_REQUIRED_CODE, RequestFailedError, failureMessage, notConnectedBecause } = await import('../src/lib/errorCopy');
const { isBecauseLine } = await import('../src/lib/notConnectedLine');
const connection = await import('../src/lib/backendConnection');
const { LineText } = await import('../src/components/LineText');
const { AgentNotesList } = await import('../src/components/agent-notes/AgentNotesList');

const BECAUSE = notConnectedBecause('save the change');
const OTHER = 'Couldn’t save the change. The file is missing.';
const offline = () => act(() => { connection.noteBackendConnection('offline'); });
const online = () => act(() => { connection.noteBackendConnection('online'); });

beforeEach(() => { act(() => connection.resetBackendConnectionForTests()); });
afterEach(() => { cleanup(); act(() => connection.resetBackendConnectionForTests()); });

describe('LineText: offline first', () => {
  it('a because line alone in its surface: the surface is hidden offline and back online', () => {
    expect(isBecauseLine(BECAUSE)).toBe(true);
    render(<p role="alert" data-testid="surface"><LineText text={BECAUSE} /></p>);
    const surface = screen.getByTestId('surface');
    expect(surface.textContent).toBe(BECAUSE);
    offline();
    expect(surface.hidden).toBe(true);
    expect(surface.textContent).toBe('');
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    online();
    expect(surface.hidden).toBe(false);
    expect(surface.textContent).toBe(BECAUSE);
  });

  it('a because line beside other content: only its words go', () => {
    render(<p data-testid="surface"><button type="button">Retry</button><LineText text={BECAUSE} /></p>);
    const surface = screen.getByTestId('surface');
    offline();
    expect(surface.hidden).toBe(false);
    expect(surface.textContent).toBe('Retry');
    online();
    expect(surface.textContent).toBe(`Retry${BECAUSE}`);
  });

  it('with a className: its own span is hidden', () => {
    render(<div data-testid="surface"><LineText text={BECAUSE} className="line" /></div>);
    const span = screen.getByTestId('surface').querySelector('span.line') as HTMLElement;
    offline();
    expect(span.hidden).toBe(true);
    expect(span.textContent).toBe('');
    online();
    expect(span.hidden).toBe(false);
    expect(span.textContent).toBe(BECAUSE);
  });

  it('a surface the screen already hid stays hidden when Nebula is back', () => {
    render(<p hidden data-testid="surface"><LineText text={BECAUSE} /></p>);
    offline();
    online();
    expect(screen.getByTestId('surface').hidden).toBe(true);
  });

  it('any other failure line stays offline', () => {
    render(<p role="alert" data-testid="surface"><LineText text={OTHER} /></p>);
    offline();
    expect(screen.getByTestId('surface').hidden).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe(OTHER);
  });
});

describe('an action refusal no screen filtered (review 12 probe zzR12NotesOffline)', () => {
  it('the Updates list\'s refused dismiss: hidden offline, back online', () => {
    const line = failureMessage(new RequestFailedError('Couldn’t dismiss the note.', 403, { code: PERSON_REQUIRED_CODE, detail: 'x' }), 'Couldn’t dismiss the note.');
    expect(isBecauseLine(line)).toBe(true);
    render(<AgentNotesList listRef={() => {}} sections={[]} newCount={0} now={Date.now()} onClose={() => {}} onSeeAll={null}
      onAction={() => {}} onShow={() => {}} onHover={() => {}} error={line} />);
    const says = () => screen.queryAllByRole('alert').map((node) => node.textContent ?? '');
    expect(says().some((text) => text.includes('isn’t connected as you'))).toBe(true);
    offline();
    expect(says().some((text) => text.includes('isn’t connected as you'))).toBe(false);
    online();
    expect(says().some((text) => text.includes('isn’t connected as you'))).toBe(true);
  });
});
