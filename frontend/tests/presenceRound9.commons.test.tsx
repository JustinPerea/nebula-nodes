/**
 * PR #204 round 9 (the coordinator, after GM r12 (2)): a Commons because line ("Nebula couldn’t …
 * because this tab isn’t connected as you. …") must not stay on screen once the tab is connected.
 * On the promote the line clears and the Commons loads what the refusal stopped: the references
 * load and the status line reads as it normally does. On a held page (the tab never had the
 * person's token) and on a normal page (the backend forgot the token: a 401) alike.
 *
 * And structurally: every Commons screen sets a failure line only through useCommonsLine, which
 * registers it (and a load's retry) with lib/clearsOnPromote.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), token: null as string | null }));
vi.mock('../src/lib/backend', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/personSession')>(),
  personToken: async () => transport.token,
}));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsSettings', () => ({ CommonsSettings: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests, personGateHeld } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { pendingPromoteClears, pendingPromoteRetries } = await import('../src/lib/clearsOnPromote');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');

const TOKEN = 'a'.repeat(43);
const ROW = {
  id: 'r1', membership_id: 'm1', collection_id: 'c1', collection: 'Refs', summary: 'A lighthouse', role: 'neutral',
  media: 'image', made_by: 'person', analysis_state: 'ready', in_inbox: false, comment_count: 0, matched: [], score: 1,
  blob_key: 'b1', also_in: [],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** The backend: 401 for every Commons call while `forgotten`, else the library. */
const backend = { forgotten: false };
function answer(path: string): Response {
  if (backend.forgotten) return json({ detail: 'no person session' }, 401);
  if (path.endsWith('/status')) return json({ worker: { running: false, state: 'idle' }, queue: {} });
  if (path.endsWith('/collections')) return json([{ id: 'c1', name: 'Refs', kind: 'user' }]);
  if (path.endsWith('/search')) return json({ results: [ROW] });
  return json({});
}

const notConnected = () => document.querySelector('[data-commons-line="not-connected"]');

beforeEach(() => {
  vi.useRealTimers();
  resetPersonSessionForTests();
  resetCommonsSessionForTests();
  resetLinesForTests();
  backend.forgotten = false;
  transport.token = null;
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (path: string) => answer(path));
});
afterEach(() => { cleanup(); });

async function promote() {
  transport.token = TOKEN;
  backend.forgotten = false;
  await act(async () => { notePersonPromoted(); });
}

describe('PR #204 round 9: a Commons not-connected line clears on the promote, and the Commons loads', () => {
  it('a held page (no person token): the because line, then on the promote it goes and the references load', async () => {
    act(() => reportPersonRequired());
    expect(personGateHeld()).toBe(true);
    render(<CommonsView />);
    await waitFor(() => expect(notConnected()?.textContent).toMatch(/^Nebula couldn’t .+ because this tab isn’t connected as you\. Open the link Nebula printed when it started\.$/));
    expect(document.querySelector('[data-commons-tile]')).toBeNull();
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(pendingPromoteRetries()).toBeGreaterThan(0);
    await promote();
    await waitFor(() => expect(document.querySelectorAll('[data-commons-tile]')).toHaveLength(1));
    expect(notConnected()).toBeNull();
    expect(document.querySelector('.commons-messages')).toBeNull();
    // The status line reads as it normally does (not "Connecting…").
    await waitFor(() => expect(document.querySelector('.commons-status')?.textContent).not.toMatch(/Connecting/));
    expect(pendingPromoteRetries()).toBe(0);
  });

  it('a normal page (the backend forgot the token: 401): the same line, then the promote clears it and loads', async () => {
    transport.token = TOKEN;
    backend.forgotten = true;
    render(<CommonsView />);
    await waitFor(() => expect(notConnected()).not.toBeNull());
    expect(personGateHeld()).toBe(false);
    await promote();
    await waitFor(() => expect(document.querySelectorAll('[data-commons-tile]')).toHaveLength(1));
    expect(notConnected()).toBeNull();
    expect(transport.fetch.mock.calls.some(([path]) => String(path).endsWith('/search'))).toBe(true);
  });

  it('a call sent before the promote and refused after it: its line clears at once (stamped when sent)', async () => {
    transport.token = TOKEN;
    let answerLate: (response: Response) => void = () => {};
    transport.fetch.mockImplementation(async (path: string) => (path.endsWith('/search')
      ? new Promise<Response>((resolve) => { answerLate = resolve; })
      : answer(path)));
    render(<CommonsView />);
    await waitFor(() => expect(transport.fetch.mock.calls.some(([path]) => String(path).endsWith('/search'))).toBe(true));
    await act(async () => { notePersonPromoted(); });
    transport.fetch.mockImplementation(async (path: string) => answer(path));
    // The old state's answer (the backend had forgotten the token), twice: its resend is refused too.
    backend.forgotten = true;
    await act(async () => { answerLate(json({ detail: 'no person session' }, 401)); });
    await waitFor(() => expect(transport.fetch.mock.calls.filter(([path]) => String(path).endsWith('/search')).length).toBe(2));
    backend.forgotten = false;
    transport.token = TOKEN;
    await waitFor(() => expect(notConnected()).toBeNull());
    expect(document.querySelectorAll('[data-commons-tile]')).toHaveLength(1);
  });

  it('a line for another reason stays through the promote', async () => {
    transport.token = TOKEN;
    transport.fetch.mockImplementation(async (path: string) => (path.endsWith('/search') ? json({ detail: 'boom' }, 500) : answer(path)));
    render(<CommonsView />);
    await waitFor(() => expect(document.querySelector('[data-commons-line="error"]')).not.toBeNull());
    const before = document.querySelector('[data-commons-line="error"]')!.textContent;
    await promote();
    expect(document.querySelector('[data-commons-line="error"]')?.textContent).toBe(before);
  });

  it('the status poll, refused every few seconds while the tab waits, keeps one registration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => reportPersonRequired());
    render(<CommonsView />);
    await vi.waitFor(() => expect(notConnected()).not.toBeNull());
    // The three loads (collections, status, the debounced search) each put up their line once.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const after = pendingPromoteClears();
    expect(after).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(pendingPromoteClears()).toBe(after);
    vi.useRealTimers();
  });
});

const COMMONS_DIR = join(__dirname, '..', 'src', 'components', 'commons');

/** Each Commons screen's failure line set some way other than useCommonsLine. */
export function linesOutsideTheHook(files: { name: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const { name, text } of files) {
    if (name === 'useCommonsLine.ts') continue;
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        // A line setter (setError, setLoadError, setImageError, ...) handed anything but a literal.
        if (/^set\w*Error$/.test(callee) && node.arguments.length === 1) {
          const arg = node.arguments[0];
          const literal = ts.isStringLiteralLike(arg) || arg.kind === ts.SyntaxKind.NullKeyword;
          if (!literal) found.push(`${name}: ${node.getText(source)}`);
        }
        // failureMessage only where its failure travels with it (a scan's outcome carries `cause`).
        if (callee === 'failureMessage') {
          const holder = node.parent;
          const carried = ts.isPropertyAssignment(holder) && ts.isObjectLiteralExpression(holder.parent)
            && holder.parent.properties.some((property) => property.name?.getText(source) === 'cause');
          if (!carried) found.push(`${name}: ${node.getText(source)}`);
        }
        // A line put in some other state (`setMedia({ error: … })`).
        if (/^set[A-Z]/.test(callee) && node.arguments.some((arg) => ts.isObjectLiteralExpression(arg)
          && arg.properties.some((property) => /error|message|line/i.test(property.name?.getText(source) ?? '')))) {
          found.push(`${name}: ${node.getText(source)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('PR #204 round 9: every Commons screen\'s line goes through useCommonsLine', () => {
  const files = readdirSync(COMMONS_DIR).filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
    .map((name) => ({ name, text: readFileSync(join(COMMONS_DIR, name), 'utf8') }));

  it('no screen sets a failure line itself', () => {
    expect(linesOutsideTheHook(files)).toEqual([]);
  });

  it('each screen with a line uses the hook', () => {
    for (const name of ['CommonsView.tsx', 'CommonsDetail.tsx', 'CommonsEvaluation.tsx', 'CommonsReview.tsx', 'CommonsSettings.tsx', 'CommonsCloseBatch.tsx', 'CommonsMedia.tsx']) {
      expect(files.find((file) => file.name === name)!.text, name).toMatch(/useCommonsLine\(/);
    }
  });

  it('catches each way round it', () => {
    const probe = (body: string) => linesOutsideTheHook([{ name: 'P.tsx', text: `function P() { ${body} }` }]);
    expect(probe('setError(failureMessage(e, "Couldn’t x."));')).toHaveLength(2);
    expect(probe('setLoadError(line);')).toHaveLength(1);
    expect(probe('setImageError(failure.message);')).toHaveLength(1);
    expect(probe('setMedia({ path, error: text });')).toHaveLength(1);
    expect(probe('const o = { error: failureMessage(e, "x") };')).toHaveLength(1);
    expect(probe('setError(\'\'); setError(null); setError(\'Pick a collection.\');')).toHaveLength(0);
    expect(probe('settle({ error: failureMessage(e, "x"), cause: e });')).toHaveLength(0);
    expect(probe('line.show(e, "Couldn’t x.");')).toHaveLength(0);
  });
});
