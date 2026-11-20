import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ReadSection } from './ReadSection'
import { readRecord } from './testRecord'
import type { ExtractionRecord } from './types'

function withRequests(): ExtractionRecord {
  const record = readRecord()
  return {
    ...record,
    structure: { ...record.structure, read: null },
    read_requests: [{ actor: 'agent', at: '2026-11-19T12:00:00Z', reason: 'Needs its regions for the brief.' }],
  }
}

describe('a pending read request', () => {
  it('is shown and never starts a read on its own', () => {
    const onRead = vi.fn(async () => {})
    render(<ReadSection record={withRequests()} onRead={onRead} />)
    expect(screen.getByText(/An agent asked for a reading/)).toBeTruthy()
    expect(onRead).not.toHaveBeenCalled()
  })

  it('reaches the read endpoint only from the confirm handler', () => {
    // The page calls api.read in exactly one place, the handler ReadSection's
    // confirm runs. Nothing on load, on a drop or on a request calls it.
    const dir = path.dirname(new URL(import.meta.url).pathname)
    const calls = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))
      .flatMap((name) => (readFileSync(path.join(dir, name), 'utf8').match(/api\.read\(/g) ?? []).map(() => name))
    expect(calls).toEqual(['RecordView.tsx'])
    const view = readFileSync(path.join(dir, 'RecordView.tsx'), 'utf8')
    expect(view).toMatch(/onRead=\{/)
  })
})

describe('a fake reading', () => {
  it('is marked with a notice', () => {
    render(<ReadSection record={readRecord('fake-reader')} onRead={async () => {}} />)
    expect(document.querySelector('[data-fake-reading]')).not.toBeNull()
  })

  it('has no notice when Claude read it', () => {
    render(<ReadSection record={readRecord()} onRead={async () => {}} />)
    expect(document.querySelector('[data-fake-reading]')).toBeNull()
  })
})
