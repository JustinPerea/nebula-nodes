import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TabLoadBoundary } from '../src/components/panels/Settings';

// The Settings tabs load when the panel opens (Settings.tsx). A tab whose code
// can't load, as after a rebuild that removed the chunk an open tab asks for,
// must say so inside the panel and leave the rest of the app standing. React
// hands a rejected lazy() load to the nearest error boundary the same way as a
// render error, so a tab that throws stands in for it here.

function BrokenTab(): never {
  throw new Error('Failed to fetch dynamically imported module');
}

describe('TabLoadBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a failed tab inside the panel and keeps what is around it', () => {
    // React reports the caught error; the boundary is what this test checks.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div role="dialog" aria-label="Settings">
        <TabLoadBoundary><BrokenTab /></TabLoadBoundary>
      </div>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      "This part of Settings couldn't load. Reload the tab to try again.",
    );
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  it('renders a tab that loads', () => {
    render(<TabLoadBoundary><p>Storage</p></TabLoadBoundary>);
    expect(screen.getByText('Storage')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
