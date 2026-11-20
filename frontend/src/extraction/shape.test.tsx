import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecordBoundary } from './RecordBoundary'
import { RecordView } from './RecordView'
import { RegionOverlay } from './RegionOverlay'
import { usableRegions, usableRuns, validBox } from './read'
import { RegionsSection, TextSection } from './Sections'
import { readRecord } from './testRecord'
import type { ExtractionRecord, Region } from './types'

/** The record the review's example leaves behind: region r1 set whole to {role: "hero"}. */
function broken(): ExtractionRecord {
  const record = readRecord()
  const read = record.structure.read!
  ;(read.regions as Record<string, unknown>).r1 = { role: 'hero' }
  ;(read.text as Record<string, unknown>).t9 = { content: 'no box' }
  return record
}

const noop = () => {}
const props = (view: ExtractionRecord) => ({
  record: view, view, hovered: null, selected: null, onHover: noop, onSelect: noop, onCorrect: noop,
})

describe('a region or run without a valid box', () => {
  it('is not usable, and the others are', () => {
    expect(validBox([0, 0, 1, 1])).toBe(true)
    for (const box of [undefined, null, [0, 0, 1], [0, 0, 1, Number.NaN], [0, 0, 1, Infinity], ['0', 0, 1, 1], 'x']) {
      expect(validBox(box)).toBe(false)
    }
    const read = broken().structure.read!
    expect(Object.keys(usableRegions(read.regions))).toEqual(['r2'])
    expect(Object.keys(usableRuns(read.text))).toEqual(['t1'])
    expect(usableRegions({ a: null } as unknown as Record<string, Region>)).toEqual({})
  })

  it('is left out of the overlay and the rows, and the rest still draws', () => {
    const view = broken()
    const regions = view.structure.read!.regions
    render(<RegionOverlay regions={regions} hovered={null} selected={null} onHover={noop} onSelect={noop} />)
    expect(screen.getAllByTestId('region-box').map((b) => b.getAttribute('data-region'))).toEqual(['r2'])
    render(<><RegionsSection {...props(view)} /><TextSection {...props(view)} /></>)
    expect(screen.getAllByTestId('region-row')).toHaveLength(1)
    expect(screen.getAllByTestId('text-row')).toHaveLength(1)
  })
})

describe('RecordBoundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows one sentence and a Close button instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const record = readRecord()
    // reader_1 without its summary: the reading section can't draw it.
    delete (record.structure.read!.reader_1 as unknown as Record<string, unknown>).summary
    const onClose = vi.fn()
    const api = { rendering: () => new Promise<Blob>(() => {}) } as never
    render(
      <RecordBoundary onClose={onClose}>
        <RecordView api={api} folder="/f" detail={{ record, effective: record }} onClose={onClose} onChange={noop} onNotice={noop} />
      </RecordBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toContain('This record couldn’t be shown.')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('passes a record it can draw straight through', () => {
    render(<RecordBoundary onClose={noop}><p>drawn</p></RecordBoundary>)
    expect(screen.getByText('drawn')).toBeTruthy()
  })
})
