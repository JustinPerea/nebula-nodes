import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReferenceTray } from '../../src/components/create-studio/ReferenceTray';
import type { CreateDraftUpload } from '../../src/store/createDraftStore';

afterEach(cleanup);

const LOST = 'Nebula couldn’t upload “a.png” because the server isn’t answering. Check that Nebula is running, then try again.';
const failed = (error: string): CreateDraftUpload => ({ id: 'u1', name: 'a.png', status: 'error', error, attempt: '1' });

describe('the upload chip’s line beside its button', () => {
  it('ends “Try again.” beside a Try again button, whatever the line said before', () => {
    render(<ReferenceTray refs={[]} uploads={[failed(LOST)]} canRetry={() => true} />);
    expect(screen.getByRole('button', { name: 'Try again to upload “a.png”' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Nebula couldn’t upload “a.png” because the server isn’t answering. Try again.');
  });

  it('keeps the line as written beside Attach again, which is not a Try again button', () => {
    render(<ReferenceTray refs={[]} uploads={[failed(LOST)]} canRetry={() => false} />);
    expect(screen.getByRole('button', { name: 'Attach again a.png' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(LOST);
  });
});
