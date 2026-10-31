/**
 * PR #204 round 11 (review 9 lock-sweep LOW-6): the runtime ratchet (tests/helpers/bareLines.ts)
 * closes the three bypasses the review found, each caught here, beside controls that still pass.
 * - P1: a bare "connected as you" text beside a <LineText> in the same parent (before or after
 *   it, or in a child element) passed because the parent was registered.
 * - P2: data-agent-text on any element exempted it; only the two Update texts are an agent's.
 * - P3: a line in a `title` (a tooltip) or an `aria-label` was never read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { LineText } from '../src/components/LineText';
import { notConnectedBecause, personRequiredCopy } from '../src/lib/errorCopy';
import { resetLinesForTests } from '../src/lib/notConnectedLine';
import { takeBareLines } from './helpers/bareLines';

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
afterEach(() => { cleanup(); resetLinesForTests(); });

async function seen(ui: React.ReactElement): Promise<string[]> {
  takeBareLines();
  render(ui);
  await settle();
  return takeBareLines();
}

const line = notConnectedBecause('save', false);
const other = notConnectedBecause('delete this', false);

describe('review 9 LOW-6: each bypass is caught', () => {
  const forms: [string, () => React.ReactElement][] = [
    ['P1 a bare line before a LineText in the same parent', () => <p>{other} <LineText text={line} /></p>],
    ['P1 a bare line after a LineText in the same parent', () => <p><LineText text={line} /> {other}</p>],
    ['P1 a bare line in a child element of a registered parent', () => <p><LineText text={line} /><em>{other}</em></p>],
    ['P1 other words laid out in an element before a LineText\'s anchor', () => <p><LineText text={line}><code>{other}</code></LineText></p>],
    ['P2 data-agent-text on an element that is not an Update', () => <p data-agent-text="">{line}</p>],
    ['P2 data-agent-text on an Update class without the attribute', () => <p className="agent-note-card__text">{line}</p>],
    ['P3 a title', () => <button title={line}>Save</button>],
    ['P3 an aria-label', () => <button aria-label={line}>Save</button>],
    ['P3 a title on a registered element', () => <p title={line}><LineText text={line} /></p>],
  ];
  for (const [name, ui] of forms) {
    it(name, async () => {
      expect((await seen(ui())).length, name).toBe(1);
    });
  }
  it('P3 a title set after render (the observer watches the attribute)', async () => {
    takeBareLines();
    const { container } = render(<button>Save</button>);
    await settle();
    expect(takeBareLines()).toEqual([]);
    act(() => { container.querySelector('button')!.setAttribute('title', line); });
    await settle();
    expect(takeBareLines()).toEqual([`title: ${line}`]);
  });
});

describe('review 9 LOW-6: the registered forms still pass', () => {
  it('LineText alone, its own-span form, its children form, the notice and an Update\'s quote', async () => {
    expect(await seen(<>
      <p>Couldn’t save. <LineText text={line} /></p>
      <span className="label">Couldn’t save. <LineText text={line} className="own" /></span>
      <p><LineText text={line}><span>Nebula couldn’t save</span> because this tab isn’t connected as you.</LineText></p>
      <p><LineText text={line}><code>Nebula couldn’t save because this tab isn’t connected as you.</code></LineText></p>
      <div className="person-required" title={personRequiredCopy()}>{personRequiredCopy()}</div>
      <p className="agent-note-card__text" data-agent-text="">{`The tab said: “${line}”`}</p>
      <p className="agent-notes-entry__text" data-agent-text="">{`The tab said: “${line}”`}</p>
      <button title="Save" aria-label="Save">Save</button>
    </>)).toEqual([]);
  });
});
