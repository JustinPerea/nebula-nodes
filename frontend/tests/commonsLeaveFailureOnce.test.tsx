import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommonsErrorLine } from '../src/components/commons/CommonsErrorLine';
import { CommonsLeavePopover } from '../src/components/commons/CommonsLeavePopover';
import { CommonsLeaveFailure, leaveFailureFor, type LeaveAsking } from '../src/components/commons/commonsLeave';

afterEach(cleanup);

const FAILURE = 'Nebula couldn’t save your labels because the server hit an error. Try again.';
const asking = (failure: string | null, panel: LeaveAsking['panel'] = null): LeaveAsking => ({ anchor: null, failure, panel, retry: true, pending: false, slow: false, seq: 1 });

/** The popover over a panel whose own notice holds the same sentence (what a failed Save and leave leaves behind). */
const view = (open: string | null) => render(
  <CommonsLeaveFailure.Provider value={open}>
    <CommonsErrorLine line={FAILURE} />
    {open !== null && <CommonsLeavePopover asking={asking(open)} unsaved running={false} onChoose={vi.fn()} onStay={vi.fn()} />}
  </CommonsLeaveFailure.Provider>,
);

describe('design: the leave failure shows once, in the popover where the person acted', () => {
  it('while the popover shows the failure, the panel behind it does not say the same line', () => {
    view(FAILURE);
    expect(screen.getAllByText(FAILURE)).toHaveLength(1);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(FAILURE);
    // The popover keeps the alert role on its line.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('after Stay (the popover closed) the failure still stands, so the panel says it again', () => {
    view(null);
    expect(screen.getAllByText(FAILURE)).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(FAILURE);
  });

  it('a different line in the panel is not hidden by the popover', () => {
    const other = 'Nebula couldn’t load Blind labeling because the server didn’t respond. Try again.';
    render(
      <CommonsLeaveFailure.Provider value={FAILURE}>
        <CommonsErrorLine line={other} />
      </CommonsLeaveFailure.Provider>,
    );
    expect(screen.getByText(/couldn’t load Blind labeling/)).toBeInTheDocument();
  });

  it('only the panel that failed stands down: the other panel\'s identical sentence still shows', () => {
    const open = asking(FAILURE, 'labeling');
    render(
      <>
        <CommonsLeaveFailure.Provider value={leaveFailureFor(open, 'labeling')}>
          <div data-testid="labeling"><CommonsErrorLine line={FAILURE} /></div>
        </CommonsLeaveFailure.Provider>
        <CommonsLeaveFailure.Provider value={leaveFailureFor(open, 'review')}>
          <div data-testid="review"><CommonsErrorLine line={FAILURE} /></div>
        </CommonsLeaveFailure.Provider>
      </>,
    );
    expect(screen.getByTestId('labeling')).toBeEmptyDOMElement();
    expect(screen.getByTestId('review')).toHaveTextContent(FAILURE);
    expect(leaveFailureFor(asking(null), 'review')).toBeNull();
    expect(leaveFailureFor(null, 'review')).toBeNull();
  });

  it('CommonsView gives each panel the failure only when that panel failed', () => {
    const source = readFileSync(resolve(__dirname, '../src/components/commons/CommonsView.tsx'), 'utf8');
    expect(source).toMatch(/<CommonsLeaveFailure\.Provider value=\{leaveFailureFor\(leave\.asking, 'review'\)\}>[\s\S]*<CommonsReview/);
    expect(source).toMatch(/<CommonsLeaveFailure\.Provider value=\{leaveFailureFor\(leave\.asking, 'labeling'\)\}>[\s\S]*<CommonsEvaluation/);
  });
});
