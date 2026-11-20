import type { Correction, ExtractionRecord, ReadResult } from './types'

/** A small read-record for tests: two regions, one text run, one show. */
export function readRecord(model = 'claude-opus-5-5', corrections: Correction[] = []): ExtractionRecord {
  const read: ReadResult = {
    origin: 'model',
    model,
    prompt_version: 'extract-1',
    read_at: '2026-11-19T10:00:00Z',
    reader_1: {
      summary: { value: 'A landing page.', why: 'bar and button' },
      type_style: { value: 'geometric_sans', why: '' },
      spacing_density: { value: 'airy', why: '' },
      layout: { value: 'asymmetric', why: '' },
      composition_notes: { value: 'Text on the left.', why: '' },
      medium: { value: 'ui', why: '' },
      subject: { value: 'landing page', why: '' },
      axes: { quiet_loud: { value: -0.5, why: 'one accent' }, warm_cold: { value: 1, why: '' } },
      keywords: ['landing_page', 'whitespace'],
    },
    regions: {
      r1: { box: [0, 0, 1, 0.08], box_px: [0, 0, 1440, 72], role: 'header', label: 'Top bar', order: 0 },
      r2: { box: [0.0667, 0.4556, 0.1389, 0.0622], box_px: [96, 410, 200, 56], role: 'button', label: 'Primary button', order: 1 },
    },
    text: {
      t1: {
        region: 'r2', box: [0.09, 0.47, 0.09, 0.02], box_px: [130, 430, 130, 16], content: 'Get started',
        size_px: { value: 14, estimate: true }, weight: 'medium', type_style: 'geometric_sans', order: 0,
      },
    },
    spacing: { outer_margin_px: { value: 96, estimate: true }, gaps: [{ between: ['r1', 'r2'], axis: 'y', px: 40, estimate: true }] },
  }
  return {
    id: 'ex_0123456789abcdef',
    status: 'proposal',
    rendering: { width: 1440, height: 900, sha256: 'a'.repeat(64), phash: '0'.repeat(16) },
    source: { kind: 'drop', name: 'landing.png', size: 1000, read_at: '2026-11-19T09:00:00Z' },
    structure: {
      measured: {
        palette: [
          { index: 0, hex: '#f6f4ee', share: 0.7, is_accent: false },
          // palette-exempt: a colour measured from a test image, data the page shows as a swatch, not a UI colour
          { index: 1, hex: '#f06e1e', share: 0.01, is_accent: true },
        ],
        value_range: { low: 10, high: 95 },
        aspect: 1.6,
        lightness: 200,
        saturation: 20,
        // palette-exempt: the same measured image colour, inside a region
        region_measures: { r2: { box_px: [96, 410, 200, 56], palette: [{ index: 0, hex: '#f06e1e', share: 1, is_accent: true }], origin: 'code', from_model_box: true } },
        region_gaps: [{ between: ['r1', 'r2'], axis: 'y', px: 338, origin: 'code' }],
      },
      read,
    },
    shows: {
      s1: { statement: 'One accent, used on the button.', evidence: ['P1', 'r2'], origin: 'model', status: 'proposal', decision_ref: null, order: 0 },
    },
    corrections,
  }
}

/** The record with each correction's value set at its path (what the server's effective view does for sets). */
export function applied(record: ExtractionRecord): ExtractionRecord {
  const copy = structuredClone(record) as unknown as Record<string, unknown>
  for (const c of record.corrections) {
    const parts = c.path.split('.')
    let node = copy as Record<string, unknown>
    for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>
    node[parts[parts.length - 1]] = c.value
  }
  return copy as unknown as ExtractionRecord
}
