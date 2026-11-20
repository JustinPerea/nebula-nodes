import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PaperRunInspection } from '../src/components/panels/PaperRunInspection';
import type { RunRecord } from '../src/lib/runHistory';
import { writtenDateTime } from '../src/lib/writtenDateTime';

describe('PaperRunInspection', () => {
  it('writes the snapshot time as a written date and time, not the stored ISO text', () => {
    const capturedAt = new Date(2025, 9, 1, 15, 4, 59).toISOString();
    const record = { id: 'run-1', paperInputs: [{ nodeId: 'p1', snapshot: { id: 's', hash: 'h', capturedAt, width: 4, height: 3, previewUrl: '/a.png',
      identity: { objectName: 'Frame' }, exportSettings: { scale: 1 } } }] } as unknown as RunRecord;
    render(<PaperRunInspection record={record} />);
    expect(screen.getByText(new RegExp(`^${writtenDateTime(capturedAt)} · 4 × 3`))).toBeInTheDocument();
    expect(screen.getByText(/October 1, 2025, 3:04 PM/)).toBeInTheDocument();
    expect(screen.queryByText(/T\d\d:\d\d:\d\d/)).toBeNull();
  });
});
