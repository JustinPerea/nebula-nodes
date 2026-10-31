/**
 * PR #204 round 11, review 9 lock-sweep LOW-4: behaviour tests for the swept person-lock controls
 * outside Settings: the personal-agent warning's accept, Create's Enhance, the asset and project
 * trash, and the Inspector's model picker and favorite star. On a held tab each control is
 * aria-disabled in place (still focusable), carries data-person-lock, points at one
 * `.person-lock-line` with its verb, has no tooltip, and sends nothing; the promote lifts it and
 * the same action sends. A confirm armed before a demote sends nothing either.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: () => new Promise<Response>(() => {}),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchOpenRouterModels: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getSettings: (...args: unknown[]) => api.getSettings(...args),
  updateSettings: (...args: unknown[]) => api.updateSettings(...args),
  fetchOpenRouterModels: (...args: unknown[]) => api.fetchOpenRouterModels(...args),
}));
const enhance = vi.hoisted(() => ({ enhancePrompt: vi.fn() }));
vi.mock('../src/lib/enhancePrompt', () => ({ enhancePrompt: (...args: unknown[]) => enhance.enhancePrompt(...args) }));
const trash = vi.hoisted(() => ({ fetchTrash: vi.fn(), emptyTrash: vi.fn(), purgeTrashed: vi.fn(), restoreTrashed: vi.fn() }));
vi.mock('../src/lib/trash', async (original) => ({
  ...await original<typeof import('../src/lib/trash')>(),
  fetchTrash: (...args: unknown[]) => trash.fetchTrash(...args),
  emptyTrash: (...args: unknown[]) => trash.emptyTrash(...args),
  purgeTrashed: (...args: unknown[]) => trash.purgeTrashed(...args),
  restoreTrashed: (...args: unknown[]) => trash.restoreTrashed(...args),
}));

const session = await import('../src/lib/personSession');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');
const { PERSON_REQUIRED_CODE } = await import('../src/lib/errorCopy');
const { PersonalAgentWarning } = await import('../src/components/panels/PersonalAgentWarning');
const { CreateComposer } = await import('../src/components/create-studio/CreateComposer');
const { RecentlyDeletedAssets } = await import('../src/components/asset-trash/AssetTrash');
const { ProjectHome } = await import('../src/components/projects/ProjectHome');
const { Inspector } = await import('../src/components/panels/Inspector');
const { useGraphStore } = await import('../src/store/graphStore');
const { useUIStore } = await import('../src/store/uiStore');

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

const line = (verb: string) => `You can ${verb} when this tab is connected as you.`;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const pastFirstMoment = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, HELD_LOOK_DELAY_MS + 20); }));
const hold = async () => { act(() => session.reportPersonRequired()); await pastFirstMoment(); };
const promote = () => act(() => session.notePersonPromoted());

function lockLinesOf(element: Element): HTMLElement[] {
  return (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id))
    .filter((node): node is HTMLElement => !!node && node.classList.contains('person-lock-line'));
}

function expectLocked(element: HTMLElement, words: string): HTMLElement {
  expect(element.getAttribute('aria-disabled')).toBe('true');
  expect(element.hasAttribute('data-person-lock')).toBe(true);
  expect(element.hasAttribute('title')).toBe(false);
  expect((element as HTMLButtonElement).disabled).toBe(false);
  act(() => element.focus());
  expect(document.activeElement).toBe(element);
  const lines = lockLinesOf(element);
  expect(lines).toHaveLength(1);
  expect(lines[0].textContent).toBe(words);
  return lines[0];
}

function expectUnlocked(element: HTMLElement) {
  expect(element.hasAttribute('aria-disabled')).toBe(false);
  expect(element.hasAttribute('data-person-lock')).toBe(false);
  expect(lockLinesOf(element)).toHaveLength(0);
}

function expectNoLineTwice() {
  const texts = [...document.querySelectorAll('.person-lock-line')].map((node) => node.textContent);
  expect(new Set(texts).size).toBe(texts.length);
}

const shownLines = (words: string) => [...document.querySelectorAll('.person-lock-line')].filter((node) => node.textContent === words);

beforeEach(() => {
  session.resetPersonSessionForTests();
  api.getSettings.mockReset().mockResolvedValue({ favorites: {} });
  api.updateSettings.mockReset().mockResolvedValue({});
  api.fetchOpenRouterModels.mockReset().mockResolvedValue({ count: 2, models: [
    { id: 'acme/one', name: 'One', input_modalities: ['text'], output_modalities: ['text'], context_length: 1, pricing: {} },
    { id: 'acme/two', name: 'Two', input_modalities: ['text'], output_modalities: ['text'], context_length: 1, pricing: {} },
  ] });
  enhance.enhancePrompt.mockReset().mockResolvedValue('a better cat');
  trash.fetchTrash.mockReset().mockResolvedValue([
    { kind: 'moodboard', id: 'b1', name: 'Old board', deletedAt: '2026-10-10T11:00:00Z' },
  ]);
  trash.emptyTrash.mockReset().mockResolvedValue(undefined);
  trash.purgeTrashed.mockReset().mockResolvedValue(undefined);
  trash.restoreTrashed.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  promote();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe('the personal-agent warning: "use your agents"', () => {
  it('accept is locked in place and sends nothing; the promote lets it accept', async () => {
    const onAccept = vi.fn();
    render(<PersonalAgentWarning agentName="Mine" onAccept={onAccept} onCancel={() => {}} />);
    await hold();
    const accept = screen.getByRole('button', { name: 'I understand, start it' });
    expectLocked(accept, line('use your agents'));
    fireEvent.click(accept);
    await flush();
    expect(onAccept).not.toHaveBeenCalled();
    expectNoLineTwice();
    promote();
    expect(shownLines(line('use your agents'))).toHaveLength(0);
    expectUnlocked(screen.getByRole('button', { name: 'I understand, start it' }));
    fireEvent.click(screen.getByRole('button', { name: 'I understand, start it' }));
    await flush();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});

describe('Create: Enhance says "enhance prompts"', () => {
  it('locked in place without its tooltip, a click sends nothing; the promote lets it enhance', async () => {
    const onPromptChange = vi.fn();
    render(<CreateComposer modelDef={null} prompt="a cat" params={{}} activeCount={0} maxConcurrent={4} quantity={1}
      onPromptChange={onPromptChange} onSelectModel={() => {}} onParamsChange={() => {}} onGenerate={() => {}}
      onAttach={() => {}} onQuantityChange={() => {}} onOpenStyles={() => {}} />);
    await hold();
    const button = document.querySelector<HTMLElement>('.create-composer__enhance')!;
    expectLocked(button, line('enhance prompts'));
    fireEvent.click(button);
    await flush();
    expect(enhance.enhancePrompt).not.toHaveBeenCalled();
    expectNoLineTwice();
    promote();
    expect(shownLines(line('enhance prompts'))).toHaveLength(0);
    const live = document.querySelector<HTMLElement>('.create-composer__enhance')!;
    expectUnlocked(live);
    expect(live.getAttribute('title')).toBe('Enhance prompt with AI');
    fireEvent.click(live);
    await flush();
    expect(enhance.enhancePrompt).toHaveBeenCalledWith('a cat');
  });
});

describe('the asset trash: "delete items for good"', () => {
  const words = line('delete items for good');
  const renderTrash = async () => {
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Recently deleted/ }));
  };

  it('Empty and every Delete forever point at the one line; neither arms while locked', async () => {
    await renderTrash();
    await hold();
    const lines = shownLines(words);
    expect(lines).toHaveLength(1);
    const empty = screen.getByRole('button', { name: 'Empty' });
    const forever = screen.getByRole('button', { name: 'Delete forever' });
    expect(expectLocked(empty, words)).toBe(lines[0]);
    expect(expectLocked(forever, words)).toBe(lines[0]);
    fireEvent.click(empty);
    fireEvent.click(forever);
    expect(screen.queryByRole('button', { name: 'Delete all' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'This can’t be undone.' })).toBeNull();
    expectNoLineTwice();
  });

  it('a confirm armed before a demote sends nothing; armed after the promote it sends', async () => {
    await renderTrash();
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    await hold();
    const all = screen.getByRole('button', { name: 'Delete all' });
    expectLocked(all, words);
    fireEvent.click(all);
    const forever = screen.getAllByRole('button', { name: 'Delete forever' }).find((button) => button.classList.contains('asset-trash__button--danger'))!;
    expectLocked(forever, words);
    fireEvent.click(forever);
    await flush();
    expect(trash.emptyTrash).not.toHaveBeenCalled();
    expect(trash.purgeTrashed).not.toHaveBeenCalled();
    promote();
    expect(shownLines(words)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    const live = screen.getByRole('button', { name: 'Delete all' });
    expectUnlocked(live);
    fireEvent.click(live);
    await flush();
    expect(trash.emptyTrash).toHaveBeenCalledTimes(1);
  });
});

describe('the project trash: "delete projects for good"', () => {
  const words = line('delete projects for good');
  const trashed = {
    id: 'old', name: 'Old sketch', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-09T12:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    deletedAt: '2026-10-10T11:00:00Z', purgeAt: '2099-11-09T11:00:00Z',
  };
  const renderHome = () => {
    const actions = { onPurge: vi.fn(), onEmptyTrash: vi.fn() };
    render(<ProjectHome projects={[]} loading={false} busy={false} error={null} onCreate={() => {}} onOpen={() => {}}
      onRename={() => {}} onDelete={() => {}} onRetry={() => {}} trash={[trashed]} {...actions} />);
    fireEvent.click(screen.getByRole('button', { name: /Recently deleted/ }));
    return actions;
  };

  it('Empty and Delete forever point at the one line; neither arms while locked', async () => {
    renderHome();
    await hold();
    const lines = shownLines(words);
    expect(lines).toHaveLength(1);
    const empty = screen.getByRole('button', { name: 'Empty' });
    const forever = screen.getByRole('button', { name: 'Delete forever' });
    expect(expectLocked(empty, words)).toBe(lines[0]);
    expect(expectLocked(forever, words)).toBe(lines[0]);
    fireEvent.click(empty);
    fireEvent.click(forever);
    expect(screen.queryByRole('button', { name: 'Delete all' })).toBeNull();
    expectNoLineTwice();
  });

  it('a confirm armed before a demote sends nothing; armed after the promote it sends', async () => {
    const actions = renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    await hold();
    const all = screen.getByRole('button', { name: 'Delete all' });
    expectLocked(all, words);
    fireEvent.click(all);
    const forever = document.querySelector<HTMLElement>('.project-home__trash-row .project-home__danger')!;
    expectLocked(forever, words);
    fireEvent.click(forever);
    expect(actions.onEmptyTrash).not.toHaveBeenCalled();
    expect(actions.onPurge).not.toHaveBeenCalled();
    promote();
    expect(shownLines(words)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    const live = document.querySelector<HTMLElement>('.project-home__trash-row .project-home__danger')!;
    expectUnlocked(live);
    fireEvent.click(live);
    expect(actions.onPurge).toHaveBeenCalledWith('old');
  });
});

describe('the Inspector: "change the model" and "save favorites"', () => {
  const setUp = (model: string) => {
    const configureOpenRouterModel = vi.fn();
    useGraphStore.setState({
      configureOpenRouterModel,
      nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
        data: { label: 'Chat', definitionId: 'openrouter-universal', params: { model }, state: 'idle', outputs: {} } }] as Node<NodeData>[],
      edges: [],
    } as never);
    useUIStore.getState().selectNode('n1');
    render(<Inspector embedded />);
    return configureOpenRouterModel;
  };
  const modelSelect = () => document.querySelector<HTMLElement>('.inspector__control-stack select.inspector__field')!;
  const star = () => document.querySelector<HTMLElement>('.inspector__favorite-button')!;

  it('the model picker: locked in place, a change sends nothing; the promote lets it change', async () => {
    const configure = setUp('acme/one');
    await flush();
    await hold();
    expectLocked(modelSelect(), line('change the model'));
    fireEvent.change(modelSelect(), { target: { value: 'acme/two' } });
    expect(configure).not.toHaveBeenCalled();
    promote();
    expect(shownLines(line('change the model'))).toHaveLength(0);
    expectUnlocked(modelSelect());
    fireEvent.change(modelSelect(), { target: { value: 'acme/two' } });
    expect(configure).toHaveBeenCalledWith('n1', 'acme/two', expect.objectContaining({ id: 'acme/two' }));
  });

  it('the star: locked without its tooltip, a click sends nothing; each lock has its one line', async () => {
    setUp('acme/one');
    await flush();
    await hold();
    expectLocked(star(), line('save favorites'));
    fireEvent.click(star());
    await flush();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(star().getAttribute('aria-pressed')).toBe('false');
    expectNoLineTwice();
    promote();
    expectUnlocked(star());
    expect(star().getAttribute('title')).toBe('Add favorite');
    fireEvent.click(star());
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ favorites: { openrouter: ['acme/one'] } });
    expect(star().getAttribute('aria-pressed')).toBe('true');
  });

  it('a refused save puts the star back and says why (GM r17 item 5)', async () => {
    api.updateSettings.mockRejectedValue(Object.assign(new Error('Only the person can do this.'), { code: PERSON_REQUIRED_CODE }));
    setUp('acme/one');
    await flush();
    fireEvent.click(star());
    await flush();
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(star().getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('alert').textContent).toMatch(/^Nebula couldn’t save the favorite because this tab isn’t connected as you\./);
  });
});
