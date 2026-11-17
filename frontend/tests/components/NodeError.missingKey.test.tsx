import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { NodeError, NodeRunError } from '../../src/components/nodes/NodeError';
import { validationReadings } from '../../src/lib/validationCopy';
import { PLAIN_MISSING_KEY_STOP_NODES, drawsAsMissingKey } from '../../src/lib/missingKeyTone';

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

  it('reads the error’s own kind for a run error shown by NodeRunError', () => {
    const data = { state: 'error', error: 'Missing API key: FAL_KEY', errorPerson: person, errorNotStarted: true, errorMissingKey: true } as const;
    const { container } = render(<NodeRunError data={data} className="cinema-scene-node__run-error" />);
    expect(container.firstElementChild?.className).toContain('model-node__error--key');
  });

  it('never reads the card’s key state: another failure on a node whose key is missing stays a failure', () => {
    const data = { state: 'error', error: 'boom', errorPerson: 'Something broke.', keyStatus: 'missing' } as const;
    const { container } = render(<NodeRunError data={data} className="cinema-scene-node__run-error" />);
    expect(container.firstElementChild?.className).not.toContain('model-node__error--key');
  });
});

describe('a refused run’s reading is a missing-key one only when every check on the node is', () => {
  const key = { nodeId: 'n1', portId: '', message: 'Missing API key: OPENAI_API_KEY', person: 'Add an OpenAI API key in Settings to run this node.', missingKey: true };
  const input = { nodeId: 'n1', portId: 'prompt', message: 'Missing input: prompt', person: 'Connect a prompt to this node.' };

  it('marks a node whose only check is its missing key', () => {
    expect(validationReadings([key]).byNode.get('n1')?.errorMissingKey).toBe(true);
  });

  it('leaves a node with a second failing check a failure', () => {
    expect(validationReadings([key, input]).byNode.get('n1')?.errorMissingKey).toBeUndefined();
    expect(validationReadings([input]).byNode.get('n1')?.errorMissingKey).toBeUndefined();
  });

  it('reads each node on its own', () => {
    const readings = validationReadings([key, { ...input, nodeId: 'n2' }]).byNode;
    expect(readings.get('n1')?.errorMissingKey).toBe(true);
    expect(readings.get('n2')?.errorMissingKey).toBeUndefined();
  });
});

// The four handlers that still raise a plain error for their own missing-key stop keep drawing neutral
// from the card's key state, until the follow-up pull request retires PLAIN_MISSING_KEY_STOP_NODES.
describe('the four plain missing-key stops draw neutral from the card’s key state', () => {
  const run = (definitionId: string) => ({
    state: 'error', error: 'WORLDLABS_API_KEY is required', errorPerson: 'Add a key in Settings.', definitionId, keyStatus: 'missing',
  }) as const;

  it('names exactly World Labs, Style reference, Idol and Veo', () => {
    expect([...PLAIN_MISSING_KEY_STOP_NODES]).toEqual(['worldlabs-environment', 'style-reference', 'speridlabs-idol', 'veo-3']);
  });

  it.each(PLAIN_MISSING_KEY_STOP_NODES)('%s draws neutral with keyStatus missing and no errorMissingKey flag', (id) => {
    const { container } = render(<NodeRunError data={run(id)} className="x__run-error" />);
    expect(container.firstElementChild?.className).toContain('model-node__error--key');
  });

  it('draws any other id with keyStatus missing and no flag as a failure', () => {
    const { container } = render(<NodeRunError data={run('gpt-image-2')} className="x__run-error" />);
    expect(container.firstElementChild?.className).not.toContain('model-node__error--key');
  });

  it('keeps a key that is not missing a failure on those four, and the flag neutral anywhere', () => {
    expect(drawsAsMissingKey({ definitionId: 'veo-3', keyStatus: 'ok' })).toBe(false);
    expect(drawsAsMissingKey({ definitionId: 'veo-3' })).toBe(false);
    expect(drawsAsMissingKey({ definitionId: 'gpt-image-2', errorMissingKey: true })).toBe(true);
  });
});
