/**
 * Q116 a) (Justin, 2026-10-23): "a): "Download your edits" plus "Continue
 * without them"." GM - Design's copy, verbatim:
 * - Heading: "Couldn’t save your edits."
 * - Buttons: "Download your edits" (primary) / "Continue without them"
 * - Confirm after "Continue without them": "Continue without your edits?
 *   They can’t be recovered after this." Buttons: "Continue without them" /
 *   "Cancel", with focus on Cancel.
 * - After a download: "Your edits are saved as {filename}. Open it from
 *   Projects to bring them back." Use whatever the real reopen path is called
 *   (it is Load graph, under Canvas actions on a project's canvas).
 * Announced as the screen's errors are (role="alert"), keyboard reachable,
 * and the confirm is an in-app dialog, never window.confirm.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps } from './ProjectHome';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const TOO_LARGE = 'These edits are too large for Nebula to save. Download them so nothing is lost, or continue without them.';
type Props = ProjectHomeProps & {
  unsavedEdits?: { reason: string; keptIn?: string; agentOpening?: { agent: string; projectName: string } } | null; editsSavedAs?: { name: string; reopens: boolean } | null;
  onDownloadEdits?: () => void; onContinueWithoutEdits?: () => void;
};
const props = (overrides: Partial<Props> = {}): Props => ({
  projects: [], loading: false, busy: false, error: null, retry: 'none',
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(),
  unsavedEdits: { reason: TOO_LARGE }, onDownloadEdits: vi.fn(), onContinueWithoutEdits: vi.fn(), ...overrides,
});
const Home = ProjectHome as unknown as (props: Props) => ReturnType<typeof ProjectHome>;

afterEach(() => vi.restoreAllMocks());

describe("Projects: Couldn’t save your edits.", () => {
  // GM - Design, 2026-10-24: when an agent's switch is what left the project,
  // "{agent} is opening “{name}”." goes above the screen's lines.
  it("an agent's switch: the agent and the project it opens, above the heading; the rest unchanged", () => {
    render(<Home {...props({ unsavedEdits: { reason: TOO_LARGE, keptIn: 'Glass campaign',
      agentOpening: { agent: 'Claude Code', projectName: 'Moodboard v2' } } })} />);
    const alert = screen.getByRole('alert');
    const opening = within(alert).getByText('Claude Code is opening “Moodboard v2”.');
    const heading = within(alert).getByText("Couldn’t save your edits.");
    expect(opening.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(alert).getByText(TOO_LARGE)).toBeTruthy();
    expect(within(alert).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['Download your edits', 'Continue without them']);
  });

  it('any other cause: no opening line', () => {
    render(<Home {...props({ unsavedEdits: { reason: TOO_LARGE, keptIn: 'Glass campaign' } })} />);
    expect(screen.getByRole('alert').textContent).not.toContain('is opening');
  });

  it("held from the open project's own canvas: the confirm says its nodes, connections and settings stay in that project (review)", () => {
    const actions = props({ unsavedEdits: { reason: TOO_LARGE, keptIn: 'Glass campaign' } });
    render(<Home {...actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without them' }));
    const dialog = screen.getByRole('alertdialog');
    const line = dialog.getAttribute('aria-labelledby') ? document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent : '';
    expect(line).toBe("Continue without them? “Glass campaign” keeps its nodes, connections and settings. "
      + 'Run history since the last save, and anything else only this tab has, will be lost.');
    expect(line).not.toContain("Continue without your edits? They can’t be recovered after this.");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue without them' }));
    expect(actions.onContinueWithoutEdits).toHaveBeenCalledTimes(1);
  });

  it("shows GM's heading, the reason and the two choices, announced as an alert, with no Try again", () => {
    render(<Home {...props()} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText("Couldn’t save your edits.")).toBeTruthy();
    expect(within(alert).getByText(TOO_LARGE)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Download your edits' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Continue without them' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    // Nothing else on the screen can act until the person chooses.
    expect((screen.getByRole('button', { name: 'New project' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Your first project starts here.')).toBeNull();
  });

  it('Download your edits is the primary choice and asks the store to write the file', () => {
    const actions = props();
    render(<Home {...actions} />);
    const download = screen.getByRole('button', { name: 'Download your edits' });
    expect(download.className).toMatch(/primary/);
    fireEvent.click(download);
    expect(actions.onDownloadEdits).toHaveBeenCalledTimes(1);
    expect(actions.onContinueWithoutEdits).not.toHaveBeenCalled();
  });

  it("Continue without them asks first in the app's own dialog, focused on Cancel", () => {
    const confirm = vi.spyOn(window, 'confirm');
    const actions = props();
    render(<Home {...actions} />);
    const trigger = screen.getByRole('button', { name: 'Continue without them' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('alertdialog', { name: "Continue without your edits? They can’t be recovered after this." });
    expect(within(dialog).getByRole('button', { name: 'Continue without them' })).toBeTruthy();
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    expect(confirm).not.toHaveBeenCalled();

    // Cancel: back to the two choices, nothing dropped.
    fireEvent.click(cancel);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(actions.onContinueWithoutEdits).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue without them' }));

    // Escape is Cancel too.
    fireEvent.click(screen.getByRole('button', { name: 'Continue without them' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(actions.onContinueWithoutEdits).not.toHaveBeenCalled();

    // Confirm drops them.
    fireEvent.click(screen.getByRole('button', { name: 'Continue without them' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Continue without them' }));
    expect(actions.onContinueWithoutEdits).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps Tab inside the confirm', () => {
    render(<Home {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without them' }));
    const dialog = screen.getByRole('alertdialog');
    const [first, last] = within(dialog).getAllByRole('button');
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('the choices wait while the download is under way', () => {
    render(<Home {...props({ busy: true })} />);
    expect((screen.getByRole('button', { name: 'Download your edits' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Continue without them' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("after a download: GM's line with the file's name and the real way to open it", () => {
    render(<Home {...props({ unsavedEdits: null, editsSavedAs: { name: 'Glass campaign - unsaved edits.nebula', reopens: true } })} />);
    const line = screen.getByText('Your edits are saved as Glass campaign - unsaved edits.nebula. Open it with “Load canvas” under “Canvas actions” in a new project to bring them back.');
    expect(line.closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByText("Couldn’t save your edits.")).toBeNull();
  });
});

const SAVED = 'Glass campaign - unsaved edits.nebula';
const REOPEN_LINE = `Your edits are saved as ${SAVED}. Open it with “Load canvas” under “Canvas actions” in a new project to bring them back.`;

describe('review: the line after a download, and where focus goes', () => {
  // Q118 (GM, 2026-10-23: "#178's TOO-LARGE LINE: yes, it goes. The Load
  // graph line covers every case now"): every download reads the Load graph line.
  it('every download reads the Load graph line, even one past a reader limit', () => {
    render(<Home {...props({ unsavedEdits: null, editsSavedAs: { name: SAVED, reopens: false } })} />);
    expect(screen.getByRole('status').textContent).toBe(REOPEN_LINE);
    expect(screen.queryByText(/too large for “Load canvas”/)).toBeNull();
  });

  it('after a download, focus moves to the line that says where the file went', async () => {
    const view = render(<Home {...props()} />);
    screen.getByRole('button', { name: 'Download your edits' }).focus();
    view.rerender(<Home {...props({ unsavedEdits: null, editsSavedAs: { name: SAVED, reopens: true } })} />);
    const line = screen.getByRole('status');
    await waitFor(() => expect(document.activeElement).toBe(line));
  });

  // GM r15: with the notice stack empty, focus goes to the start of the
  // page content, the "Recent projects" heading (no longer the page title).
  it('after Continue without them, focus moves to the Recent projects heading, not the page body', async () => {
    const view = render(<Home {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without them' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Continue without them' }));
    view.rerender(<Home {...props({ unsavedEdits: null })} />);
    const heading = screen.getByRole('heading', { name: 'Recent projects' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('a cancelled save picker gives focus back to Download your edits', async () => {
    const view = render(<Home {...props()} />);
    const download = screen.getByRole('button', { name: 'Download your edits' });
    download.focus();
    // A browser drops focus from a button that becomes disabled (jsdom
    // doesn't, and won't blur a disabled one, so it drops here first).
    download.blur();
    view.rerender(<Home {...props({ busy: true })} />);
    expect(document.activeElement).toBe(document.body);
    view.rerender(<Home {...props({ busy: false })} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Download your edits' })));
  });

  it("doesn't take focus from something the person moved to", async () => {
    const view = render(<><Home {...props()} /><input aria-label="Elsewhere" /></>);
    const elsewhere = screen.getByRole('textbox', { name: 'Elsewhere' });
    elsewhere.focus();
    view.rerender(<><Home {...props({ unsavedEdits: null, editsSavedAs: { name: SAVED, reopens: true } })} /><input aria-label="Elsewhere" /></>);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(elsewhere);
  });
});

/** GM - Design, 2026-10-23, verbatim (Q116 a, the three lines). */
describe("GM's lines", () => {
  const BILLING = "zz1: Changing how a Krea node is billed (_kreaAuth) is the person's call. Propose the change instead with propose_change (`nebula propose`).";
  const PERSON_LINE = "Couldn't recover the project. This change needs your OK, and this tab isn’t connected as you. Open the link Nebula printed when it started, then try again.";
  const NOT_WRITTEN = "The download didn’t save, so your edits are still only in this tab. Check that your disk has free space, then download them again, or continue without them.";

  it("GM's line 1 is gone (Q118): a big file opens with Load graph now", () => {
    render(<Home {...props({ unsavedEdits: null, editsSavedAs: { name: SAVED, reopens: false } })} />);
    expect(screen.getByRole('status').textContent).toBe(REOPEN_LINE);
  });

  it("a download that couldn't be written: the heading and both buttons stay, GM's line 2 is the body", () => {
    render(<Home {...props({ unsavedEdits: { reason: TOO_LARGE, downloadFailed: true } as never })} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText("Couldn’t save your edits.")).toBeTruthy();
    expect(within(alert).getByText(NOT_WRITTEN)).toBeTruthy();
    expect(within(alert).queryByText(TOO_LARGE)).toBeNull();
    expect(within(alert).getByRole('button', { name: 'Download your edits' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Continue without them' })).toBeTruthy();
  });

  it("a person-only refusal: GM's line 3 under the heading, the agents' text behind a closed Details, Try again kept", () => {
    const { container } = render(<Home {...props({ unsavedEdits: null, error: PERSON_LINE, retry: 'redo',
      errorDetails: BILLING } as never)} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(PERSON_LINE)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    const details = container.querySelector('.project-home__error details') as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector('summary')?.textContent).toBe('Details');
    expect(details!.textContent).toContain(BILLING);
    // The line itself is GM's alone.
    expect(alert.querySelector('span')?.textContent).toBe(PERSON_LINE);
  });

  it('an error with nothing behind it has no Details', () => {
    const { container } = render(<Home {...props({ unsavedEdits: null, error: "Couldn't load your projects.", retry: 'redo' })} />);
    expect(container.querySelector('details')).toBeNull();
  });
});
