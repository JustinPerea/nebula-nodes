import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { NodeError, NodeRunError } from '../../src/components/nodes/NodeError';

// Copy sweep item 12: a missing key is something to do, not a failure, so its run error draws neutral.
describe('a missing-key run error draws neutral', () => {
  const person = 'Add an OpenAI API key in Settings to run this node.';

  it('takes the key tone when the card knows its key is missing', () => {
    const { container } = render(<NodeError raw="Missing API key: OPENAI_API_KEY" person={person} notStarted missingKey />);
    expect(container.firstElementChild?.className).toBe('model-node__error model-node__error--key');
    expect(container.textContent).toContain(person);
  });

  it('keeps the error look for any other failure', () => {
    const { container } = render(<NodeError raw="boom" person="Something broke." />);
    expect(container.firstElementChild?.className).toBe('model-node__error');
  });

  it('reads the card key state for a run error shown by NodeRunError', () => {
    const data = { state: 'error', error: 'Missing API key: FAL_KEY', errorPerson: person, errorNotStarted: true, keyStatus: 'missing' } as const;
    const { container } = render(<NodeRunError data={data} className="cinema-scene-node__run-error" />);
    expect(container.firstElementChild?.className).toContain('model-node__error--key');
  });
});
