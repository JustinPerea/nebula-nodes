/**
 * PR #204 round 18h (review 16 logic LOW-4): the capability is asked again when the backend's boot
 * id changes, a restart health never saw as offline, as well as on reconnect. Still no polling.
 * And a tab without the Commons (a canvas tab that loaded while it was off) asks the same way, so
 * its Commons entry appears without a reload. Probes PD/PE from review 16, as assertions.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (o) => ({ ...await o<typeof import('../src/lib/backend')>(), apiFetch: api.fetch }));
const { useCommonsCapability } = await import('../src/hooks/useCommonsCapability');
const { useUIStore } = await import('../src/store/uiStore');
const { useProjectStore } = await import('../src/store/projectStore');
const { noteBackendBootId, noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
const { noteCommonsAnswered } = await import('../src/lib/commonsOff');

const cap = { on: false };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
function Probe() { useCommonsCapability(); return null; }
const reads = () => api.fetch.mock.calls.filter(([p]) => String(p) === '/api/capabilities/commons').length;
const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  useProjectStore.setState({ ...initialProjects, screen: 'home', initialized: true, activeProject: null }, true);
  noteCommonsAnswered();
  resetBackendConnectionForTests();
  cap.on = false;
  api.fetch.mockReset();
  api.fetch.mockImplementation(async () => json({ enabled: cap.on }));
});
afterEach(() => { cleanup(); act(() => resetBackendConnectionForTests()); history.replaceState({}, '', '/'); noteCommonsAnswered(); });

it('PD: under the off view, a restart seen only by its boot id asks again, and the off view goes', async () => {
  history.replaceState({}, '', '/#commons');
  render(<Probe />);
  await flush();
  expect(useUIStore.getState().commonsOffShown).toBe(true);
  expect(reads()).toBe(1);
  cap.on = true;
  act(() => { noteBackendBootId('boot-a', 1); });
  // The first boot id is no restart.
  await flush();
  expect(reads()).toBe(1);
  act(() => { noteBackendBootId('boot-b', 2); });
  await flush();
  expect(reads()).toBe(2);
  // No project open: the Projects home, as "← Projects" would.
  expect(useUIStore.getState().commonsOffShown).toBe(false);
});

it('a canvas tab that loaded with the Commons off learns on reconnect that it is on', async () => {
  render(<Probe />);
  await flush();
  expect(useUIStore.getState().commonsEnabled).toBe(false);
  expect(useUIStore.getState().commonsOffShown).toBe(false);
  cap.on = true;
  await act(async () => { noteBackendConnection('offline'); });
  await act(async () => { noteBackendConnection('online'); });
  await flush();
  expect(reads()).toBe(2);
  expect(useUIStore.getState().commonsEnabled).toBe(true);
  // On the canvas, not routed to the Commons: the entry appears, nothing opens.
  expect(useUIStore.getState().viewMode).not.toBe('commons');
});

it('a canvas tab learns on a boot-id change too, and stops asking once the Commons is on', async () => {
  render(<Probe />);
  await flush();
  cap.on = true;
  act(() => { noteBackendBootId('boot-a', 1); });
  act(() => { noteBackendBootId('boot-b', 2); });
  await flush();
  expect(useUIStore.getState().commonsEnabled).toBe(true);
  const after = reads();
  act(() => { noteBackendBootId('boot-c', 3); });
  await act(async () => { noteBackendConnection('offline'); });
  await act(async () => { noteBackendConnection('online'); });
  await flush();
  expect(reads()).toBe(after);
});

it('no polling: nothing asks while nothing changes, and a capability still off keeps the tab as it is', async () => {
  vi.useFakeTimers();
  try {
    render(<Probe />);
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reads()).toBe(1);
    act(() => { noteBackendBootId('boot-a', 1); });
    act(() => { noteBackendBootId('boot-b', 2); });
    await flush();
    expect(reads()).toBe(2);
    expect(useUIStore.getState().commonsEnabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('PE: flapping three times while each read is slow still opens the Commons', async () => {
  history.replaceState({}, '', '/#commons');
  render(<Probe />);
  await flush();
  cap.on = true;
  const resolvers: (() => void)[] = [];
  api.fetch.mockImplementation(() => new Promise((r) => resolvers.push(() => r(json({ enabled: cap.on })))));
  for (let i = 0; i < 3; i++) {
    await act(async () => { noteBackendConnection('offline'); });
    await act(async () => { noteBackendConnection('online'); });
  }
  await act(async () => { for (const r of resolvers) r(); });
  await flush();
  expect(useUIStore.getState().commonsOffShown).toBe(false);
});

it('N8: going offline alone asks nothing; only coming back does', async () => {
  history.replaceState({}, '', '/#commons');
  render(<Probe />);
  await flush();
  await act(async () => { noteBackendConnection('offline'); });
  await flush();
  expect(reads()).toBe(1);
  await act(async () => { noteBackendConnection('online'); });
  await flush();
  expect(reads()).toBe(2);
});

it('N9: the person leaving the off view while the project opens: the Commons doesn\'t open after all', async () => {
  history.replaceState({}, '', '/#commons');
  let finish = () => {};
  const opened = new Promise<void>((resolve) => { finish = resolve; });
  useProjectStore.setState({ activeProject: { id: 'p1', name: 'Lighthouse' } as never,
    open: vi.fn(async () => { await opened; useProjectStore.setState({ screen: 'workspace' }); }) as never });
  render(<Probe />);
  await flush();
  expect(useUIStore.getState().commonsOffShown).toBe(true);
  cap.on = true;
  await act(async () => { noteBackendConnection('offline'); });
  await act(async () => { noteBackendConnection('online'); });
  await flush();
  // "← Projects" meanwhile: the off view and its route go.
  act(() => { useUIStore.getState().setCommonsOffShown(false); history.replaceState({}, '', '/'); });
  await act(async () => { finish(); });
  await flush();
  expect(useUIStore.getState().viewMode).not.toBe('commons');
});

it('N13: an answer that comes after the hook went sets nothing', async () => {
  const view = render(<Probe />);
  await flush();
  cap.on = true;
  let answer = () => {};
  api.fetch.mockImplementation(() => new Promise((resolve) => { answer = () => resolve(json({ enabled: true })); }));
  act(() => { noteBackendBootId('boot-a', 1); });
  act(() => { noteBackendBootId('boot-b', 2); });
  view.unmount();
  await act(async () => { answer(); });
  await flush();
  expect(useUIStore.getState().commonsEnabled).toBe(false);
});
