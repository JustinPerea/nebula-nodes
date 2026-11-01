/**
 * PR #204 round 15 (review 12 LOW-1; GM r23 3, offline comes first): a because line is hidden
 * while Nebula is offline wherever it is drawn, one rule in <LineText>, not per screen. That covers
 * the action-refusal lines no screen filtered (the Updates list's dismiss, Settings writes,
 * Connected apps, Trash, Pins, the proposal decide lines, the questions form and the rest). Back
 * online the line shows again. Other failure lines, and lines that aren't because lines, stay.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));

const { PERSON_REQUIRED_CODE, RequestFailedError, failureMessage, notConnectedBecause } = await import('../src/lib/errorCopy');
const { isBecauseLine } = await import('../src/lib/notConnectedLine');
const connection = await import('../src/lib/backendConnection');
const { LineText } = await import('../src/components/LineText');
const { AgentNotesList } = await import('../src/components/agent-notes/AgentNotesList');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { SettingsNoticeBar } = await import('../src/components/panels/settings/SettingsNoticeBar');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');

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

// Round 17 (review 13 LOW-3): a toast or bar whose only line is a because line holds nothing but
// its controls offline (the pin toast's ×, Settings' Undo). Hiding the line's span left an empty
// box, so these ask the one rule (hooks/useOfflineFirstBecause) for the line before they show at
// all: offline the box isn't there; back online it is, if the line still applies.
describe('a toast whose only line is hidden offline doesn\'t show (review 13 LOW-3)', () => {
  const pinToast = () => document.querySelector<HTMLElement>('.canvas-pin-toast--notice');
  const pinError = (error: string) => useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error,
    errorProject: null, errorPersonGate: null, draft: '', drafts: {}, kept: [] } as never);
  afterEach(() => { act(() => { useCanvasPinsStore.setState({ error: null } as never); useSettingsDraftStore.setState({ notice: null }); }); });

  it('the pin toast: gone offline (not left as a ×), back online', () => {
    pinError(notConnectedBecause('add the note'));
    render(<PinComposer />);
    expect(pinToast()?.textContent).toContain('isn’t connected as you');
    // It goes at once, not through a leave: a leave would draw the box with its words hidden.
    const leaves: string[] = [];
    const seen = (records: MutationRecord[]) => {
      for (const record of records) {
        const target = record.target as Element;
        if (target.matches?.('.canvas-pin-toast--notice') && record.attributeName === 'data-leaving') leaves.push(record.attributeName);
      }
    };
    const watch = new MutationObserver(seen);
    watch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-leaving'] });
    offline();
    seen(watch.takeRecords());
    watch.disconnect();
    expect(leaves).toEqual([]);
    expect(pinToast()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    online();
    expect(pinToast()?.textContent).toContain('isn’t connected as you');
  });

  it('the pin toast with another failure: stays offline', () => {
    pinError(OTHER);
    render(<PinComposer />);
    offline();
    expect(pinToast()?.textContent).toContain(OTHER);
  });

  it('Settings\' notice bar: no empty bar offline, back online', () => {
    act(() => useSettingsDraftStore.setState({ notice: { id: 1, message: BECAUSE } }));
    render(<SettingsNoticeBar />);
    const bar = () => document.querySelector('.settings-notice');
    expect(bar()?.textContent).toContain(BECAUSE);
    offline();
    expect(bar()).toBeNull();
    online();
    expect(bar()?.textContent).toContain(BECAUSE);
  });

  it('Settings\' notice bar with another line: stays offline', () => {
    act(() => useSettingsDraftStore.setState({ notice: { id: 2, message: 'Key added.', undoKey: 'OPENAI_API_KEY' } }));
    render(<SettingsNoticeBar />);
    offline();
    expect(document.querySelector('.settings-notice')?.textContent).toContain('Key added.');
  });

  it('every surface that wraps a line in a span beside its controls asks the rule itself', () => {
    const SRC = join(__dirname, '../src');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
    });
    const wrappers = files(SRC).filter((path) => /<span>\s*<LineText\b/.test(readFileSync(path, 'utf8')));
    expect(wrappers.map((path) => relative(SRC, path)).sort()).toEqual(['components/canvas/PinComposer.tsx', 'components/panels/settings/SettingsNoticeBar.tsx']);
    for (const path of wrappers) expect(readFileSync(path, 'utf8'), path).toMatch(/\buseOfflineFirstBecause\(/);
  });
});
