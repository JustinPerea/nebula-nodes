/**
 * PR #204 round 13 (review 10 MEDIUM-2): useFocusHandover finds "the same control" again by more
 * than aria-label, name or id. A keyed pane still remounts on a demote and the promote (a
 * reference's detail, Commons Settings), and its fields often have none of those: a select or
 * checkbox inside a <label>, or a field named by aria-labelledby. Focus on one comes back to its
 * new twin, never to the line or the heading.
 */
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useFocusHandover } from '../src/hooks/useFocusHandover';

function Pane({ loaded }: { loaded: boolean }) {
  return (
    <>
      {/* Its options come with the data (none on the demoted tab): its name is the label's word. */}
      <label>Collection<select><option>All collections</option>{loaded && <option>Refs</option>}</select></label>
      <label>Media<select><option>Any</option><option>Image</option></select></label>
      <label>Role<select><option>Any</option></select></label>
      <label><input type="checkbox" />Corrected only</label>
      <span id="cap-label">Calls per day</span>
      <input aria-labelledby="cap-label" />
    </>
  );
}

function Harness({ view }: { view: string }) {
  const root = useRef<HTMLDivElement>(null);
  const handover = useFocusHandover(view, () => root.current, () => root.current?.querySelector('h2') ?? null);
  return (
    <div ref={root} onFocus={handover.onFocus}>
      <h2 tabIndex={-1}>Settings</h2>
      <Pane key={view} loaded={view !== 'demoted'} />
    </div>
  );
}

afterEach(cleanup);

describe('the handover finds an unlabelled field again by the words that label it', () => {
  const cases: Array<[string, (root: ParentNode) => HTMLElement]> = [
    ['a select whose options change with the data (Collection)', (root) => root.querySelectorAll('select')[0] as HTMLElement],
    ['a select in a <label> (Media), not the one before it', (root) => root.querySelectorAll('select')[1] as HTMLElement],
    ['the third select (Role)', (root) => root.querySelectorAll('select')[2] as HTMLElement],
    ['a checkbox in a <label>', (root) => root.querySelector('input[type="checkbox"]') as HTMLElement],
    ['a field named by aria-labelledby', (root) => root.querySelector('input[aria-labelledby]') as HTMLElement],
  ];
  for (const [name, find] of cases) {
    it(`${name}: focus moves to its remounted twin`, () => {
      const view = render(<Harness view="live-0" />);
      const before = find(document);
      act(() => before.focus());
      expect(document.activeElement).toBe(before);
      view.rerender(<Harness view="demoted" />);
      const after = find(document);
      expect(after).not.toBe(before);
      expect(before.isConnected).toBe(false);
      expect(document.activeElement).toBe(after);
    });
  }
});
