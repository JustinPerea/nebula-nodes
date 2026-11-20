import { describe, expect, it } from 'vitest'
import { boxPosition, drawOrder, inOrder, originAt, showOrigin } from './read'
import { readRecord } from './testRecord'
import type { Correction } from './types'

const fix = (path: string, actor: 'person' | 'agent'): Correction => ({ path, op: 'set', value: 'x', actor, at: 't' })

describe('boxPosition', () => {
  it('turns box fractions into percentages of the frame', () => {
    expect(boxPosition([0.25, 0.5, 0.125, 0.0622])).toEqual({ left: '25%', top: '50%', width: '12.5%', height: '6.22%' })
    expect(boxPosition([0, 0, 1, 1])).toEqual({ left: '0%', top: '0%', width: '100%', height: '100%' })
  })
})

describe('drawOrder', () => {
  it('draws the largest region first so a small one sits on top', () => {
    const record = readRecord()
    expect(drawOrder(record.structure.read!.regions).map(([id]) => id)).toEqual(['r1', 'r2'])
  })
})

describe('inOrder', () => {
  it('sorts by the read order', () => {
    expect(inOrder({ b: { order: 1 }, a: { order: 0 } }).map(([id]) => id)).toEqual(['a', 'b'])
    expect(inOrder(undefined)).toEqual([])
  })
})

describe('originAt', () => {
  it('is the base origin when nothing was corrected', () => {
    expect(originAt([], 'structure.read.regions.r1', 'Claude')).toBe('Claude')
    expect(originAt([], 'structure.measured.palette', 'code')).toBe('code')
    expect(originAt([], 'structure.read.regions.r1', 'fake reader')).toBe('fake reader')
  })

  it('says you for a person correction and agent for an agent one, from a field up to its region', () => {
    const corrections = [fix('structure.read.regions.r1.role', 'person'), fix('structure.read.regions.r2.label', 'agent')]
    expect(originAt(corrections, 'structure.read.regions.r1', 'Claude')).toBe('you')
    expect(originAt(corrections, 'structure.read.regions.r1.role', 'Claude')).toBe('you')
    expect(originAt(corrections, 'structure.read.regions.r2', 'Claude')).toBe('agent')
    expect(originAt(corrections, 'structure.read.regions.r3', 'Claude')).toBe('Claude')
  })

  it('takes the last correction when two actors touched a value', () => {
    const corrections = [fix('structure.read.regions.r1.role', 'person'), fix('structure.read.regions.r1.role', 'agent')]
    expect(originAt(corrections, 'structure.read.regions.r1', 'Claude')).toBe('agent')
  })
})

describe('showOrigin', () => {
  it('follows the show origin and the model name', () => {
    expect(showOrigin(readRecord(), 's1', 'model')).toBe('Claude')
    expect(showOrigin(readRecord('fake-reader'), 's1', 'model')).toBe('fake reader')
    expect(showOrigin(readRecord(), 's9', 'person')).toBe('you')
    expect(showOrigin(readRecord(), 's9', 'agent')).toBe('agent')
  })

  it('marks a model show whose statement a person changed', () => {
    const record = readRecord('claude-opus-5-5', [fix('shows.s1.statement', 'person')])
    expect(showOrigin(record, 's1', 'model')).toBe('you')
  })
})
