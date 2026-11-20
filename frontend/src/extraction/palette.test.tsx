import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { segmentWidths, sharePercent } from './palette'
import { PaletteBar } from './RecordView'
import type { PaletteEntry } from './types'

const entry = (index: number, share: number, is_accent = false): PaletteEntry => ({ index, hex: '#101010', share, is_accent })

describe('segmentWidths', () => {
  it('follows the shares and fills the bar', () => {
    const widths = segmentWidths([entry(0, 0.6), entry(1, 0.3), entry(2, 0.1)])
    expect(widths[0]).toBeCloseTo(60)
    expect(widths[1]).toBeCloseTo(30)
    expect(widths[2]).toBeCloseTo(10)
  })

  it('scales shares that do not add to one', () => {
    const widths = segmentWidths([entry(0, 0.5), entry(1, 0.25)])
    expect(widths[0]).toBeCloseTo(66.667, 2)
    expect(widths[0] + widths[1]).toBeCloseTo(100)
  })

  it('gives an empty palette no width', () => {
    expect(segmentWidths([])).toEqual([])
    expect(segmentWidths([entry(0, 0)])).toEqual([0])
  })
})

describe('sharePercent', () => {
  it('rounds, and calls a sliver under one percent', () => {
    expect(sharePercent(0.6208)).toBe('62%')
    expect(sharePercent(0.004)).toBe('<1%')
    expect(sharePercent(0)).toBe('0%')
  })
})

describe('PaletteBar', () => {
  it('draws one segment per color with its width set by its share', () => {
    render(<PaletteBar palette={[entry(0, 0.7), entry(1, 0.2, true), entry(2, 0.1)]} />)
    const segments = screen.getAllByTestId('palette-segment')
    expect(segments.map((s) => parseFloat(s.style.width))).toEqual([
      expect.closeTo(70, 3),
      expect.closeTo(20, 3),
      expect.closeTo(10, 3),
    ])
    expect(segments[1].className).toContain('ex-seg-accent')
    expect(segments[0].className).not.toContain('ex-seg-accent')
  })
})
