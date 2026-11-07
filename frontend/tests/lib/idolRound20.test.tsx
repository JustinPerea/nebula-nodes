// PR #203 round 20, section 1 (GM r39) and section E (GM r40): the agent stop's
// neutral card, every neutral Settings line in the row's muted colour, the
// dismiss failure, and a renamed node's own route line.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getNotice = vi.fn();
const dismissNotice = vi.fn();
vi.mock('../../src/lib/settingsNotice', async (original) => ({
  ...await original<typeof import('../../src/lib/settingsNotice')>(),
  getSettingsNotice: (...args: unknown[]) => getNotice(...args),
  dismissSettingsNotice: (...args: unknown[]) => dismissNotice(...args),
}));
const updateSettings = vi.fn();
vi.mock('../../src/lib/api', async (original) => ({
  ...await original<typeof import('../../src/lib/api')>(),
  updateSettings: (...args: unknown[]) => updateSettings(...args),
}));

import { NodeError } from '../../src/components/nodes/NodeError';
import { SettingsRowError } from '../../src/components/panels/settings/SettingsRowError';
import { SettingsTopNotice } from '../../src/components/panels/settings/SettingsTopNotice';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { renamedLabel, routeUnavailable } from '../../src/lib/directRoute';
import { RequestFailedError } from '../../src/lib/errorCopy';
import { RUN_NODE_HEADING, WAITING_CATEGORY, WAITING_HEADING, nodeErrorCopy } from '../../src/lib/nodeErrorCopy';
import { DISMISS_FAILED } from '../../src/lib/settingsNotice';
import { resetSettingsWrites, saveField } from '../../src/lib/settingsWrites';
import { useSettingsDraftStore } from '../../src/store/settingsDraftStore';
import type { ModelNodeDefinition } from '../../src/types';

const STYLES = join(__dirname, '../../src/styles');
const css = (file: string) => readFileSync(join(STYLES, file), 'utf8');
const rule = (source: string, selector: string) => {
  const at = source.indexOf(`${selector} {`);
  return at < 0 ? '' : source.slice(at, source.indexOf('}', at));
};

const STOP = 'An agent’s run stopped here because this node could bill your Hugging Face account, and only you can '
  + 'start that. Run the node yourself to go ahead.';
const TAB = 'This node could bill your Hugging Face account, so only you can run it. You can run it when this tab is '
  + 'connected as you.';
const BUSY = 'Nothing was saved because another Nebula is saving your settings. Try again in a moment.';

afterEach(() => {
  cleanup();
  getNotice.mockReset();
  dismissNotice.mockReset();
  updateSettings.mockReset();
  resetSettingsWrites();
  useSettingsDraftStore.setState({ errors: {}, neutral: {}, pending: {} });
});

describe('the agent stop card (GM r39 item 1, r40 item 5)', () => {
  it('waits under its own heading, its body the person line', () => {
    const copy = nodeErrorCopy({ raw: 'agent text', category: WAITING_CATEGORY, person: STOP });
    expect(WAITING_HEADING).toBe('Waiting for you to run it');
    expect(copy.heading).toBe(WAITING_HEADING);
    expect(copy.reason).toBe(STOP);
    // Any other failure keeps its heading.
    expect(nodeErrorCopy({ raw: 'x', category: 'unknown', person: 'Try again.' }).heading).toBe(RUN_NODE_HEADING);
  });

  it.each([STOP, TAB])('is a notice, not an error: the waiting tone', (person) => {
    const { container } = render(<NodeError raw="agent text" category={WAITING_CATEGORY} person={person} />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toBe('model-node__error model-node__error--waiting');
    expect(card.textContent).toContain(WAITING_HEADING);
    expect(card.textContent).toContain(person);
  });

  it('its colour is the muted ink, not the error colour', () => {
    const skin = rule(css('slava-restraint.css'), 'body.app-slava-restraint .model-node__error--waiting');
    expect(skin).toContain('color: var(--sr-ink-light)');
    expect(skin).not.toMatch(/--sr-(danger|error|red)/);
    const plain = rule(css('nodes.css'), 'body:not(.app-slava-restraint) .model-node__error--waiting');
    expect(plain).toContain('color: #a3a3a3');
  });
});

describe('neutral Settings lines (GM r39: neutral in colour too)', () => {
  it('the lock-wait line is a polite status in the muted colour', async () => {
    updateSettings.mockRejectedValue(new RequestFailedError('Couldn’t save.', 409, { detail: BUSY, code: 'settings_busy' }));
    await act(async () => { await saveField('outputPath', '/tmp/out'); });
    expect(useSettingsDraftStore.getState().neutral.outputPath).toBe(true);
    render(<SettingsRowError id="outputPath" message={useSettingsDraftStore.getState().errors.outputPath} />);
    const line = screen.getByRole('status');
    expect(line.textContent).toBe(BUSY);
    expect(line.className).toBe('settings-row__error settings-row__error--neutral');
    expect(rule(css('settings.css'), 'body.app-slava-restraint .settings-row__error--neutral'))
      .toContain('color: var(--sr-ink-meta)');
  });

  it('any other failed write stays an alert, and a retry that fails otherwise clears neutral', async () => {
    updateSettings.mockRejectedValueOnce(new RequestFailedError('Couldn’t save.', 409, { detail: BUSY, code: 'settings_busy' }));
    await act(async () => { await saveField('outputPath', '/tmp/out'); });
    updateSettings.mockRejectedValueOnce(new Error('boom'));
    await act(async () => { await saveField('outputPath', '/tmp/out'); });
    expect(useSettingsDraftStore.getState().neutral.outputPath).toBeUndefined();
    render(<SettingsRowError id="outputPath" message={useSettingsDraftStore.getState().errors.outputPath} />);
    expect(screen.getByRole('alert').className).toBe('settings-row__error');
  });

  it("a row's own line (not the write's) is never neutral", () => {
    useSettingsDraftStore.setState({ errors: { outputPath: BUSY }, neutral: { outputPath: true } });
    render(<SettingsRowError id="outputPath" message="That folder doesn’t exist." />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('a dismiss that fails (GM r40 item 4)', () => {
  it('puts the notice back with GM’s line', async () => {
    const line = 'Nebula restored your settings from its saved copy because the last save didn’t finish.';
    getNotice.mockResolvedValue({ kind: 'restored', line, path: '' });
    dismissNotice.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<SettingsTopNotice visible />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(DISMISS_FAILED).toEqual({ heading: 'Nebula couldn’t dismiss this notice', reason: 'Try again.' });
    expect(screen.getByRole('status').querySelector('p')?.textContent).toBe(line);
    expect(screen.getByRole('alert').textContent).toContain('Nebula couldn’t dismiss this notice');
    expect(screen.getByRole('alert').textContent).toContain('Try again.');
  });

  it("the notice's path stays mono and selectable", () => {
    const path = rule(css('settings.css'), 'body.app-slava-restraint .settings-top-notice__path');
    expect(path).toContain('font-family: var(--sr-mono)');
    expect(path).toContain('user-select: text');
  });
});

describe("a renamed node's route line (GM r39 item 8)", () => {
  const FLUX3 = NODE_DEFINITIONS['flux-3-image'] as ModelNodeDefinition;
  const keys = { FAL_KEY: 'fal-test-fake', REPLICATE_API_TOKEN: 'r8-test-fake' } as never;

  it('names it by its name, never its type as well', () => {
    const line = routeUnavailable(FLUX3, { _provider: 'fal', resolution: '1.5k' }, keys, renamedLabel(FLUX3, 'Hero shot'))?.message;
    expect(line?.startsWith('“Hero shot” can’t run on fal.ai')).toBe(true);
    expect(line).not.toContain('FLUX 3 Image');
  });

  it('a label that is its type name, or none, keeps the type name', () => {
    expect(renamedLabel(FLUX3, undefined)).toBeUndefined();
    expect(renamedLabel(FLUX3, '  ')).toBeUndefined();
    expect(renamedLabel(FLUX3, FLUX3.displayName)).toBeUndefined();
    const line = routeUnavailable(FLUX3, { _provider: 'fal', resolution: '1.5k' }, keys, renamedLabel(FLUX3, FLUX3.displayName))?.message;
    expect(line?.startsWith('“FLUX 3 Image” can’t run on fal.ai')).toBe(true);
  });
});
