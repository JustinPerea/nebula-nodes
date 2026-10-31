// PR #203 round 19, sections 2 and 3: review 18's copy-ui NIT-2 (F8), the
// settings_busy 409 (copy-ui LOW-3; GM r38 item 3) and settings.restored's
// line at the top of Settings until dismissed (GM r38 item 5's fallback).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getNotice = vi.fn();
const dismissNotice = vi.fn();
vi.mock('../../src/lib/settingsNotice', async (original) => ({
  ...await original<typeof import('../../src/lib/settingsNotice')>(),
  getSettingsNotice: (...args: unknown[]) => getNotice(...args),
  dismissSettingsNotice: (...args: unknown[]) => dismissNotice(...args),
}));

import { autoLabel } from '../../src/lib/providerSwitch';
import { SETTINGS_REFUSAL_CODES, unreadableSettingsLine } from '../../src/lib/settingsWrites';
import { RequestFailedError } from '../../src/lib/errorCopy';
import { SettingsTopNotice } from '../../src/components/panels/settings/SettingsTopNotice';
import { noticeParts } from '../../src/lib/settingsNotice';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { PERSON_PROMOTED_EVENT } from '../../src/lib/personSession';
import type { ModelNodeDefinition } from '../../src/types';

const FLUX3 = NODE_DEFINITIONS['flux-3-image'] as ModelNodeDefinition;
const BUSY = 'Nothing was saved because another Nebula is saving your settings. Try again in a moment.';
const PATH = '~/.nebula/settings-copy/settings-replaced-0123456789abcdef.json';
const LINE = 'Nebula restored your settings from its saved copy because the last save didn’t finish. '
  + `The file it replaced is kept at ${PATH}.`;

afterEach(() => {
  cleanup();
  getNotice.mockReset();
  dismissNotice.mockReset();
});

describe('the Auto row for a route chosen with no block (F8)', () => {
  it('says which provider needs a key', () => {
    expect(autoLabel(FLUX3, { routeId: 'fal', missing: ['FAL_KEY'], block: undefined, alternatives: [], fixes: [],
      message: '' } as unknown as Parameters<typeof autoLabel>[1], {})).toBe('Auto · fal.ai needs a key');
  });

  it('with no route at all, the credential alone', () => {
    expect(autoLabel(FLUX3, { routeId: null, missing: ['FAL_KEY'], block: undefined, alternatives: [], fixes: [],
      message: '' } as unknown as Parameters<typeof autoLabel>[1], {})).toBe('Auto · needs a key');
  });
});

describe('another Nebula saving the settings (settings_busy)', () => {
  it('is one of the settings refusals, its line said as it is', () => {
    expect(SETTINGS_REFUSAL_CODES).toContain('settings_busy');
    expect(unreadableSettingsLine(new RequestFailedError('Couldn’t save.', 409, { detail: BUSY, code: 'settings_busy' })))
      .toBe(BUSY);
    expect(unreadableSettingsLine(new RequestFailedError('Couldn’t save.', 409, { detail: BUSY, code: 'other' })))
      .toBeNull();
  });
});

describe('settings.restored at the top of Settings', () => {
  it('splits the line at its path', () => {
    expect(noticeParts({ kind: 'restored', line: LINE, path: PATH })).toEqual({
      before: LINE.slice(0, LINE.indexOf(PATH)), path: PATH, after: '.' });
    expect(noticeParts({ kind: 'restored', line: 'No path here.', path: PATH }))
      .toEqual({ before: 'No path here.', path: '', after: '' });
  });

  it('shows the line word for word, its path in mono, until dismissed', async () => {
    getNotice.mockResolvedValue({ kind: 'restored', line: LINE, path: PATH });
    dismissNotice.mockResolvedValue(undefined);
    await act(async () => { render(<SettingsTopNotice visible />); });
    const notice = await screen.findByRole('status');
    expect(notice.querySelector('p')?.textContent).toBe(LINE);
    const code = notice.querySelector('code');
    expect(code?.textContent).toBe(PATH);
    expect(code?.className).toBe('settings-top-notice__path');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(dismissNotice).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when there is no line, or while Settings is closed', async () => {
    getNotice.mockResolvedValue(null);
    await act(async () => { render(<SettingsTopNotice visible />); });
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    await act(async () => { render(<SettingsTopNotice visible={false} />); });
    expect(getNotice).toHaveBeenCalledTimes(1);
  });

  it('asks again once the server promotes the tab as the person (a first load refused)', async () => {
    getNotice.mockRejectedValueOnce(new Error('person required'))
      .mockResolvedValueOnce({ kind: 'restored', line: LINE, path: PATH });
    await act(async () => { render(<SettingsTopNotice visible />); });
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { window.dispatchEvent(new Event(PERSON_PROMOTED_EVENT)); });
    expect((await screen.findByRole('status')).querySelector('code')?.textContent).toBe(PATH);
    expect(getNotice).toHaveBeenCalledTimes(2);
  });

  it('a failed load shows nothing', async () => {
    getNotice.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<SettingsTopNotice visible />); });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
