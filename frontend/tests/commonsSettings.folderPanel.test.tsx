import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ folders: vi.fn(), settings: vi.fn(), candidates: vi.fn() }));
vi.mock('../src/lib/commonsApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/commonsApi')>(),
  commonsApi: { ...(await importOriginal<typeof import('../src/lib/commonsApi')>()).commonsApi, ...api },
}));

const { CommonsSettings } = await import('../src/components/commons/CommonsSettings');
const { writtenDateTime } = await import('../src/lib/commonsFormat');

const SCAN_AT = new Date(2026, 10, 20, 3, 0, 12).toISOString();
const link = (over: Record<string, unknown> = {}) => ({
  id: 'f1', path: '/x', ignores: [], last_scan_at: SCAN_AT, last_scan_summary: { added: 3, unchanged: 0 }, device_states: [], ...over,
});
const status = { meter: { calls: 1, cap: 10, resets_at: new Date(2026, 10, 21, 0, 0).toISOString() }, agent_adds: null } as never;

async function show(folders: unknown[]) {
  api.folders.mockResolvedValue(folders);
  api.settings.mockResolvedValue({});
  api.candidates.mockResolvedValue([]);
  render(<CommonsSettings status={status} onOpenAsset={() => {}} onChanged={() => {}} />);
  await screen.findByText('/x');
}

// Only Date is faked, so the year in "November 20" stays the current one whenever this runs.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 20, 9, 0)); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('the folder panel', () => {
  it('labels the ignore field "Ignore" with the hint as its placeholder', async () => {
    await show([link()]);
    expect(screen.getByLabelText('Ignore')).toHaveAttribute('placeholder', 'Separate names with commas');
    expect(screen.queryByText(/comma separated/i)).toBeNull();
    // Empty: the placeholder carries the hint, so no second copy sits under it.
    expect(screen.queryByText('Separate names with commas')).toBeNull();
  });

  it('keeps the hint under the field once it holds names, outside the label', async () => {
    await show([link({ ignores: ['.DS_Store'] })]);
    const hint = screen.getByText('Separate names with commas');
    expect(hint).toBeInTheDocument();
    expect(hint.closest('label')).toBeNull();
    // The accessible name stays "Ignore"; the hint is its description.
    const field = screen.getByRole('textbox', { name: 'Ignore' });
    expect(field).toHaveAccessibleDescription('Separate names with commas');
  });

  it('reads the last scan as a written date and time, with the count first', async () => {
    await show([link()]);
    expect(screen.getByText('Last scan November 20, 3:00 AM · 3 added')).toBeInTheDocument();
  });

  it('leaves unchanged files out: a rescan that found nothing reads "nothing new"', async () => {
    await show([link({ last_scan_summary: { added: 0, unchanged: 120 } })]);
    expect(screen.getByText('Last scan November 20, 3:00 AM · nothing new')).toBeInTheDocument();
    cleanup();
    await show([link({ last_scan_summary: { added: 3, unchanged: 120 } })]);
    expect(screen.getByText('Last scan November 20, 3:00 AM · 3 added')).toBeInTheDocument();
  });

  it('reads a time with no summary as "Last scan <date>"', async () => {
    await show([link({ last_scan_summary: null })]);
    expect(screen.getByText('Last scan November 20, 3:00 AM')).toBeInTheDocument();
  });

  it('keeps the "Last scan" prefix when there is a summary and no time', async () => {
    await show([link({ last_scan_at: null })]);
    expect(screen.getByText('Last scan · 3 added')).toBeInTheDocument();
  });

  it('reads once when it was never scanned', async () => {
    await show([link({ last_scan_at: null, last_scan_summary: null })]);
    expect(screen.getByText('Not scanned yet')).toBeInTheDocument();
    expect(screen.queryByText(/never/i)).toBeNull();
  });

  it('writes the meter reset the same way', async () => {
    await show([link()]);
    await waitFor(() => expect(screen.getByText(new RegExp(`resets ${writtenDateTime(status.meter.resets_at)}`))).toBeInTheDocument());
    expect(screen.getByText(/resets November 21, 12:00 AM/)).toBeInTheDocument();
  });
});
