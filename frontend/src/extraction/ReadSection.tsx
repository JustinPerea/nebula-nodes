import { useState } from 'react'
import { Origin } from './Origin'
import { FAKE_MODEL, modelTag } from './read'
import { readTime } from './format'
import type { ExtractionRecord } from './types'

export const CONFIRM_LINE = 'This sends the image to Claude through the Claude CLI and uses your Claude usage.'

/**
 * The "Read by Claude" section. A read uses the person's Claude usage, so the button only opens a
 * confirm; nothing is requested until the person presses Read there.
 */
export function ReadSection({ record, onRead }: {
  record: ExtractionRecord
  onRead: (again: boolean) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const read = record.structure.read
  const requests = record.read_requests ?? []

  const go = async () => {
    setRunning(true)
    try {
      await onRead(read !== null)
    } finally {
      setRunning(false)
      setConfirming(false)
    }
  }

  return (
    <section>
      <h2 className="ex-label">Read by Claude</h2>
      {read?.model === FAKE_MODEL ? (
        <p className="ex-notice" data-fake-reading>
          The development reader wrote this reading from a file, not Claude. Read again with the real reader before
          you rely on it.
        </p>
      ) : null}
      {read ? (
        <p className="ex-read-line">
          <span className="ex-mono">{read.model}</span>
          {read.model === FAKE_MODEL ? <Origin tag="fake reader" /> : <Origin tag={modelTag(read.model)} />}
          <span className="ex-quiet">{readTime(read.read_at)}</span>
        </p>
      ) : (
        <p className="ex-quiet">Not read yet.</p>
      )}
      {requests.map((request, i) => (
        <p key={`${request.at}-${i}`} className="ex-request">
          An agent asked for a reading: {request.reason}
        </p>
      ))}
      {confirming ? (
        <div className="ex-confirm" role="group" aria-label="Confirm the read">
          <p>{CONFIRM_LINE}</p>
          <div className="ex-confirm-actions">
            <button type="button" className="ex-button" disabled={running} onClick={() => void go()}>
              {running ? 'Reading' : 'Read'}
            </button>
            <button type="button" className="ex-button ex-button-quiet" disabled={running} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="ex-button" onClick={() => setConfirming(true)}>
          {read ? 'Read again' : 'Read with Claude'}
        </button>
      )}
    </section>
  )
}
