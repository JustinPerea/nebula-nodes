/**
 * GM r14 (5), PR #204 round 9: Settings' Connect while this tab isn't connected as the person.
 * The server refuses it (backend/main.py create_agent_app: require_person, a 403
 * person_required), so it locks in place (aria-disabled, focusable, the held cards' first-moment
 * rule) with "You can connect an agent when this tab is connected as you." under it ("window" in
 * the app), no tooltip, and unlocks on the promote. The agent/person gate is unchanged.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const createConnectedApp = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  createConnectedApp: (...args: unknown[]) => createConnectedApp(...args),
}));

const { ConnectedApps } = await import('../src/components/panels/settings/ConnectedApps');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { connectAgentLockCopy } = await import('../src/lib/errorCopy');

const LINE = 'You can connect an agent when this tab is connected as you.';

beforeEach(() => { resetPersonSessionForTests(); createConnectedApp.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const connect = () => screen.getByRole('button', { name: 'Connect' });

describe('GM r14 (5): Connect locks while this tab isn\'t connected as you', () => {
  it('the words: "tab" in a browser, "window" in the app', () => {
    expect(connectAgentLockCopy(false)).toBe(LINE);
    expect(connectAgentLockCopy(true)).toBe('You can connect an agent when this window is connected as you.');
  });

  it('held: locked in place with the line under it, no tooltip, and a click sends nothing', () => {
    act(() => reportPersonRequired());
    render(<ConnectedApps view={null} loadError={null} onChanged={() => {}} />);
    const button = connect();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    const line = document.getElementById(button.getAttribute('aria-describedby')!)!;
    expect(line.textContent).toBe(LINE);
    expect(line.className).toBe('settings-apps__held-line');
    fireEvent.click(button);
    fireEvent.submit(button.closest('form')!);
    expect(createConnectedApp).not.toHaveBeenCalled();
  });

  it('the promote unlocks it and the line goes', () => {
    act(() => reportPersonRequired());
    render(<ConnectedApps view={null} loadError={null} onChanged={() => {}} />);
    act(() => notePersonPromoted());
    expect(connect().hasAttribute('aria-disabled')).toBe(false);
    expect(connect().hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it('a fresh page before the socket answers: locked without the grey or the line, for the first moment', () => {
    vi.useFakeTimers();
    resetPersonSessionForTests({ unanswered: true });
    render(<ConnectedApps view={null} loadError={null} onChanged={() => {}} />);
    expect(connect().getAttribute('aria-disabled')).toBe('true');
    expect(connect().hasAttribute('data-held-pending')).toBe(true);
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it('the server refuses it: create_agent_app requires the person', () => {
    const main = readFileSync(join(__dirname, '..', '..', 'backend', 'main.py'), 'utf8');
    const route = main.slice(main.indexOf('@app.post("/api/agent/spend/apps")'));
    const body = route.slice(0, route.indexOf('\n@app.'));
    expect(body).toMatch(/async def create_agent_app[\s\S]*?\n {4}require_person\(current_request_headers\(\)\)/);
  });
});
