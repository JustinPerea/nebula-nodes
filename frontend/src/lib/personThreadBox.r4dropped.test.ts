import { describe, expect, it } from 'vitest';
import { sanitizeRow, type ThreadRow } from './personThread';
import { listenerDroppedLine, messageStatus, nextStatusChange, runOrigin } from './personThreadBox';

/** #225 review 2, boundary LOW-1: the person revoked the listener's token before it took the message. */

const CLAUDE_CODE = { id: 'app:claude1', name: 'Claude Code', color: '#E8825A', verified: true };

function dropped(): ThreadRow {
  const row = sanitizeRow({
    id: 'pm_1', kind: 'message', at: 1_000, text: 'warmer', nodeIds: [], state: 'dropped',
    to: { listenerId: 'ch_1', agent: CLAUDE_CODE, session: { key: '0123456789ab', ordinal: 1 } },
  });
  if (!row) throw new Error('row');
  return row;
}

describe('a message its listener can never take', () => {
  it('keeps its dropped state from the socket', () => {
    expect(dropped().state).toBe('dropped');
  });

  it('reads the send-time "stopped listening" line, at once and for good', () => {
    const status = messageStatus(dropped(), 1_001, { replied: false, activity: null, label: 'Claude Code' });
    expect(status).toEqual({ kind: 'dropped', text: listenerDroppedLine('Claude Code') });
    expect(status?.text).toBe('Nebula couldn’t send your message because Claude Code stopped listening. '
      + 'Reconnect it in the terminal, then send it again.');
    expect(nextStatusChange(dropped(), 1_001, null)).toBeNull();
  });

  it('is never the open run its working fold waits on', () => {
    expect(runOrigin([dropped()], [])).toBeNull();
  });
});
