import { useCallback, useMemo, useState } from 'react'
import { ApiError, type Api, type RecordDetail } from './api'
import { cameIn, readTime, statusLabel } from './format'
import { Origin } from './Origin'
import { segmentWidths, sharePercent } from './palette'
import { ReadSection } from './ReadSection'
import { RegionOverlay } from './RegionOverlay'
import { useRendering } from './rendering'
import { ReadingSection, RegionsSection, ShowsSection, SpacingSection, TextSection } from './Sections'
import type { ExtractionRecord, PaletteEntry } from './types'

function Line({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="ex-line">
      <dt>{name}</dt>
      <dd>
        <span className="ex-value">{children}</span>
        <Origin tag="code" />
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

function Colors({ palette, hovered }: { palette: readonly PaletteEntry[]; hovered: string | null }) {
  if (palette.length === 0) return <p className="ex-quiet">No colors were found.</p>
  return (
    <>
      <PaletteBar palette={palette} />
      <ul className="ex-colors">
        {palette.map((entry) => (
          <li key={entry.index} className={hovered === `P${entry.index}` ? 'ex-color-on' : undefined} data-palette={`P${entry.index}`}>
            <span className="ex-swatch" style={{ backgroundColor: entry.hex }} />
            <span className="ex-hex">{entry.hex}</span>
            <span className="ex-share">{sharePercent(entry.share)}</span>
            <span className="ex-accent-tag">{entry.is_accent ? 'accent' : ''}</span>
            <Origin tag="code" />
          </li>
        ))}
      </ul>
    </>
  )
}

const mean = (value: number | null) => (value === null ? 'Not measured' : `${Math.round(value)} of 255`)

const sentence = (error: unknown) => (error instanceof ApiError ? error.message : 'That didn’t work. Try again.')

export function RecordView({ api, folder, detail, onClose, onChange, onNotice }: {
  api: Api
  folder: string
  detail: RecordDetail
  onClose: () => void
  onChange: (next: RecordDetail) => void
  onNotice: (message: string | null) => void
}) {
  const { record, effective: view } = detail
  const url = useRendering(api, folder, record.id)
  const [hovered, setHovered] = useState<string | null>(null)
  const { measured } = view.structure
  const range = measured.value_range
  const read = view.structure.read

  const correct = useCallback((path: string, value: unknown) => {
    onNotice(null)
    api.correct(record.id, folder, [{ path, op: 'set', value }]).then(onChange, (error: unknown) => onNotice(sentence(error)))
  }, [api, folder, onChange, onNotice, record.id])

  const startRead = useCallback(async (again: boolean) => {
    onNotice(null)
    try {
      onChange(await api.read(record.id, folder, again))
    } catch (error) {
      onNotice(sentence(error))
    }
  }, [api, folder, onChange, onNotice, record.id])

  const sectionProps = { record: record as ExtractionRecord, view, hovered, onHover: setHovered, onCorrect: correct }

  return (
    <div className="ex-record">
      <div className="ex-stage">
        {url ? (
          <div className="ex-frame" style={{ '--ex-ratio': String(record.rendering.width / record.rendering.height) } as React.CSSProperties}>
            <img className="ex-rendering" src={url} alt={record.source.name ?? 'The measured image'} />
            {read ? <RegionOverlay key={read.read_at} regions={read.regions} hovered={hovered} onHover={setHovered} /> : null}
          </div>
        ) : null}
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
          <Colors palette={measured.palette} hovered={hovered} />
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
            <Line name="Added">{readTime(record.source.read_at)}</Line>
            <Line name="Hash"><span className="ex-mono">{record.rendering.sha256.slice(0, 12)}</span></Line>
          </dl>
        </section>
        <ReadSection key={record.structure.read?.read_at ?? 'unread'} record={record} onRead={startRead} />
        {read ? (
          <>
            <RegionsSection {...sectionProps} />
            <TextSection {...sectionProps} />
            <SpacingSection {...sectionProps} />
            <ReadingSection {...sectionProps} />
            <ShowsSection {...sectionProps} />
          </>
        ) : null}
      </aside>
    </div>
  )
}
