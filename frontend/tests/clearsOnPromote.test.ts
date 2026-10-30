import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GM, PR #204 round 3: on the promote, every line whose only reason was "this
 * tab isn't connected as you" clears at once, wherever it sits; a line with
 * any other reason stays. The mechanism (lib/clearsOnPromote) and the
 * surfaces it was found missing from: the Updates list's "Couldn't mark the
 * updates as read…" (the review's stale line), a canvas toast, a Settings
 * row, the Projects screen.
 */

const notesApi = vi.hoisted(() => ({ markAgentNotesRead: vi.fn(), dismissAgentNote: vi.fn(), fetchAgentNotes: vi.fn() }));
vi.mock('../src/lib/agentNotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentNotes')>()),
  ...notesApi,
}));
const settingsApi = vi.hoisted(() => ({ updateSettings: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  ...settingsApi,
}));
const projectsApi = vi.hoisted(() => ({ pinProjectCover: vi.fn() }));
vi.mock('../src/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/projects')>()),
  ...projectsApi,
}));

const { clearLineOnPromote, clearsOnPromote, pendingPromoteClears } = await import('../src/lib/clearsOnPromote');
const { notePersonPromoted } = await import('../src/lib/personSession');
const { PERSON_REQUIRED_CODE, PERSON_REQUIRED_COPY, MARK_READ_REFUSED_COPY, RequestFailedError } = await import('../src/lib/errorCopy');
const { useAgentNotesStore } = await import('../src/store/agentNotesStore');
const { useGraphStore } = await import('../src/store/graphStore');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
const { saveField, resetSettingsWrites } = await import('../src/lib/settingsWrites');
const { useProjectStore } = await import('../src/store/projectStore');

const refused = (heading: string) => new RequestFailedError(heading, 403, { code: PERSON_REQUIRED_CODE, detail: 'agents read this' });
const otherwise = (heading: string) => new RequestFailedError(heading, 500, { detail: 'boom' });

beforeEach(() => {
  notePersonPromoted(); // nothing left from another test
  useAgentNotesStore.getState().reset();
  notesApi.markAgentNotesRead.mockReset();
  notesApi.dismissAgentNote.mockReset();
  notesApi.fetchAgentNotes.mockReset().mockResolvedValue({ projectId: 'p1', notes: [], unread: 0 });
  settingsApi.updateSettings.mockReset();
  projectsApi.pinProjectCover.mockReset();
  resetSettingsWrites();
});
afterEach(() => { notePersonPromoted(); });

describe('the mechanism', () => {
  it('a person-gate refusal\'s line goes on the promote; another reason\'s stays; a newer line stays', () => {
    let line: string | null = 'A';
    expect(clearLineOnPromote(refused('x'), () => line, 'A', () => { line = null; })).toBe(true);
    expect(clearLineOnPromote(otherwise('x'), () => line, 'A', () => { line = null; })).toBe(false);
    notePersonPromoted();
    expect(line).toBeNull();

    line = 'B';
    clearLineOnPromote(refused('x'), () => line, 'B', () => { line = null; });
    line = 'C'; // something else happened since, for another reason
    notePersonPromoted();
    expect(line).toBe('C');
  });

  it('sweeps each line once, and a clear that throws doesn\'t stop the others', () => {
    const seen: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clearsOnPromote(() => { throw new Error('gone'); });
    clearsOnPromote(() => { seen.push('kept going'); });
    expect(pendingPromoteClears()).toBe(2);
    notePersonPromoted();
    notePersonPromoted();
    expect(seen).toEqual(['kept going']);
    expect(pendingPromoteClears()).toBe(0);
  });
});

describe('the surfaces', () => {
  const surface = { kind: 'canvas' as const, projectId: null };

  it('the Updates list: "Couldn\'t mark the updates as read…" (refused, not connected) goes on the promote', async () => {
    notesApi.markAgentNotesRead.mockRejectedValue(refused("Couldn't mark the updates as read."));
    await useAgentNotesStore.getState().markRead(surface);
    // GM, #204 r3 item 3: its own line, no "then try again" (the promote retries it).
    expect(useAgentNotesStore.getState().error).toBe(MARK_READ_REFUSED_COPY);
    notePersonPromoted();
    expect(useAgentNotesStore.getState().error).toBeNull();
  });

  it('the Updates list: a read that failed for another reason keeps its line', async () => {
    notesApi.markAgentNotesRead.mockRejectedValue(otherwise("Couldn't mark the updates as read."));
    await useAgentNotesStore.getState().markRead(surface);
    const line = useAgentNotesStore.getState().error;
    expect(line).toBeTruthy();
    notePersonPromoted();
    expect(useAgentNotesStore.getState().error).toBe(line);
  });

  it('a canvas toast saying GM\'s person line goes on the promote; another toast stays', () => {
    useGraphStore.setState({ undoNotice: null, messageNotice: null } as never);
    useGraphStore.getState().notify(`Couldn't set up “Chat”. ${PERSON_REQUIRED_COPY}`);
    expect(useGraphStore.getState().undoNotice?.text).toContain(PERSON_REQUIRED_COPY);
    notePersonPromoted();
    expect(useGraphStore.getState().undoNotice).toBeNull();

    useGraphStore.getState().notify("Couldn't set up “Chat”.", 'error', { error: otherwise('x') });
    notePersonPromoted();
    expect(useGraphStore.getState().undoNotice?.text).toBe("Couldn't set up “Chat”.");
  });

  it('a canvas toast for the model route\'s refusal (its own words) goes on the promote', () => {
    useGraphStore.setState({ undoNotice: null, messageNotice: null } as never);
    useGraphStore.getState().notify("Couldn't change the model.", 'error', { error: { code: PERSON_REQUIRED_CODE } });
    notePersonPromoted();
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it('a Settings row refused for not being connected goes on the promote', async () => {
    useSettingsDraftStore.setState({ errors: {}, pending: {} } as never);
    settingsApi.updateSettings.mockRejectedValue(refused("Couldn't save your settings."));
    await saveField('outputPath' as never, '/tmp/x' as never);
    expect(useSettingsDraftStore.getState().errors.outputPath).toBeTruthy();
    notePersonPromoted();
    expect(useSettingsDraftStore.getState().errors.outputPath).toBeUndefined();
  });

  it('the Projects screen: a cover pin refused for not being connected goes, with its Try again', async () => {
    useProjectStore.setState({ error: null, errorRetry: null, errorDetails: null, projects: [] } as never);
    projectsApi.pinProjectCover.mockRejectedValue(refused("Couldn't change the cover."));
    await useProjectStore.getState().pinCover('p1', '/api/outputs/a.png');
    expect(useProjectStore.getState().error).toContain(PERSON_REQUIRED_COPY);
    notePersonPromoted();
    expect(useProjectStore.getState()).toMatchObject({ error: null, errorRetry: null, errorDetails: null });
  });
});
