import { useMemo } from 'react'
import type { Api } from './api'
import { cameIn, readTime, statusLabel } from './format'
import { segmentWidths, sharePercent } from './palette'
import { useRendering } from './rendering'
import type { ExtractionRecord, PaletteEntry } from './types'

function Origin() {
  return <span className="ex-origin" title="Set by code">code</span>
}

function Line({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="ex-line">
      <dt>{name}</dt>
      <dd>
        <span className="ex-value">{children}</span>
        <Origin />
      </dd>
    </div>
  )
}

export function PaletteBar({ palette }: { palette: readonly PaletteEntry[] }) {
  const widths = useMemo(() => segmentWidths(palette), [palette])
  return (
    <div className="ex-bar" role="img" aria-label="The palette, each color as wide as its share of the image">
      {palette.map((entry, i) => (
        <span
          key={entry.index}
          className={entry.is_accent ? 'ex-seg ex-seg-accent' : 'ex-seg'}
          data-testid="palette-segment"
          style={{ width: `${widths[i]}%`, backgroundColor: entry.hex, animationDelay: `${i * 40}ms` }}
        />
      ))}
    </div>
  )
}

function Colors({ palette }: { palette: readonly PaletteEntry[] }) {
  if (palette.length === 0) return <p className="ex-quiet">No colors were found.</p>
  return (
    <>
      <PaletteBar palette={palette} />
      <ul className="ex-colors">
        {palette.map((entry) => (
          <li key={entry.index}>
            <span className="ex-swatch" style={{ backgroundColor: entry.hex }} />
            <span className="ex-hex">{entry.hex}</span>
            <span className="ex-share">{sharePercent(entry.share)}</span>
            <span className="ex-accent-tag">{entry.is_accent ? 'accent' : ''}</span>
            <Origin />
          </li>
        ))}
      </ul>
    </>
  )
}

const mean = (value: number | null) => (value === null ? 'Not measured' : `${Math.round(value)} of 255`)

export function RecordView({ api, folder, record, onClose }: {
  api: Api
  folder: string
  record: ExtractionRecord
  onClose: () => void
}) {
  const url = useRendering(api, folder, record.id)
  const { measured } = record.structure
  const range = measured.value_range
  return (
    <div className="ex-record">
      <div className="ex-stage">
        {url ? <img className="ex-rendering" src={url} alt={record.source.name ?? 'The measured image'} /> : null}
      </div>
      <aside className="ex-side">
        <div className="ex-side-head">
          <span className="ex-status">{statusLabel(record.status)}</span>
          <button type="button" className="ex-button ex-button-quiet" onClick={onClose}>
            Close
          </button>
        </div>
        <section>
          <h2 className="ex-label">Colors</h2>
          <Colors palette={measured.palette} />
        </section>
        <section>
          <h2 className="ex-label">Measured</h2>
          <dl>
            <Line name="Size">{record.rendering.width} × {record.rendering.height} px</Line>
            <Line name="Aspect">{measured.aspect.toFixed(2)}</Line>
            <Line name="Lightness range">{range ? `${Math.round(range.low)} to ${Math.round(range.high)} of 100` : 'Not measured'}</Line>
            <Line name="Mean lightness">{mean(measured.lightness)}</Line>
            <Line name="Saturation">{mean(measured.saturation)}</Line>
            <Line name="Perceptual hash"><span className="ex-mono">{record.rendering.phash}</span></Line>
          </dl>
        </section>
        <section>
          <h2 className="ex-label">Source</h2>
          <dl>
            <Line name="Name">{record.source.name || 'Unnamed'}</Line>
            <Line name="Came in">{cameIn(record.source.kind)}</Line>
            <Line name="Read">{readTime(record.source.read_at)}</Line>
            <Line name="Hash"><span className="ex-mono">{record.rendering.sha256.slice(0, 12)}</span></Line>
          </dl>
        </section>
        <section>
          <h2 className="ex-label">Read by Claude</h2>
          <p className="ex-quiet">Not read yet.</p>
        </section>
      </aside>
    </div>
  )
}
